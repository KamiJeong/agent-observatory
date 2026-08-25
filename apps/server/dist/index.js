// apps/server/src/index.ts
import { sep } from "node:path";
import { fileURLToPath } from "node:url";

// apps/server/src/access-token.ts
import { randomBytes } from "node:crypto";
function consumeAccessToken(environment = process.env) {
  const configured = environment.OBSERVATORY_ACCESS_TOKEN;
  delete environment.OBSERVATORY_ACCESS_TOKEN;
  return configured ?? randomBytes(32).toString("base64url");
}

// apps/server/src/codex-adapter.ts
import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";

// apps/server/src/normalize.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringValue(value) {
  return typeof value === "string" ? value : void 0;
}
function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function stringArray(value) {
  if (!Array.isArray(value)) return void 0;
  const strings = value.filter((item) => typeof item === "string");
  return strings.length > 0 ? strings : void 0;
}
function statusValue(value) {
  if (!isRecord(value) || typeof value.type !== "string") return { type: "notLoaded" };
  if (value.type === "active") {
    return {
      type: "active",
      activeFlags: Array.isArray(value.activeFlags) ? value.activeFlags.filter((flag) => typeof flag === "string") : []
    };
  }
  if (value.type === "idle" || value.type === "systemError" || value.type === "notLoaded") {
    return { type: value.type };
  }
  return { type: "notLoaded" };
}
function spawnedSource(source) {
  if (!isRecord(source)) return void 0;
  const subAgent = isRecord(source.subAgent) ? source.subAgent : isRecord(source.subagent) ? source.subagent : void 0;
  if (!subAgent || !isRecord(subAgent.thread_spawn)) return void 0;
  return subAgent.thread_spawn;
}
function toThreadSnapshot(value) {
  if (!isRecord(value) || typeof value.id !== "string") return void 0;
  const spawn2 = spawnedSource(value.source);
  const parentThreadId = stringValue(value.parentThreadId) ?? stringValue(spawn2?.parent_thread_id);
  const nickname = stringValue(value.agentNickname) ?? stringValue(spawn2?.agent_nickname);
  const role = stringValue(value.agentRole) ?? stringValue(spawn2?.agent_role);
  const model = stringValue(value.model);
  const reasoningEffort = stringValue(value.reasoningEffort) ?? stringValue(value.effort);
  const observedSkills = stringArray(value.observedSkills);
  const observedWorkflows = stringArray(value.observedWorkflows);
  const collaborationMode = stringValue(value.collaborationMode);
  const createdAtSeconds = numberValue(value.createdAt);
  const updatedAtSeconds = numberValue(value.updatedAt);
  return {
    id: value.id,
    ...stringValue(value.sessionId) ? { sessionId: stringValue(value.sessionId) } : {},
    ...parentThreadId ? { parentThreadId } : {},
    ...stringValue(value.forkedFromId) ? { forkedFromId: stringValue(value.forkedFromId) } : {},
    ...nickname ? { nickname } : {},
    ...role ? { role } : {},
    nativeStatus: statusValue(value.status),
    ...createdAtSeconds !== void 0 ? { createdAt: createdAtSeconds * 1e3 } : {},
    ...updatedAtSeconds !== void 0 ? { updatedAt: updatedAtSeconds * 1e3 } : {},
    ...stringValue(value.cwd) ? { cwd: stringValue(value.cwd) } : {},
    ...model ? { model } : {},
    ...stringValue(value.modelProvider) ? { modelProvider: stringValue(value.modelProvider) } : {},
    ...reasoningEffort ? { reasoningEffort } : {},
    ...observedSkills ? { observedSkills } : {},
    ...observedWorkflows ? { observedWorkflows } : {},
    ...collaborationMode ? { collaborationMode } : {},
    ...value.source !== void 0 ? { source: value.source } : {},
    ...numberValue(spawn2?.depth) !== void 0 ? { depth: numberValue(spawn2?.depth) } : {},
    ...stringValue(spawn2?.agent_path) ? { path: stringValue(spawn2?.agent_path) } : {}
  };
}
function commandLooksLikeTest(command) {
  return /(^|\s)(vitest|jest|pytest|go test|cargo test|npm (run )?test|pnpm (run )?test|bun (run )?test)(\s|$)/i.test(
    command
  );
}
function itemOutcome(item) {
  if (item.status === "failed") return "failed";
  if (item.status === "declined") return "declined";
  if (item.status === "completed") return "completed";
  return void 0;
}
var HISTORY_CONTENT_LIMIT = 2e3;
function boundedText(value) {
  if (!value) return void 0;
  const normalized = value.trim();
  if (!normalized) return void 0;
  return normalized.length > HISTORY_CONTENT_LIMIT ? `${normalized.slice(0, HISTORY_CONTENT_LIMIT - 1)}\u2026` : normalized;
}
function contentText(value) {
  if (typeof value === "string") return boundedText(value);
  if (!Array.isArray(value)) return void 0;
  const parts = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const text = stringValue(entry.text) ?? stringValue(entry.input_text) ?? stringValue(entry.output_text);
    if (text) parts.push(text);
    else if (entry.type === "skill" && stringValue(entry.name)) parts.push(`Skill: ${stringValue(entry.name)}`);
    else if (entry.type === "mention" && stringValue(entry.name)) parts.push(`Mention: ${stringValue(entry.name)}`);
  }
  return boundedText(parts.join("\n"));
}
function historyStatus(item, completed) {
  if (item.status === "failed") return "failed";
  if (item.status === "declined") return "failed";
  if (!completed || item.status === "inProgress") return "running";
  return "completed";
}
function agentRef(id, label) {
  return { type: "agent", id, ...label ? { label } : {} };
}
function historyFromItem(item, threadId, at, completed, turnId) {
  const itemId = stringValue(item.id) ?? `${threadId}:${at}`;
  const base = {
    id: `activity:${itemId}`,
    actor: agentRef(threadId),
    status: historyStatus(item, completed),
    ...turnId ? { turnId } : {},
    correlationId: itemId,
    occurredAt: completed ? at - (numberValue(item.durationMs) ?? 0) : at,
    source: "protocol"
  };
  if (item.type === "userMessage") {
    return [{
      ...base,
      kind: "request",
      actor: { type: "human" },
      recipients: [agentRef(threadId)],
      summary: "Request received",
      ...contentText(item.content) ? { content: contentText(item.content) } : {},
      status: "completed"
    }];
  }
  if (item.type === "plan") {
    return [{
      ...base,
      kind: "decision",
      summary: "Plan updated",
      ...boundedText(stringValue(item.text)) ? { content: boundedText(stringValue(item.text)) } : {},
      status: "completed"
    }];
  }
  if (item.type === "agentMessage") {
    const phase = stringValue(item.phase);
    return [{
      ...base,
      kind: "delivery",
      recipients: [{ type: "human" }],
      summary: phase === "final_answer" ? "Delivered final result" : phase === "commentary" ? "Shared progress update" : "Agent message",
      ...boundedText(stringValue(item.text)) ? { content: boundedText(stringValue(item.text)) } : {},
      status: phase === "final_answer" || completed ? "completed" : "sent"
    }];
  }
  if (item.type !== "collabAgentToolCall") return [];
  const senderId = stringValue(item.senderThreadId) ?? threadId;
  const receivers = stringArray(item.receiverThreadIds) ?? [];
  const recipients = receivers.map((id) => agentRef(id));
  const tool = stringValue(item.tool) ?? "collaboration";
  const details = {
    spawnAgent: { kind: "handoff", summary: "Delegated work" },
    sendInput: { kind: "handoff", summary: "Sent message" },
    resumeAgent: { kind: "handoff", summary: "Resumed agent" },
    wait: { kind: "work", summary: "Waited for agents" },
    closeAgent: { kind: "completion", summary: "Closed agent" }
  };
  const detail = details[tool] ?? { kind: "handoff", summary: "Agent collaboration" };
  const events = [{
    ...base,
    kind: detail.kind,
    actor: agentRef(senderId),
    ...recipients.length > 0 ? { recipients } : {},
    summary: detail.summary,
    ...boundedText(stringValue(item.prompt)) ? { content: boundedText(stringValue(item.prompt)) } : {}
  }];
  if (isRecord(item.agentsStates)) {
    for (const [receiverId, state] of Object.entries(item.agentsStates)) {
      if (!isRecord(state)) continue;
      const message = boundedText(stringValue(state.message));
      if (!message) continue;
      events.push({
        id: `collab-result:${itemId}:${receiverId}`,
        kind: "delivery",
        actor: agentRef(receiverId),
        recipients: [agentRef(senderId)],
        summary: state.status === "errored" ? "Reported failure" : "Reported result",
        content: message,
        status: state.status === "errored" ? "failed" : "completed",
        correlationId: itemId,
        parentEventId: `activity:${itemId}`,
        occurredAt: at,
        source: "protocol"
      });
    }
  }
  return events;
}
function activityFromItem(item, threadId, at, completed) {
  const id = stringValue(item.id) ?? `${threadId}:${at}`;
  const base = {
    id,
    agentId: threadId,
    startedAt: completed ? at - (numberValue(item.durationMs) ?? 0) : at,
    ...completed ? { completedAt: at } : {},
    ...itemOutcome(item) ? { outcome: itemOutcome(item) } : {}
  };
  switch (item.type) {
    case "reasoning":
      return { ...base, kind: "thinking", title: "Thinking" };
    case "commandExecution": {
      const command = stringValue(item.command) ?? "Command";
      const actions = Array.isArray(item.commandActions) ? item.commandActions.filter(isRecord) : [];
      const onlyReads = actions.length > 0 && actions.every(
        (action) => action.type === "read" || action.type === "listFiles" || action.type === "search"
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
          commandActions: item.commandActions
        }
      };
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes.filter(isRecord) : [];
      const paths = changes.map((change) => stringValue(change.path)).filter((path2) => Boolean(path2));
      return {
        ...base,
        kind: "write",
        title: paths.length === 1 ? `Editing ${paths[0]}` : `Editing ${paths.length} files`,
        ...paths.length > 0 ? { detail: paths.join(", ") } : {},
        metadata: { changes: changes.map(({ path: path2, kind }) => ({ path: path2, kind })) }
      };
    }
    case "mcpToolCall":
      return {
        ...base,
        kind: "tool",
        title: `${stringValue(item.server) ?? "MCP"} \xB7 ${stringValue(item.tool) ?? "tool"}`
      };
    case "dynamicToolCall":
      return {
        ...base,
        kind: "tool",
        title: [stringValue(item.namespace), stringValue(item.tool)].filter(Boolean).join(" \xB7 ") || "Tool call"
      };
    case "collabAgentToolCall":
      return {
        ...base,
        kind: "tool",
        title: `Agent \xB7 ${stringValue(item.tool) ?? "collaboration"}`,
        ...stringValue(item.prompt) ? { detail: stringValue(item.prompt) } : {},
        metadata: { receiverThreadIds: item.receiverThreadIds }
      };
    case "subAgentActivity":
      return {
        ...base,
        kind: "message",
        title: `Subagent ${stringValue(item.kind) ?? "activity"}`,
        detail: stringValue(item.agentPath) ?? stringValue(item.agentThreadId)
      };
    case "agentMessage":
      return {
        ...base,
        kind: "message",
        title: "Agent message",
        ...stringValue(item.text) ? { detail: stringValue(item.text)?.slice(0, 240) } : {}
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
function lifecycleEvents(item, at) {
  if (item.type !== "collabAgentToolCall" || !isRecord(item.agentsStates)) return [];
  const events = [];
  for (const [threadId, state] of Object.entries(item.agentsStates)) {
    if (!isRecord(state) || typeof state.status !== "string") continue;
    const allowed = [
      "pendingInit",
      "running",
      "interrupted",
      "completed",
      "errored",
      "shutdown",
      "notFound"
    ];
    if (!allowed.includes(state.status)) continue;
    events.push({
      type: "agent.lifecycle",
      at,
      threadId,
      status: state.status,
      ...stringValue(state.message) ? { message: stringValue(state.message) } : {}
    });
  }
  return events;
}
function requestReason(method) {
  if (method === "item/tool/requestUserInput") return { reason: "userInput", title: "Waiting for user input" };
  if (method === "mcpServer/elicitation/request") return { reason: "elicitation", title: "Waiting for MCP input" };
  if (method.includes("requestApproval") || method === "applyPatchApproval" || method === "execCommandApproval") {
    return { reason: "approval", title: "Waiting for approval" };
  }
  return void 0;
}
function tokenUsage(value) {
  if (!isRecord(value)) return {};
  const total = isRecord(value.total) ? value.total : value;
  return {
    ...numberValue(total.inputTokens) !== void 0 ? { inputTokens: numberValue(total.inputTokens) } : {},
    ...numberValue(total.cachedInputTokens) !== void 0 ? { cachedInputTokens: numberValue(total.cachedInputTokens) } : {},
    ...numberValue(total.outputTokens) !== void 0 ? { outputTokens: numberValue(total.outputTokens) } : {},
    ...numberValue(total.reasoningOutputTokens) !== void 0 ? { reasoningOutputTokens: numberValue(total.reasoningOutputTokens) } : {},
    ...numberValue(total.totalTokens) !== void 0 ? { totalTokens: numberValue(total.totalTokens) } : {},
    ...numberValue(value.modelContextWindow) !== void 0 ? { modelContextWindow: numberValue(value.modelContextWindow) } : {}
  };
}
function normalizeEnvelope(envelope, at = Date.now()) {
  const method = envelope.method;
  const params = isRecord(envelope.params) ? envelope.params : {};
  if (!method) return [];
  const request = requestReason(method);
  if (request && envelope.id !== void 0) {
    const threadId = stringValue(params.threadId);
    if (!threadId) return [];
    const pending = {
      id: String(envelope.id),
      agentId: threadId,
      reason: request.reason,
      title: request.title,
      ...stringValue(params.reason) ? { detail: stringValue(params.reason) } : {},
      openedAt: numberValue(params.startedAtMs) ?? at
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
          ...pending.detail ? { detail: pending.detail } : {},
          startedAt: pending.openedAt
        }
      }
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
      const error = isRecord(turn.error) ? stringValue(turn.error.message) : void 0;
      return [{
        type: "turn.completed",
        at,
        threadId,
        turnId,
        status,
        ...error ? { error } : {}
      }];
    }
    case "item/started":
    case "item/completed": {
      const item = isRecord(params.item) ? params.item : void 0;
      const threadId = stringValue(params.threadId);
      if (!item || !threadId) return [];
      const completed = method === "item/completed";
      const activity = activityFromItem(item, threadId, at, completed);
      const activityEvent = completed ? {
        type: "activity.completed",
        at,
        threadId,
        activityId: activity.id,
        activity,
        ...activity.outcome ? { outcome: activity.outcome } : {}
      } : { type: "activity.started", at, activity };
      const historyEvents = historyFromItem(
        item,
        threadId,
        at,
        completed,
        stringValue(params.turnId)
      ).map((history) => ({ type: "history.recorded", at, history }));
      return [activityEvent, ...historyEvents, ...lifecycleEvents(item, at)];
    }
    case "serverRequest/resolved": {
      const requestId = params.requestId;
      if (typeof requestId !== "string" && typeof requestId !== "number") return [];
      return [{
        type: "request.resolved",
        at,
        requestId: String(requestId),
        ...stringValue(params.threadId) ? { threadId: stringValue(params.threadId) } : {}
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
          outcome: "failed"
        },
        outcome: "failed"
      }];
    }
    default:
      return [];
  }
}
function parseEnvelope(line) {
  try {
    const parsed = JSON.parse(line);
    return isRecord(parsed) ? parsed : void 0;
  } catch {
    return void 0;
  }
}

// apps/server/src/codex-adapter.ts
var ALL_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown"
];
function messageFromError(value) {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "message" in value && typeof value.message === "string") {
    return value.message;
  }
  return "Unknown App Server error";
}
var RealCodexAdapter = class {
  mode = "codex";
  #listeners = /* @__PURE__ */ new Set();
  #child;
  #pending = /* @__PURE__ */ new Map();
  #nextId = 1;
  #connected = false;
  #connectPromise;
  #closing = false;
  #reconnectTimer;
  #attempt = 0;
  #experimental = true;
  #strategy = "experimental-descendants";
  #codexVersion = "unknown";
  runtimeInfo() {
    return {
      adapter: "codex",
      observatoryVersion: "0.1.0",
      codexCliVersion: this.#codexVersion,
      protocolGenerationVersion: "0.149.0",
      experimentalApi: this.#experimental,
      discoveryStrategy: this.#strategy
    };
  }
  async connect() {
    this.#closing = false;
    if (this.#connected) return;
    if (this.#connectPromise) return this.#connectPromise;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = void 0;
    const pending = this.#open().finally(() => {
      if (this.#connectPromise === pending) this.#connectPromise = void 0;
    });
    this.#connectPromise = pending;
    await pending;
  }
  async disconnect() {
    this.#closing = true;
    this.#connected = false;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = void 0;
    this.#child?.kill("SIGTERM");
    this.#child = void 0;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("App Server disconnected"));
    }
    this.#pending.clear();
    this.#emit({
      type: "connection.changed",
      at: Date.now(),
      connection: { phase: "disconnected", attempt: this.#attempt, message: "Disconnected" }
    });
  }
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async listThreads(options) {
    if (options?.rootThreadId && this.#experimental) {
      try {
        const descendants = await this.#pageThreads({ ancestorThreadId: options.rootThreadId });
        this.#strategy = "experimental-descendants";
        return descendants;
      } catch (error) {
        this.#experimental = false;
        this.#strategy = "compatibility";
        this.#emit({ type: "runtime.updated", at: Date.now(), runtime: this.runtimeInfo() });
        this.#debug("connection", "Experimental descendant discovery unavailable; using compatibility mode", error);
      }
    }
    const threads = await this.#pageThreads({});
    if (!options?.rootThreadId) return threads;
    const ids = /* @__PURE__ */ new Set();
    let changed = true;
    while (changed) {
      changed = false;
      for (const thread of threads) {
        if (thread.parentThreadId === options.rootThreadId || thread.parentThreadId && ids.has(thread.parentThreadId)) {
          if (!ids.has(thread.id)) {
            ids.add(thread.id);
            changed = true;
          }
        }
      }
    }
    return threads.filter((thread) => ids.has(thread.id));
  }
  async listLoadedThreads() {
    const result = await this.#request("thread/loaded/list", {});
    if (!result || typeof result !== "object" || !("data" in result) || !Array.isArray(result.data)) return [];
    return result.data.filter((id) => typeof id === "string");
  }
  async readThread(threadId, options) {
    const result = await this.#request("thread/read", {
      threadId,
      includeTurns: options?.includeTurns ?? false
    });
    const thread = result && typeof result === "object" && "thread" in result ? toThreadSnapshot(result.thread) : void 0;
    if (!thread) throw new Error(`Invalid thread/read response for ${threadId}`);
    return thread;
  }
  async #open() {
    this.#emit({
      type: "connection.changed",
      at: Date.now(),
      connection: {
        phase: this.#attempt === 0 ? "connecting" : "reconnecting",
        attempt: this.#attempt,
        message: "Connecting to Codex App Server"
      }
    });
    const version = spawnSync("codex", ["--version"], { encoding: "utf8" });
    this.#codexVersion = version.stdout.trim().replace(/^codex-cli\s+/, "") || "unknown";
    const transport = process.env.OBSERVATORY_CODEX_TRANSPORT ?? "standalone";
    const args = transport === "proxy" ? ["app-server", "proxy"] : ["app-server"];
    const child = spawn("codex", args, { stdio: ["pipe", "pipe", "pipe"] });
    this.#child = child;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.#onLine(line));
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) this.#debug("protocol", text);
    });
    child.once("exit", (code, signal) => this.#onExit(code, signal));
    try {
      await this.#request("initialize", {
        clientInfo: {
          name: "codex_agent_observatory",
          title: "Codex Agent Observatory",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false
        }
      });
      this.#send({ method: "initialized", params: {} });
      this.#connected = true;
      this.#attempt = 0;
      this.#emit({
        type: "connection.changed",
        at: Date.now(),
        connection: {
          phase: "connected",
          attempt: 0,
          message: args.at(-1) === "proxy" ? "Connected through App Server daemon" : "Connected to child App Server"
        }
      });
      this.#emit({ type: "runtime.updated", at: Date.now(), runtime: this.runtimeInfo() });
      await this.#refreshDiscovery();
    } catch (error) {
      child.kill("SIGTERM");
      throw error;
    }
  }
  async #refreshDiscovery() {
    const rootThreadId = process.env.OBSERVATORY_ROOT_THREAD_ID;
    const threads = rootThreadId ? [await this.readThread(rootThreadId), ...await this.listThreads({ rootThreadId })] : await this.listThreads();
    for (const thread of threads) this.#emit({ type: "thread.discovered", at: Date.now(), thread });
  }
  async #pageThreads(extra) {
    const all = [];
    const configuredCwd = process.env.OBSERVATORY_CWD ?? process.env.INIT_CWD ?? process.cwd();
    let cursor = null;
    do {
      const result = await this.#request("thread/list", {
        ...extra,
        cursor,
        limit: 100,
        sourceKinds: ALL_SOURCE_KINDS,
        archived: false
      });
      if (!result || typeof result !== "object") break;
      const data = "data" in result && Array.isArray(result.data) ? result.data : [];
      for (const value of data) {
        const thread = toThreadSnapshot(value);
        if (thread) all.push(thread);
      }
      cursor = "nextCursor" in result && typeof result.nextCursor === "string" ? result.nextCursor : null;
    } while (cursor);
    return configuredCwd === "all" || "ancestorThreadId" in extra ? all : all.filter((thread) => thread.cwd === configuredCwd);
  }
  #request(method, params) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after 10 seconds`));
      }, 1e4);
      this.#pending.set(id, { resolve, reject, timeout });
      try {
        this.#send({ method, id, params });
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  #send(envelope) {
    if (!this.#child?.stdin.writable) throw new Error("Codex App Server stdin is not writable");
    this.#child.stdin.write(`${JSON.stringify(envelope)}
`);
    this.#debug("protocol", `\u2192 ${envelope.method ?? "response"}`, envelope, "out");
  }
  #onLine(line) {
    const envelope = parseEnvelope(line);
    if (!envelope) {
      this.#debug("malformed", "Malformed JSONL message", line);
      return;
    }
    this.#debug("protocol", `\u2190 ${envelope.method ?? "response"}`, envelope);
    if (envelope.id !== void 0 && !envelope.method) {
      const pending = this.#pending.get(envelope.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.#pending.delete(envelope.id);
        if (envelope.error !== void 0) pending.reject(new Error(messageFromError(envelope.error)));
        else pending.resolve(envelope.result);
      }
      return;
    }
    for (const event of normalizeEnvelope(envelope)) {
      this.#emit(event);
      this.#debug("normalized", event.type, event);
    }
  }
  #onExit(code, signal) {
    this.#connected = false;
    this.#child = void 0;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Codex App Server exited"));
    }
    this.#pending.clear();
    if (this.#closing) return;
    this.#attempt += 1;
    const base = Math.min(15e3, 500 * 2 ** Math.min(this.#attempt - 1, 5));
    const delay = base + Math.floor(Math.random() * Math.max(1, base * 0.2));
    this.#emit({
      type: "connection.changed",
      at: Date.now(),
      connection: {
        phase: "reconnecting",
        attempt: this.#attempt,
        message: `App Server exited (${code ?? signal ?? "unknown"})`,
        nextRetryAt: Date.now() + delay
      }
    });
    this.#reconnectTimer = setTimeout(() => {
      void this.connect().catch((error) => {
        this.#debug("connection", "Reconnect failed", error);
      });
    }, delay);
  }
  #emit(event) {
    for (const listener of this.#listeners) listener(event);
  }
  #debug(category, summary, payload, direction = "in") {
    this.#emit({
      type: "debug",
      at: Date.now(),
      entry: {
        id: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
        at: Date.now(),
        direction: category === "connection" ? "internal" : direction,
        category,
        summary,
        ...payload !== void 0 ? { payload } : {}
      }
    });
  }
};

// apps/server/src/http-server.ts
import { createServer } from "node:http";

// packages/observatory-core/src/projector.ts
var DEFAULT_ACTIVITY_LIMIT = 300;
var DEFAULT_HISTORY_LIMIT = 500;
var DEFAULT_DEBUG_LIMIT = 150;
var RECENT_ACTIVITY_LIMIT = 30;
function projectNativeStatus(status) {
  switch (status.type) {
    case "active": {
      const waitingReasons = [];
      if (status.activeFlags.includes("waitingOnApproval")) {
        waitingReasons.push("approval");
      }
      if (status.activeFlags.includes("waitingOnUserInput")) {
        waitingReasons.push("userInput");
      }
      return {
        status: waitingReasons.length > 0 ? "waiting" : "working",
        waitingReasons
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
function createInitialState(runtime, now = Date.now()) {
  return {
    agents: {},
    activities: [],
    history: [],
    pendingRequests: {},
    connection: { phase: "connecting", attempt: 0 },
    runtime,
    debug: [],
    startedAt: now,
    revision: 0
  };
}
function agentFromThread(thread) {
  const projected = projectNativeStatus(thread.nativeStatus);
  return {
    id: thread.id,
    threadId: thread.id,
    ...thread.parentThreadId ? { parentId: thread.parentThreadId } : {},
    ...thread.sessionId ? { sessionId: thread.sessionId } : {},
    ...thread.nickname ? { nickname: thread.nickname } : {},
    ...thread.role ? { role: thread.role } : {},
    status: projected.status,
    nativeStatus: thread.nativeStatus,
    waitingReasons: projected.waitingReasons,
    ...thread.createdAt ? { startedAt: thread.createdAt } : {},
    ...thread.updatedAt ? { updatedAt: thread.updatedAt } : {},
    recentActivityIds: [],
    children: [],
    ...thread.cwd ? { cwd: thread.cwd } : {},
    ...thread.model ? { model: thread.model } : {},
    ...thread.modelProvider ? { modelProvider: thread.modelProvider } : {},
    ...thread.reasoningEffort ? { reasoningEffort: thread.reasoningEffort } : {},
    ...thread.observedSkills ? { observedSkills: thread.observedSkills } : {},
    ...thread.observedWorkflows ? { observedWorkflows: thread.observedWorkflows } : {},
    ...thread.collaborationMode ? { collaborationMode: thread.collaborationMode } : {},
    ...thread.source !== void 0 ? { source: thread.source } : {},
    ...thread.depth !== void 0 ? { depth: thread.depth } : {},
    ...thread.path ? { path: thread.path } : {}
  };
}
function ensureAgent(state, threadId, at) {
  return state.agents[threadId] ?? {
    id: threadId,
    threadId,
    status: "unknown",
    waitingReasons: [],
    updatedAt: at,
    recentActivityIds: [],
    children: []
  };
}
function waitingReasonsFromRequests(state, threadId) {
  return Array.from(
    new Set(
      Object.values(state.pendingRequests).filter((request) => request.agentId === threadId).map((request) => request.reason)
    )
  );
}
function rebuildChildren(agents) {
  const next = Object.fromEntries(
    Object.entries(agents).map(([id, agent]) => [id, { ...agent, children: [] }])
  );
  for (const agent of Object.values(next)) {
    if (!agent.parentId) continue;
    const parent = next[agent.parentId];
    if (parent && !parent.children.includes(agent.id)) parent.children.push(agent.id);
  }
  for (const agent of Object.values(next)) agent.children.sort();
  return next;
}
function agentActor(id) {
  return { type: "agent", id };
}
function recordHistory(state, history, limit) {
  return [history, ...state.history.filter((item) => item.id !== history.id)].slice(0, limit);
}
function boundedHistoryContent(content) {
  if (!content) return void 0;
  return content.length > 2e3 ? `${content.slice(0, 1999)}\u2026` : content;
}
function resolveHistoryRecipients(state, history) {
  if (history.kind !== "delivery" || history.actor.type !== "agent" || !history.actor.id) return history;
  if (history.recipients?.length !== 1 || history.recipients[0]?.type !== "human") return history;
  const parentId = state.agents[history.actor.id]?.parentId;
  return parentId ? { ...history, recipients: [agentActor(parentId)] } : history;
}
function activityHistory(activity, status) {
  if (activity.kind === "approval") return void 0;
  const content = boundedHistoryContent(activity.detail);
  return {
    id: `activity:${activity.id}`,
    kind: activity.kind === "message" ? "delivery" : "work",
    actor: agentActor(activity.agentId),
    ...activity.kind === "message" ? { recipients: [{ type: "human" }] } : {},
    summary: activity.title,
    ...content ? { content } : {},
    status,
    correlationId: activity.id,
    occurredAt: activity.startedAt,
    source: "derived"
  };
}
function reduceEvent(state, event, limits = {
  activities: DEFAULT_ACTIVITY_LIMIT,
  debug: DEFAULT_DEBUG_LIMIT,
  history: DEFAULT_HISTORY_LIMIT
}) {
  const historyLimit = limits.history ?? DEFAULT_HISTORY_LIMIT;
  let next = {
    ...state,
    agents: { ...state.agents },
    pendingRequests: { ...state.pendingRequests },
    revision: state.revision + 1
  };
  switch (event.type) {
    case "thread.discovered": {
      const previous = state.agents[event.thread.id];
      const discovered = agentFromThread(event.thread);
      if (previous) {
        const terminal = previous.completionEvidence !== void 0;
        next.agents[event.thread.id] = {
          ...previous,
          ...discovered,
          ...terminal ? { status: previous.status, waitingReasons: [] } : {},
          recentActivityIds: previous.recentActivityIds,
          currentActivityId: previous.currentActivityId,
          completionEvidence: previous.completionEvidence,
          completedAt: previous.completedAt
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
          ...event.thread.role ? { content: event.thread.role } : {},
          status: "started",
          correlationId: event.thread.id,
          occurredAt: event.at,
          source: "derived"
        }, historyLimit);
      }
      break;
    }
    case "thread.status": {
      const previous = ensureAgent(state, event.threadId, event.at);
      const projected = projectNativeStatus(event.status);
      const explicitTerminal = previous.completionEvidence !== void 0;
      next.agents[event.threadId] = {
        ...previous,
        nativeStatus: event.status,
        status: explicitTerminal ? previous.status : projected.status,
        waitingReasons: explicitTerminal ? [] : projected.waitingReasons,
        updatedAt: event.at
      };
      break;
    }
    case "agent.lifecycle": {
      const previous = ensureAgent(state, event.threadId, event.at);
      const mapped = { updatedAt: event.at };
      if (event.status === "completed") {
        Object.assign(mapped, {
          status: "completed",
          completedAt: event.at,
          currentActivityId: void 0,
          waitingReasons: [],
          completionEvidence: "collab-completed"
        });
      } else if (event.status === "errored") {
        Object.assign(mapped, {
          status: "failed",
          completedAt: event.at,
          currentActivityId: void 0,
          waitingReasons: [],
          completionEvidence: "collab-errored"
        });
      } else if (event.status === "running" || event.status === "pendingInit") {
        Object.assign(mapped, {
          status: "working",
          waitingReasons: [],
          completionEvidence: void 0,
          completedAt: void 0
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
          ...event.message ? { content: event.message } : {},
          status: failed ? "failed" : event.status === "interrupted" ? "interrupted" : "completed",
          occurredAt: event.at,
          source: "derived"
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
        completionEvidence: void 0,
        completedAt: void 0,
        updatedAt: event.at
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
        source: "derived"
      }, historyLimit);
      break;
    }
    case "turn.completed": {
      const previous = ensureAgent(state, event.threadId, event.at);
      next.agents[event.threadId] = {
        ...previous,
        ...event.status === "failed" ? {
          status: "failed",
          completionEvidence: "turn-failed"
        } : {},
        currentTurnId: void 0,
        currentActivityId: void 0,
        updatedAt: event.at
      };
      next.history = recordHistory(state, {
        id: `turn-completed:${event.turnId}`,
        kind: "completion",
        actor: agentActor(event.threadId),
        summary: event.status === "failed" ? "Work failed" : event.status === "interrupted" ? "Work interrupted" : "Work completed",
        ...event.error ? { content: event.error } : {},
        status: event.status === "failed" ? "failed" : event.status === "interrupted" ? "interrupted" : "completed",
        turnId: event.turnId,
        correlationId: event.turnId,
        parentEventId: `turn:${event.turnId}`,
        occurredAt: event.at,
        source: "derived"
      }, historyLimit);
      break;
    }
    case "activity.started": {
      const previous = ensureAgent(state, event.activity.agentId, event.at);
      next.activities = [event.activity, ...state.activities.filter((item) => item.id !== event.activity.id)].slice(
        0,
        limits.activities
      );
      next.agents[event.activity.agentId] = {
        ...previous,
        currentActivityId: event.activity.id,
        recentActivityIds: [
          event.activity.id,
          ...previous.recentActivityIds.filter((id) => id !== event.activity.id)
        ].slice(0, RECENT_ACTIVITY_LIMIT),
        updatedAt: event.at
      };
      const startedHistory = activityHistory(event.activity, "running");
      if (startedHistory) next.history = recordHistory(state, startedHistory, historyLimit);
      break;
    }
    case "activity.completed": {
      const previous = ensureAgent(state, event.threadId, event.at);
      const existing = state.activities.find((activity) => activity.id === event.activityId);
      const completed = event.activity ?? (existing ? { ...existing, completedAt: event.at, ...event.outcome ? { outcome: event.outcome } : {} } : void 0);
      next.activities = completed ? [completed, ...state.activities.filter((item) => item.id !== completed.id)].slice(0, limits.activities) : state.activities;
      next.agents[event.threadId] = {
        ...previous,
        ...previous.currentActivityId === event.activityId ? { currentActivityId: void 0 } : {},
        updatedAt: event.at
      };
      if (completed) {
        const status = completed.outcome === "failed" || completed.outcome === "declined" ? "failed" : completed.outcome === "interrupted" ? "interrupted" : "completed";
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
      const reasons = Array.from(/* @__PURE__ */ new Set([...previous.waitingReasons, event.request.reason]));
      next.agents[event.request.agentId] = {
        ...previous,
        status: "waiting",
        waitingReasons: reasons,
        updatedAt: event.at
      };
      next.history = recordHistory(state, {
        id: `request:${event.request.id}`,
        kind: "request",
        actor: agentActor(event.request.agentId),
        recipients: [{ type: "human" }],
        summary: event.request.title,
        ...event.request.detail ? { content: event.request.detail } : {},
        status: "running",
        correlationId: event.request.id,
        occurredAt: event.request.openedAt,
        source: "derived"
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
          updatedAt: event.at
        };
      }
      if (request) {
        next.history = recordHistory(state, {
          id: `request:${event.requestId}`,
          kind: "request",
          actor: agentActor(request.agentId),
          recipients: [{ type: "human" }],
          summary: request.title,
          ...request.detail ? { content: request.detail } : {},
          status: "completed",
          correlationId: request.id,
          occurredAt: request.openedAt,
          source: "derived"
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
function buildGraph(agents) {
  const roots = [];
  const edges = [];
  for (const agent of Object.values(agents)) {
    if (agent.parentId && agents[agent.parentId]) {
      edges.push({
        id: `${agent.parentId}->${agent.id}`,
        source: agent.parentId,
        target: agent.id
      });
    } else {
      roots.push(agent.id);
    }
  }
  roots.sort((a, b) => (agents[a]?.startedAt ?? 0) - (agents[b]?.startedAt ?? 0));
  return { roots, edges };
}
function toSnapshot(state) {
  return { ...state, ...buildGraph(state.agents) };
}

// packages/observatory-core/src/store.ts
var ObservatoryStore = class {
  #state;
  #listeners = /* @__PURE__ */ new Set();
  constructor(runtime, now) {
    this.#state = createInitialState(runtime, now);
  }
  apply(event) {
    this.#state = reduceEvent(this.#state, event);
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot, event);
    return snapshot;
  }
  snapshot() {
    return toSnapshot(this.#state);
  }
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
};

// apps/server/src/http/public-payload.ts
function publicSnapshot(snapshot) {
  return { ...snapshot, debug: snapshot.debug.map(({ payload: _payload, ...entry }) => entry) };
}
function publicEvent(event) {
  if (event.type !== "debug") return event;
  const { payload: _payload, ...entry } = event.entry;
  return { ...event, entry };
}

// apps/server/src/http/request-security.ts
var securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY"
};
function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    ...securityHeaders,
    "content-type": "application/json; charset=utf-8",
    ...headers
  });
  response.end(JSON.stringify(body));
}
function requestAuthority(request) {
  const host = request.headers.host;
  if (!host || Array.isArray(host)) return void 0;
  const port2 = request.socket.localPort;
  if (!port2) return void 0;
  const allowed = port2 === 80 ? ["127.0.0.1", "localhost", "127.0.0.1:80", "localhost:80"] : [`127.0.0.1:${port2}`, `localhost:${port2}`];
  return allowed.includes(host) ? new URL(`http://${host}`).origin : void 0;
}
function hasTrustedOrigin(request, authority, devWebOrigins2 = [], requireOrigin = false) {
  const origin = request.headers.origin;
  if (!origin) return !requireOrigin;
  return origin === authority || devWebOrigins2.includes(origin);
}
function rejectUpgrade(socket, status) {
  const reason = status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Not Found";
  socket.end(`HTTP/1.1 ${status} ${reason}\r
Connection: close\r
Cache-Control: no-store\r
Content-Length: 0\r
\r
`);
}

// apps/server/src/http/session-auth.ts
import { timingSafeEqual } from "node:crypto";
var OBSERVATORY_SESSION_COOKIE = "observatory_session";
function tokenMatches(provided, expected) {
  if (!provided) return false;
  const actualBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}
function sessionToken(request) {
  const cookie = request.headers.cookie;
  if (!cookie) return void 0;
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== OBSERVATORY_SESSION_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return void 0;
    }
  }
  return void 0;
}
function hasSession(request, accessToken2) {
  return tokenMatches(sessionToken(request), accessToken2);
}
function handleSessionBootstrap(requestUrl, response, accessToken2, redirectLocation) {
  if (requestUrl.pathname !== "/" || !requestUrl.searchParams.has("token")) return false;
  if (!tokenMatches(requestUrl.searchParams.get("token") ?? void 0, accessToken2)) {
    sendJson(response, 401, { error: "Unauthorized" }, { "www-authenticate": "ObservatoryBootstrap" });
    return true;
  }
  response.writeHead(302, {
    ...securityHeaders,
    location: redirectLocation,
    "set-cookie": `${OBSERVATORY_SESSION_COOKIE}=${encodeURIComponent(accessToken2)}; HttpOnly; SameSite=Strict; Path=/`
  });
  response.end();
  return true;
}

// apps/server/src/http/api-router.ts
function handleApiRequest(request, response, requestUrl, options) {
  if (requestUrl.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, connection: options.store.snapshot().connection });
    return true;
  }
  if (requestUrl.pathname === "/api/snapshot") {
    if (!hasSession(request, options.accessToken)) {
      sendJson(response, 401, { error: "Unauthorized" }, { "www-authenticate": "ObservatorySession" });
      return true;
    }
    sendJson(response, 200, publicSnapshot(options.store.snapshot()));
    return true;
  }
  if (requestUrl.pathname === "/api/retry" && request.method === "POST") {
    if (!hasSession(request, options.accessToken)) {
      sendJson(response, 401, { error: "Unauthorized" }, { "www-authenticate": "ObservatorySession" });
      return true;
    }
    if (!options.retryAllowed()) {
      sendJson(response, 429, { error: "Retry rate limit exceeded" }, {
        "retry-after": String(options.retryAfterSeconds)
      });
      return true;
    }
    void options.connectAdapter().catch(() => void 0);
    sendJson(response, 202, { accepted: true });
    return true;
  }
  if (!requestUrl.pathname.startsWith("/api/")) return false;
  sendJson(response, 404, { error: "Not found" });
  return true;
}

// apps/server/src/http/static-files.ts
import { createReadStream, existsSync } from "node:fs";
import path, { extname } from "node:path";
var contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8"
};
function isPathWithin(root, candidate, pathOperations = path) {
  const relativePath = pathOperations.relative(pathOperations.resolve(root), pathOperations.resolve(candidate));
  return relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${pathOperations.sep}`) && !pathOperations.isAbsolute(relativePath);
}
function serveWebAsset(response, requestUrl, webDist2) {
  if (!existsSync(webDist2)) {
    sendJson(response, 404, { error: "Web build not found. Run the Vite development server." });
    return;
  }
  const relative = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
  const candidate = path.resolve(webDist2, relative);
  const safePath = isPathWithin(webDist2, candidate) && existsSync(candidate) ? candidate : path.resolve(webDist2, "index.html");
  response.writeHead(200, {
    ...securityHeaders,
    "cache-control": safePath.endsWith("index.html") ? "no-store" : "public, max-age=3600",
    "content-type": contentTypes[extname(safePath)] ?? "application/octet-stream"
  });
  createReadStream(safePath).pipe(response);
}

// apps/server/src/http/websocket-server.ts
import { WebSocket, WebSocketServer } from "ws";
var MAX_WEBSOCKET_PAYLOAD_BYTES = 8 * 1024;
function createWebSocketTransport(options) {
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES });
  options.server.on("upgrade", (request, socket, head) => {
    const authority = requestAuthority(request);
    if (!authority || !hasTrustedOrigin(request, authority, options.devWebOrigins, true)) {
      rejectUpgrade(socket, 403);
      return;
    }
    const requestUrl = new URL(request.url ?? "/", authority);
    if (requestUrl.pathname !== "/ws") {
      rejectUpgrade(socket, 404);
      return;
    }
    if (!hasSession(request, options.accessToken)) {
      rejectUpgrade(socket, 401);
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (client) => webSockets.emit("connection", client, request));
  });
  webSockets.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "snapshot", snapshot: publicSnapshot(options.store.snapshot()) }));
    socket.on("error", () => void 0);
    socket.on("message", (message) => {
      try {
        const parsed = JSON.parse(message.toString());
        if (typeof parsed === "object" && parsed !== null && "type" in parsed && parsed.type === "retry" && options.retryAllowed()) {
          void options.connectAdapter().catch(() => void 0);
        }
      } catch {
      }
    });
  });
  return webSockets;
}
function broadcastSnapshot(webSockets, payload) {
  for (const client of webSockets.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

// apps/server/src/http-server.ts
var DEFAULT_RETRY_WINDOW_MS = 1e3;
function createObservatoryHttpServer(options) {
  const { accessToken: accessToken2, adapter: adapter2, webDist: webDist2, devWebOrigins: devWebOrigins2 } = options;
  const retryWindowMs = options.retryWindowMs ?? DEFAULT_RETRY_WINDOW_MS;
  const store = new ObservatoryStore(adapter2.runtimeInfo());
  let connectPromise;
  let connectedOnce = false;
  let lastRetryAt = Number.NEGATIVE_INFINITY;
  function connectAdapter2() {
    if (connectedOnce) return Promise.resolve();
    if (connectPromise) return connectPromise;
    const pending = adapter2.connect().then(() => {
      connectedOnce = true;
    }).catch((error) => {
      store.apply({
        type: "connection.changed",
        at: Date.now(),
        connection: {
          phase: "disconnected",
          attempt: 0,
          message: error instanceof Error ? error.message : String(error)
        }
      });
      throw error;
    }).finally(() => {
      if (connectPromise === pending) connectPromise = void 0;
    });
    connectPromise = pending;
    return pending;
  }
  function retryAllowed() {
    const now = Date.now();
    if (now - lastRetryAt < retryWindowMs) return false;
    lastRetryAt = now;
    return true;
  }
  adapter2.subscribe((event) => {
    if (event.type === "connection.changed") {
      if (event.connection.phase === "connected") connectedOnce = true;
      if (event.connection.phase === "disconnected" || event.connection.phase === "reconnecting") connectedOnce = false;
    }
    store.apply(event);
  });
  const server2 = createServer((request, response) => {
    const authority = requestAuthority(request);
    if (!authority || !hasTrustedOrigin(request, authority, devWebOrigins2)) {
      sendJson(response, 403, { error: "Forbidden" });
      return;
    }
    const requestUrl = new URL(request.url ?? "/", authority);
    if (handleSessionBootstrap(requestUrl, response, accessToken2, devWebOrigins2?.[0] ?? "/")) return;
    if (handleApiRequest(request, response, requestUrl, {
      accessToken: accessToken2,
      connectAdapter: connectAdapter2,
      retryAllowed,
      retryAfterSeconds: Math.max(1, Math.ceil(retryWindowMs / 1e3)),
      store
    })) return;
    if (requestUrl.pathname === "/" && devWebOrigins2?.[0] && hasSession(request, accessToken2)) {
      response.writeHead(302, { ...securityHeaders, location: devWebOrigins2[0] });
      response.end();
      return;
    }
    serveWebAsset(response, requestUrl, webDist2);
  });
  const webSockets = createWebSocketTransport({
    accessToken: accessToken2,
    connectAdapter: connectAdapter2,
    devWebOrigins: devWebOrigins2,
    retryAllowed,
    server: server2,
    store
  });
  store.subscribe((snapshot, event) => {
    broadcastSnapshot(webSockets, JSON.stringify({
      type: "snapshot",
      snapshot: publicSnapshot(snapshot),
      event: publicEvent(event)
    }));
  });
  return { server: server2, webSockets, connectAdapter: connectAdapter2, store };
}

// apps/server/src/mock-adapter.ts
var active = (flags = []) => ({ type: "active", activeFlags: flags });
function baseThread(id, nickname, role, nativeStatus, parentThreadId, depth = 0) {
  const now = Date.now();
  return {
    id,
    sessionId: "mock-session",
    ...parentThreadId ? { parentThreadId } : {},
    nickname,
    role,
    nativeStatus,
    createdAt: now - Math.max(1, 7 - depth) * 42e3,
    updatedAt: now,
    cwd: "/projects/codex-agent-observatory",
    model: depth === 0 ? "gpt-5.6-sol" : "gpt-5.6-terra",
    modelProvider: "openai",
    reasoningEffort: depth === 0 ? "high" : "medium",
    observedSkills: depth === 0 ? [] : [`mock-${role}`],
    observedWorkflows: ["Mock lifecycle"],
    collaborationMode: "default",
    source: parentThreadId ? { subAgent: { thread_spawn: { parent_thread_id: parentThreadId, depth } } } : "cli",
    depth,
    path: parentThreadId ? `/root/${nickname.toLowerCase()}` : "/root"
  };
}
var MockCodexAdapter = class {
  mode = "mock";
  #scenario;
  #threads = /* @__PURE__ */ new Map();
  #listeners = /* @__PURE__ */ new Set();
  #timers = [];
  #connected = false;
  constructor(scenario = "a") {
    this.#scenario = scenario === "b" || scenario === "stress" ? scenario : "a";
    const root = baseThread("mock-main", "Main", "root", active());
    this.#threads.set(root.id, root);
    if (this.#scenario === "b") this.#seedScenarioB();
    if (this.#scenario === "stress") this.#seedStress();
  }
  runtimeInfo() {
    return {
      adapter: "mock",
      observatoryVersion: "0.1.0",
      protocolGenerationVersion: "0.149.0",
      experimentalApi: false,
      discoveryStrategy: "mock",
      scenario: this.#scenario
    };
  }
  async connect() {
    if (this.#connected) return;
    this.#connected = true;
    for (const thread of this.#threads.values()) {
      this.#emit({ type: "thread.discovered", at: Date.now(), thread });
    }
    this.#emit({
      type: "connection.changed",
      at: Date.now(),
      connection: { phase: "connected", attempt: 0, message: `Mock scenario ${this.#scenario.toUpperCase()}` }
    });
    if (this.#scenario === "a") {
      const now = Date.now();
      this.#history({
        id: "mock-request",
        kind: "request",
        actor: { type: "human" },
        recipients: [{ type: "agent", id: "mock-main" }],
        summary: "Request received",
        content: "Inspect the Codex agent run and report verified results.",
        status: "completed",
        occurredAt: now,
        source: "mock"
      });
      this.#history({
        id: "mock-decision",
        kind: "decision",
        actor: { type: "agent", id: "mock-main" },
        summary: "Plan updated",
        content: "Research the protocol, implement the projector, then verify it in the browser.",
        status: "completed",
        occurredAt: now + 1,
        source: "mock"
      });
      this.#runScenarioA();
    }
    if (this.#scenario === "b") this.#runScenarioB();
    if (this.#scenario === "stress") this.#runStress();
  }
  async disconnect() {
    this.#connected = false;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers = [];
    this.#emit({
      type: "connection.changed",
      at: Date.now(),
      connection: { phase: "disconnected", attempt: 0, message: "Mock stream stopped" }
    });
  }
  async listThreads(options) {
    const threads = Array.from(this.#threads.values());
    if (!options?.rootThreadId) return threads;
    const descendants = /* @__PURE__ */ new Set();
    let changed = true;
    while (changed) {
      changed = false;
      for (const thread of threads) {
        if (thread.parentThreadId === options.rootThreadId || thread.parentThreadId && descendants.has(thread.parentThreadId)) {
          if (!descendants.has(thread.id)) {
            descendants.add(thread.id);
            changed = true;
          }
        }
      }
    }
    return threads.filter((thread) => descendants.has(thread.id));
  }
  async listLoadedThreads() {
    return Array.from(this.#threads.values()).filter((thread) => thread.nativeStatus.type !== "notLoaded").map((thread) => thread.id);
  }
  async readThread(threadId, _options) {
    const thread = this.#threads.get(threadId);
    if (!thread) throw new Error(`Mock thread not found: ${threadId}`);
    return thread;
  }
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #emit(event) {
    for (const listener of this.#listeners) listener(event);
  }
  #schedule(delay, action) {
    this.#timers.push(setTimeout(() => this.#connected && action(), delay));
  }
  #discover(thread) {
    this.#threads.set(thread.id, thread);
    this.#emit({ type: "thread.discovered", at: Date.now(), thread });
  }
  #activity(agentId, id, kind, title, detail) {
    const now = Date.now();
    this.#emit({
      type: "activity.started",
      at: now,
      activity: { id, agentId, kind, title, ...detail ? { detail } : {}, startedAt: now }
    });
  }
  #history(history) {
    this.#emit({ type: "history.recorded", at: history.occurredAt, history });
  }
  #runScenarioA() {
    this.#schedule(500, () => {
      this.#discover(baseThread("mock-researcher", "Researcher", "research", active(), "mock-main", 1));
      this.#history({
        id: "mock-research-handoff",
        kind: "handoff",
        actor: { type: "agent", id: "mock-main" },
        recipients: [{ type: "agent", id: "mock-researcher" }],
        summary: "Delegated work",
        content: "Identify the protocol events needed for agent status projection.",
        status: "sent",
        occurredAt: Date.now(),
        source: "mock"
      });
      this.#activity("mock-researcher", "research-web", "tool", "Searching Codex protocol", "thread/status/changed");
    });
    this.#schedule(1100, () => {
      this.#discover(baseThread("mock-implementer", "Implementer", "implementation", active(), "mock-main", 1));
      this.#activity("mock-implementer", "edit-store", "write", "Editing AgentStore.ts", "packages/core/AgentStore.ts");
    });
    this.#schedule(3e3, () => {
      this.#emit({ type: "agent.lifecycle", at: Date.now(), threadId: "mock-researcher", status: "completed" });
      this.#emit({
        type: "activity.completed",
        at: Date.now(),
        threadId: "mock-researcher",
        activityId: "research-web",
        outcome: "completed"
      });
      this.#history({
        id: "mock-research-delivery",
        kind: "delivery",
        actor: { type: "agent", id: "mock-researcher" },
        recipients: [{ type: "agent", id: "mock-main" }],
        summary: "Reported result",
        content: "Confirmed thread/status/changed as the primary native status signal.",
        status: "completed",
        occurredAt: Date.now(),
        source: "mock"
      });
    });
    this.#schedule(3800, () => {
      this.#discover(baseThread("mock-tester", "Tester", "testing", active(), "mock-main", 1));
      this.#activity("mock-tester", "run-tests", "test", "Running vitest", "bun run test");
    });
    this.#schedule(5100, () => {
      this.#emit({
        type: "request.opened",
        at: Date.now(),
        request: {
          id: "mock-approval",
          agentId: "mock-tester",
          reason: "approval",
          title: "Waiting for approval",
          detail: "Run browser outside sandbox",
          openedAt: Date.now()
        }
      });
    });
    this.#schedule(8e3, () => {
      this.#emit({ type: "request.resolved", at: Date.now(), requestId: "mock-approval", threadId: "mock-tester" });
      this.#activity("mock-tester", "browser-e2e", "test", "Running Playwright", "mock runtime lifecycle");
    });
    this.#schedule(10500, () => {
      this.#emit({ type: "agent.lifecycle", at: Date.now(), threadId: "mock-tester", status: "completed" });
      this.#emit({ type: "agent.lifecycle", at: Date.now(), threadId: "mock-implementer", status: "completed" });
      this.#history({
        id: "mock-final-delivery",
        kind: "delivery",
        actor: { type: "agent", id: "mock-main" },
        recipients: [{ type: "human" }],
        summary: "Delivered final result",
        content: "Implementation and browser verification completed.",
        status: "completed",
        occurredAt: Date.now(),
        source: "mock"
      });
    });
  }
  #seedScenarioB() {
    const entries = [
      baseThread("mock-frontend", "Frontend", "frontend", active(), "mock-main", 1),
      baseThread("mock-test", "Test", "testing", active(), "mock-frontend", 2),
      baseThread("mock-backend", "Backend", "backend", { type: "idle" }, "mock-main", 1),
      baseThread("mock-reviewer", "Reviewer", "review", { type: "systemError" }, "mock-main", 1)
    ];
    for (const entry of entries) this.#threads.set(entry.id, entry);
  }
  #runScenarioB() {
    this.#schedule(300, () => this.#activity("mock-frontend", "front-edit", "write", "Editing Dashboard.tsx"));
    this.#schedule(700, () => this.#activity("mock-test", "test-unit", "test", "Running component tests"));
    this.#schedule(
      1200,
      () => this.#emit({ type: "agent.lifecycle", at: Date.now(), threadId: "mock-backend", status: "completed" })
    );
    this.#schedule(
      1400,
      () => this.#activity("mock-reviewer", "review-error", "error", "Review failed", "Malformed tool response")
    );
  }
  #seedStress() {
    for (let index = 1; index <= 35; index += 1) {
      const parent = index <= 6 ? "mock-main" : `mock-agent-${(index - 1) % 6 + 1}`;
      const status = index % 7 === 0 ? { type: "idle" } : active();
      const thread = baseThread(`mock-agent-${index}`, `Agent ${index}`, index % 3 === 0 ? "testing" : "worker", status, parent, index <= 6 ? 1 : 2);
      this.#threads.set(thread.id, thread);
    }
  }
  #runStress() {
    let tick = 0;
    const timer = setInterval(() => {
      if (!this.#connected) return;
      tick += 1;
      const index = tick % 35 + 1;
      const threadId = `mock-agent-${index}`;
      const waiting = tick % 5 === 0;
      this.#emit({
        type: "thread.status",
        at: Date.now(),
        threadId,
        status: waiting ? active(["waitingOnUserInput"]) : active()
      });
      this.#activity(threadId, `stress-${tick}`, tick % 3 === 0 ? "test" : "command", tick % 3 === 0 ? "Running tests" : "Running command", `task ${tick}`);
    }, 900);
    this.#timers.push(timer);
  }
};

// apps/server/src/shared-state-adapter.ts
import {
  closeSync,
  existsSync as existsSync2,
  fstatSync,
  openSync,
  readSync,
  readdirSync as readdirSync2,
  statSync,
  watch
} from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";
import { spawnSync as spawnSync3 } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

// apps/server/src/process-discovery.ts
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { spawnSync as spawnSync2 } from "node:child_process";
import { basename, join, win32 } from "node:path";
var NON_INTERACTIVE_COMMANDS = /* @__PURE__ */ new Set([
  "agents",
  "app-server",
  "apply",
  "archive",
  "cloud",
  "completion",
  "debug",
  "delete",
  "doctor",
  "exec",
  "exec-server",
  "features",
  "login",
  "logout",
  "mcp",
  "mcp-server",
  "plugin",
  "queue",
  "remote-control",
  "review",
  "sandbox",
  "unarchive",
  "update"
]);
var OPTIONS_WITH_VALUES = /* @__PURE__ */ new Set([
  "-a",
  "--add-dir",
  "--ask-for-approval",
  "-c",
  "--cd",
  "--config",
  "-C",
  "-i",
  "--image",
  "--local-provider",
  "-m",
  "--model",
  "-p",
  "--profile",
  "--remote",
  "--remote-auth-token-env",
  "-s",
  "--sandbox"
]);
function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}
function splitProcessCommandLine(commandLine) {
  const tokens = [];
  const pattern = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  for (const match of commandLine.matchAll(pattern)) {
    tokens.push((match[1] ?? match[2] ?? match[3] ?? "").replace(/\\"/g, '"'));
  }
  return tokens;
}
function codexInvocation(commandLine, platform) {
  const tokens = splitProcessCommandLine(commandLine);
  const codexIndex = tokens.findIndex((token) => {
    const name = (platform === "win32" ? win32.basename(token) : basename(token)).toLowerCase();
    return name === "codex" || name === "codex.exe";
  });
  if (codexIndex === -1) return void 0;
  const args = tokens.slice(codexIndex + 1);
  let explicitCwd;
  let subcommand;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index] ?? "";
    if (value.startsWith("--cd=")) {
      explicitCwd = value.slice("--cd=".length);
      continue;
    }
    if (value === "-C" || value === "--cd") {
      explicitCwd = args[index + 1];
      index += 1;
      continue;
    }
    if (OPTIONS_WITH_VALUES.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith("-")) continue;
    subcommand = value;
    break;
  }
  if (subcommand && NON_INTERACTIVE_COMMANDS.has(subcommand)) return void 0;
  return explicitCwd ? { explicitCwd } : {};
}
function findInteractiveCodexCwds(procRoot = "/proc") {
  const result = /* @__PURE__ */ new Map();
  let entries;
  try {
    entries = readdirSync(procRoot).filter((entry) => /^\d+$/.test(entry));
  } catch {
    return result;
  }
  for (const pid of entries) {
    try {
      const command = readFileSync(join(procRoot, pid, "cmdline"), "utf8").split("\0").filter(Boolean);
      if (!codexInvocation(command.map((value) => JSON.stringify(value)).join(" "), "linux")) continue;
      const cwd = readlinkSync(join(procRoot, pid, "cwd"));
      if (cwd) increment(result, cwd);
    } catch {
    }
  }
  return result;
}
function parseMacProcessList(output) {
  const result = [];
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (Number.isInteger(pid) && codexInvocation(match[2] ?? "", "darwin")) result.push(pid);
  }
  return result;
}
function parseLsofCwds(output) {
  const result = /* @__PURE__ */ new Map();
  let pid;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      const value = Number(line.slice(1));
      pid = Number.isInteger(value) ? value : void 0;
    } else if (pid !== void 0 && line.startsWith("n") && line.length > 1) {
      result.set(pid, line.slice(1));
    }
  }
  return result;
}
function parseWindowsProcessList(output) {
  const cwdCounts = /* @__PURE__ */ new Map();
  let parsed;
  try {
    parsed = JSON.parse(output || "[]");
  } catch {
    return {
      cwdCounts,
      processCount: 0,
      exact: false,
      source: "windows-cim",
      warning: "Windows process discovery returned invalid JSON"
    };
  }
  const records = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : [];
  let processCount = 0;
  for (const record of records) {
    if (typeof record.CommandLine !== "string") continue;
    const invocation = codexInvocation(record.CommandLine, "win32");
    if (!invocation) continue;
    processCount += 1;
    if (invocation.explicitCwd && win32.isAbsolute(invocation.explicitCwd)) {
      increment(cwdCounts, invocation.explicitCwd);
    }
  }
  const resolvedCwdCount = [...cwdCounts.values()].reduce((sum, count) => sum + count, 0);
  return {
    cwdCounts,
    processCount,
    exact: processCount === resolvedCwdCount,
    source: "windows-cim",
    ...processCount > 0 && processCount !== resolvedCwdCount ? { warning: "Windows does not expose process working directories; using the newest matching Codex roots" } : {}
  };
}
function discoverMacProcesses() {
  const ps = spawnSync2("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    timeout: 5e3,
    maxBuffer: 4 * 1024 * 1024
  });
  if (ps.error || ps.status !== 0) {
    return {
      cwdCounts: /* @__PURE__ */ new Map(),
      processCount: 0,
      exact: false,
      source: "macos-ps-lsof",
      warning: ps.error?.message ?? (ps.stderr?.trim() || "ps failed")
    };
  }
  const pids = parseMacProcessList(ps.stdout ?? "");
  if (pids.length === 0) {
    return { cwdCounts: /* @__PURE__ */ new Map(), processCount: 0, exact: true, source: "macos-ps-lsof" };
  }
  const lsof = spawnSync2("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"], {
    encoding: "utf8",
    timeout: 5e3,
    maxBuffer: 4 * 1024 * 1024
  });
  const byPid = parseLsofCwds(lsof.stdout ?? "");
  const cwdCounts = /* @__PURE__ */ new Map();
  for (const cwd of byPid.values()) increment(cwdCounts, cwd);
  const exact = byPid.size === pids.length;
  return {
    cwdCounts,
    processCount: pids.length,
    exact,
    source: "macos-ps-lsof",
    ...!exact ? { warning: lsof.error?.message ?? (lsof.stderr?.trim() || "lsof could not resolve every Codex cwd") } : {}
  };
}
function discoverWindowsProcesses() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Get-CimInstance Win32_Process |",
    `Where-Object { $_.Name -ieq 'codex.exe' -or $_.CommandLine -match '(?:^|[\\\\/])codex(?:\\.exe)?(?:"|\\s|$)' } |`,
    "Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress"
  ].join(" ");
  const powershell = spawnSync2("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 8e3,
    maxBuffer: 4 * 1024 * 1024
  });
  if (powershell.error || powershell.status !== 0) {
    return {
      cwdCounts: /* @__PURE__ */ new Map(),
      processCount: 0,
      exact: false,
      source: "windows-cim",
      warning: powershell.error?.message ?? (powershell.stderr?.trim() || "PowerShell process discovery failed")
    };
  }
  return parseWindowsProcessList(powershell.stdout?.trim() ?? "");
}
function discoverInteractiveCodexProcesses(platform = process.platform) {
  if (platform === "linux") {
    const cwdCounts = findInteractiveCodexCwds();
    return {
      cwdCounts,
      processCount: [...cwdCounts.values()].reduce((sum, count) => sum + count, 0),
      exact: true,
      source: "procfs"
    };
  }
  if (platform === "darwin") return discoverMacProcesses();
  if (platform === "win32") return discoverWindowsProcesses();
  return {
    cwdCounts: /* @__PURE__ */ new Map(),
    processCount: 0,
    exact: false,
    source: "unsupported",
    warning: `Process discovery is not implemented for ${platform}`
  };
}
function pathKey(value, platform) {
  if (platform === "win32") {
    return win32.normalize(value).replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "").toLowerCase();
  }
  return value.replace(/\/+$/, "") || "/";
}
function samePath(left, right, platform) {
  return pathKey(left, platform) === pathKey(right, platform);
}
function selectRootThreadIds(roots, discovery, configuredCwd, rootOverride, platform = process.platform) {
  if (rootOverride) return /* @__PURE__ */ new Set([rootOverride]);
  const eligible = configuredCwd === "all" ? roots : roots.filter((root) => root.cwd && samePath(root.cwd, configuredCwd, platform));
  const selected = /* @__PURE__ */ new Set();
  for (const [cwd, count] of discovery.cwdCounts) {
    for (const root of eligible.filter((candidate) => candidate.cwd && samePath(candidate.cwd, cwd, platform)).slice(0, count)) {
      selected.add(root.id);
    }
  }
  if (discovery.exact) return selected;
  const unresolvedCount = Math.max(0, discovery.processCount - selected.size);
  for (const root of eligible.filter((candidate) => !selected.has(candidate.id)).sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0)).slice(0, unresolvedCount)) {
    selected.add(root.id);
  }
  return selected;
}

// apps/server/src/shared-state-adapter.ts
var ACTIVITY_LIMIT_PER_THREAD = 30;
var HISTORY_LIMIT_PER_THREAD = 80;
var GLOBAL_ACTIVITY_LIMIT = 300;
var SAFETY_REFRESH_MS = 15e3;
var PROCESS_DISCOVERY_CACHE_MS = 2e3;
var ROLLOUT_TAIL_BYTES = 2 * 1024 * 1024;
var SEEN_ACTIVITY_LIMIT = 3e3;
var SEEN_HISTORY_LIMIT = 5e3;
function numberValue2(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return void 0;
}
function stringValue2(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function jsonRecord(line) {
  try {
    const value = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
  } catch {
    return void 0;
  }
}
function recordValue(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function timestampValue(value) {
  if (typeof value !== "string") return void 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function activityTitle(name) {
  switch (name) {
    case "exec":
      return { kind: "command", title: "Running command" };
    case "spawn_agent":
      return { kind: "tool", title: "Spawning agent" };
    case "wait_agent":
      return { kind: "tool", title: "Waiting for agents" };
    case "send_message":
    case "followup_task":
      return { kind: "message", title: "Messaging agent" };
    case "list_agents":
      return { kind: "tool", title: "Checking agent status" };
    case "request_user_input":
      return { kind: "approval", title: "Waiting for user input" };
    default:
      return { kind: "tool", title: name.replaceAll("_", " ") || "Tool call" };
  }
}
function boundedHistoryText(value) {
  if (typeof value !== "string") return void 0;
  const normalized = value.trim();
  if (!normalized) return void 0;
  return normalized.length > 2e3 ? `${normalized.slice(0, 1999)}\u2026` : normalized;
}
function rolloutMessageText(payload) {
  const direct = boundedHistoryText(payload.text);
  if (direct) return direct;
  if (!Array.isArray(payload.content)) return void 0;
  const parts = payload.content.map((entry) => recordValue(entry)).map((entry) => boundedHistoryText(entry?.text ?? entry?.input_text ?? entry?.output_text)).filter((entry) => Boolean(entry));
  return boundedHistoryText(parts.join("\n"));
}
function collaborationHistory(name, input, callId, threadId, at) {
  if (!["spawn_agent", "send_message", "followup_task"].includes(name)) return void 0;
  const parsed = jsonRecord(input) ?? {};
  const target = boundedHistoryText(parsed.target);
  const taskName = boundedHistoryText(parsed.task_name);
  const content = boundedHistoryText(parsed.message) ?? boundedHistoryText(parsed.task);
  const recipient = target ? { type: "agent", id: target, ...target.includes("/") ? { label: target } : {} } : taskName ? { type: "agent", label: taskName } : void 0;
  return {
    id: `activity:${callId}`,
    kind: "handoff",
    actor: { type: "agent", id: threadId },
    ...recipient ? { recipients: [recipient] } : {},
    summary: name === "spawn_agent" ? "Delegated work" : name === "followup_task" ? "Assigned follow-up" : "Sent message",
    ...content ? { content } : {},
    status: "sent",
    correlationId: callId,
    occurredAt: at,
    source: "compatibility"
  };
}
function decisionHistory(name, input, callId, threadId, at) {
  if (!["update_plan", "create_goal"].includes(name)) return void 0;
  const parsed = jsonRecord(input) ?? {};
  const plan = Array.isArray(parsed.plan) ? parsed.plan.map((item) => recordValue(item)).map((item) => boundedHistoryText(item?.step)).filter((item) => Boolean(item)).map((step, index) => `${index + 1}. ${step}`).join("\n") : void 0;
  const content = boundedHistoryText(parsed.explanation) ?? boundedHistoryText(parsed.objective) ?? boundedHistoryText(plan);
  return {
    id: `activity:${callId}`,
    kind: "decision",
    actor: { type: "agent", id: threadId },
    summary: name === "create_goal" ? "Goal set" : "Plan updated",
    ...content ? { content } : {},
    status: "started",
    correlationId: callId,
    occurredAt: at,
    source: "compatibility"
  };
}
function skillNameFromPath(path2) {
  const parts = path2.split("/").filter(Boolean);
  if (parts.at(-1) !== "SKILL.md") return void 0;
  const name = parts.at(-2);
  if (!name || name === "skills") return void 0;
  const skillsIndex = parts.lastIndexOf("skills");
  const pluginName = skillsIndex >= 2 && parts[skillsIndex - 1]?.match(/^\d+\.\d+/) ? parts[skillsIndex - 2] : void 0;
  return pluginName && pluginName !== ".system" ? `${pluginName}:${name}` : name;
}
function executionContextFromToolInput(input, toolName) {
  let command = "";
  const parsed = jsonRecord(input);
  if (parsed && typeof parsed.cmd === "string") {
    command = parsed.cmd;
  } else {
    const commandLiterals = [...input.matchAll(/(?:^|[,{\s])["']?cmd["']?\s*:\s*("(?:\\.|[^"\\])*")/gs)];
    if (commandLiterals.length > 0) {
      for (const match of commandLiterals) {
        try {
          const decoded = JSON.parse(match[1] ?? "");
          if (typeof decoded === "string") command += `${command ? "\n" : ""}${decoded}`;
        } catch {
        }
      }
    } else if (/^\s*(?:rtk\s+(?:proxy\s+)?)?(?:cat|sed|head|tail|less|bat|rg)\b/.test(input)) {
      command = input;
    }
  }
  const skills = /* @__PURE__ */ new Set();
  const workflows = /* @__PURE__ */ new Set();
  const readsFiles = toolName === "exec" && /(?:^|&&|\|\||;|\n)\s*(?:rtk\s+(?:proxy\s+)?)?(?:cat|sed|head|tail|less|bat|rg)\b/m.test(command);
  if (readsFiles) {
    for (const match of command.matchAll(/[A-Za-z0-9_@.+~/-]+\/SKILL\.md\b/g)) {
      const name = skillNameFromPath(match[0]);
      if (name) skills.add(name);
    }
  }
  if (readsFiles && (/(?:^|[\s"'])\.sdd\//m.test(command) || /\/\.sdd\//.test(command))) workflows.add("SDD");
  for (const skill of skills) {
    if (skill.startsWith("sdd-")) workflows.add("SDD");
  }
  if (toolName === "update_plan") workflows.add("Planning");
  if (toolName === "create_goal" || toolName === "update_goal") workflows.add("Goal tracking");
  return { skills: [...skills], workflows: [...workflows] };
}
function parseRolloutState(text, threadId, isRoot, processActive) {
  let taskStartedAt;
  let taskCompletedAt;
  let interruptedAt;
  let workItemAt;
  let lastEventAt;
  let model;
  let reasoningEffort;
  let collaborationMode;
  const observedSkills = /* @__PURE__ */ new Set();
  const observedWorkflows = /* @__PURE__ */ new Set();
  const openCalls = /* @__PURE__ */ new Map();
  const completedActivities = [];
  const openHistory = /* @__PURE__ */ new Map();
  const completedHistory = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const envelope = jsonRecord(line);
    if (!envelope) continue;
    const at = timestampValue(envelope.timestamp);
    if (at !== void 0) lastEventAt = Math.max(lastEventAt ?? at, at);
    const payload = recordValue(envelope.payload);
    if (!payload) continue;
    if (envelope.type === "turn_context") {
      if (typeof payload.model === "string" && payload.model.length > 0) model = payload.model;
      if (typeof payload.effort === "string" && payload.effort.length > 0) reasoningEffort = payload.effort;
      const mode = recordValue(payload.collaboration_mode);
      if (typeof mode?.mode === "string" && mode.mode.length > 0) collaborationMode = mode.mode;
      if (collaborationMode === "plan") observedWorkflows.add("Planning");
      continue;
    }
    if (envelope.type === "event_msg") {
      if (payload.type === "task_started" && at !== void 0) {
        taskStartedAt = at;
        openHistory.set(`compat-turn:${threadId}`, {
          id: `compat-turn:${threadId}`,
          kind: "work",
          actor: { type: "agent", id: threadId },
          summary: "Started work",
          status: "running",
          occurredAt: at,
          source: "compatibility"
        });
      }
      if (payload.type === "task_complete" && at !== void 0) {
        taskCompletedAt = at;
        openHistory.delete(`compat-turn:${threadId}`);
        completedHistory.push({
          id: `compat-completion:${threadId}:${at}`,
          kind: "completion",
          actor: { type: "agent", id: threadId },
          summary: "Work completed",
          status: "completed",
          occurredAt: at,
          source: "compatibility"
        });
      }
      if (payload.type === "turn_aborted" && at !== void 0) interruptedAt = at;
      continue;
    }
    if (envelope.type !== "response_item" || at === void 0) continue;
    workItemAt = at;
    const itemType = typeof payload.type === "string" ? payload.type : "";
    if (itemType === "custom_tool_call" || itemType === "function_call") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : `${threadId}:${at}`;
      const name = typeof payload.name === "string" ? payload.name : "tool";
      const input = typeof payload.input === "string" ? payload.input : typeof payload.arguments === "string" ? payload.arguments : "";
      const context = executionContextFromToolInput(input, name);
      context.skills.forEach((skill) => observedSkills.add(skill));
      context.workflows.forEach((workflow) => observedWorkflows.add(workflow));
      const mapped = activityTitle(name);
      openCalls.set(callId, {
        id: callId,
        agentId: threadId,
        kind: mapped.kind,
        title: mapped.title,
        detail: name,
        startedAt: at
      });
      const semanticHistory = collaborationHistory(name, input, callId, threadId, at) ?? decisionHistory(name, input, callId, threadId, at);
      if (semanticHistory) openHistory.set(callId, semanticHistory);
      continue;
    }
    if (itemType === "custom_tool_call_output" || itemType === "function_call_output") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : void 0;
      const activity = callId ? openCalls.get(callId) : void 0;
      if (activity) {
        completedActivities.push({ ...activity, completedAt: at, outcome: "completed" });
        openCalls.delete(activity.id);
      }
      const history2 = callId ? openHistory.get(callId) : void 0;
      if (history2) {
        completedHistory.push({ ...history2, status: "completed" });
        openHistory.delete(history2.correlationId ?? history2.id);
      }
      continue;
    }
    if (itemType === "message") {
      const content = rolloutMessageText(payload);
      const role = typeof payload.role === "string" ? payload.role : "assistant";
      completedActivities.push({
        id: `message:${threadId}:${at}`,
        agentId: threadId,
        kind: "message",
        title: role === "user" ? "User message" : "Agent message",
        ...content ? { detail: content } : {},
        startedAt: at,
        completedAt: at,
        outcome: "completed"
      });
      completedHistory.push(role === "user" ? {
        id: `activity:message:${threadId}:${at}`,
        kind: "request",
        actor: { type: "human" },
        recipients: [{ type: "agent", id: threadId }],
        summary: "Request received",
        ...content ? { content } : {},
        status: "completed",
        occurredAt: at,
        source: "compatibility"
      } : {
        id: `activity:message:${threadId}:${at}`,
        kind: "delivery",
        actor: { type: "agent", id: threadId },
        recipients: [{ type: "human" }],
        summary: payload.phase === "final_answer" ? "Delivered final result" : "Agent message",
        ...content ? { content } : {},
        status: "completed",
        occurredAt: at,
        source: "compatibility"
      });
    }
  }
  const latestTerminalAt = Math.max(taskCompletedAt ?? 0, interruptedAt ?? 0);
  const explicitWorking = (taskStartedAt ?? 0) > latestTerminalAt;
  const activeRootWork = isRoot && processActive && (workItemAt ?? 0) > latestTerminalAt;
  const isWorking = explicitWorking || activeRootWork;
  const waitingOnUserInput = [...openCalls.values()].some((activity) => activity.detail === "request_user_input");
  let nativeStatus;
  let lifecycle;
  if (isWorking) {
    nativeStatus = {
      type: "active",
      activeFlags: waitingOnUserInput ? ["waitingOnUserInput"] : []
    };
    lifecycle = "running";
  } else if (interruptedAt !== void 0 && interruptedAt >= (taskCompletedAt ?? 0)) {
    nativeStatus = processActive && isRoot ? { type: "idle" } : { type: "notLoaded" };
    lifecycle = "interrupted";
  } else if (taskCompletedAt !== void 0) {
    nativeStatus = processActive && isRoot ? { type: "idle" } : { type: "notLoaded" };
    if (!isRoot) lifecycle = "completed";
  } else {
    nativeStatus = processActive && isRoot ? { type: "idle" } : { type: "notLoaded" };
  }
  const activities = [...completedActivities, ...openCalls.values()].sort((a, b) => a.startedAt - b.startedAt).slice(-ACTIVITY_LIMIT_PER_THREAD);
  const history = [...completedHistory, ...openHistory.values()].sort((a, b) => a.occurredAt - b.occurredAt).slice(-HISTORY_LIMIT_PER_THREAD);
  return {
    nativeStatus,
    ...lifecycle ? { lifecycle } : {},
    ...lastEventAt ? { lastEventAt } : {},
    ...model ? { model } : {},
    ...reasoningEffort ? { reasoningEffort } : {},
    observedSkills: [...observedSkills].sort(),
    observedWorkflows: [...observedWorkflows].sort(),
    ...collaborationMode ? { collaborationMode } : {},
    history,
    activities
  };
}
function readRolloutTail(path2) {
  const fd = openSync(path2, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - ROLLOUT_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    if (start === 0) return text;
    const firstNewline = text.indexOf("\n");
    return firstNewline === -1 ? "" : text.slice(firstNewline + 1);
  } finally {
    closeSync(fd);
  }
}
function latestVersionedDatabase(codexHome, prefix) {
  const matches = readdirSync2(codexHome).filter((name) => new RegExp(`^${prefix}_[0-9]+\\.sqlite$`).test(name)).sort((a, b) => {
    const aVersion = Number(a.match(/_([0-9]+)\.sqlite$/)?.[1] ?? 0);
    const bVersion = Number(b.match(/_([0-9]+)\.sqlite$/)?.[1] ?? 0);
    return bVersion - aVersion;
  });
  return matches[0] ? join2(codexHome, matches[0]) : void 0;
}
function rowSnapshot(row, rollout) {
  const id = stringValue2(row.id);
  if (!id) return void 0;
  const createdAt = numberValue2(row.created_at_ms) ?? ((numberValue2(row.created_at) ?? 0) * 1e3 || void 0);
  const updatedAt = rollout.lastEventAt ?? numberValue2(row.updated_at_ms) ?? ((numberValue2(row.updated_at) ?? 0) * 1e3 || void 0);
  return {
    id,
    ...stringValue2(row.parent_thread_id) ? { parentThreadId: stringValue2(row.parent_thread_id) } : {},
    ...stringValue2(row.agent_nickname) ? { nickname: stringValue2(row.agent_nickname) } : {},
    ...stringValue2(row.agent_role) ? { role: stringValue2(row.agent_role) } : {},
    nativeStatus: rollout.nativeStatus,
    ...createdAt ? { createdAt } : {},
    ...updatedAt ? { updatedAt } : {},
    ...stringValue2(row.cwd) ? { cwd: stringValue2(row.cwd) } : {},
    ...rollout.model ? { model: rollout.model } : {},
    ...stringValue2(row.model_provider) ? { modelProvider: stringValue2(row.model_provider) } : {},
    ...rollout.reasoningEffort ? { reasoningEffort: rollout.reasoningEffort } : {},
    observedSkills: rollout.observedSkills,
    observedWorkflows: rollout.observedWorkflows,
    ...rollout.collaborationMode ? { collaborationMode: rollout.collaborationMode } : {},
    ...stringValue2(row.thread_source) ? { source: row.thread_source } : {},
    ...stringValue2(row.agent_path) ? { path: stringValue2(row.agent_path) } : {}
  };
}
var SharedStateCodexAdapter = class {
  mode = "codex";
  #listeners = /* @__PURE__ */ new Set();
  #db;
  #threads = /* @__PURE__ */ new Map();
  #watchers = [];
  #refreshTimer;
  #safetyTimer;
  #connected = false;
  #connectPromise;
  #refreshing = false;
  #refreshQueued = false;
  #codexVersion = "unknown";
  #seenActivities = /* @__PURE__ */ new Set();
  #seenActivityOrder = [];
  #seenHistory = /* @__PURE__ */ new Set();
  #seenHistoryOrder = [];
  #lastLifecycle = /* @__PURE__ */ new Map();
  #lastThreadFingerprint = /* @__PURE__ */ new Map();
  #rolloutCache = /* @__PURE__ */ new Map();
  #processDiscoveryCache;
  #lastDiscoveryWarning;
  runtimeInfo() {
    return {
      adapter: "codex",
      observatoryVersion: "0.1.0",
      codexCliVersion: this.#codexVersion,
      protocolGenerationVersion: "0.149.0",
      experimentalApi: false,
      discoveryStrategy: "compatibility"
    };
  }
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async connect() {
    if (this.#connected) return;
    if (this.#connectPromise) return this.#connectPromise;
    const pending = this.#connectOnce().finally(() => {
      if (this.#connectPromise === pending) this.#connectPromise = void 0;
    });
    this.#connectPromise = pending;
    await pending;
  }
  async #connectOnce() {
    this.#emit({
      type: "connection.changed",
      at: Date.now(),
      connection: { phase: "connecting", attempt: 0, message: "Connecting to shared Codex state" }
    });
    const version = spawnSync3("codex", ["--version"], { encoding: "utf8" });
    this.#codexVersion = version.stdout.trim().replace(/^codex-cli\s+/, "") || "unknown";
    const codexHome = process.env.CODEX_HOME ?? join2(homedir(), ".codex");
    const stateDbPath = latestVersionedDatabase(codexHome, "state");
    if (!stateDbPath) throw new Error(`Codex state database was not found in ${codexHome}`);
    this.#db = new DatabaseSync(stateDbPath, { readOnly: true });
    await this.#refresh();
    this.#connected = true;
    this.#emit({ type: "runtime.updated", at: Date.now(), runtime: this.runtimeInfo() });
    this.#emit({
      type: "connection.changed",
      at: Date.now(),
      connection: {
        phase: "connected",
        attempt: 0,
        message: "Connected \xB7 shared Codex compatibility mode"
      }
    });
    this.#startWatching(codexHome);
  }
  async disconnect() {
    this.#connected = false;
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
    if (this.#safetyTimer) clearInterval(this.#safetyTimer);
    this.#refreshTimer = void 0;
    this.#safetyTimer = void 0;
    this.#processDiscoveryCache = void 0;
    for (const watcher of this.#watchers) watcher.close();
    this.#watchers = [];
    this.#db?.close();
    this.#db = void 0;
    this.#emit({
      type: "connection.changed",
      at: Date.now(),
      connection: { phase: "disconnected", attempt: 0, message: "Disconnected" }
    });
  }
  async listThreads(options) {
    const values = [...this.#threads.values()].map((thread) => thread.snapshot);
    if (!options?.rootThreadId) return values;
    const descendants = /* @__PURE__ */ new Set();
    let changed = true;
    while (changed) {
      changed = false;
      for (const thread of values) {
        if (thread.parentThreadId === options.rootThreadId || thread.parentThreadId && descendants.has(thread.parentThreadId)) {
          if (!descendants.has(thread.id)) {
            descendants.add(thread.id);
            changed = true;
          }
        }
      }
    }
    return values.filter((thread) => descendants.has(thread.id));
  }
  async listLoadedThreads() {
    return [...this.#threads.values()].filter((thread) => thread.snapshot.nativeStatus.type !== "notLoaded").map((thread) => thread.snapshot.id);
  }
  async readThread(threadId, _options) {
    const thread = this.#threads.get(threadId)?.snapshot;
    if (!thread) throw new Error(`Unknown shared Codex thread ${threadId}`);
    return thread;
  }
  #startWatching(codexHome) {
    const schedule = () => this.#scheduleRefresh();
    try {
      this.#watchers.push(watch(codexHome, (_event, file) => {
        if (!file || String(file).startsWith("state_")) schedule();
      }));
    } catch (error) {
      this.#debug("Unable to watch Codex state database", error);
    }
    const sessions = join2(codexHome, "sessions");
    if (existsSync2(sessions)) {
      try {
        this.#watchers.push(watch(sessions, { recursive: true }, (_event, file) => {
          if (!file || String(file).endsWith(".jsonl")) schedule();
        }));
      } catch (error) {
        this.#debug("Unable to watch Codex session events", error);
      }
    }
    this.#safetyTimer = setInterval(schedule, SAFETY_REFRESH_MS);
  }
  #scheduleRefresh() {
    if (!this.#connected) return;
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = void 0;
      void this.#refresh().catch((error) => this.#debug("Shared state refresh failed", error));
    }, 150);
  }
  async #refresh() {
    if (this.#refreshing) {
      this.#refreshQueued = true;
      return;
    }
    this.#refreshing = true;
    try {
      const db = this.#db;
      if (!db) return;
      const rows = db.prepare(`
        SELECT t.*, e.parent_thread_id
        FROM threads t
        LEFT JOIN thread_spawn_edges e ON e.child_thread_id = t.id
        WHERE t.archived = 0
        ORDER BY t.updated_at_ms DESC
      `).all();
      const processDiscovery = this.#processDiscovery();
      if (processDiscovery.warning && processDiscovery.warning !== this.#lastDiscoveryWarning) {
        this.#lastDiscoveryWarning = processDiscovery.warning;
        this.#debug(processDiscovery.warning, { source: processDiscovery.source });
      }
      const configuredCwd = process.env.OBSERVATORY_CWD ?? "all";
      const rootOverride = process.env.OBSERVATORY_ROOT_THREAD_ID;
      const roots = rows.filter((row) => !stringValue2(row.parent_thread_id));
      const rootCandidates = roots.flatMap((row) => {
        const id = stringValue2(row.id);
        if (!id) return [];
        const cwd = stringValue2(row.cwd);
        const updatedAt = numberValue2(row.updated_at_ms);
        return [{
          id,
          ...cwd ? { cwd } : {},
          ...updatedAt !== void 0 ? { updatedAt } : {}
        }];
      });
      const selectedRoots = selectRootThreadIds(
        rootCandidates,
        processDiscovery,
        configuredCwd,
        rootOverride
      );
      const selected = new Set(selectedRoots);
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of rows) {
          const id = stringValue2(row.id);
          const parentId = stringValue2(row.parent_thread_id);
          if (id && parentId && selected.has(parentId) && !selected.has(id)) {
            selected.add(id);
            changed = true;
          }
        }
      }
      const next = /* @__PURE__ */ new Map();
      for (const row of rows) {
        const id = stringValue2(row.id);
        if (!id || !selected.has(id)) continue;
        const rolloutPath = stringValue2(row.rollout_path);
        if (!rolloutPath || !existsSync2(rolloutPath)) continue;
        const isRoot = !stringValue2(row.parent_thread_id);
        const processActive = isRoot && selectedRoots.has(id);
        const file = statSync(rolloutPath);
        const cached = this.#rolloutCache.get(rolloutPath);
        const rollout = cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs && cached.processActive === processActive ? cached.state : parseRolloutState(
          readRolloutTail(rolloutPath),
          id,
          isRoot,
          processActive
        );
        this.#rolloutCache.set(rolloutPath, {
          size: file.size,
          mtimeMs: file.mtimeMs,
          processActive,
          state: rollout
        });
        const snapshot = rowSnapshot(row, rollout);
        if (!snapshot) continue;
        next.set(id, { snapshot, rolloutPath, rollout });
      }
      this.#threads = next;
      const activePaths = new Set([...next.values()].map((thread) => thread.rolloutPath));
      for (const path2 of this.#rolloutCache.keys()) {
        if (!activePaths.has(path2)) this.#rolloutCache.delete(path2);
      }
      for (const thread of next.values()) this.#projectThread(thread);
      const activities = [...next.values()].flatMap((thread) => thread.rollout.activities).sort((a, b) => a.startedAt - b.startedAt).slice(-GLOBAL_ACTIVITY_LIMIT);
      for (const activity of activities) this.#projectActivity(activity);
      const history = [...next.values()].flatMap((thread) => thread.rollout.history).sort((a, b) => a.occurredAt - b.occurredAt);
      for (const item of history) this.#projectHistory(item);
    } finally {
      this.#refreshing = false;
      if (this.#refreshQueued) {
        this.#refreshQueued = false;
        this.#scheduleRefresh();
      }
    }
  }
  #processDiscovery() {
    const now = Date.now();
    if (this.#processDiscoveryCache && now - this.#processDiscoveryCache.at < PROCESS_DISCOVERY_CACHE_MS) {
      return this.#processDiscoveryCache.value;
    }
    const value = discoverInteractiveCodexProcesses();
    this.#processDiscoveryCache = { at: now, value };
    return value;
  }
  #projectThread(thread) {
    const at = thread.rollout.lastEventAt ?? Date.now();
    const fingerprint = JSON.stringify(thread.snapshot);
    if (this.#lastThreadFingerprint.get(thread.snapshot.id) !== fingerprint) {
      this.#lastThreadFingerprint.set(thread.snapshot.id, fingerprint);
      this.#emit({ type: "thread.discovered", at, thread: thread.snapshot });
    }
    const lifecycle = thread.rollout.lifecycle;
    if (lifecycle && this.#lastLifecycle.get(thread.snapshot.id) !== lifecycle) {
      this.#lastLifecycle.set(thread.snapshot.id, lifecycle);
      this.#emit({ type: "agent.lifecycle", at, threadId: thread.snapshot.id, status: lifecycle });
      if (lifecycle === "running") {
        this.#emit({ type: "thread.status", at, threadId: thread.snapshot.id, status: thread.snapshot.nativeStatus });
      }
    }
  }
  #projectActivity(activity) {
    const key = `${activity.id}:${activity.completedAt ?? "open"}`;
    if (this.#seenActivities.has(key)) return;
    this.#rememberActivity(key);
    if (activity.completedAt !== void 0) {
      this.#emit({
        type: "activity.completed",
        at: activity.completedAt,
        threadId: activity.agentId,
        activityId: activity.id,
        activity,
        outcome: activity.outcome
      });
    } else {
      this.#emit({ type: "activity.started", at: activity.startedAt, activity });
    }
  }
  #projectHistory(history) {
    const key = `${history.id}:${history.status ?? "recorded"}`;
    if (this.#seenHistory.has(key)) return;
    this.#seenHistory.add(key);
    this.#seenHistoryOrder.push(key);
    while (this.#seenHistoryOrder.length > SEEN_HISTORY_LIMIT) {
      const oldest = this.#seenHistoryOrder.shift();
      if (oldest) this.#seenHistory.delete(oldest);
    }
    this.#emit({ type: "history.recorded", at: history.occurredAt, history });
  }
  #rememberActivity(key) {
    this.#seenActivities.add(key);
    this.#seenActivityOrder.push(key);
    while (this.#seenActivityOrder.length > SEEN_ACTIVITY_LIMIT) {
      const oldest = this.#seenActivityOrder.shift();
      if (oldest) this.#seenActivities.delete(oldest);
    }
  }
  #emit(event) {
    for (const listener of this.#listeners) listener(event);
  }
  #debug(summary, payload) {
    this.#emit({
      type: "debug",
      at: Date.now(),
      entry: {
        id: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
        at: Date.now(),
        direction: "internal",
        category: "connection",
        summary,
        ...payload !== void 0 ? { payload: payload instanceof Error ? payload.message : payload } : {}
      }
    });
  }
};

// apps/server/src/index.ts
var accessToken = consumeAccessToken();
var port = Number(process.env.OBSERVATORY_PORT ?? 4317);
var realTransport = process.env.OBSERVATORY_CODEX_TRANSPORT ?? "shared";
var adapter = process.env.OBSERVATORY_ADAPTER === "codex" ? realTransport === "shared" ? new SharedStateCodexAdapter() : new RealCodexAdapter() : new MockCodexAdapter(process.env.OBSERVATORY_SCENARIO ?? "a");
var webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
var runningFromSource = fileURLToPath(import.meta.url).includes(`${sep}src${sep}`);
var webPort = Number(process.env.OBSERVATORY_WEB_PORT ?? 4318);
var devWebOrigins = runningFromSource ? [`http://127.0.0.1:${webPort}`, `http://localhost:${webPort}`] : void 0;
var { server, connectAdapter } = createObservatoryHttpServer({ accessToken, adapter, webDist, devWebOrigins });
server.listen(port, "127.0.0.1", () => {
  const bootstrapOrigin = `http://127.0.0.1:${port}`;
  console.log(`Codex Agent Observatory server: ${bootstrapOrigin}/?token=${encodeURIComponent(accessToken)}`);
  console.log(`Adapter: ${adapter.mode}`);
});
void connectAdapter().catch(() => void 0);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void adapter.disconnect().finally(() => server.close(() => process.exit(0)));
  });
}
