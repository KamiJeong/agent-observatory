import type {
  AgentActivity,
  AgentRuntimeEvent,
  AgentGraphEdge,
  AgentNode,
  AgentRelationKind,
  AgentRuntimeStatus,
  HistoryActor,
  HistoryEvent,
  NativeThreadStatus,
  ObservatorySnapshot,
  ObservatoryState,
  RuntimeInfo,
  RuntimeProvider,
  ThreadSnapshot,
  WaitingReason,
} from "./types.ts";

export const DEFAULT_ACTIVITY_LIMIT = 300;
export const DEFAULT_HISTORY_LIMIT = 500;
export const DEFAULT_DEBUG_LIMIT = 150;
const RECENT_ACTIVITY_LIMIT = 30;

export function projectNativeStatus(status: NativeThreadStatus): {
  status: AgentRuntimeStatus;
  waitingReasons: WaitingReason[];
} {
  switch (status.type) {
    case "active": {
      const waitingReasons: WaitingReason[] = [];
      if (status.activeFlags.includes("waitingOnApproval")) {
        waitingReasons.push("approval");
      }
      if (status.activeFlags.includes("waitingOnUserInput")) {
        waitingReasons.push("userInput");
      }
      return {
        status: waitingReasons.length > 0 ? "waiting" : "working",
        waitingReasons,
      };
    }
    case "idle":
      return { status: "idle", waitingReasons: [] };
    case "systemError":
      return { status: "failed", waitingReasons: [] };
    case "notLoaded":
      return { status: "unknown", waitingReasons: [] };
  }
}

export function createInitialState(runtime: RuntimeInfo, now = Date.now()): ObservatoryState {
  const providerConnections = Object.fromEntries(
    (runtime.providers ?? [])
      .filter((provider) => provider.connection)
      .map((provider) => [provider.provider, provider.connection as NonNullable<typeof provider.connection>]),
  );
  return {
    agents: {},
    activities: [],
    history: [],
    pendingRequests: {},
    connection: { phase: "connecting", attempt: 0 },
    providerConnections,
    runtime,
    debug: [],
    startedAt: now,
    revision: 0,
  };
}

function runtimeProvider(runtime: RuntimeInfo): RuntimeProvider {
  return runtime.provider ?? (runtime.adapter === "composite" ? "unknown" : runtime.adapter);
}

function eventProvider(state: ObservatoryState, event: AgentRuntimeEvent): RuntimeProvider {
  if (event.provider) return event.provider;
  if (event.type === "thread.discovered" && event.thread.provider) return event.thread.provider;
  if (event.type === "activity.started" && event.activity.provider) return event.activity.provider;
  if (event.type === "activity.completed" && event.activity?.provider) return event.activity.provider;
  if (event.type === "history.recorded" && event.history.provider) return event.history.provider;
  if (event.type === "request.opened" && event.request.provider) return event.request.provider;
  if (event.type === "debug" && event.entry.provider) return event.entry.provider;
  return runtimeProvider(state.runtime);
}

function agentFromThread(thread: ThreadSnapshot, provider: RuntimeProvider): AgentNode {
  const projected = projectNativeStatus(thread.nativeStatus);
  return {
    provider: thread.provider ?? provider,
    id: thread.id,
    threadId: thread.id,
    ...(thread.parentThreadId ? { parentId: thread.parentThreadId } : {}),
    ...(thread.sessionId ? { sessionId: thread.sessionId } : {}),
    ...(thread.nickname ? { nickname: thread.nickname } : {}),
    ...(thread.role ? { role: thread.role } : {}),
    status: projected.status,
    nativeStatus: thread.nativeStatus,
    waitingReasons: projected.waitingReasons,
    ...(thread.createdAt ? { startedAt: thread.createdAt } : {}),
    ...(thread.updatedAt ? { updatedAt: thread.updatedAt } : {}),
    recentActivityIds: [],
    children: [],
    ...(thread.cwd ? { cwd: thread.cwd } : {}),
    ...(thread.model ? { model: thread.model } : {}),
    ...(thread.modelProvider ? { modelProvider: thread.modelProvider } : {}),
    ...(thread.reasoningEffort ? { reasoningEffort: thread.reasoningEffort } : {}),
    ...(thread.observedSkills ? { observedSkills: thread.observedSkills } : {}),
    ...(thread.observedWorkflows ? { observedWorkflows: thread.observedWorkflows } : {}),
    ...(thread.collaborationMode ? { collaborationMode: thread.collaborationMode } : {}),
    ...(thread.source !== undefined ? { source: thread.source } : {}),
    ...(thread.depth !== undefined ? { depth: thread.depth } : {}),
    ...(thread.path ? { path: thread.path } : {}),
    ...(thread.evidenceSources ? { evidenceSources: thread.evidenceSources } : {}),
  };
}

function ensureAgent(
  state: ObservatoryState,
  threadId: string,
  at: number,
  provider: RuntimeProvider = runtimeProvider(state.runtime),
): AgentNode {
  return (
    state.agents[threadId] ?? {
      provider,
      id: threadId,
      threadId,
      status: "unknown",
      waitingReasons: [],
      updatedAt: at,
      recentActivityIds: [],
      children: [],
    }
  );
}

function waitingReasonsFromRequests(state: ObservatoryState, threadId: string): WaitingReason[] {
  return Array.from(
    new Set(
      Object.values(state.pendingRequests)
        .filter((request) => request.agentId === threadId)
        .map((request) => request.reason),
    ),
  );
}

function rebuildChildren(agents: Record<string, AgentNode>): Record<string, AgentNode> {
  const next: Record<string, AgentNode> = Object.fromEntries(
    Object.entries(agents).map(([id, agent]) => [id, { ...agent, children: [] as string[] }]),
  );
  for (const agent of Object.values(next)) {
    if (!agent.parentId) continue;
    const parent = next[agent.parentId];
    if (parent && !parent.children.includes(agent.id)) parent.children.push(agent.id);
  }
  for (const agent of Object.values(next)) agent.children.sort();
  return next;
}

function agentActor(id: string): HistoryActor {
  return { type: "agent", id };
}

function recordHistory(state: ObservatoryState, history: HistoryEvent, limit: number): HistoryEvent[] {
  const actorProvider = history.actor.type === "agent" && history.actor.id
    ? state.agents[history.actor.id]?.provider
    : undefined;
  const tagged = { ...history, provider: history.provider ?? actorProvider ?? runtimeProvider(state.runtime) };
  return [tagged, ...state.history.filter((item) => item.id !== history.id)].slice(0, limit);
}

function boundedHistoryContent(content: string | undefined): string | undefined {
  if (!content) return undefined;
  return content.length > 2_000 ? `${content.slice(0, 1_999)}…` : content;
}

function resolveHistoryRecipients(state: ObservatoryState, history: HistoryEvent): HistoryEvent {
  if (history.kind !== "delivery" || history.actor.type !== "agent" || !history.actor.id) return history;
  if (history.recipients?.length !== 1 || history.recipients[0]?.type !== "human") return history;
  const parentId = state.agents[history.actor.id]?.parentId;
  return parentId ? { ...history, recipients: [agentActor(parentId)] } : history;
}

function activityHistory(activity: AgentActivity, status: HistoryEvent["status"]): HistoryEvent | undefined {
  if (activity.kind === "approval") return undefined;
  const content = boundedHistoryContent(activity.detail);
  return {
    id: `activity:${activity.id}`,
    provider: activity.provider,
    kind: activity.kind === "message" ? "delivery" : "work",
    actor: agentActor(activity.agentId),
    ...(activity.kind === "message" ? { recipients: [{ type: "human" as const }] } : {}),
    summary: activity.title,
    ...(content ? { content } : {}),
    status,
    correlationId: activity.id,
    occurredAt: activity.startedAt,
    source: "derived",
  };
}

export function reduceEvent(
  state: ObservatoryState,
  event: AgentRuntimeEvent,
  limits: { activities: number; debug: number; history?: number } = {
    activities: DEFAULT_ACTIVITY_LIMIT,
    debug: DEFAULT_DEBUG_LIMIT,
    history: DEFAULT_HISTORY_LIMIT,
  },
): ObservatoryState {
  const historyLimit = limits.history ?? DEFAULT_HISTORY_LIMIT;
  const provider = eventProvider(state, event);
  let next: ObservatoryState = {
    ...state,
    agents: { ...state.agents },
    pendingRequests: { ...state.pendingRequests },
    providerConnections: { ...state.providerConnections },
    revision: state.revision + 1,
  };

  switch (event.type) {
    case "thread.discovered": {
      const previous = state.agents[event.thread.id];
      const discovered = agentFromThread(event.thread, provider);
      if (previous) {
        const terminal = previous.completionEvidence !== undefined;
        next.agents[event.thread.id] = {
            ...previous,
            ...discovered,
            ...(terminal ? { status: previous.status, waitingReasons: [] } : {}),
            recentActivityIds: previous.recentActivityIds,
            currentActivityId: previous.currentActivityId,
            completionEvidence: previous.completionEvidence,
            completedAt: previous.completedAt,
          };
      } else {
        next.agents[event.thread.id] = discovered;
      }
      next.agents = rebuildChildren(next.agents);
      if (event.thread.parentThreadId) {
        next.history = recordHistory(state, {
          id: `spawn:${event.thread.id}`,
          provider,
          kind: "handoff",
          actor: agentActor(event.thread.parentThreadId),
          recipients: [{ type: "agent", id: event.thread.id, label: event.thread.nickname }],
          summary: `Started ${event.thread.nickname ?? event.thread.role ?? "subagent"}`,
          ...(event.thread.role ? { content: event.thread.role } : {}),
          status: "started",
          correlationId: event.thread.id,
          occurredAt: event.at,
          source: "derived",
          relationKind: "spawn",
        }, historyLimit);
      }
      break;
    }
    case "thread.status": {
      const previous = ensureAgent(state, event.threadId, event.at, provider);
      const projected = projectNativeStatus(event.status);
      const explicitTerminal = previous.completionEvidence !== undefined;
      next.agents[event.threadId] = {
        ...previous,
        nativeStatus: event.status,
        status: explicitTerminal ? previous.status : projected.status,
        waitingReasons: explicitTerminal ? [] : projected.waitingReasons,
        updatedAt: event.at,
      };
      break;
    }
    case "agent.lifecycle": {
      const previous = ensureAgent(state, event.threadId, event.at, provider);
      const mapped: Partial<AgentNode> = { updatedAt: event.at };
      if (event.status === "completed") {
        Object.assign(mapped, {
          status: "completed",
          completedAt: event.at,
          currentActivityId: undefined,
          waitingReasons: [],
          completionEvidence: "collab-completed",
        });
      } else if (event.status === "errored") {
        Object.assign(mapped, {
          status: "failed",
          completedAt: event.at,
          currentActivityId: undefined,
          waitingReasons: [],
          completionEvidence: "collab-errored",
        });
      } else if (event.status === "running" || event.status === "pendingInit") {
        Object.assign(mapped, {
          status: "working",
          waitingReasons: [],
          completionEvidence: undefined,
          completedAt: undefined,
        });
      } else if (event.status === "interrupted") {
        Object.assign(mapped, { status: "idle", waitingReasons: [] });
      }
      next.agents[event.threadId] = { ...previous, ...mapped };
      if (["completed", "errored", "interrupted"].includes(event.status)) {
        const failed = event.status === "errored";
        next.history = recordHistory(state, {
          id: `lifecycle:${event.threadId}:${event.status}:${event.at}`,
          provider,
          kind: "completion",
          actor: agentActor(event.threadId),
          summary: failed ? "Agent failed" : event.status === "interrupted" ? "Agent interrupted" : "Agent completed work",
          ...(event.message ? { content: event.message } : {}),
          status: failed ? "failed" : event.status === "interrupted" ? "interrupted" : "completed",
          occurredAt: event.at,
          source: "derived",
        }, historyLimit);
      }
      break;
    }
    case "turn.started": {
      const previous = ensureAgent(state, event.threadId, event.at, provider);
      next.agents[event.threadId] = {
        ...previous,
        status: "working",
        waitingReasons: [],
        currentTurnId: event.turnId,
        completionEvidence: undefined,
        completedAt: undefined,
        updatedAt: event.at,
      };
      next.history = recordHistory(state, {
        id: `turn:${event.turnId}`,
        provider,
        kind: "work",
        actor: agentActor(event.threadId),
        summary: "Started work",
        status: "running",
        turnId: event.turnId,
        correlationId: event.turnId,
        occurredAt: event.at,
        source: "derived",
      }, historyLimit);
      break;
    }
    case "turn.completed": {
      const previous = ensureAgent(state, event.threadId, event.at, provider);
      next.agents[event.threadId] = {
        ...previous,
        ...(event.status === "failed"
          ? {
              status: "failed" as const,
              completionEvidence: "turn-failed" as const,
            }
          : {}),
        currentTurnId: undefined,
        currentActivityId: undefined,
        updatedAt: event.at,
      };
      next.history = recordHistory(state, {
        id: `turn-completed:${event.turnId}`,
        provider,
        kind: "completion",
        actor: agentActor(event.threadId),
        summary: event.status === "failed" ? "Work failed" : event.status === "interrupted" ? "Work interrupted" : "Work completed",
        ...(event.error ? { content: event.error } : {}),
        status: event.status === "failed" ? "failed" : event.status === "interrupted" ? "interrupted" : "completed",
        turnId: event.turnId,
        correlationId: event.turnId,
        parentEventId: `turn:${event.turnId}`,
        occurredAt: event.at,
        source: "derived",
      }, historyLimit);
      break;
    }
    case "activity.started": {
      const activity = { ...event.activity, provider: event.activity.provider ?? provider };
      const previous = ensureAgent(state, activity.agentId, event.at, provider);
      next.activities = [activity, ...state.activities.filter((item) => item.id !== activity.id)].slice(
        0,
        limits.activities,
      );
      next.agents[activity.agentId] = {
        ...previous,
        currentActivityId: activity.id,
        recentActivityIds: [
          activity.id,
          ...previous.recentActivityIds.filter((id) => id !== activity.id),
        ].slice(0, RECENT_ACTIVITY_LIMIT),
        updatedAt: event.at,
      };
      const startedHistory = activityHistory(activity, "running");
      if (startedHistory) next.history = recordHistory(state, startedHistory, historyLimit);
      break;
    }
    case "activity.completed": {
      const previous = ensureAgent(state, event.threadId, event.at, provider);
      const existing = state.activities.find((activity) => activity.id === event.activityId);
      const completedSource = event.activity ?? (existing
        ? { ...existing, completedAt: event.at, ...(event.outcome ? { outcome: event.outcome } : {}) }
        : undefined);
      const completed = completedSource
        ? { ...completedSource, provider: completedSource.provider ?? provider }
        : undefined;
      next.activities = completed
        ? [completed, ...state.activities.filter((item) => item.id !== completed.id)].slice(0, limits.activities)
        : state.activities;
      next.agents[event.threadId] = {
        ...previous,
        ...(previous.currentActivityId === event.activityId ? { currentActivityId: undefined } : {}),
        updatedAt: event.at,
      };
      if (completed) {
        const status = completed.outcome === "failed" || completed.outcome === "declined"
          ? "failed"
          : completed.outcome === "interrupted"
            ? "interrupted"
            : "completed";
        const completedHistory = activityHistory(completed, status);
        if (completedHistory) next.history = recordHistory(state, completedHistory, historyLimit);
      }
      break;
    }
    case "history.recorded":
      next.history = recordHistory(
        state,
        resolveHistoryRecipients(state, { ...event.history, provider: event.history.provider ?? provider }),
        historyLimit,
      );
      break;
    case "request.opened": {
      const request = { ...event.request, provider: event.request.provider ?? provider };
      next.pendingRequests[request.id] = request;
      const previous = ensureAgent(state, request.agentId, event.at, provider);
      const reasons = Array.from(new Set([...previous.waitingReasons, request.reason]));
      next.agents[request.agentId] = {
        ...previous,
        status: "waiting",
        waitingReasons: reasons,
        updatedAt: event.at,
      };
      next.history = recordHistory(state, {
        id: `request:${request.id}`,
        provider,
        kind: "request",
        actor: agentActor(request.agentId),
        recipients: [{ type: "human" }],
        summary: request.title,
        ...(request.detail ? { content: request.detail } : {}),
        status: "running",
        correlationId: request.id,
        occurredAt: request.openedAt,
        source: "derived",
      }, historyLimit);
      break;
    }
    case "request.resolved": {
      const request = state.pendingRequests[event.requestId];
      delete next.pendingRequests[event.requestId];
      const threadId = event.threadId ?? request?.agentId;
      if (threadId) {
        const previous = ensureAgent(state, threadId, event.at, provider);
        const remaining = waitingReasonsFromRequests(next, threadId);
        next.agents[threadId] = {
          ...previous,
          status: remaining.length > 0 ? "waiting" : previous.nativeStatus?.type === "active" ? "working" : previous.status,
          waitingReasons: remaining,
          updatedAt: event.at,
        };
      }
      if (request) {
        next.history = recordHistory(state, {
          id: `request:${event.requestId}`,
          provider: request.provider ?? provider,
          kind: "request",
          actor: agentActor(request.agentId),
          recipients: [{ type: "human" }],
          summary: request.title,
          ...(request.detail ? { content: request.detail } : {}),
          status: "completed",
          correlationId: request.id,
          occurredAt: request.openedAt,
          source: "derived",
        }, historyLimit);
      }
      break;
    }
    case "token.updated": {
      const previous = ensureAgent(state, event.threadId, event.at, provider);
      next.agents[event.threadId] = { ...previous, tokenUsage: event.usage, updatedAt: event.at };
      break;
    }
    case "connection.changed":
      next.connection = event.connection;
      if (event.provider && next.runtime.adapter !== "composite") {
        next.providerConnections[event.provider] = event.connection;
      }
      break;
    case "provider.connection.changed":
      next.providerConnections[event.provider] = event.connection;
      break;
    case "runtime.updated":
      next.runtime = event.runtime;
      break;
    case "debug":
      next.debug = [{ ...event.entry, provider: event.entry.provider ?? provider }, ...state.debug].slice(0, limits.debug);
      break;
  }

  return next;
}

function relationFromHistory(history: HistoryEvent): AgentRelationKind | undefined {
  if (history.relationKind) return history.relationKind;
  if (history.kind === "handoff") return "handoff";
  return undefined;
}

function actorAgentId(actor: HistoryActor): string | undefined {
  return actor.type === "agent" ? actor.id : undefined;
}

export function buildGraph(
  agents: Record<string, AgentNode>,
  history: HistoryEvent[] = [],
): {
  roots: string[];
  edges: AgentGraphEdge[];
} {
  const roots: string[] = [];
  const edges: AgentGraphEdge[] = [];
  for (const agent of Object.values(agents)) {
    if (agent.parentId && agents[agent.parentId]) {
      edges.push({
        id: `${agent.parentId}->${agent.id}`,
        source: agent.parentId,
        target: agent.id,
        kind: "spawn",
        evidenceSource: agent.evidenceSources?.[0] ?? "derived",
      });
    } else {
      roots.push(agent.id);
    }
  }
  const seenRelations = new Set<string>();
  for (const event of history) {
    const kind = relationFromHistory(event);
    const source = actorAgentId(event.actor);
    if (!kind || kind === "spawn" || !source || !agents[source]) continue;
    for (const recipient of event.recipients ?? []) {
      const target = actorAgentId(recipient);
      if (!target || !agents[target]) continue;
      const relationKey = `${kind}:${source}->${target}`;
      if (seenRelations.has(relationKey)) continue;
      seenRelations.add(relationKey);
      edges.push({
        id: `${relationKey}:${event.id}`,
        source,
        target,
        kind,
        evidenceSource: event.source,
        label: event.summary,
        occurredAt: event.occurredAt,
      });
    }
  }
  roots.sort((a, b) => (agents[a]?.startedAt ?? 0) - (agents[b]?.startedAt ?? 0));
  return { roots, edges };
}

export function toSnapshot(state: ObservatoryState): ObservatorySnapshot {
  return { ...state, ...buildGraph(state.agents, state.history) };
}
