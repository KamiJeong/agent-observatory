import type {
  AgentActivity,
  AgentRuntimeEvent,
  HistoryActor,
  HistoryEvent,
  PendingRequest,
  RuntimeInfo,
  RuntimeProvider,
  ThreadSnapshot,
} from "./types.ts";

function providerPrefix(provider: RuntimeProvider): string {
  return `${encodeURIComponent(provider)}:`;
}

/** Creates a stable, idempotent identifier in a provider-owned namespace. */
export function namespaceRuntimeId(provider: RuntimeProvider, id: string): string {
  const prefix = providerPrefix(provider);
  return id.startsWith(prefix) ? id : `${prefix}${id}`;
}

/** Returns the provider-local identifier, or undefined when the namespace differs. */
export function stripRuntimeIdNamespace(provider: RuntimeProvider, id: string): string | undefined {
  const prefix = providerPrefix(provider);
  return id.startsWith(prefix) ? id.slice(prefix.length) : undefined;
}

function optionalId(provider: RuntimeProvider, id: string | undefined): string | undefined {
  return id === undefined ? undefined : namespaceRuntimeId(provider, id);
}

function namespaceActor(provider: RuntimeProvider, actor: HistoryActor): HistoryActor {
  return actor.type === "agent" && actor.id
    ? { ...actor, id: namespaceRuntimeId(provider, actor.id) }
    : actor;
}

export function namespaceThreadSnapshot(
  provider: RuntimeProvider,
  thread: ThreadSnapshot,
): ThreadSnapshot {
  return {
    ...thread,
    provider,
    id: namespaceRuntimeId(provider, thread.id),
    sessionId: optionalId(provider, thread.sessionId),
    parentThreadId: optionalId(provider, thread.parentThreadId),
    forkedFromId: optionalId(provider, thread.forkedFromId),
  };
}

export function namespaceAgentActivity(
  provider: RuntimeProvider,
  activity: AgentActivity,
): AgentActivity {
  return {
    ...activity,
    provider,
    id: namespaceRuntimeId(provider, activity.id),
    agentId: namespaceRuntimeId(provider, activity.agentId),
  };
}

export function namespaceHistoryEvent(
  provider: RuntimeProvider,
  history: HistoryEvent,
): HistoryEvent {
  return {
    ...history,
    provider,
    id: namespaceRuntimeId(provider, history.id),
    actor: namespaceActor(provider, history.actor),
    recipients: history.recipients?.map((recipient) => namespaceActor(provider, recipient)),
    turnId: optionalId(provider, history.turnId),
    correlationId: optionalId(provider, history.correlationId),
    parentEventId: optionalId(provider, history.parentEventId),
  };
}

function namespacePendingRequest(
  provider: RuntimeProvider,
  request: PendingRequest,
): PendingRequest {
  return {
    ...request,
    provider,
    id: namespaceRuntimeId(provider, request.id),
    agentId: namespaceRuntimeId(provider, request.agentId),
  };
}

export function providerRuntimeInfo(provider: RuntimeProvider, runtime: RuntimeInfo): RuntimeInfo {
  return { ...runtime, provider };
}

/** Tags an event and namespaces every provider-owned identifier it contains. */
export function namespaceRuntimeEvent(
  provider: RuntimeProvider,
  event: AgentRuntimeEvent,
): AgentRuntimeEvent {
  switch (event.type) {
    case "thread.discovered":
      return { ...event, provider, thread: namespaceThreadSnapshot(provider, event.thread) };
    case "thread.status":
    case "agent.lifecycle":
    case "token.updated":
      return { ...event, provider, threadId: namespaceRuntimeId(provider, event.threadId) };
    case "turn.started":
    case "turn.completed":
      return {
        ...event,
        provider,
        threadId: namespaceRuntimeId(provider, event.threadId),
        turnId: namespaceRuntimeId(provider, event.turnId),
      };
    case "activity.started":
      return { ...event, provider, activity: namespaceAgentActivity(provider, event.activity) };
    case "activity.completed":
      return {
        ...event,
        provider,
        threadId: namespaceRuntimeId(provider, event.threadId),
        activityId: namespaceRuntimeId(provider, event.activityId),
        activity: event.activity ? namespaceAgentActivity(provider, event.activity) : undefined,
      };
    case "history.recorded":
      return { ...event, provider, history: namespaceHistoryEvent(provider, event.history) };
    case "request.opened":
      return { ...event, provider, request: namespacePendingRequest(provider, event.request) };
    case "request.resolved":
      return {
        ...event,
        provider,
        requestId: namespaceRuntimeId(provider, event.requestId),
        threadId: optionalId(provider, event.threadId),
      };
    case "connection.changed":
      return { ...event, provider };
    case "provider.connection.changed":
      return { ...event, provider };
    case "runtime.updated":
      return { ...event, provider, runtime: providerRuntimeInfo(provider, event.runtime) };
    case "debug":
      return {
        ...event,
        provider,
        entry: {
          ...event.entry,
          provider,
          id: namespaceRuntimeId(provider, event.entry.id),
        },
      };
  }
}
