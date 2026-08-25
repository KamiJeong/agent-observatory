import type {
  AgentActivity,
  AgentGraphEdge,
  AgentNode,
  AgentRuntimeStatus,
  CodexRuntimeEvent,
  HistoryActor,
  HistoryEvent,
  NativeThreadStatus,
  ObservatorySnapshot,
  ObservatoryState,
  RuntimeInfo,
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
  return {
    agents: {},
    activities: [],
    history: [],
    pendingRequests: {},
    connection: { phase: "connecting", attempt: 0 },
    runtime,
    debug: [],
    startedAt: now,
    revision: 0,
  };
}

function agentFromThread(thread: ThreadSnapshot): AgentNode {
  const projected = projectNativeStatus(thread.nativeStatus);
  return {
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
  };
}

function ensureAgent(state: ObservatoryState, threadId: string, at: number): AgentNode {
  return (
    state.agents[threadId] ?? {
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
  return [history, ...state.history.filter((item) => item.id !== history.id)].slice(0, limit);
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
  event: CodexRuntimeEvent,
  limits: { activities: number; debug: number; history?: number } = {
    activities: DEFAULT_ACTIVITY_LIMIT,
    debug: DEFAULT_DEBUG_LIMIT,
    history: DEFAULT_HISTORY_LIMIT,
  },
): ObservatoryState {
  const historyLimit = limits.history ?? DEFAULT_HISTORY_LIMIT;
  let next: ObservatoryState = {
    ...state,
    agents: { ...state.agents },
    pendingRequests: { ...state.pendingRequests },
    revision: state.revision + 1,
  };

  switch (event.type) {
    case "thread.discovered": {
      const previous = state.agents[event.thread.id];
      const discovered = agentFromThread(event.thread);
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
          kind: "handoff",
          actor: agentActor(event.thread.parentThreadId),
          recipients: [{ type: "agent", id: event.thread.id, label: event.thread.nickname }],
          summary: `Started ${event.thread.nickname ?? event.thread.role ?? "subagent"}`,
          ...(event.thread.role ? { content: event.thread.role } : {}),
          status: "started",
          correlationId: event.thread.id,
          occurredAt: event.at,
          source: "derived",
        }, historyLimit);
      }
      break;
    }
    case "thread.status": {
      const previous = ensureAgent(state, event.threadId, event.at);
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
      const previous = ensureAgent(state, event.threadId, event.at);
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
      const previous = ensureAgent(state, event.threadId, event.at);
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
      const previous = ensureAgent(state, event.threadId, event.at);
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
      const previous = ensureAgent(state, event.activity.agentId, event.at);
      next.activities = [event.activity, ...state.activities.filter((item) => item.id !== event.activity.id)].slice(
        0,
        limits.activities,
      );
      next.agents[event.activity.agentId] = {
        ...previous,
        currentActivityId: event.activity.id,
        recentActivityIds: [
          event.activity.id,
          ...previous.recentActivityIds.filter((id) => id !== event.activity.id),
        ].slice(0, RECENT_ACTIVITY_LIMIT),
        updatedAt: event.at,
      };
      const startedHistory = activityHistory(event.activity, "running");
      if (startedHistory) next.history = recordHistory(state, startedHistory, historyLimit);
      break;
    }
    case "activity.completed": {
      const previous = ensureAgent(state, event.threadId, event.at);
      const existing = state.activities.find((activity) => activity.id === event.activityId);
      const completed = event.activity ?? (existing
        ? { ...existing, completedAt: event.at, ...(event.outcome ? { outcome: event.outcome } : {}) }
        : undefined);
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
      next.history = recordHistory(state, resolveHistoryRecipients(state, event.history), historyLimit);
      break;
    case "request.opened": {
      next.pendingRequests[event.request.id] = event.request;
      const previous = ensureAgent(state, event.request.agentId, event.at);
      const reasons = Array.from(new Set([...previous.waitingReasons, event.request.reason]));
      next.agents[event.request.agentId] = {
        ...previous,
        status: "waiting",
        waitingReasons: reasons,
        updatedAt: event.at,
      };
      next.history = recordHistory(state, {
        id: `request:${event.request.id}`,
        kind: "request",
        actor: agentActor(event.request.agentId),
        recipients: [{ type: "human" }],
        summary: event.request.title,
        ...(event.request.detail ? { content: event.request.detail } : {}),
        status: "running",
        correlationId: event.request.id,
        occurredAt: event.request.openedAt,
        source: "derived",
      }, historyLimit);
      break;
    }
    case "request.resolved": {
      const request = state.pendingRequests[event.requestId];
      delete next.pendingRequests[event.requestId];
      const threadId = event.threadId ?? request?.agentId;
      if (threadId) {
        const previous = ensureAgent(state, threadId, event.at);
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
      const previous = ensureAgent(state, event.threadId, event.at);
      next.agents[event.threadId] = { ...previous, tokenUsage: event.usage, updatedAt: event.at };
      break;
    }
    case "connection.changed":
      next.connection = event.connection;
      break;
    case "runtime.updated":
      next.runtime = event.runtime;
      break;
    case "debug":
      next.debug = [event.entry, ...state.debug].slice(0, limits.debug);
      break;
  }

  return next;
}

export function buildGraph(agents: Record<string, AgentNode>): {
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
      });
    } else {
      roots.push(agent.id);
    }
  }
  roots.sort((a, b) => (agents[a]?.startedAt ?? 0) - (agents[b]?.startedAt ?? 0));
  return { roots, edges };
}

export function toSnapshot(state: ObservatoryState): ObservatorySnapshot {
  return { ...state, ...buildGraph(state.agents) };
}
