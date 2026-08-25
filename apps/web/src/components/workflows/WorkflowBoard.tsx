import { useMemo, useState, type CSSProperties } from "react";
import type { AgentNode, AgentRuntimeStatus, ObservatorySnapshot } from "@observatory/core";
import {
  agentRuntimeLabel,
  formatTime,
  roleColor,
  shortId,
  STATUS,
  StatusBadge,
} from "../shared/presentation.tsx";

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
