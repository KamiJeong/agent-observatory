import { useMemo, useState, type CSSProperties } from "react";
import type { AgentNode, ObservatorySnapshot } from "@observatory/core";
import {
  agentContextLabel,
  agentContextSummary,
  agentProvider,
  agentRuntimeLabel,
  ProviderBadge,
  roleColor,
  shortId,
  StatusBadge,
  type AgentContextFilter,
} from "../shared/presentation.tsx";

export function AgentList({
  snapshot,
  selectedId,
  onSelect,
  collapsed = false,
  onToggleCollapse,
}: {
  snapshot: ObservatorySnapshot;
  selectedId?: string;
  onSelect(id: string): void;
  collapsed?: boolean;
  onToggleCollapse?(): void;
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
    <aside className="agent-list panel" aria-labelledby="agents-heading" data-collapsed={collapsed || undefined}>
      <div className="panel__heading agent-list__heading">
        <h2 id="agents-heading">Agents</h2>
        <div className="panel__heading-actions">
          {!collapsed && <span className="panel__count">{visibleAgents.length}{countIsReduced ? `/${agents.length}` : ""}</span>}
          {onToggleCollapse && (
            <button
              className="panel-collapse-toggle panel-collapse-toggle--left"
              type="button"
              aria-expanded={!collapsed}
              aria-controls="agent-list-panel-content"
              aria-label={`${collapsed ? "Expand" : "Collapse"} agents panel`}
              title={`${collapsed ? "Expand" : "Collapse"} agents panel`}
              onClick={onToggleCollapse}
            >
              <span aria-hidden="true">{collapsed ? "›" : "‹"}</span>
            </button>
          )}
        </div>
      </div>
      <div id="agent-list-panel-content" className="agent-list__content" hidden={collapsed}>
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
                    <ProviderBadge provider={agentProvider(agent, snapshot.runtime.adapter)} />
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
      </div>
    </aside>
  );
}
