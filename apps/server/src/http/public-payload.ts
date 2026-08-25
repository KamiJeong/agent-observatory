import type {
  AgentActivity,
  AgentNode,
  AgentRuntimeEvent,
  HistoryEvent,
  ObservatorySnapshot,
  PendingRequest,
  RuntimeProvider,
  ThreadSnapshot,
} from "@observatory/core";

function captureContent(): boolean {
  return process.env.OBSERVATORY_CAPTURE_CONTENT === "1";
}

function mayExpose(provider: RuntimeProvider | undefined): boolean {
  return captureContent() || provider === "mock";
}

function publicMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const safeKeys = ["provider", "observation", "nativeTool", "evidenceSource"];
  const entries = safeKeys
    .filter((key) => metadata[key] !== undefined)
    .map((key) => [key, metadata[key]] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function publicActivity(activity: AgentActivity): AgentActivity {
  if (mayExpose(activity.provider)) return activity;
  const { detail: _detail, metadata, ...safe } = activity;
  const sanitizedMetadata = publicMetadata(metadata);
  return { ...safe, ...(sanitizedMetadata ? { metadata: sanitizedMetadata } : {}) };
}

function publicHistory(history: HistoryEvent): HistoryEvent {
  if (mayExpose(history.provider)) return history;
  const { content: _content, ...safe } = history;
  return safe;
}

function publicRequest(request: PendingRequest): PendingRequest {
  if (mayExpose(request.provider)) return request;
  const { detail: _detail, ...safe } = request;
  return safe;
}

function publicAgent(agent: AgentNode): AgentNode {
  if (mayExpose(agent.provider)) return agent;
  const { source: _source, ...safe } = agent;
  return safe;
}

function publicThread(thread: ThreadSnapshot, eventProvider?: RuntimeProvider): ThreadSnapshot {
  if (mayExpose(thread.provider ?? eventProvider)) return thread;
  const { source: _source, ...safe } = thread;
  return safe;
}

export function publicSnapshot(snapshot: ObservatorySnapshot): ObservatorySnapshot {
  return {
    ...snapshot,
    agents: Object.fromEntries(
      Object.entries(snapshot.agents).map(([id, agent]) => [id, publicAgent(agent)]),
    ),
    activities: snapshot.activities.map(publicActivity),
    history: snapshot.history.map(publicHistory),
    pendingRequests: Object.fromEntries(
      Object.entries(snapshot.pendingRequests).map(([id, request]) => [id, publicRequest(request)]),
    ),
    debug: snapshot.debug.map(({ payload: _payload, ...entry }) => entry),
  };
}

export function publicEvent(event: AgentRuntimeEvent): AgentRuntimeEvent {
  switch (event.type) {
    case "thread.discovered":
      return { ...event, thread: publicThread(event.thread, event.provider) };
    case "activity.started":
      return { ...event, activity: publicActivity(event.activity) };
    case "activity.completed":
      return { ...event, activity: event.activity ? publicActivity(event.activity) : undefined };
    case "history.recorded":
      return { ...event, history: publicHistory(event.history) };
    case "request.opened":
      return { ...event, request: publicRequest(event.request) };
    case "agent.lifecycle": {
      if (mayExpose(event.provider)) return event;
      const { message: _message, ...safe } = event;
      return safe;
    }
    case "turn.completed": {
      if (mayExpose(event.provider)) return event;
      const { error: _error, ...safe } = event;
      return safe;
    }
    case "debug": {
      const { payload: _payload, ...entry } = event.entry;
      return { ...event, entry };
    }
    default:
      return event;
  }
}
