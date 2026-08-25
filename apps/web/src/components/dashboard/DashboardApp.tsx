import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AgentNode, AgentRuntimeStatus, HistoryActor, ObservatorySnapshot } from "@observatory/core";
import { uiStore } from "../../ui-store.ts";
import { DetailRow, RightRail } from "../activity/ActivityPanel.tsx";
import { AgentGraph } from "../agents/AgentGraph.tsx";
import { AgentList } from "../agents/AgentList.tsx";
import {
  agentProvider,
  formatDuration,
  formatTime,
  normalizeProvider,
  providerLabel,
  shortId,
  useNow,
} from "../shared/presentation.tsx";
import { WorkflowBoard } from "../workflows/WorkflowBoard.tsx";
import {
  buildProviderGuidance,
  NoFilterMatches,
  ProviderOnboarding,
  type ProviderHealth,
  type ProviderPhase,
} from "./ProviderOnboarding.tsx";

type StatusFilter = "all" | "live" | AgentRuntimeStatus;

export interface DashboardFilterState {
  provider: string;
  workspace: string;
  session: string;
  status: StatusFilter;
  query: string;
}

export const INITIAL_DASHBOARD_FILTERS: DashboardFilterState = {
  provider: "all",
  workspace: "all",
  session: "all",
  status: "all",
  query: "",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof record[key] === "string") return record[key];
  return undefined;
}

function numberValue(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) if (typeof record[key] === "number") return record[key];
  return undefined;
}

function providerPhase(record: Record<string, unknown>): ProviderPhase {
  if (record.setupRequired === true || record.configured === false) return "setup-required";
  const message = stringValue(record, "message", "detail", "reason")?.toLowerCase();
  if (message && /(unsupported|upgrade required|version.*(?:too old|minimum|required)|not supported)/.test(message)) return "unsupported";
  if (message && /(permission|eacces|access denied|forbidden|not permitted)/.test(message)) return "permission-blocked";
  if (message && /(setup required|not configured|configure .*hook|missing hook)/.test(message)) return "setup-required";
  const value = stringValue(record, "phase", "status", "health", "state")?.toLowerCase().replaceAll("_", "-");
  if (!value) return "unknown";
  if (["ready", "healthy", "connected", "active", "detected"].includes(value)) return "ready";
  if (["connecting", "discovering", "starting"].includes(value)) return "discovering";
  if (["setup-required", "not-configured", "missing"].includes(value)) return "setup-required";
  if (["unsupported", "upgrade-required", "version-unsupported"].includes(value)) return "unsupported";
  if (["permission-blocked", "permission-denied", "forbidden"].includes(value)) return "permission-blocked";
  if (["error", "failed", "unhealthy"].includes(value)) return "error";
  if (["offline", "disconnected", "unavailable", "disabled"].includes(value)) return "offline";
  return "unknown";
}

function runtimeProviderEntries(snapshot: ObservatorySnapshot): unknown[] {
  const providers = (snapshot.runtime as unknown as Record<string, unknown>).providers;
  if (Array.isArray(providers)) return providers;
  if (isRecord(providers)) {
    return Object.entries(providers).map(([provider, value]) => isRecord(value) ? { provider, ...value } : { provider, status: value });
  }
  return [];
}

export function getProviderHealth(snapshot: ObservatorySnapshot): ProviderHealth[] {
  const fallback = snapshot.runtime.adapter;
  const agents = Object.values(snapshot.agents);
  const health = new Map<string, ProviderHealth>();

  for (const entry of runtimeProviderEntries(snapshot)) {
    const record = isRecord(entry) ? entry : { provider: entry };
    const provider = normalizeProvider(stringValue(record, "provider", "id", "name"));
    if (!provider) continue;
    const connection = isRecord(record.connection) ? record.connection : record;
    health.set(provider, {
      provider,
      phase: providerPhase(connection),
      message: stringValue(connection, "message", "detail", "reason"),
      lastUpdatedAt: numberValue(record, "lastUpdatedAt", "lastSeenAt", "updatedAt"),
      agentCount: 0,
    });
  }

  const providerConnections = (snapshot as unknown as { providerConnections?: Record<string, unknown> }).providerConnections ?? {};
  for (const [providerName, connectionValue] of Object.entries(providerConnections)) {
    if (!isRecord(connectionValue)) continue;
    const provider = normalizeProvider(providerName);
    if (!provider) continue;
    const current = health.get(provider) ?? { provider, phase: "unknown" as const, agentCount: 0 };
    health.set(provider, {
      ...current,
      phase: providerPhase(connectionValue),
      message: stringValue(connectionValue, "message", "detail", "reason") ?? current.message,
    });
  }

  for (const agent of agents) {
    const provider = agentProvider(agent, fallback);
    const current = health.get(provider) ?? { provider, phase: "ready" as const, agentCount: 0 };
    const lastUpdatedAt = Math.max(current.lastUpdatedAt ?? 0, agent.updatedAt ?? agent.startedAt ?? 0) || undefined;
    health.set(provider, {
      ...current,
      phase: current.phase === "unknown" && !(provider in providerConnections) ? "ready" : current.phase,
      agentCount: current.agentCount + 1,
      lastUpdatedAt,
    });
  }

  if (health.size === 0) {
    const provider = normalizeProvider(fallback) ?? "unknown";
    health.set(provider, { provider, phase: "unknown", agentCount: 0 });
  }

  return [...health.values()].sort((a, b) => {
    const order = ["codex", "claude", "mock", "unknown"];
    const aIndex = order.indexOf(a.provider);
    const bIndex = order.indexOf(b.provider);
    return (aIndex < 0 ? order.length : aIndex) - (bIndex < 0 ? order.length : bIndex)
      || a.provider.localeCompare(b.provider);
  });
}

function matchesStatus(status: AgentRuntimeStatus, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "live") return !["completed", "failed"].includes(status);
  return status === filter;
}

function agentSearchText(agent: AgentNode): string {
  return [
    agent.id,
    agent.threadId,
    agent.sessionId,
    agent.nickname,
    agent.role,
    agent.cwd,
    agent.model,
    agent.modelProvider,
    agent.reasoningEffort,
    ...(agent.observedSkills ?? []),
    ...(agent.observedWorkflows ?? []),
  ].filter(Boolean).join(" ").toLowerCase();
}

function actorAgentId(actor: HistoryActor): string | undefined {
  return actor.type === "agent" ? actor.id : undefined;
}

export function filterSnapshot(snapshot: ObservatorySnapshot, filters: DashboardFilterState): ObservatorySnapshot {
  const fallback = snapshot.runtime.adapter;
  const query = filters.query.trim().toLowerCase();
  const matchingActivityAgents = new Set(snapshot.activities
    .filter((activity) => !query || [activity.kind, activity.title, activity.detail].filter(Boolean).join(" ").toLowerCase().includes(query))
    .map((activity) => activity.agentId));

  const agents = Object.fromEntries(Object.values(snapshot.agents)
    .filter((agent) => filters.provider === "all" || agentProvider(agent, fallback) === filters.provider)
    .filter((agent) => filters.workspace === "all" || agent.cwd === filters.workspace)
    .filter((agent) => filters.session === "all" || agent.sessionId === filters.session)
    .filter((agent) => matchesStatus(agent.status, filters.status))
    .filter((agent) => !query || agentSearchText(agent).includes(query) || matchingActivityAgents.has(agent.id))
    .map((agent) => [agent.id, agent]));
  const visibleIds = new Set(Object.keys(agents));
  const filteredAgents = Object.fromEntries(Object.values(agents).map((agent) => [agent.id, {
    ...agent,
    children: agent.children.filter((id) => visibleIds.has(id)),
  }]));
  const activities = snapshot.activities.filter((activity) => {
    if (!visibleIds.has(activity.agentId)) return false;
    if (!query || agentSearchText(snapshot.agents[activity.agentId]!).includes(query)) return true;
    return [activity.kind, activity.title, activity.detail].filter(Boolean).join(" ").toLowerCase().includes(query);
  });
  const filtering = filters.provider !== "all"
    || filters.workspace !== "all"
    || filters.session !== "all"
    || filters.status !== "all"
    || Boolean(query);
  const history = filtering ? snapshot.history.filter((event) => {
    const actorId = actorAgentId(event.actor);
    const recipientIds = event.recipients?.map(actorAgentId).filter((id): id is string => Boolean(id)) ?? [];
    const belongsToVisibleAgent = Boolean(actorId && visibleIds.has(actorId)) || recipientIds.some((id) => visibleIds.has(id));
    const matchesQuery = query && [event.kind, event.summary, event.content].filter(Boolean).join(" ").toLowerCase().includes(query);
    return belongsToVisibleAgent || Boolean(matchesQuery);
  }) : snapshot.history;

  return {
    ...snapshot,
    agents: filteredAgents,
    activities,
    history,
    pendingRequests: Object.fromEntries(Object.entries(snapshot.pendingRequests)
      .filter(([, request]) => visibleIds.has(request.agentId))),
    roots: Object.values(filteredAgents)
      .filter((agent) => !agent.parentId || !visibleIds.has(agent.parentId))
      .map((agent) => agent.id),
    edges: snapshot.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)),
  };
}

function Connection({ snapshot }: { snapshot: ObservatorySnapshot }) {
  const phase = snapshot.connection.phase;
  const symbol = phase === "connected" ? "●" : phase === "disconnected" ? "!" : "○";
  const label = phase[0]?.toUpperCase() + phase.slice(1);
  return (
    <div className={`connection connection--${phase}`} role="status" aria-live="polite" aria-label={`Dashboard transport: ${label}`}>
      <span aria-hidden="true">{symbol}</span>
      <strong>Transport {label}</strong>
      {phase === "disconnected" && <button onClick={() => uiStore.retry()}>Retry</button>}
    </div>
  );
}

function ProviderHealthStrip({ snapshot }: { snapshot: ObservatorySnapshot }) {
  const providers = getProviderHealth(snapshot);
  return (
    <section className="provider-health" aria-label="Provider health">
      <span className="provider-health__label">Providers</span>
      <div className="provider-health__items">
        {providers.map((provider) => {
          const guidance = buildProviderGuidance(provider);
          return (
            <div className={`provider-health__item provider-health__item--${provider.phase}`} key={provider.provider} role="status">
              <span className="provider-health__dot" aria-hidden="true" />
              <strong>{providerLabel(provider.provider)}</strong>
              <span>{provider.phase.replace("-", " ")}</span>
              <span>{provider.agentCount} agent{provider.agentCount === 1 ? "" : "s"}</span>
              {provider.lastUpdatedAt && <time dateTime={new Date(provider.lastUpdatedAt).toISOString()}>Updated {formatTime(provider.lastUpdatedAt)}</time>}
              <small title={guidance.description}>{guidance.title}</small>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function DebugPanel({ snapshot, onClose }: { snapshot: ObservatorySnapshot; onClose(): void }) {
  const providers = getProviderHealth(snapshot);
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const panel = panelRef.current;
    const focusable = () => [...(panel?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? [])];
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        panel?.focus();
        return;
      }
      const first = items[0]!;
      const last = items.at(-1)!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    closeButtonRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  return (
    <div className="debug-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={panelRef} className="debug-panel" role="dialog" aria-modal="true" aria-labelledby="debug-heading" tabIndex={-1}>
        <div className="debug-panel__heading">
          <div>
            <span className="eyebrow">Diagnostics</span>
            <h2 id="debug-heading">Runtime debug</h2>
          </div>
          <button ref={closeButtonRef} onClick={onClose} aria-label="Close debug panel">×</button>
        </div>
        <dl className="debug-meta">
          <DetailRow label="Adapter">{snapshot.runtime.adapter}</DetailRow>
          <DetailRow label="Providers">{providers.map((provider) => providerLabel(provider.provider)).join(", ")}</DetailRow>
          {snapshot.runtime.codexCliVersion && <DetailRow label="Codex CLI">{snapshot.runtime.codexCliVersion}</DetailRow>}
          {snapshot.runtime.claudeCliVersion && <DetailRow label="Claude CLI">{snapshot.runtime.claudeCliVersion}</DetailRow>}
          {snapshot.runtime.contentCapture && <DetailRow label="Content">{snapshot.runtime.contentCapture}</DetailRow>}
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
          {snapshot.debug.length === 0 && <li className="debug-log__empty">No diagnostic events recorded.</li>}
        </ol>
      </section>
    </div>
  );
}

export function DashboardFilters({
  snapshot,
  filters,
  onChange,
}: {
  snapshot: ObservatorySnapshot;
  filters: DashboardFilterState;
  onChange(filters: DashboardFilterState): void;
}) {
  const agents = Object.values(snapshot.agents);
  const fallback = snapshot.runtime.adapter;
  const providerCounts = new Map<string, number>();
  for (const agent of agents) {
    const provider = agentProvider(agent, fallback);
    providerCounts.set(provider, (providerCounts.get(provider) ?? 0) + 1);
  }
  for (const health of getProviderHealth(snapshot)) if (!providerCounts.has(health.provider)) providerCounts.set(health.provider, 0);
  const providers = ["codex", "claude", ...providerCounts.keys()]
    .filter((provider, index, values) => values.indexOf(provider) === index);
  const workspaces = [...new Set(agents.map((agent) => agent.cwd).filter((value): value is string => Boolean(value)))].sort();
  const sessions = [...new Set(agents.map((agent) => agent.sessionId).filter((value): value is string => Boolean(value)))].sort();
  const sessionLabel = (session: string) => {
    const sessionAgents = agents.filter((agent) => agent.sessionId === session);
    const live = sessionAgents.some((agent) => matchesStatus(agent.status, "live"));
    return `${shortId(session)} · ${live ? "live" : "completed"}`;
  };
  const active = JSON.stringify(filters) !== JSON.stringify(INITIAL_DASHBOARD_FILTERS);
  const set = <Key extends keyof DashboardFilterState>(key: Key, value: DashboardFilterState[Key]) => onChange({ ...filters, [key]: value });

  return (
    <section className="dashboard-filters" aria-label="Dashboard filters">
      <div className="dashboard-filters__providers" role="group" aria-label="Provider">
        <button aria-pressed={filters.provider === "all"} onClick={() => set("provider", "all")}>All <span>{agents.length}</span></button>
        {providers.map((provider) => (
          <button key={provider} aria-pressed={filters.provider === provider} onClick={() => set("provider", provider)}>
            {providerLabel(provider)} <span>{providerCounts.get(provider) ?? 0}</span>
          </button>
        ))}
      </div>
      <label className="dashboard-filters__search">
        <span className="sr-only">Search agents and activity</span>
        <input
          type="search"
          value={filters.query}
          onChange={(event) => set("query", event.currentTarget.value)}
          placeholder="Search agents and activity"
        />
      </label>
      <label>
        <span>Status</span>
        <select aria-label="Status" value={filters.status} onChange={(event) => set("status", event.currentTarget.value as StatusFilter)}>
          <option value="all">All statuses</option>
          <option value="live">Live</option>
          <option value="working">Working</option>
          <option value="waiting">Waiting</option>
          <option value="idle">Idle</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="unknown">Unknown</option>
        </select>
      </label>
      <label>
        <span>Workspace</span>
        <select aria-label="Workspace" value={workspaces.includes(filters.workspace) ? filters.workspace : "all"} onChange={(event) => set("workspace", event.currentTarget.value)}>
          <option value="all">All workspaces</option>
          {workspaces.map((workspace) => <option value={workspace} key={workspace}>{workspace}</option>)}
        </select>
      </label>
      <label>
        <span>Session</span>
        <select aria-label="Session" value={sessions.includes(filters.session) ? filters.session : "all"} onChange={(event) => set("session", event.currentTarget.value)}>
          <option value="all">All sessions</option>
          {sessions.map((session) => <option value={session} key={session}>{sessionLabel(session)}</option>)}
        </select>
      </label>
      <button className="dashboard-filters__clear" disabled={!active} onClick={() => onChange(INITIAL_DASHBOARD_FILTERS)}>Clear</button>
    </section>
  );
}

export function App() {
  const snapshot = useSyncExternalStore(uiStore.subscribe, uiStore.getSnapshot);
  const now = useNow();
  const [selectedId, setSelectedId] = useState<string>();
  const [debugOpen, setDebugOpen] = useState(false);
  const [visualization, setVisualization] = useState<"graph" | "workflow">("graph");
  const [filters, setFilters] = useState<DashboardFilterState>(INITIAL_DASHBOARD_FILTERS);
  const openDebug = useCallback(() => setDebugOpen(true), []);
  const closeDebug = useCallback(() => setDebugOpen(false), []);
  const filteredSnapshot = useMemo(() => filterSnapshot(snapshot, filters), [filters, snapshot]);
  useEffect(() => uiStore.start(), []);
  useEffect(() => {
    if (selectedId && !filteredSnapshot.agents[selectedId]) setSelectedId(undefined);
  }, [filteredSnapshot.agents, selectedId]);

  const agents = Object.values(filteredSnapshot.agents);
  const allAgents = Object.values(snapshot.agents);
  const counts = {
    working: agents.filter((agent) => agent.status === "working").length,
    waiting: agents.filter((agent) => agent.status === "waiting").length,
    completed: agents.filter((agent) => agent.status === "completed").length,
    failed: agents.filter((agent) => agent.status === "failed").length,
  };
  const providerHealth = getProviderHealth(snapshot);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">⌁</span>
          <div>
            <h1>Agent Observatory</h1>
            <span>{snapshot.runtime.adapter === "mock" ? `Mock · ${snapshot.runtime.scenario?.toUpperCase() ?? "A"}` : "Local multi-agent runtime"}</span>
          </div>
        </div>
        <div className="metrics" aria-label="Run summary">
          <div className="metric metric--agents"><span>Agents</span><strong>{agents.length === allAgents.length ? agents.length : `${agents.length}/${allAgents.length}`}</strong></div>
          <div className="metric metric--working"><span>Working</span><strong>{counts.working}</strong></div>
          <div className="metric metric--waiting"><span>Waiting</span><strong>{counts.waiting}</strong></div>
          <div className="metric metric--completed"><span>Completed</span><strong>{counts.completed}</strong></div>
          <div className="metric metric--runtime"><span>Runtime</span><strong>{formatDuration(now - snapshot.startedAt)}</strong></div>
        </div>
        <div className="topbar__actions">
          <button className="debug-button" onClick={openDebug}>Debug</button>
          <Connection snapshot={snapshot} />
        </div>
      </header>

      <ProviderHealthStrip snapshot={snapshot} />

      {snapshot.connection.phase !== "connected" && (
        <div className={`connection-banner connection-banner--${snapshot.connection.phase}`}>
          <strong>Dashboard transport</strong>
          <span>{snapshot.connection.message ?? "Connection unavailable"}</span>
          {snapshot.connection.phase === "reconnecting" && <small>Attempt {snapshot.connection.attempt}</small>}
          {snapshot.connection.phase === "disconnected" && <button onClick={() => uiStore.retry()}>Retry connection</button>}
        </div>
      )}

      <main className="dashboard-main">
        <DashboardFilters snapshot={snapshot} filters={filters} onChange={setFilters} />
        {allAgents.length > 0 && (
          <ProviderOnboarding providers={providerHealth} hasAgentContent onOpenDebug={openDebug} />
        )}
        {allAgents.length === 0 ? (
          <ProviderOnboarding providers={providerHealth} hasAgentContent={false} onOpenDebug={openDebug} />
        ) : agents.length === 0 ? (
          <NoFilterMatches onClear={() => setFilters(INITIAL_DASHBOARD_FILTERS)} />
        ) : (
          <div className="workspace">
            <AgentList snapshot={filteredSnapshot} selectedId={selectedId} onSelect={setSelectedId} />
            <div className="visualization">
              <div className="visualization-tabs" role="group" aria-label="Agent visualization">
                <button aria-pressed={visualization === "graph"} onClick={() => setVisualization("graph")}>Graph</button>
                <button aria-pressed={visualization === "workflow"} onClick={() => setVisualization("workflow")}>Workflows</button>
              </div>
              {visualization === "graph"
                ? <AgentGraph snapshot={filteredSnapshot} selectedId={selectedId} onSelect={setSelectedId} />
                : <WorkflowBoard snapshot={filteredSnapshot} selectedId={selectedId} onSelect={setSelectedId} />}
            </div>
            <RightRail snapshot={filteredSnapshot} selectedId={selectedId} onClear={() => setSelectedId(undefined)} now={now} />
          </div>
        )}
      </main>

      <footer className="runbar">
        <span className="runbar__label">Filtered summary</span>
        <span><i className="dot dot--working" /> Active {counts.working}</span>
        <span><i className="dot dot--waiting" /> Waiting {counts.waiting}</span>
        <span><i className="dot dot--completed" /> Done {counts.completed}</span>
        {counts.failed > 0 && <span><i className="dot dot--failed" /> Failed {counts.failed}</span>}
        <span className="runbar__version">Agent Observatory {snapshot.runtime.observatoryVersion}</span>
      </footer>
      {debugOpen && <DebugPanel snapshot={snapshot} onClose={closeDebug} />}
    </div>
  );
}
