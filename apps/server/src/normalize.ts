import type {
  AgentActivity,
  AgentLifecycleStatus,
  CodexRuntimeEvent,
  NativeThreadStatus,
  PendingRequest,
  ThreadSnapshot,
  TokenUsageSnapshot,
  WaitingReason,
} from "@observatory/core";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings : undefined;
}

function statusValue(value: unknown): NativeThreadStatus {
  if (!isRecord(value) || typeof value.type !== "string") return { type: "notLoaded" };
  if (value.type === "active") {
    return {
      type: "active",
      activeFlags: Array.isArray(value.activeFlags)
        ? value.activeFlags.filter((flag): flag is string => typeof flag === "string")
        : [],
    };
  }
  if (value.type === "idle" || value.type === "systemError" || value.type === "notLoaded") {
    return { type: value.type };
  }
  return { type: "notLoaded" };
}

function spawnedSource(source: unknown): UnknownRecord | undefined {
  if (!isRecord(source)) return undefined;
  const subAgent = isRecord(source.subAgent)
    ? source.subAgent
    : isRecord(source.subagent)
      ? source.subagent
      : undefined;
  if (!subAgent || !isRecord(subAgent.thread_spawn)) return undefined;
  return subAgent.thread_spawn;
}

export function toThreadSnapshot(value: unknown): ThreadSnapshot | undefined {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  const spawn = spawnedSource(value.source);
  const parentThreadId = stringValue(value.parentThreadId) ?? stringValue(spawn?.parent_thread_id);
  const nickname = stringValue(value.agentNickname) ?? stringValue(spawn?.agent_nickname);
  const role = stringValue(value.agentRole) ?? stringValue(spawn?.agent_role);
  const model = stringValue(value.model);
  const reasoningEffort = stringValue(value.reasoningEffort) ?? stringValue(value.effort);
  const observedSkills = stringArray(value.observedSkills);
  const observedWorkflows = stringArray(value.observedWorkflows);
  const collaborationMode = stringValue(value.collaborationMode);
  const createdAtSeconds = numberValue(value.createdAt);
  const updatedAtSeconds = numberValue(value.updatedAt);
  return {
    id: value.id,
    ...(stringValue(value.sessionId) ? { sessionId: stringValue(value.sessionId) } : {}),
    ...(parentThreadId ? { parentThreadId } : {}),
    ...(stringValue(value.forkedFromId) ? { forkedFromId: stringValue(value.forkedFromId) } : {}),
    ...(nickname ? { nickname } : {}),
    ...(role ? { role } : {}),
    nativeStatus: statusValue(value.status),
    ...(createdAtSeconds !== undefined ? { createdAt: createdAtSeconds * 1000 } : {}),
    ...(updatedAtSeconds !== undefined ? { updatedAt: updatedAtSeconds * 1000 } : {}),
    ...(stringValue(value.cwd) ? { cwd: stringValue(value.cwd) } : {}),
    ...(model ? { model } : {}),
    ...(stringValue(value.modelProvider) ? { modelProvider: stringValue(value.modelProvider) } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(observedSkills ? { observedSkills } : {}),
    ...(observedWorkflows ? { observedWorkflows } : {}),
    ...(collaborationMode ? { collaborationMode } : {}),
    ...(value.source !== undefined ? { source: value.source } : {}),
    ...(numberValue(spawn?.depth) !== undefined ? { depth: numberValue(spawn?.depth) } : {}),
    ...(stringValue(spawn?.agent_path) ? { path: stringValue(spawn?.agent_path) } : {}),
  };
}

function commandLooksLikeTest(command: string): boolean {
  return /(^|\s)(vitest|jest|pytest|go test|cargo test|npm (run )?test|pnpm (run )?test|bun (run )?test)(\s|$)/i.test(
    command,
  );
}

function itemOutcome(item: UnknownRecord): AgentActivity["outcome"] | undefined {
  if (item.status === "failed") return "failed";
  if (item.status === "declined") return "declined";
  if (item.status === "completed") return "completed";
  return undefined;
}

function activityFromItem(
  item: UnknownRecord,
  threadId: string,
  at: number,
  completed: boolean,
): AgentActivity {
  const id = stringValue(item.id) ?? `${threadId}:${at}`;
  const base = {
    id,
    agentId: threadId,
    startedAt: completed ? at - (numberValue(item.durationMs) ?? 0) : at,
    ...(completed ? { completedAt: at } : {}),
    ...(itemOutcome(item) ? { outcome: itemOutcome(item) } : {}),
  };

  switch (item.type) {
    case "reasoning":
      return { ...base, kind: "thinking", title: "Thinking" };
    case "commandExecution": {
      const command = stringValue(item.command) ?? "Command";
      const actions = Array.isArray(item.commandActions) ? item.commandActions.filter(isRecord) : [];
      const onlyReads = actions.length > 0 && actions.every((action) =>
        action.type === "read" || action.type === "listFiles" || action.type === "search",
      );
      const kind = commandLooksLikeTest(command) ? "test" : onlyReads ? "read" : "command";
      return {
        ...base,
        kind,
        title: kind === "test" ? "Running tests" : kind === "read" ? "Reading workspace" : "Running command",
        detail: command,
        metadata: {
          cwd: item.cwd,
          exitCode: item.exitCode,
          commandActions: item.commandActions,
        },
      };
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes.filter(isRecord) : [];
      const paths = changes.map((change) => stringValue(change.path)).filter((path): path is string => Boolean(path));
      return {
        ...base,
        kind: "write",
        title: paths.length === 1 ? `Editing ${paths[0]}` : `Editing ${paths.length} files`,
        ...(paths.length > 0 ? { detail: paths.join(", ") } : {}),
        metadata: { changes: changes.map(({ path, kind }) => ({ path, kind })) },
      };
    }
    case "mcpToolCall":
      return {
        ...base,
        kind: "tool",
        title: `${stringValue(item.server) ?? "MCP"} · ${stringValue(item.tool) ?? "tool"}`,
      };
    case "dynamicToolCall":
      return {
        ...base,
        kind: "tool",
        title: [stringValue(item.namespace), stringValue(item.tool)].filter(Boolean).join(" · ") || "Tool call",
      };
    case "collabAgentToolCall":
      return {
        ...base,
        kind: "tool",
        title: `Agent · ${stringValue(item.tool) ?? "collaboration"}`,
        ...(stringValue(item.prompt) ? { detail: stringValue(item.prompt) } : {}),
        metadata: { receiverThreadIds: item.receiverThreadIds },
      };
    case "subAgentActivity":
      return {
        ...base,
        kind: "message",
        title: `Subagent ${stringValue(item.kind) ?? "activity"}`,
        detail: stringValue(item.agentPath) ?? stringValue(item.agentThreadId),
      };
    case "agentMessage":
      return {
        ...base,
        kind: "message",
        title: "Agent message",
        ...(stringValue(item.text) ? { detail: stringValue(item.text)?.slice(0, 240) } : {}),
      };
    case "webSearch":
      return { ...base, kind: "tool", title: "Searching the web" };
    case "imageView":
      return { ...base, kind: "read", title: "Viewing image", detail: stringValue(item.path) };
    case "imageGeneration":
      return { ...base, kind: "tool", title: "Generating image" };
    case "sleep":
      return { ...base, kind: "tool", title: "Waiting on timer" };
    case "contextCompaction":
      return { ...base, kind: "thinking", title: "Compacting context" };
    default:
      return { ...base, kind: "unknown", title: stringValue(item.type) ?? "Unknown activity" };
  }
}

function lifecycleEvents(item: UnknownRecord, at: number): CodexRuntimeEvent[] {
  if (item.type !== "collabAgentToolCall" || !isRecord(item.agentsStates)) return [];
  const events: CodexRuntimeEvent[] = [];
  for (const [threadId, state] of Object.entries(item.agentsStates)) {
    if (!isRecord(state) || typeof state.status !== "string") continue;
    const allowed: AgentLifecycleStatus[] = [
      "pendingInit",
      "running",
      "interrupted",
      "completed",
      "errored",
      "shutdown",
      "notFound",
    ];
    if (!allowed.includes(state.status as AgentLifecycleStatus)) continue;
    events.push({
      type: "agent.lifecycle",
      at,
      threadId,
      status: state.status as AgentLifecycleStatus,
      ...(stringValue(state.message) ? { message: stringValue(state.message) } : {}),
    });
  }
  return events;
}

function requestReason(method: string): { reason: WaitingReason; title: string } | undefined {
  if (method === "item/tool/requestUserInput") return { reason: "userInput", title: "Waiting for user input" };
  if (method === "mcpServer/elicitation/request") return { reason: "elicitation", title: "Waiting for MCP input" };
  if (method.includes("requestApproval") || method === "applyPatchApproval" || method === "execCommandApproval") {
    return { reason: "approval", title: "Waiting for approval" };
  }
  return undefined;
}

function tokenUsage(value: unknown): TokenUsageSnapshot {
  if (!isRecord(value)) return {};
  const total = isRecord(value.total) ? value.total : value;
  return {
    ...(numberValue(total.inputTokens) !== undefined ? { inputTokens: numberValue(total.inputTokens) } : {}),
    ...(numberValue(total.cachedInputTokens) !== undefined ? { cachedInputTokens: numberValue(total.cachedInputTokens) } : {}),
    ...(numberValue(total.outputTokens) !== undefined ? { outputTokens: numberValue(total.outputTokens) } : {}),
    ...(numberValue(total.reasoningOutputTokens) !== undefined
      ? { reasoningOutputTokens: numberValue(total.reasoningOutputTokens) }
      : {}),
    ...(numberValue(total.totalTokens) !== undefined ? { totalTokens: numberValue(total.totalTokens) } : {}),
    ...(numberValue(value.modelContextWindow) !== undefined
      ? { modelContextWindow: numberValue(value.modelContextWindow) }
      : {}),
  };
}

export interface JsonRpcEnvelope {
  method?: string;
  id?: string | number;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export function normalizeEnvelope(envelope: JsonRpcEnvelope, at = Date.now()): CodexRuntimeEvent[] {
  const method = envelope.method;
  const params = isRecord(envelope.params) ? envelope.params : {};
  if (!method) return [];

  const request = requestReason(method);
  if (request && envelope.id !== undefined) {
    const threadId = stringValue(params.threadId);
    if (!threadId) return [];
    const pending: PendingRequest = {
      id: String(envelope.id),
      agentId: threadId,
      reason: request.reason,
      title: request.title,
      ...(stringValue(params.reason) ? { detail: stringValue(params.reason) } : {}),
      openedAt: numberValue(params.startedAtMs) ?? at,
    };
    return [
      { type: "request.opened", at, request: pending },
      {
        type: "activity.started",
        at,
        activity: {
          id: `request:${pending.id}`,
          agentId: threadId,
          kind: "approval",
          title: pending.title,
          ...(pending.detail ? { detail: pending.detail } : {}),
          startedAt: pending.openedAt,
        },
      },
    ];
  }

  switch (method) {
    case "thread/started": {
      const thread = toThreadSnapshot(params.thread);
      return thread ? [{ type: "thread.discovered", at, thread }] : [];
    }
    case "thread/status/changed": {
      const threadId = stringValue(params.threadId);
      return threadId ? [{ type: "thread.status", at, threadId, status: statusValue(params.status) }] : [];
    }
    case "turn/started": {
      const turn = isRecord(params.turn) ? params.turn : {};
      const threadId = stringValue(params.threadId);
      const turnId = stringValue(turn.id);
      return threadId && turnId ? [{ type: "turn.started", at, threadId, turnId }] : [];
    }
    case "turn/completed": {
      const turn = isRecord(params.turn) ? params.turn : {};
      const threadId = stringValue(params.threadId);
      const turnId = stringValue(turn.id);
      const status = stringValue(turn.status);
      if (!threadId || !turnId || !status || !["completed", "interrupted", "failed"].includes(status)) return [];
      const error = isRecord(turn.error) ? stringValue(turn.error.message) : undefined;
      return [{
        type: "turn.completed",
        at,
        threadId,
        turnId,
        status: status as "completed" | "interrupted" | "failed",
        ...(error ? { error } : {}),
      }];
    }
    case "item/started":
    case "item/completed": {
      const item = isRecord(params.item) ? params.item : undefined;
      const threadId = stringValue(params.threadId);
      if (!item || !threadId) return [];
      const completed = method === "item/completed";
      const activity = activityFromItem(item, threadId, at, completed);
      const activityEvent: CodexRuntimeEvent = completed
        ? {
            type: "activity.completed",
            at,
            threadId,
            activityId: activity.id,
            activity,
            ...(activity.outcome ? { outcome: activity.outcome } : {}),
          }
        : { type: "activity.started", at, activity };
      return [activityEvent, ...lifecycleEvents(item, at)];
    }
    case "serverRequest/resolved": {
      const requestId = params.requestId;
      if (typeof requestId !== "string" && typeof requestId !== "number") return [];
      return [{
        type: "request.resolved",
        at,
        requestId: String(requestId),
        ...(stringValue(params.threadId) ? { threadId: stringValue(params.threadId) } : {}),
      }];
    }
    case "thread/tokenUsage/updated": {
      const threadId = stringValue(params.threadId);
      return threadId ? [{ type: "token.updated", at, threadId, usage: tokenUsage(params.tokenUsage) }] : [];
    }
    case "error": {
      const threadId = stringValue(params.threadId);
      const error = isRecord(params.error) ? params.error : {};
      if (!threadId) return [];
      return [{
        type: "activity.completed",
        at,
        threadId,
        activityId: `error:${stringValue(params.turnId) ?? at}`,
        activity: {
          id: `error:${stringValue(params.turnId) ?? at}`,
          agentId: threadId,
          kind: "error",
          title: "Codex error",
          detail: stringValue(error.message) ?? "Unknown Codex error",
          startedAt: at,
          completedAt: at,
          outcome: "failed",
        },
        outcome: "failed",
      }];
    }
    default:
      return [];
  }
}

export function parseEnvelope(line: string): JsonRpcEnvelope | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? (parsed as JsonRpcEnvelope) : undefined;
  } catch {
    return undefined;
  }
}
