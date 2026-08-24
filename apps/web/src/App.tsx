import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  ActivityKind,
  AgentActivity,
  AgentNode,
  AgentRuntimeStatus,
  ObservatorySnapshot,
} from "@observatory/core";
import { uiStore } from "./ui-store.ts";

const STATUS: Record<AgentRuntimeStatus, { icon: string; label: string }> = {
  working: { icon: "●", label: "Working" },
  waiting: { icon: "◐", label: "Waiting" },
  idle: { icon: "○", label: "Idle" },
  completed: { icon: "✓", label: "Completed" },
  failed: { icon: "!", label: "Failed" },
  unknown: { icon: "?", label: "Unknown" },
};

const FALLBACK_ROLE_COLORS = ["#93c5fd", "#c4b5fd", "#67e8f9", "#fcd34d", "#6ee7b7", "#fda4af"];

function roleColor(role?: string): string {
  const value = role?.trim().toLowerCase() ?? "agent";
  if (/^(root|main|agent|orchestrator)$/.test(value)) return "#a8b3ba";
  if (/(architect|planner|research|analyst)/.test(value)) return "#c4b5fd";
  if (/(implement|builder|engineer|frontend|backend|developer)/.test(value)) return "#7dd3fc";
  if (/(evaluat|test|qa|validator)/.test(value)) return "#fbbf24";
  if (/(review|audit)/.test(value)) return "#5eead4";
  if (/(fix|debug|repair)/.test(value)) return "#fb7185";
  let hash = 0;
  for (const character of value) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return FALLBACK_ROLE_COLORS[Math.abs(hash) % FALLBACK_ROLE_COLORS.length] ?? "#a8b3ba";
}

function roleDescription(role?: string): string {
  const value = role?.trim().toLowerCase() ?? "agent";
  if (/^(root|main|orchestrator)$/.test(value)) {
    return "Coordinates the run, delegates work, and integrates agent results.";
  }
  if (value === "agent") return "General-purpose agent working on the current task.";
  if (/(architect|planner)/.test(value)) {
    return "Defines structure, constraints, and the implementation direction.";
  }
  if (/(research|analyst|explorer)/.test(value)) {
    return "Investigates context, evidence, and possible approaches.";
  }
  if (/(implement|builder|engineer|frontend|backend|developer)/.test(value)) {
    return "Builds and modifies the requested implementation.";
  }
  if (/(evaluat|test|qa|validator)/.test(value)) {
    return "Checks behavior, quality, tests, and acceptance criteria.";
  }
  if (/(review|audit)/.test(value)) {
    return "Reviews results for correctness, risk, and regressions.";
  }
  if (/(fix|debug|repair)/.test(value)) {
    return "Diagnoses issues and applies corrective changes.";
  }
  return "Custom agent role defined by the current workflow.";
}

type TimelineFilter = "all" | "agent" | "tool" | "file" | "command" | "error";
type AgentContextFilter = "all" | "skill" | "workflow";

function useNow(interval = 1_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), interval);
    return () => window.clearInterval(timer);
  }, [interval]);
  return now;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(timestamp);
}

function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function agentRuntimeLabel(agent: AgentNode): string | undefined {
  const values = [agent.model, agent.reasoningEffort].filter((value): value is string => Boolean(value));
  return values.length > 0 ? values.join(" · ") : undefined;
}

function agentContextLabel(agent: AgentNode): string | undefined {
  const skills = agent.observedSkills ?? [];
  const workflows = agent.observedWorkflows ?? [];
  const values = [
    skills.length > 0 ? `Skill: ${skills.join(", ")}` : undefined,
    workflows.length > 0 ? `Workflow: ${workflows.join(", ")}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return values.length > 0 ? values.join(" · ") : undefined;
}

function agentContextSummary(agent: AgentNode): string | undefined {
  const skills = agent.observedSkills ?? [];
  const workflows = agent.observedWorkflows ?? [];
  const skill = skills[0] ? `${skills[0]}${skills.length > 1 ? ` +${skills.length - 1}` : ""}` : undefined;
  const workflow = workflows[0] ? `${workflows[0]}${workflows.length > 1 ? ` +${workflows.length - 1}` : ""}` : undefined;
  return [skill, workflow].filter(Boolean).join(" · ") || undefined;
}

function StatusBadge({ agent, compact = false }: { agent: AgentNode; compact?: boolean }) {
  const status = STATUS[agent.status];
  const waiting = agent.waitingReasons
    .map((reason) => reason === "userInput" ? "user input" : reason)
    .join(" + ");
  const label = agent.status === "waiting" && waiting ? `${status.label} · ${waiting}` : status.label;
  return (
    <span className={`status status--${agent.status}`} aria-label={`Status: ${label}`}>
      <span className="status__icon" aria-hidden="true">{status.icon}</span>
      {!compact && <span>{label}</span>}
    </span>
  );
}

export function AgentList({
  snapshot,
  selectedId,
  onSelect,
}: {
  snapshot: ObservatorySnapshot;
  selectedId?: string;
  onSelect(id: string): void;
}) {
  const [contextFilter, setContextFilter] = useState<AgentContextFilter>("all");
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const agents = useMemo(() => {
    const compareAgents = (a: AgentNode, b: AgentNode) =>
      (a.startedAt ?? 0) - (b.startedAt ?? 0)
      || (a.nickname ?? a.role ?? a.id).localeCompare(b.nickname ?? b.role ?? b.id);
    const ordered: AgentNode[] = [];
    const visited = new Set<string>();
    const visit = (id: string) => {
      const agent = snapshot.agents[id];
      if (!agent || visited.has(id)) return;
      visited.add(id);
      ordered.push(agent);
      agent.children
        .map((childId) => snapshot.agents[childId])
        .filter((child): child is AgentNode => Boolean(child))
        .sort(compareAgents)
        .forEach((child) => visit(child.id));
    };

    snapshot.roots
      .map((rootId) => snapshot.agents[rootId])
      .filter((root): root is AgentNode => Boolean(root))
      .sort(compareAgents)
      .forEach((root) => visit(root.id));
    Object.values(snapshot.agents).sort(compareAgents).forEach((agent) => visit(agent.id));
    return ordered;
  }, [snapshot.agents, snapshot.roots]);
  const includedIds = useMemo(() => {
    if (contextFilter === "all") return new Set(agents.map((agent) => agent.id));
    const included = new Set<string>();
    for (const agent of agents) {
      const matches = contextFilter === "skill"
        ? (agent.observedSkills?.length ?? 0) > 0
        : (agent.observedWorkflows?.length ?? 0) > 0;
      if (!matches) continue;

      let current: AgentNode | undefined = agent;
      const path = new Set<string>();
      while (current && !path.has(current.id)) {
        path.add(current.id);
        included.add(current.id);
        current = current.parentId ? snapshot.agents[current.parentId] : undefined;
      }
    }
    return included;
  }, [agents, contextFilter, snapshot.agents]);
  const visibleAgents = agents.filter((agent) => {
    if (!includedIds.has(agent.id)) return false;
    let parentId = agent.parentId;
    const path = new Set<string>();
    while (parentId && !path.has(parentId)) {
      if (collapsedIds.has(parentId)) return false;
      path.add(parentId);
      parentId = snapshot.agents[parentId]?.parentId;
    }
    return true;
  });
  const countIsReduced = visibleAgents.length !== agents.length;
  const toggleCollapsed = (id: string) => {
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  return (
    <aside className="agent-list panel" aria-labelledby="agents-heading">
      <div className="panel__heading">
        <h2 id="agents-heading">Agents</h2>
        <span className="panel__count">{visibleAgents.length}{countIsReduced ? `/${agents.length}` : ""}</span>
      </div>
      <div className="agent-context-filters" aria-label="Agent context filters">
        {(["all", "skill", "workflow"] as const).map((option) => (
          <button key={option} data-active={contextFilter === option || undefined} onClick={() => setContextFilter(option)}>
            {option === "all" ? "All" : option === "skill" ? "Skills" : "Workflows"}
          </button>
        ))}
      </div>
      <div className="agent-list__items">
        {visibleAgents.map((agent) => {
          const name = agent.nickname ?? agent.role ?? shortId(agent.id);
          const childCount = agent.children.filter((childId) => Boolean(snapshot.agents[childId])).length;
          const collapsed = collapsedIds.has(agent.id);
          return (
            <div
              className="agent-tree-item"
              data-parent={childCount > 0 || undefined}
              data-selected={agent.id === selectedId || undefined}
              key={agent.id}
              style={{ "--agent-role-color": roleColor(agent.role) } as CSSProperties}
            >
              <span
                className="agent-row__indent"
                data-visible={(agent.depth ?? 0) > 0 || undefined}
                aria-hidden="true"
                style={{ width: `${(agent.depth ?? 0) * 12}px` }}
              />
              {childCount > 0 ? (
                <button
                  className="agent-row__toggle"
                  type="button"
                  aria-expanded={!collapsed}
                  aria-label={`${collapsed ? "Expand" : "Collapse"} ${name}`}
                  title={`${collapsed ? "Expand" : "Collapse"} children`}
                  onClick={() => toggleCollapsed(agent.id)}
                >
                  <svg
                    className="agent-row__toggle-icon"
                    aria-hidden="true"
                    viewBox="0 0 16 16"
                  >
                    <path d="m3.75 6 4.25 4 4.25-4" />
                  </svg>
                </button>
              ) : (
                <span className="agent-row__toggle-spacer" aria-hidden="true" />
              )}
              <button
                className="agent-row"
                data-selected={agent.id === selectedId || undefined}
                onClick={() => onSelect(agent.id)}
                aria-pressed={agent.id === selectedId}
              >
                <StatusBadge agent={agent} compact />
                <span className="agent-row__copy">
                  <strong>{name}</strong>
                  <span className="agent-row__role-line">
                    <span className="agent-row__role">{agent.role ?? "agent"}</span>
                    {childCount > 0 && <span className="agent-row__parent-label">Parent</span>}
                  </span>
                  {agentRuntimeLabel(agent) && (
                    <span className="agent-row__runtime" title={agentRuntimeLabel(agent)}>{agentRuntimeLabel(agent)}</span>
                  )}
                  {agentContextLabel(agent) && (
                    <span className="agent-row__context" title={agentContextLabel(agent)}>
                      {agentContextSummary(agent)}
                    </span>
                  )}
                </span>
                {childCount > 0 && (
                  <span className="agent-row__children" aria-label={`${childCount} child agents`} title={`${childCount} direct child agents`}>
                    <span aria-hidden="true">↳</span>{childCount}
                  </span>
                )}
              </button>
            </div>
          );
        })}
        {visibleAgents.length === 0 && (
          <div className="empty-state">
            <span className="empty-state__mark">⌁</span>
            <p>{agents.length === 0 ? "No agents discovered yet." : "No agents match this context filter."}</p>
          </div>
        )}
      </div>
    </aside>
  );
}

interface Point { x: number; y: number }

const GRAPH_NODE_WIDTH = 218;
const GRAPH_NODE_HEIGHT = 106;

interface LayoutBox {
  width: number;
  height: number;
  rootX: number;
  children: Array<{ id: string; x: number; y: number; box: LayoutBox }>;
}

function layoutGraph(snapshot: ObservatorySnapshot): {
  positions: Record<string, Point>;
  width: number;
  height: number;
} {
  const nodeWidth = GRAPH_NODE_WIDTH;
  const nodeHeight = GRAPH_NODE_HEIGHT;
  const horizontalGap = 34;
  const verticalGap = 40;
  const positions: Record<string, Point> = {};
  const memo = new Map<string, LayoutBox>();
  const building = new Set<string>();
  const buildBox = (id: string): LayoutBox => {
    const cached = memo.get(id);
    if (cached) return cached;
    if (building.has(id)) return { width: nodeWidth, height: nodeHeight, rootX: 0, children: [] };
    building.add(id);
    const childIds = snapshot.agents[id]?.children.filter((child) => snapshot.agents[child] && !building.has(child)) ?? [];
    if (childIds.length === 0) {
      const leaf = { width: nodeWidth, height: nodeHeight, rootX: 0, children: [] };
      memo.set(id, leaf);
      building.delete(id);
      return leaf;
    }

    // Wide sibling sets become a compact matrix. A fixed depth row makes 10–50
    // agents several thousand pixels wide and forces labels below readable size.
    const columns = Math.min(6, Math.max(1, Math.ceil(Math.sqrt(childIds.length * 0.6))));
    const rows = Array.from({ length: Math.ceil(childIds.length / columns) }, (_, rowIndex) => (
      childIds.slice(rowIndex * columns, (rowIndex + 1) * columns).map((childId) => ({ id: childId, box: buildBox(childId) }))
    ));
    const rowWidths = rows.map((row) => row.reduce((sum, child) => sum + child.box.width, 0) + horizontalGap * (row.length - 1));
    const rowHeights = rows.map((row) => Math.max(...row.map((child) => child.box.height)));
    const width = Math.max(nodeWidth, ...rowWidths);
    const children: LayoutBox["children"] = [];
    let rowTop = nodeHeight + verticalGap;
    rows.forEach((row, rowIndex) => {
      let childLeft = (width - rowWidths[rowIndex]!) / 2;
      row.forEach((child) => {
        children.push({ id: child.id, x: childLeft, y: rowTop, box: child.box });
        childLeft += child.box.width + horizontalGap;
      });
      rowTop += rowHeights[rowIndex]! + verticalGap;
    });
    const box = {
      width,
      height: rowTop - verticalGap,
      rootX: (width - nodeWidth) / 2,
      children,
    };
    memo.set(id, box);
    building.delete(id);
    return box;
  };
  const place = (id: string, box: LayoutBox, left: number, top: number): void => {
    positions[id] = { x: left + box.rootX, y: top };
    for (const child of box.children) {
      place(child.id, child.box, left + child.x, top + child.y);
    }
  };
  let left = 36;
  let contentHeight = 0;
  for (const root of snapshot.roots) {
    const box = buildBox(root);
    place(root, box, left, 36);
    left += box.width + horizontalGap * 2;
    contentHeight = Math.max(contentHeight, box.height);
  }
  return { positions, width: Math.max(720, left), height: Math.max(460, contentHeight + 72) };
}

const WORKFLOW_WITHOUT_EVIDENCE = "__without-workflow-evidence__";
const WORKFLOW_STATUS_ORDER: Record<AgentRuntimeStatus, number> = {
  working: 0,
  waiting: 1,
  failed: 2,
  idle: 3,
  unknown: 4,
  completed: 5,
};
type WorkflowSort = "started" | "status" | "updated";

const WORKFLOW_SORT: Record<WorkflowSort, { label: string; description: string; laneLabel: string; timeLabel: string }> = {
  started: {
    label: "Started",
    description: "Observed agent start time · earliest first",
    laneLabel: "Started ↑",
    timeLabel: "Started",
  },
  status: {
    label: "Status",
    description: "Active states first · then recent updates",
    laneLabel: "Status priority",
    timeLabel: "Updated",
  },
  updated: {
    label: "Updated",
    description: "Most recently updated first",
    laneLabel: "Updated ↓",
    timeLabel: "Updated",
  },
};

export function WorkflowBoard({
  snapshot,
  selectedId,
  onSelect,
}: {
  snapshot: ObservatorySnapshot;
  selectedId?: string;
  onSelect(id: string): void;
}) {
  const [sort, setSort] = useState<WorkflowSort>("started");
  const activitiesById = useMemo(
    () => new Map(snapshot.activities.map((activity) => [activity.id, activity])),
    [snapshot.activities],
  );
  const lanes = useMemo(() => {
    const members = new Map<string, AgentNode[]>();
    for (const agent of Object.values(snapshot.agents)) {
      const workflows = agent.observedWorkflows?.length
        ? agent.observedWorkflows
        : [WORKFLOW_WITHOUT_EVIDENCE];
      for (const workflow of workflows) {
        const lane = members.get(workflow) ?? [];
        lane.push(agent);
        members.set(workflow, lane);
      }
    }
    const compareTimestamp = (a?: number, b?: number, descending = false) => {
      if (a === undefined && b === undefined) return 0;
      if (a === undefined) return 1;
      if (b === undefined) return -1;
      return descending ? b - a : a - b;
    };
    const compareAgents = (a: AgentNode, b: AgentNode) => {
      const ordered = sort === "started"
        ? compareTimestamp(a.startedAt, b.startedAt)
        : sort === "updated"
          ? compareTimestamp(a.updatedAt, b.updatedAt, true)
          : WORKFLOW_STATUS_ORDER[a.status] - WORKFLOW_STATUS_ORDER[b.status]
            || compareTimestamp(a.updatedAt, b.updatedAt, true);
      return ordered || (a.nickname ?? a.id).localeCompare(b.nickname ?? b.id);
    };
    return [...members.entries()]
      .map(([id, agents]) => ({
        id,
        label: id === WORKFLOW_WITHOUT_EVIDENCE ? "No workflow evidence" : id,
        agents: agents.sort(compareAgents),
      }))
      .sort((a, b) => {
        if (a.id === WORKFLOW_WITHOUT_EVIDENCE) return 1;
        if (b.id === WORKFLOW_WITHOUT_EVIDENCE) return -1;
        return b.agents.length - a.agents.length || a.label.localeCompare(b.label);
      });
  }, [snapshot.agents, sort]);
  const membershipCount = lanes.reduce((total, lane) => total + lane.agents.length, 0);
  const sortConfig = WORKFLOW_SORT[sort];

  return (
    <section className="workflow-board panel" aria-labelledby="workflow-board-heading">
      <div className="panel__heading workflow-board__heading">
        <div>
          <h2 id="workflow-board-heading">Workflow board</h2>
          <span className="panel__subtle">Observed execution context · live</span>
        </div>
        <span className="workflow-board__summary">{Object.keys(snapshot.agents).length} agents · {membershipCount} memberships</span>
      </div>
      <div className="workflow-board__evidence" role="note">
        <div className="workflow-board__evidence-copy">
          <strong>Observed order</strong>
          <span>{sortConfig.description}. This is evidence-based order—not orchestration ownership or a declared workflow stage.</span>
        </div>
        <div className="workflow-board__sort" role="group" aria-label="Workflow agent order">
          {(Object.keys(WORKFLOW_SORT) as WorkflowSort[]).map((option) => (
            <button key={option} aria-pressed={sort === option} onClick={() => setSort(option)}>
              {WORKFLOW_SORT[option].label}
            </button>
          ))}
        </div>
      </div>
      <div className="workflow-board__lanes" data-compact={lanes.length <= 2 || undefined} data-single={lanes.length === 1 || undefined}>
        {lanes.map((lane, laneIndex) => (
          <section
            className="workflow-lane"
            key={lane.id}
            aria-labelledby={`workflow-lane-${laneIndex}`}
            style={{ "--workflow-lane-weight": lane.agents.length > 8 ? 2 : 1 } as CSSProperties}
          >
            <header className="workflow-lane__heading">
              <div>
                <span>{lane.id === WORKFLOW_WITHOUT_EVIDENCE ? "Compatibility lane" : "Observed workflow"}</span>
                <h3 id={`workflow-lane-${laneIndex}`}>{lane.label}</h3>
                <small>{sortConfig.laneLabel}</small>
              </div>
              <strong>{lane.agents.length}</strong>
            </header>
            <ul className="workflow-lane__cards">
              {lane.agents.map((agent, agentIndex) => {
                const activity = agent.currentActivityId
                  ? activitiesById.get(agent.currentActivityId)
                  : undefined;
                const skills = agent.observedSkills ?? [];
                const name = agent.nickname ?? agent.role ?? shortId(agent.id);
                const orderAt = sort === "started" ? agent.startedAt : agent.updatedAt;
                return (
                  <li key={`${lane.id}:${agent.id}`}>
                    <button
                      className={`workflow-card workflow-card--${agent.status}`}
                      data-selected={selectedId === agent.id || undefined}
                      onClick={() => onSelect(agent.id)}
                      aria-label={`Position ${agentIndex + 1}, ${name}, ${STATUS[agent.status].label}, ${lane.label} workflow lane`}
                      aria-pressed={selectedId === agent.id}
                      style={{ "--agent-role-color": roleColor(agent.role) } as CSSProperties}
                    >
                      <span className="workflow-card__topline">
                        <span className="workflow-card__identity">
                          <span className="workflow-card__position" aria-label={`Observed position ${agentIndex + 1}`}>
                            {String(agentIndex + 1).padStart(2, "0")}
                          </span>
                          <span className="workflow-card__role">{agent.role ?? "agent"}</span>
                        </span>
                        <StatusBadge agent={agent} />
                      </span>
                      <strong>{name}</strong>
                      <span className="workflow-card__order-time">
                        {sortConfig.timeLabel} {orderAt === undefined ? "unknown" : formatTime(orderAt)}
                      </span>
                      <span className="workflow-card__activity">
                        {activity?.title
                          ?? (agent.status === "completed"
                            ? "Work completed"
                            : agent.status === "failed"
                              ? "Execution failed"
                              : agent.status === "idle"
                                ? "Ready"
                                : "No current activity")}
                      </span>
                      <span className="workflow-card__runtime">{agentRuntimeLabel(agent) ?? "Runtime metadata unavailable"}</span>
                      <span className="workflow-card__footer">
                        <span>{skills[0] ?? "No skill evidence"}{skills.length > 1 ? ` +${skills.length - 1}` : ""}</span>
                        {agent.children.length > 0 && <span>{agent.children.length} children</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {lanes.length === 0 && (
          <div className="workflow-board__empty">
            <strong>No agents discovered</strong>
            <span>Workflow lanes appear as runtime evidence arrives.</span>
          </div>
        )}
      </div>
    </section>
  );
}

export const AgentGraph = memo(function AgentGraph({
  snapshot,
  selectedId,
  onSelect,
}: {
  snapshot: ObservatorySnapshot;
  selectedId?: string;
  onSelect(id: string): void;
}) {
  const topologyKey = snapshot.roots.join("|") + snapshot.edges.map((edge) => `${edge.source}>${edge.target}`).join("|");
  const layout = useMemo(() => layoutGraph(snapshot), [topologyKey]);
  const activitiesById = useMemo(
    () => new Map(snapshot.activities.map((activity) => [activity.id, activity])),
    [snapshot.activities],
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const view = useRef({ scale: 1, x: 0, y: 0 });
  const [scalePercent, setScalePercent] = useState(100);
  const scalePercentRef = useRef(100);
  const [roleTooltip, setRoleTooltip] = useState<{
    role: string;
    description: string;
    x: number;
    y: number;
  }>();
  const drag = useRef<{ pointerId: number; x: number; y: number; originX: number; originY: number } | undefined>(undefined);

  const applyView = useCallback((next: { scale: number; x: number; y: number }) => {
    const normalized = {
      scale: Math.min(2, Math.max(0.15, next.scale)),
      x: next.x,
      y: next.y,
    };
    view.current = normalized;
    if (canvasRef.current) {
      canvasRef.current.style.transform = `translate3d(${normalized.x}px, ${normalized.y}px, 0) scale(${normalized.scale})`;
    }
    const nextPercent = Math.round(normalized.scale * 100);
    if (scalePercentRef.current !== nextPercent) {
      scalePercentRef.current = nextPercent;
      setScalePercent(nextPercent);
    }
  }, []);

  const zoomAt = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const current = view.current;
    const nextScale = Math.min(2, Math.max(0.15, current.scale * factor));
    const anchorX = clientX === undefined ? bounds.width / 2 : clientX - bounds.left;
    const anchorY = clientY === undefined ? bounds.height / 2 : clientY - bounds.top;
    const worldX = (anchorX - current.x) / current.scale;
    const worldY = (anchorY - current.y) / current.scale;
    applyView({
      scale: nextScale,
      x: anchorX - worldX * nextScale,
      y: anchorY - worldY * nextScale,
    });
  }, [applyView]);

  const fit = useCallback(() => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const widthScale = Math.max(0, bounds.width - 48) / layout.width;
    const heightScale = Math.max(0, bounds.height - 48) / layout.height;
    const scale = Math.min(1, Math.max(0.15, Math.min(widthScale, heightScale)));
    applyView({
      scale,
      x: Math.max(20, (bounds.width - layout.width * scale) / 2),
      y: Math.max(20, (bounds.height - layout.height * scale) / 2),
    });
  }, [applyView, layout.height, layout.width]);

  useEffect(() => {
    fit();
    const observer = new ResizeObserver(fit);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [fit]);

  useEffect(() => {
    if (!selectedId) return;
    const position = layout.positions[selectedId];
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!position || !bounds) return;
    const current = view.current;
    const nodeLeft = current.x + position.x * current.scale;
    const nodeTop = current.y + position.y * current.scale;
    const nodeRight = nodeLeft + GRAPH_NODE_WIDTH * current.scale;
    const nodeBottom = nodeTop + GRAPH_NODE_HEIGHT * current.scale;
    const safeInset = 32;
    const isVisible = nodeLeft >= safeInset
      && nodeTop >= safeInset
      && nodeRight <= bounds.width - safeInset
      && nodeBottom <= bounds.height - safeInset;
    if (isVisible) return;
    applyView({
      ...current,
      x: bounds.width / 2 - (position.x + 109) * current.scale,
      y: bounds.height / 2 - (position.y + 46) * current.scale,
    });
  }, [applyView, layout, selectedId]);

  useEffect(() => {
    const viewport = containerRef.current;
    if (!viewport) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? viewport.clientHeight
          : 1;
      if (event.ctrlKey || event.metaKey) {
        const factor = Math.exp(Math.max(-80, Math.min(80, -event.deltaY * unit)) * 0.008);
        zoomAt(factor, event.clientX, event.clientY);
        return;
      }
      const current = view.current;
      const horizontal = event.shiftKey && event.deltaX === 0 ? event.deltaY * unit : event.deltaX * unit;
      const vertical = event.shiftKey && event.deltaX === 0 ? 0 : event.deltaY * unit;
      applyView({ ...current, x: current.x - horizontal, y: current.y - vertical });
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [applyView, zoomAt]);

  const beginPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0 && event.button !== 1) return;
    if (event.button === 0 && event.target !== event.currentTarget && (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const current = view.current;
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: current.x, originY: current.y };
    event.currentTarget.dataset.panning = "true";
  };
  const pan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    applyView({
      scale: view.current.scale,
      x: current.originX + event.clientX - current.x,
      y: current.originY + event.clientY - current.y,
    });
  };
  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = undefined;
    delete event.currentTarget.dataset.panning;
  };
  const showRoleTooltip = (element: HTMLElement, agent: AgentNode) => {
    const viewportBounds = containerRef.current?.getBoundingClientRect();
    if (!viewportBounds) return;
    const roleBounds = element.getBoundingClientRect();
    const width = 260;
    const height = 68;
    const x = Math.max(12, Math.min(viewportBounds.width - width - 12, roleBounds.left - viewportBounds.left));
    const below = roleBounds.bottom - viewportBounds.top + 8;
    const y = below + height <= viewportBounds.height - 12
      ? below
      : Math.max(12, roleBounds.top - viewportBounds.top - height - 8);
    setRoleTooltip({
      role: agent.role ?? "agent",
      description: roleDescription(agent.role),
      x,
      y,
    });
  };
  const showRoleTooltipFromNode = (event: React.FocusEvent<HTMLButtonElement>, agent: AgentNode) => {
    const label = event.currentTarget.querySelector<HTMLElement>(".agent-node__role");
    if (label) showRoleTooltip(label, agent);
  };
  const handleViewportKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const current = view.current;
    const step = event.shiftKey ? 80 : 32;
    if (event.key === "+" || event.key === "=") zoomAt(1.15);
    else if (event.key === "-") zoomAt(0.85);
    else if (event.key === "0") fit();
    else if (event.key === "ArrowLeft") applyView({ ...current, x: current.x + step });
    else if (event.key === "ArrowRight") applyView({ ...current, x: current.x - step });
    else if (event.key === "ArrowUp") applyView({ ...current, y: current.y + step });
    else if (event.key === "ArrowDown") applyView({ ...current, y: current.y - step });
    else return;
    event.preventDefault();
  };

  return (
    <section className="graph panel" aria-labelledby="graph-heading">
      <div className="panel__heading graph__heading">
        <div>
          <h2 id="graph-heading">Agent graph</h2>
          <span className="panel__subtle">Session topology · live</span>
        </div>
        <div className="graph-controls" aria-label="Graph controls">
          <button onClick={() => zoomAt(0.85)} aria-label="Zoom out">−</button>
          <span className="graph-controls__scale" aria-label={`Zoom ${scalePercent}%`}>{scalePercent}%</span>
          <button onClick={() => zoomAt(1.15)} aria-label="Zoom in">+</button>
          <button onClick={fit} title="Fit graph to viewport (0)">Fit</button>
        </div>
      </div>
      <div
        className="graph__viewport"
        ref={containerRef}
        tabIndex={0}
        aria-label="Interactive agent graph. Drag or scroll to move, and pinch or Control plus scroll to zoom."
        onPointerDown={beginPan}
        onPointerMove={pan}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onKeyDown={handleViewportKeyDown}
      >
        <div
          className="graph__canvas"
          ref={canvasRef}
          style={{
            width: `${layout.width}px`,
            height: `${layout.height}px`,
            transform: "translate3d(0, 0, 0) scale(1)",
          }}
        >
          <svg className="graph__edges" width={layout.width} height={layout.height} aria-hidden="true">
            {snapshot.edges.map((edge) => {
              const source = layout.positions[edge.source];
              const target = layout.positions[edge.target];
              if (!source || !target) return null;
              const x1 = source.x + GRAPH_NODE_WIDTH / 2;
              const y1 = source.y + GRAPH_NODE_HEIGHT;
              const x2 = target.x + GRAPH_NODE_WIDTH / 2;
              const y2 = target.y;
              const branchY = y1 + 18;
              const approachY = y2 - 18;
              const gutterX = target.x - 16;
              return (
                <path
                  key={edge.id}
                  d={`M ${x1} ${y1} V ${branchY} H ${gutterX} V ${approachY} H ${x2} V ${y2}`}
                  data-active={edge.target === selectedId || edge.source === selectedId || undefined}
                />
              );
            })}
          </svg>
          {Object.values(snapshot.agents).map((agent) => {
            const position = layout.positions[agent.id];
            if (!position) return null;
            const activity = agent.currentActivityId
              ? activitiesById.get(agent.currentActivityId)
              : undefined;
            return (
              <button
                className={`agent-node agent-node--${agent.status}${agent.children.length > 0 ? " agent-node--parent" : ""}`}
                data-selected={selectedId === agent.id || undefined}
                style={{
                  transform: `translate(${position.x}px, ${position.y}px)`,
                  "--agent-role-color": roleColor(agent.role),
                } as CSSProperties}
                key={agent.id}
                onClick={() => onSelect(agent.id)}
                onFocus={(event) => showRoleTooltipFromNode(event, agent)}
                onBlur={() => setRoleTooltip(undefined)}
                aria-label={`${agent.nickname ?? agent.role ?? agent.id}, ${STATUS[agent.status].label}. Role ${agent.role ?? "agent"}: ${roleDescription(agent.role)}${agent.children.length > 0 ? ` Parent of ${agent.children.length} agents.` : ""}`}
                aria-pressed={selectedId === agent.id}
              >
                <span className="agent-node__topline">
                  <span
                    className="agent-node__role"
                    onMouseEnter={(event: ReactMouseEvent<HTMLSpanElement>) => showRoleTooltip(event.currentTarget, agent)}
                    onMouseLeave={() => setRoleTooltip(undefined)}
                  >
                    {agent.role ?? "agent"}
                  </span>
                  <span className="agent-node__signals">
                    {(agent.observedSkills?.length ?? 0) > 0 && <span title={`${agent.observedSkills?.length} observed skill(s)`}>S{agent.observedSkills?.length}</span>}
                    {(agent.observedWorkflows?.length ?? 0) > 0 && <span title={`${agent.observedWorkflows?.length} observed workflow(s)`}>W{agent.observedWorkflows?.length}</span>}
                    {agent.children.length > 0 && (
                      <span className="agent-node__children" title={`${agent.children.length} direct child agents`} aria-label={`${agent.children.length} child agents`}>
                        <span aria-hidden="true">↳</span>{agent.children.length}
                      </span>
                    )}
                    <span className="agent-node__depth">L{agent.depth ?? 0}</span>
                  </span>
                </span>
                <strong>{agent.nickname ?? shortId(agent.id)}</strong>
                <StatusBadge agent={agent} />
                {agentRuntimeLabel(agent) && (
                  <span className="agent-node__runtime" title={agentRuntimeLabel(agent)}>{agentRuntimeLabel(agent)}</span>
                )}
                <span className="agent-node__activity">{activity?.title ?? (agent.status === "idle" ? "Ready" : "No current activity")}</span>
              </button>
            );
          })}
        </div>
        {Object.keys(snapshot.agents).length === 0 && (
          <div className="graph__empty">
            <span>Waiting for thread discovery</span>
            <small>Agent nodes appear as App Server events arrive.</small>
          </div>
        )}
        {Object.keys(snapshot.agents).length > 0 && (
          <div className="graph__hint" aria-hidden="true">Drag or scroll to move · Pinch or Ctrl-scroll to zoom</div>
        )}
        {roleTooltip && (
          <div
            className="role-tooltip"
            role="tooltip"
            style={{ left: `${roleTooltip.x}px`, top: `${roleTooltip.y}px` }}
          >
            <strong>{roleTooltip.role}</strong>
            <span>{roleTooltip.description}</span>
          </div>
        )}
      </div>
    </section>
  );
});

function filterKinds(filter: TimelineFilter, kind: ActivityKind): boolean {
  if (filter === "all") return true;
  if (filter === "agent") return kind === "message" || kind === "thinking";
  if (filter === "tool") return kind === "tool" || kind === "approval";
  if (filter === "file") return kind === "read" || kind === "write";
  if (filter === "command") return kind === "command" || kind === "test";
  return kind === "error";
}

const TIMELINE_ITEM_HEIGHT = 64;
const TIMELINE_OVERSCAN = 6;

export function ActivityTimeline({ snapshot }: { snapshot: ObservatorySnapshot }) {
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });
  const listRef = useRef<HTMLOListElement>(null);
  const previousFirstActivityId = useRef<string | undefined>(undefined);
  const activities = useMemo(
    () => snapshot.activities.filter((activity) => filterKinds(filter, activity.kind)),
    [filter, snapshot.activities],
  );
  const firstIndex = Math.max(0, Math.floor(viewport.scrollTop / TIMELINE_ITEM_HEIGHT) - TIMELINE_OVERSCAN);
  const lastIndex = Math.min(
    activities.length,
    Math.ceil((viewport.scrollTop + viewport.height) / TIMELINE_ITEM_HEIGHT) + TIMELINE_OVERSCAN + 1,
  );
  const visibleActivities = activities.slice(firstIndex, lastIndex);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      setViewport((current) => {
        const height = list.clientHeight;
        return current.height === height ? current : { ...current, height };
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const list = listRef.current;
    const previousId = previousFirstActivityId.current;
    if (list && previousId && list.scrollTop > 0) {
      const previousIndex = activities.findIndex((activity) => activity.id === previousId);
      if (previousIndex > 0) {
        list.scrollTop += previousIndex * TIMELINE_ITEM_HEIGHT;
        setViewport({ scrollTop: list.scrollTop, height: list.clientHeight });
      }
    }
    previousFirstActivityId.current = activities[0]?.id;
  }, [activities]);

  const selectFilter = (nextFilter: TimelineFilter) => {
    setFilter(nextFilter);
    if (listRef.current) listRef.current.scrollTop = 0;
    setViewport((current) => ({ ...current, scrollTop: 0 }));
  };
  return (
    <div className="timeline">
      <div className="filter-tabs" aria-label="Activity filters">
        {(["all", "agent", "tool", "file", "command", "error"] as const).map((option) => (
          <button key={option} data-active={filter === option || undefined} onClick={() => selectFilter(option)}>
            {option[0]?.toUpperCase()}{option.slice(1)}
          </button>
        ))}
      </div>
      <ol
        className="timeline__list"
        ref={listRef}
        aria-label={`Recent activity, ${activities.length} events`}
        onScroll={(event) => setViewport({
          scrollTop: event.currentTarget.scrollTop,
          height: event.currentTarget.clientHeight,
        })}
      >
        {activities.length > 0 && (
          <li
            className="timeline__sizer"
            style={{ height: `${activities.length * TIMELINE_ITEM_HEIGHT + 8}px` }}
            aria-hidden="true"
          />
        )}
        {visibleActivities.map((activity, windowIndex) => {
          const agent = snapshot.agents[activity.agentId];
          const activityIndex = firstIndex + windowIndex;
          return (
            <li
              key={activity.id}
              className={`timeline-item timeline-item--${activity.kind}`}
              style={{ transform: `translateY(${activityIndex * TIMELINE_ITEM_HEIGHT + 4}px)` }}
              aria-posinset={activityIndex + 1}
              aria-setsize={activities.length}
            >
              <time dateTime={new Date(activity.startedAt).toISOString()}>{formatTime(activity.startedAt)}</time>
              <span className="timeline-item__rail" aria-hidden="true" />
              <div>
                <span className="timeline-item__agent">{agent?.nickname ?? agent?.role ?? shortId(activity.agentId)}</span>
                <strong>{activity.title}</strong>
                {activity.detail && <p>{activity.detail}</p>}
              </div>
            </li>
          );
        })}
        {activities.length === 0 && <li className="timeline__empty">No matching activity.</li>}
      </ol>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="detail-row"><dt>{label}</dt><dd>{children}</dd></div>;
}

const RECENT_ACTIVITY_ITEM_HEIGHT = 32;
const RECENT_ACTIVITY_MAX_HEIGHT = 224;
const RECENT_ACTIVITY_OVERSCAN = 4;

export function RecentActivityList({ activities }: { activities: AgentActivity[] }) {
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });
  const listRef = useRef<HTMLOListElement>(null);
  const firstIndex = Math.max(
    0,
    Math.floor(viewport.scrollTop / RECENT_ACTIVITY_ITEM_HEIGHT) - RECENT_ACTIVITY_OVERSCAN,
  );
  const lastIndex = Math.min(
    activities.length,
    Math.ceil((viewport.scrollTop + viewport.height) / RECENT_ACTIVITY_ITEM_HEIGHT)
      + RECENT_ACTIVITY_OVERSCAN
      + 1,
  );
  const visibleActivities = activities.slice(firstIndex, lastIndex);
  const listHeight = Math.min(
    RECENT_ACTIVITY_MAX_HEIGHT,
    Math.max(1, activities.length) * RECENT_ACTIVITY_ITEM_HEIGHT,
  );

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      setViewport((current) => {
        const height = list.clientHeight;
        return current.height === height ? current : { ...current, height };
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  return (
    <ol
      className="inspector__recent-list"
      ref={listRef}
      aria-label={`Recent activity, ${activities.length} events`}
      style={{ height: `${listHeight}px` }}
      onScroll={(event) => setViewport({
        scrollTop: event.currentTarget.scrollTop,
        height: event.currentTarget.clientHeight,
      })}
    >
      {activities.length > 0 && (
        <li
          className="inspector__recent-sizer"
          style={{ height: `${activities.length * RECENT_ACTIVITY_ITEM_HEIGHT}px` }}
          aria-hidden="true"
        />
      )}
      {visibleActivities.map((activity, windowIndex) => {
        const activityIndex = firstIndex + windowIndex;
        return (
          <li
            className="inspector__recent-item"
            key={activity.id}
            style={{ transform: `translateY(${activityIndex * RECENT_ACTIVITY_ITEM_HEIGHT}px)` }}
            aria-posinset={activityIndex + 1}
            aria-setsize={activities.length}
          >
            <time dateTime={new Date(activity.startedAt).toISOString()}>{formatTime(activity.startedAt)}</time>
            <span>{activity.title}</span>
          </li>
        );
      })}
      {activities.length === 0 && <li className="inspector__none">No activity recorded.</li>}
    </ol>
  );
}

function Inspector({ agent, snapshot, now }: { agent: AgentNode; snapshot: ObservatorySnapshot; now: number }) {
  const activitiesById = useMemo(
    () => new Map(snapshot.activities.map((activity) => [activity.id, activity])),
    [snapshot.activities],
  );
  const current = agent.currentActivityId
    ? activitiesById.get(agent.currentActivityId)
    : undefined;
  const recent = agent.recentActivityIds
    .map((id) => activitiesById.get(id))
    .filter((activity): activity is AgentActivity => Boolean(activity));
  return (
    <div className="inspector">
      <div className="inspector__identity">
        <span className="eyebrow">{agent.role ?? "agent"}</span>
        <h3>{agent.nickname ?? shortId(agent.id)}</h3>
        <StatusBadge agent={agent} />
      </div>
      <dl className="details">
        <DetailRow label="Runtime">{formatDuration(now - (agent.startedAt ?? snapshot.startedAt))}</DetailRow>
        <DetailRow label="Current activity">{current?.title ?? "—"}</DetailRow>
        {agent.model && <DetailRow label="Model">{agent.model}</DetailRow>}
        {agent.reasoningEffort && <DetailRow label="Effort">{agent.reasoningEffort}</DetailRow>}
        {agent.collaborationMode && <DetailRow label="Mode">{agent.collaborationMode}</DetailRow>}
        {(agent.observedSkills?.length ?? 0) > 0 && (
          <DetailRow label="Skills"><span className="context-tags">{agent.observedSkills?.map((skill) => <span key={skill}>{skill}</span>)}</span></DetailRow>
        )}
        {(agent.observedWorkflows?.length ?? 0) > 0 && (
          <DetailRow label="Workflows"><span className="context-tags">{agent.observedWorkflows?.map((workflow) => <span key={workflow}>{workflow}</span>)}</span></DetailRow>
        )}
        <DetailRow label="Thread"><code title={agent.threadId}>{shortId(agent.threadId)}</code></DetailRow>
        {agent.cwd && <DetailRow label="Working directory"><code title={agent.cwd}>{agent.cwd}</code></DetailRow>}
        {agent.tokenUsage?.totalTokens !== undefined && (
          <DetailRow label="Tokens">{agent.tokenUsage.totalTokens.toLocaleString()}</DetailRow>
        )}
      </dl>
      <div className="inspector__recent">
        <div className="inspector__recent-heading">
          <h4>Recent activity</h4>
          <span>{recent.length}</span>
        </div>
        <RecentActivityList key={agent.id} activities={recent} />
      </div>
    </div>
  );
}

export function RightRail({
  snapshot,
  selectedId,
  onClear,
  now,
}: {
  snapshot: ObservatorySnapshot;
  selectedId?: string;
  onClear(): void;
  now: number;
}) {
  const [tab, setTab] = useState<"activity" | "inspector">("activity");
  const agent = selectedId ? snapshot.agents[selectedId] : undefined;
  useEffect(() => { if (agent) setTab("inspector"); }, [agent?.id]);
  return (
    <aside className="right-rail panel" aria-label="Activity and agent inspector">
      <div className="rail-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "activity"} onClick={() => setTab("activity")}>Activity</button>
        <button role="tab" aria-selected={tab === "inspector"} disabled={!agent} onClick={() => setTab("inspector")}>Inspector</button>
        {agent && <button className="rail-tabs__close" onClick={onClear} aria-label="Close inspector">×</button>}
      </div>
      {tab === "inspector" && agent ? <Inspector agent={agent} snapshot={snapshot} now={now} /> : <ActivityTimeline snapshot={snapshot} />}
    </aside>
  );
}

function Connection({ snapshot }: { snapshot: ObservatorySnapshot }) {
  const phase = snapshot.connection.phase;
  const symbol = phase === "connected" ? "●" : phase === "disconnected" ? "!" : "○";
  const label = phase[0]?.toUpperCase() + phase.slice(1);
  return (
    <div className={`connection connection--${phase}`} role="status" aria-live="polite">
      <span aria-hidden="true">{symbol}</span>
      <strong>{label}</strong>
      {phase === "disconnected" && <button onClick={() => uiStore.retry()}>Retry</button>}
    </div>
  );
}

function DebugPanel({ snapshot, onClose }: { snapshot: ObservatorySnapshot; onClose(): void }) {
  return (
    <div className="debug-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="debug-panel" role="dialog" aria-modal="true" aria-labelledby="debug-heading">
        <div className="debug-panel__heading">
          <div>
            <span className="eyebrow">Diagnostics</span>
            <h2 id="debug-heading">Protocol debug</h2>
          </div>
          <button onClick={onClose} aria-label="Close debug panel">×</button>
        </div>
        <dl className="debug-meta">
          <DetailRow label="Adapter">{snapshot.runtime.adapter}</DetailRow>
          <DetailRow label="Codex">{snapshot.runtime.codexCliVersion ?? "mock"}</DetailRow>
          <DetailRow label="Protocol">{snapshot.runtime.protocolGenerationVersion ?? "unknown"}</DetailRow>
          <DetailRow label="Discovery">{snapshot.runtime.discoveryStrategy}</DetailRow>
          <DetailRow label="Experimental">{snapshot.runtime.experimentalApi ? "enabled" : "disabled"}</DetailRow>
        </dl>
        <ol className="debug-log">
          {snapshot.debug.map((entry) => (
            <li key={entry.id}>
              <time>{formatTime(entry.at)}</time>
              <span className={`debug-log__direction debug-log__direction--${entry.direction}`}>{entry.direction}</span>
              <span>{entry.method ?? entry.category}</span>
              <strong>{entry.summary}</strong>
            </li>
          ))}
          {snapshot.debug.length === 0 && <li className="debug-log__empty">No protocol events in mock mode.</li>}
        </ol>
      </section>
    </div>
  );
}

export function App() {
  const snapshot = useSyncExternalStore(uiStore.subscribe, uiStore.getSnapshot);
  const now = useNow();
  const [selectedId, setSelectedId] = useState<string>();
  const [debugOpen, setDebugOpen] = useState(false);
  const [visualization, setVisualization] = useState<"graph" | "workflow">("graph");
  useEffect(() => uiStore.start(), []);
  useEffect(() => {
    if (selectedId && !snapshot.agents[selectedId]) setSelectedId(undefined);
  }, [selectedId, snapshot.agents]);

  const agents = Object.values(snapshot.agents);
  const counts = {
    working: agents.filter((agent) => agent.status === "working").length,
    waiting: agents.filter((agent) => agent.status === "waiting").length,
    completed: agents.filter((agent) => agent.status === "completed").length,
    failed: agents.filter((agent) => agent.status === "failed").length,
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">⌁</span>
          <div>
            <h1>Codex Observatory</h1>
            <span>{snapshot.runtime.adapter === "mock" ? `Mock · ${snapshot.runtime.scenario?.toUpperCase() ?? "A"}` : "Local App Server"}</span>
          </div>
        </div>
        <div className="metrics" aria-label="Run summary">
          <div className="metric metric--agents"><span>Agents</span><strong>{agents.length}</strong></div>
          <div className="metric metric--working"><span>Working</span><strong>{counts.working}</strong></div>
          <div className="metric metric--waiting"><span>Waiting</span><strong>{counts.waiting}</strong></div>
          <div className="metric metric--completed"><span>Completed</span><strong>{counts.completed}</strong></div>
          <div className="metric metric--runtime"><span>Runtime</span><strong>{formatDuration(now - snapshot.startedAt)}</strong></div>
        </div>
        <div className="topbar__actions">
          <button className="debug-button" onClick={() => setDebugOpen(true)}>Debug</button>
          <Connection snapshot={snapshot} />
        </div>
      </header>

      {snapshot.connection.phase !== "connected" && (
        <div className={`connection-banner connection-banner--${snapshot.connection.phase}`}>
          <span>{snapshot.connection.message ?? "Connection unavailable"}</span>
          {snapshot.connection.phase === "reconnecting" && <small>Attempt {snapshot.connection.attempt}</small>}
          {snapshot.connection.phase === "disconnected" && <button onClick={() => uiStore.retry()}>Retry connection</button>}
        </div>
      )}

      <main className="workspace">
        <AgentList snapshot={snapshot} selectedId={selectedId} onSelect={setSelectedId} />
        <div className="visualization">
          <div className="visualization-tabs" role="group" aria-label="Agent visualization">
            <button aria-pressed={visualization === "graph"} onClick={() => setVisualization("graph")}>Graph</button>
            <button aria-pressed={visualization === "workflow"} onClick={() => setVisualization("workflow")}>Workflows</button>
          </div>
          {visualization === "graph"
            ? <AgentGraph snapshot={snapshot} selectedId={selectedId} onSelect={setSelectedId} />
            : <WorkflowBoard snapshot={snapshot} selectedId={selectedId} onSelect={setSelectedId} />}
        </div>
        <RightRail snapshot={snapshot} selectedId={selectedId} onClear={() => setSelectedId(undefined)} now={now} />
      </main>

      <footer className="runbar">
        <span className="runbar__label">Run summary</span>
        <span><i className="dot dot--working" /> Active {counts.working}</span>
        <span><i className="dot dot--waiting" /> Waiting {counts.waiting}</span>
        <span><i className="dot dot--completed" /> Done {counts.completed}</span>
        {counts.failed > 0 && <span><i className="dot dot--failed" /> Failed {counts.failed}</span>}
        <span className="runbar__version">Codex {snapshot.runtime.codexCliVersion ?? snapshot.runtime.protocolGenerationVersion ?? "mock"} · Observatory {snapshot.runtime.observatoryVersion}</span>
      </footer>
      {debugOpen && <DebugPanel snapshot={snapshot} onClose={() => setDebugOpen(false)} />}
    </div>
  );
}
