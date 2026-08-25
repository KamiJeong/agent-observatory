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

// apps/server/src/claude-adapter.ts
import { spawnSync } from "node:child_process";
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync as readFileSync2,
  readSync,
  readdirSync as readdirSync2,
  readlinkSync
} from "node:fs";
import { homedir } from "node:os";
import { basename as basename2, dirname, join as join2 } from "node:path";

// apps/server/src/claude-team-observer.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
var MAX_CONFIG_BYTES = 2 * 1024 * 1024;
var MAX_TASK_BYTES = 1024 * 1024;
var MAX_INBOX_BYTES = 4 * 1024 * 1024;
function recordValue(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function timestampValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return void 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function readBoundedJson(path2, maxBytes) {
  const stat = statSync(path2);
  if (!stat.isFile() || stat.size > maxBytes) return void 0;
  return JSON.parse(readFileSync(path2, "utf8"));
}
function parseClaudeTeamConfig(text, fallbackName) {
  let parsed;
  try {
    parsed = recordValue(JSON.parse(text));
  } catch {
    return void 0;
  }
  if (!parsed || !Array.isArray(parsed.members)) return void 0;
  const name = fallbackName;
  const leadAgentId = stringValue(parsed.leadAgentId);
  const leadSessionId = stringValue(parsed.leadSessionId);
  const members = [];
  for (const item of parsed.members) {
    const member = recordValue(item);
    if (!member) continue;
    const agentId = stringValue(member.agentId);
    const memberName = stringValue(member.name);
    if (!agentId || !memberName) continue;
    const agentType = stringValue(member.agentType);
    const isLead = agentId === leadAgentId || agentType === "team-lead" || memberName === "team-lead";
    members.push({
      agentId,
      name: memberName,
      kind: isLead ? "teamLead" : "teammate",
      ...agentType ? { agentType } : {},
      ...stringValue(member.sessionId) ? { sessionId: stringValue(member.sessionId) } : {},
      ...stringValue(member.model) ? { model: stringValue(member.model) } : {},
      ...stringValue(member.cwd) ? { cwd: stringValue(member.cwd) } : {},
      ...timestampValue(member.joinedAt) !== void 0 ? { joinedAt: timestampValue(member.joinedAt) } : {}
    });
  }
  if (members.length === 0) return void 0;
  return {
    name,
    ...timestampValue(parsed.createdAt) !== void 0 ? { createdAt: timestampValue(parsed.createdAt) } : {},
    ...leadAgentId ? { leadAgentId } : {},
    ...leadSessionId ? { leadSessionId } : {},
    members,
    evidenceSource: "compatibility",
    beta: true
  };
}
function parseClaudeTeamTask(text, updatedAt) {
  let task;
  try {
    task = recordValue(JSON.parse(text));
  } catch {
    return void 0;
  }
  if (!task) return void 0;
  const id = stringValue(task.id);
  const rawStatus = stringValue(task.status);
  if (!id || rawStatus !== "pending" && rawStatus !== "in_progress" && rawStatus !== "completed") return void 0;
  const metadata = recordValue(task.metadata);
  return {
    id,
    status: rawStatus,
    ...stringValue(task.owner) ? { owner: stringValue(task.owner) } : {},
    internal: metadata?._internal === true,
    updatedAt
  };
}
function protocolMessage(text) {
  if (!text.startsWith("{")) return void 0;
  try {
    return recordValue(JSON.parse(text));
  } catch {
    return void 0;
  }
}
function parseClaudeTeamInbox(text, recipient) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const messages = [];
  parsed.forEach((item, index) => {
    const envelope = recordValue(item);
    const from = stringValue(envelope?.from);
    const occurredAt = timestampValue(envelope?.timestamp);
    const textValue = stringValue(envelope?.text);
    if (!envelope || !from || occurredAt === void 0 || !textValue) return;
    const protocol = protocolMessage(textValue);
    const rawType = stringValue(protocol?.type);
    let type = rawType === "task_assignment" || rawType === "task_completed" || rawType === "idle_notification" || rawType === "shutdown_request" || rawType === "shutdown_approved" || rawType === "shutdown_rejected" || rawType === "teammate_terminated" ? rawType : "message";
    if (rawType === "shutdown_response" && protocol?.approve === true) type = "shutdown_approved";
    if (rawType === "shutdown_response" && protocol?.approve === false) type = "shutdown_rejected";
    const taskId = type === "task_assignment" || type === "task_completed" ? stringValue(protocol?.taskId) : void 0;
    const requestId = type === "shutdown_request" || type === "shutdown_approved" || type === "shutdown_rejected" ? stringValue(protocol?.requestId) ?? stringValue(protocol?.request_id) : void 0;
    messages.push({
      id: `${recipient}:${occurredAt}:${index}:${type}`,
      type,
      from,
      recipient,
      occurredAt,
      ...taskId ? { taskId } : {},
      ...requestId ? { requestId } : {},
      ...typeof envelope.read === "boolean" ? { read: envelope.read } : {}
    });
  });
  return messages;
}
function readTasks(claudeHome, teamName) {
  const directory = join(claudeHome, "tasks", teamName);
  let files;
  try {
    files = readdirSync(directory).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
  const tasks = [];
  for (const file of files) {
    const path2 = join(directory, file);
    try {
      const stat = statSync(path2);
      if (!stat.isFile() || stat.size > MAX_TASK_BYTES) continue;
      const task = parseClaudeTeamTask(readFileSync(path2, "utf8"), stat.mtimeMs);
      if (task) tasks.push(task);
    } catch {
    }
  }
  return tasks;
}
function readMessages(teamDirectory) {
  const inboxes = join(teamDirectory, "inboxes");
  let files;
  try {
    files = readdirSync(inboxes).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
  const messages = [];
  for (const file of files) {
    const path2 = join(inboxes, file);
    try {
      const parsed = readBoundedJson(path2, MAX_INBOX_BYTES);
      if (!Array.isArray(parsed)) continue;
      messages.push(...parseClaudeTeamInbox(JSON.stringify(parsed), basename(file, ".json")));
    } catch {
    }
  }
  return messages;
}
function discoverClaudeAgentTeams(claudeHome) {
  const teamsRoot = join(claudeHome, "teams");
  let directories;
  try {
    directories = readdirSync(teamsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(teamsRoot, entry.name));
  } catch {
    return [];
  }
  const teams = [];
  for (const directory of directories) {
    const fallbackName = basename(directory);
    try {
      const config = readBoundedJson(join(directory, "config.json"), MAX_CONFIG_BYTES);
      if (!config) continue;
      const parsed = parseClaudeTeamConfig(JSON.stringify(config), fallbackName);
      if (!parsed) continue;
      teams.push({
        ...parsed,
        tasks: readTasks(claudeHome, fallbackName),
        messages: readMessages(directory)
      });
    } catch {
    }
  }
  return teams;
}

// apps/server/src/content-capture.ts
function contentCapturePolicy(environment = process.env) {
  return environment.OBSERVATORY_CAPTURE_CONTENT === "1" ? "enabled" : "metadata-only";
}
function contentCaptureEnabled(environment = process.env) {
  return contentCapturePolicy(environment) === "enabled";
}

// package.json
var package_default = {
  name: "agent-observatory",
  version: "0.2.4",
  description: "Local observability dashboard for Codex and Claude Code multi-agent workflows",
  license: "MIT",
  type: "module",
  bin: {
    "agent-observatory": "bin/agent-observatory.js"
  },
  files: [
    "bin",
    "apps/server/dist",
    "apps/web/dist",
    "README.md"
  ],
  repository: {
    type: "git",
    url: "git+https://github.com/KamiJeong/agent-observatory.git"
  },
  homepage: "https://github.com/KamiJeong/agent-observatory#readme",
  bugs: {
    url: "https://github.com/KamiJeong/agent-observatory/issues"
  },
  keywords: [
    "codex",
    "claude",
    "claude-code",
    "agents",
    "observability",
    "dashboard",
    "developer-tools"
  ],
  engines: {
    node: ">=22.13"
  },
  packageManager: "bun@1.3.14",
  workspaces: [
    "apps/*",
    "packages/*"
  ],
  scripts: {
    dev: 'concurrently -n server,web -c yellow,cyan "bun run --filter @observatory/server dev" "bun run --filter @observatory/web dev"',
    "dev:real": "node scripts/run-dev-real.mjs",
    "demo:capture": "bun run build:cli && node scripts/capture-demo.mjs",
    build: "bun run typecheck && bun run --filter @observatory/web build",
    "build:server": "esbuild apps/server/src/index.ts --bundle --platform=node --format=esm --external:ws --outfile=apps/server/dist/index.js",
    "build:cli": "bun run build && bun run build:server",
    typecheck: "tsc -b --pretty false",
    test: "vitest run",
    "test:watch": "vitest",
    "test:e2e": "node scripts/run-e2e.mjs",
    prepack: "bun run build:cli"
  },
  dependencies: {
    ws: "^8.18.3"
  },
  devDependencies: {
    "@playwright/test": "^1.55.0",
    "@testing-library/jest-dom": "^7.0.1",
    "@testing-library/react": "^16.3.0",
    "@types/node": "^26.2.0",
    "@types/react": "^19.1.12",
    "@types/react-dom": "^19.1.9",
    "@types/ws": "^8.18.1",
    "@vitejs/plugin-react": "^6.1.0",
    concurrently: "^10.0.5",
    esbuild: "^0.28.2",
    jsdom: "^30.0.1",
    tsx: "^4.20.5",
    typescript: "^7.0.2",
    vite: "^8.2.2",
    vitest: "^4.1.11"
  }
};

// apps/server/src/version.ts
var OBSERVATORY_VERSION = package_default.version;

// apps/server/src/claude-adapter.ts
var TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
var DEFAULT_POLL_INTERVAL_MS = 2e3;
var HISTORY_LIMIT = 80;
var ACTIVITY_LIMIT = 50;
function recordValue2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function stringValue2(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function timestampValue2(value) {
  if (typeof value !== "string") return void 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function parseJsonRecord(line) {
  try {
    return recordValue2(JSON.parse(line));
  } catch {
    return void 0;
  }
}
function namespaceRoot(sessionId) {
  return `claude:${sessionId}`;
}
function namespaceSubagent(sessionId, agentId) {
  return `claude:${sessionId}:${agentId}`;
}
function requestedThreadId(threadId) {
  return threadId.startsWith("claude:") ? threadId : `claude:${threadId}`;
}
function activityPresentation(name) {
  switch (name) {
    case "Bash":
      return { kind: "command", title: "Running command" };
    case "Read":
    case "Glob":
    case "Grep":
      return { kind: "read", title: "Reading files" };
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return { kind: "write", title: "Editing files" };
    case "Agent":
    case "Task":
      return { kind: "tool", title: "Starting subagent" };
    case "AskUserQuestion":
      return { kind: "approval", title: "Waiting for user input" };
    case "SendMessage":
      return { kind: "message", title: "Messaging agent" };
    case "Skill":
      return { kind: "tool", title: "Using skill" };
    default:
      return { kind: "tool", title: name ? `Using ${name}` : "Using tool" };
  }
}
function safeModelProvider(model) {
  return model ? "anthropic" : void 0;
}
function nativeStatus(context, hasFinalResponse, hasUnresolvedTool) {
  if (context.meta?.stoppedByUser) return { type: "idle" };
  if (hasFinalResponse && !hasUnresolvedTool) return { type: "idle" };
  if (context.processActive) return { type: "active", activeFlags: [] };
  return context.isRoot ? { type: "notLoaded" } : { type: "idle" };
}
function addUsage(total, usage) {
  total.inputTokens += numberValue(usage.input_tokens) ?? 0;
  total.cachedInputTokens += numberValue(usage.cache_read_input_tokens) ?? 0;
  total.outputTokens += numberValue(usage.output_tokens) ?? 0;
  total.reasoningOutputTokens += 0;
  total.totalTokens = total.inputTokens + total.cachedInputTokens + total.outputTokens;
  total.modelContextWindow += 0;
}
function boundedMessageText(content) {
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.flatMap((item) => {
    const block = recordValue2(item);
    return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("\n\n") : "";
  const trimmed = text.trim();
  if (!trimmed) return void 0;
  return trimmed.length > 2e3 ? `${trimmed.slice(0, 1999)}\u2026` : trimmed;
}
function parseClaudeTranscript(text, context) {
  const activities = /* @__PURE__ */ new Map();
  const history = [];
  const pending = /* @__PURE__ */ new Map();
  const completedToolIds = /* @__PURE__ */ new Set();
  const toolUseIds = /* @__PURE__ */ new Set();
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    modelContextWindow: 0
  };
  let hasUsage = false;
  let cwd = context.fallbackCwd;
  let model;
  let firstTimestamp = context.createdAt;
  let lastTimestamp = context.updatedAt;
  let latestMessageKind;
  for (const line of text.split("\n")) {
    const row = parseJsonRecord(line);
    if (!row) continue;
    cwd ??= stringValue2(row.cwd);
    const at = timestampValue2(row.timestamp);
    if (at !== void 0) {
      firstTimestamp = firstTimestamp === void 0 ? at : Math.min(firstTimestamp, at);
      lastTimestamp = lastTimestamp === void 0 ? at : Math.max(lastTimestamp, at);
    }
    const message = recordValue2(row.message);
    const role2 = stringValue2(message?.role);
    model = stringValue2(message?.model) ?? model;
    const messageUsage = recordValue2(message?.usage);
    if (messageUsage) {
      addUsage(usage, messageUsage);
      hasUsage = true;
    }
    const content = Array.isArray(message?.content) ? message.content : [];
    const capturedText = context.captureContent ? boundedMessageText(message?.content) : void 0;
    if (role2 === "assistant") {
      let hasText = false;
      let hasTool = false;
      for (const item of content) {
        const block = recordValue2(item);
        if (!block) continue;
        if (block.type === "text") hasText = true;
        if (block.type !== "tool_use") continue;
        hasTool = true;
        const nativeId = stringValue2(block.id);
        if (!nativeId) continue;
        const name = stringValue2(block.name) ?? "Tool";
        const id = `${context.threadId}:activity:${nativeId}`;
        const presentation = activityPresentation(name);
        toolUseIds.add(nativeId);
        activities.set(nativeId, {
          provider: "claude",
          id,
          agentId: context.threadId,
          kind: presentation.kind,
          title: presentation.title,
          startedAt: at ?? lastTimestamp ?? Date.now(),
          evidenceSource: "transcript",
          metadata: { provider: "claude", observation: "transcript", nativeTool: name }
        });
        if (name === "AskUserQuestion") {
          pending.set(nativeId, {
            provider: "claude",
            id: `${context.threadId}:request:${nativeId}`,
            agentId: context.threadId,
            reason: "userInput",
            title: "Claude is waiting for user input",
            openedAt: at ?? lastTimestamp ?? Date.now(),
            evidenceSource: "transcript"
          });
        }
      }
      latestMessageKind = hasTool ? "assistant-tool" : hasText ? "assistant-final" : latestMessageKind;
      const uuid = stringValue2(row.uuid);
      if (hasText && uuid) {
        history.push({
          provider: "claude",
          id: `${context.threadId}:history:${uuid}`,
          kind: "delivery",
          actor: { type: "agent", id: context.threadId },
          summary: "Agent response",
          ...capturedText ? { content: capturedText } : {},
          status: "sent",
          occurredAt: at ?? lastTimestamp ?? Date.now(),
          source: "transcript"
        });
      }
    } else if (role2 === "user") {
      let hasToolResult = false;
      for (const item of content) {
        const block = recordValue2(item);
        if (block?.type !== "tool_result") continue;
        hasToolResult = true;
        const nativeId = stringValue2(block.tool_use_id);
        if (!nativeId) continue;
        completedToolIds.add(nativeId);
        pending.delete(nativeId);
        const activity = activities.get(nativeId);
        if (activity) {
          activity.completedAt = at ?? lastTimestamp ?? activity.startedAt;
          activity.outcome = block.is_error === true ? "failed" : "completed";
        }
      }
      if (!hasToolResult) {
        latestMessageKind = "user";
        const uuid = stringValue2(row.uuid);
        if (uuid) {
          history.push({
            provider: "claude",
            id: `${context.threadId}:history:${uuid}`,
            kind: "request",
            actor: { type: "human" },
            recipients: [{ type: "agent", id: context.threadId }],
            summary: "User request",
            ...capturedText ? { content: capturedText } : {},
            status: "sent",
            occurredAt: at ?? lastTimestamp ?? Date.now(),
            source: "transcript"
          });
        }
      }
    }
  }
  const hasFinalResponse = latestMessageKind === "assistant-final";
  const hasUnresolvedTool = [...toolUseIds].some((id) => !completedToolIds.has(id));
  const status = nativeStatus(context, hasFinalResponse, hasUnresolvedTool);
  const lifecycle = context.meta?.stoppedByUser ? "interrupted" : !context.isRoot && hasFinalResponse && !hasUnresolvedTool ? "completed" : status.type === "active" ? "running" : void 0;
  const nickname = context.isRoot ? "Claude session" : void 0;
  const role = context.meta?.agentType;
  const snapshot = {
    provider: "claude",
    id: context.threadId,
    sessionId: context.sessionId,
    ...context.parentThreadId ? { parentThreadId: context.parentThreadId } : {},
    ...nickname ? { nickname } : {},
    ...role ? { role } : {},
    nativeStatus: status,
    ...firstTimestamp !== void 0 ? { createdAt: firstTimestamp } : {},
    ...lastTimestamp !== void 0 ? { updatedAt: lastTimestamp } : {},
    ...cwd ? { cwd } : {},
    ...model ? { model, modelProvider: safeModelProvider(model) } : {},
    source: {
      provider: "claude",
      observation: "transcript",
      schema: "compatibility",
      contentCaptured: context.captureContent === true,
      agentKind: context.isRoot ? "session" : "subagent"
    },
    evidenceSources: ["transcript"],
    ...context.meta?.spawnDepth !== void 0 ? { depth: context.meta.spawnDepth } : {}
  };
  return {
    snapshot,
    activities: [...activities.values()].slice(-ACTIVITY_LIMIT),
    history: history.slice(-HISTORY_LIMIT),
    pendingRequests: [...pending.values()],
    ...hasUsage ? { usage } : {},
    ...lifecycle ? { lifecycle } : {},
    toolUseIds: [...toolUseIds]
  };
}
function teamThreadId(teamName, agentId) {
  return `claude:team:${encodeURIComponent(teamName)}:${encodeURIComponent(agentId)}`;
}
function emptyTeamThread(team, member, parentThreadId) {
  const id = teamThreadId(team.name, member.agentId);
  return {
    path: join2("teams", team.name, "config.json"),
    snapshot: {
      provider: "claude",
      id,
      ...member.sessionId ? { sessionId: member.sessionId } : {},
      ...parentThreadId ? { parentThreadId } : {},
      nickname: member.name,
      role: member.kind,
      nativeStatus: { type: "idle" },
      ...member.joinedAt !== void 0 ? { createdAt: member.joinedAt, updatedAt: member.joinedAt } : {},
      ...member.cwd ? { cwd: member.cwd } : {},
      ...member.model ? { model: member.model, modelProvider: "anthropic" } : {},
      collaborationMode: "claude-agent-team-beta",
      source: {
        provider: "claude",
        observation: "team-config",
        schema: "compatibility",
        contentCaptured: false,
        beta: true,
        agentKind: member.kind,
        ...member.agentType ? { agentType: member.agentType } : {}
      },
      evidenceSources: ["compatibility"],
      ...member.kind === "teammate" ? { depth: 1 } : {}
    },
    activities: [],
    history: [],
    pendingRequests: [],
    toolUseIds: []
  };
}
function enrichTeamThread(thread, team, member, parentThreadId) {
  const source = recordValue2(thread.snapshot.source) ?? {};
  thread.snapshot = {
    ...thread.snapshot,
    ...parentThreadId ? { parentThreadId } : {},
    nickname: member.name,
    role: member.kind,
    ...member.model && !thread.snapshot.model ? { model: member.model, modelProvider: "anthropic" } : {},
    collaborationMode: "claude-agent-team-beta",
    source: {
      ...source,
      teamObservation: "config",
      beta: true,
      agentKind: member.kind,
      ...member.agentType ? { agentType: member.agentType } : {}
    },
    evidenceSources: [.../* @__PURE__ */ new Set([...thread.snapshot.evidenceSources ?? [], "compatibility"])],
    ...member.kind === "teammate" && thread.snapshot.depth === void 0 ? { depth: 1 } : {}
  };
}
function teamMessageHistory(team, message, actorId, recipientId) {
  const common = {
    provider: "claude",
    id: `claude:team:${encodeURIComponent(team.name)}:message:${message.id}`,
    occurredAt: message.occurredAt,
    source: "compatibility"
  };
  switch (message.type) {
    case "task_assignment":
      return {
        ...common,
        kind: "handoff",
        actor: { type: "agent", id: actorId },
        recipients: [{ type: "agent", id: recipientId }],
        summary: "Team task assigned",
        status: "sent",
        relationKind: "task",
        ...message.taskId ? { correlationId: `claude:team:${team.name}:task:${message.taskId}` } : {}
      };
    case "task_completed":
      return {
        ...common,
        kind: "completion",
        actor: { type: "agent", id: actorId },
        recipients: [{ type: "agent", id: recipientId }],
        summary: "Team task completed",
        status: "completed",
        relationKind: "task",
        ...message.taskId ? { correlationId: `claude:team:${team.name}:task:${message.taskId}` } : {}
      };
    case "idle_notification":
      return {
        ...common,
        kind: "completion",
        actor: { type: "agent", id: actorId },
        recipients: [{ type: "agent", id: recipientId }],
        summary: "Teammate became idle",
        status: "completed"
      };
    case "shutdown_request":
      return {
        ...common,
        kind: "decision",
        actor: { type: "agent", id: actorId },
        recipients: [{ type: "agent", id: recipientId }],
        summary: "Teammate shutdown requested",
        status: "started",
        relationKind: "handoff",
        ...message.requestId ? { correlationId: message.requestId } : {}
      };
    case "shutdown_approved":
      return {
        ...common,
        kind: "completion",
        actor: { type: "agent", id: actorId },
        recipients: [{ type: "agent", id: recipientId }],
        summary: "Teammate shutdown approved",
        status: "completed",
        relationKind: "handoff",
        ...message.requestId ? { correlationId: message.requestId } : {}
      };
    case "shutdown_rejected":
      return {
        ...common,
        kind: "decision",
        actor: { type: "agent", id: actorId },
        recipients: [{ type: "agent", id: recipientId }],
        summary: "Teammate shutdown rejected",
        status: "sent",
        relationKind: "handoff",
        ...message.requestId ? { correlationId: message.requestId } : {}
      };
    case "teammate_terminated":
      return {
        ...common,
        kind: "completion",
        actor: { type: "agent", id: actorId },
        recipients: [{ type: "agent", id: recipientId }],
        summary: "Teammate terminated",
        status: "completed",
        relationKind: "handoff"
      };
    default:
      return {
        ...common,
        kind: "handoff",
        actor: { type: "agent", id: actorId },
        recipients: [{ type: "agent", id: recipientId }],
        summary: "Teammate message",
        status: "sent",
        relationKind: "message"
      };
  }
}
function teamTaskHistory(team, task, ownerId) {
  const status = task.status === "in_progress" ? "running" : task.status === "completed" ? "completed" : "started";
  return {
    provider: "claude",
    id: `claude:team:${encodeURIComponent(team.name)}:task:${task.id}:${task.status}`,
    kind: task.status === "completed" ? "completion" : "work",
    actor: ownerId ? { type: "agent", id: ownerId } : { type: "system", label: "Claude team task list" },
    summary: task.status === "completed" ? "Team task completed" : task.status === "in_progress" ? "Team task in progress" : "Team task created",
    status,
    correlationId: `claude:team:${team.name}:task:${task.id}`,
    occurredAt: task.updatedAt,
    source: "compatibility",
    relationKind: "task"
  };
}
function applyClaudeTeamEvidence(observed, teams, cwdFilter) {
  const results = [...observed];
  const sessionThreads = /* @__PURE__ */ new Map();
  for (const thread of results) {
    if (thread.snapshot.sessionId && !thread.snapshot.parentThreadId) {
      sessionThreads.set(thread.snapshot.sessionId, thread);
    }
  }
  for (const team of teams) {
    const observedTeamSession = team.members.some((member) => Boolean(member.sessionId && sessionThreads.has(member.sessionId))) || Boolean(team.leadSessionId && sessionThreads.has(team.leadSessionId));
    if (!observedTeamSession) continue;
    const hasMatchingCwd = cwdFilter === "all" || team.members.some((member) => member.cwd === cwdFilter) || (team.leadSessionId ? sessionThreads.get(team.leadSessionId)?.snapshot.cwd === cwdFilter : false);
    if (!hasMatchingCwd) continue;
    const leadMember = team.members.find((member) => member.kind === "teamLead");
    const leadSessionId = leadMember?.sessionId ?? team.leadSessionId;
    let leadThread = leadSessionId ? sessionThreads.get(leadSessionId) : void 0;
    if (!leadThread && leadMember) {
      leadThread = emptyTeamThread(team, leadMember);
      results.push(leadThread);
    }
    if (leadThread && leadMember) enrichTeamThread(leadThread, team, leadMember);
    const leadThreadId = leadThread?.snapshot.id;
    const nameToThread = /* @__PURE__ */ new Map();
    const agentIdToThread = /* @__PURE__ */ new Map();
    for (const member of team.members) {
      const memberSessionId = member.kind === "teamLead" ? member.sessionId ?? team.leadSessionId : member.sessionId;
      let thread = memberSessionId ? sessionThreads.get(memberSessionId) : void 0;
      if (!thread) {
        thread = emptyTeamThread(team, member, member.kind === "teammate" ? leadThreadId : void 0);
        results.push(thread);
      } else {
        enrichTeamThread(thread, team, member, member.kind === "teammate" ? leadThreadId : void 0);
      }
      nameToThread.set(member.name, thread);
      agentIdToThread.set(member.agentId, thread);
    }
    const ensureFormerTeammate = (name) => {
      const known = nameToThread.get(name) ?? agentIdToThread.get(name);
      if (known) return known;
      const member = {
        agentId: `${name}@${team.name}`,
        name,
        kind: name === "team-lead" ? "teamLead" : "teammate"
      };
      const thread = emptyTeamThread(team, member, member.kind === "teammate" ? leadThreadId : void 0);
      thread.snapshot.source = {
        ...recordValue2(thread.snapshot.source),
        teamObservation: "mailbox",
        formerMember: true
      };
      results.push(thread);
      nameToThread.set(name, thread);
      return thread;
    };
    for (const task of team.tasks) {
      if (task.internal) continue;
      const owner = task.owner ? ensureFormerTeammate(task.owner) : leadThread;
      const event = teamTaskHistory(team, task, owner?.snapshot.id);
      (owner ?? leadThread)?.history.push(event);
    }
    for (const message of team.messages) {
      const actor = ensureFormerTeammate(message.from);
      const recipient = ensureFormerTeammate(message.recipient);
      actor.history.push(teamMessageHistory(team, message, actor.snapshot.id, recipient.snapshot.id));
      if (message.type === "idle_notification" && message.occurredAt >= (actor.snapshot.updatedAt ?? 0)) {
        actor.snapshot.nativeStatus = { type: "idle" };
        actor.snapshot.updatedAt = message.occurredAt;
      }
      if (message.type === "shutdown_approved" || message.type === "teammate_terminated") {
        actor.snapshot.nativeStatus = { type: "idle" };
        actor.snapshot.updatedAt = Math.max(actor.snapshot.updatedAt ?? 0, message.occurredAt);
        actor.lifecycle = "shutdown";
      }
    }
  }
  for (const thread of results) thread.history = thread.history.slice(-HISTORY_LIMIT);
  return results;
}
function readTail(path2, maxBytes = TRANSCRIPT_TAIL_BYTES) {
  const fd = openSync(path2, "r");
  try {
    const stat = fstatSync(fd);
    const length = Math.min(stat.size, maxBytes);
    const start = stat.size - length;
    const buffer = Buffer.alloc(length);
    if (length > 0) readSync(fd, buffer, 0, length, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      const newline = text.indexOf("\n");
      text = newline === -1 ? "" : text.slice(newline + 1);
    }
    return { text, stat };
  } finally {
    closeSync(fd);
  }
}
function parseSubagentMeta(path2) {
  try {
    const parsed = recordValue2(JSON.parse(readFileSync2(path2, "utf8")));
    if (!parsed) return void 0;
    return {
      ...stringValue2(parsed.agentType) ? { agentType: stringValue2(parsed.agentType) } : {},
      ...stringValue2(parsed.toolUseId) ? { toolUseId: stringValue2(parsed.toolUseId) } : {},
      ...numberValue(parsed.spawnDepth) !== void 0 ? { spawnDepth: numberValue(parsed.spawnDepth) } : {},
      ...typeof parsed.stoppedByUser === "boolean" ? { stoppedByUser: parsed.stoppedByUser } : {}
    };
  } catch {
    return void 0;
  }
}
function looksLikeInteractiveClaude(command) {
  const index = command.findIndex((token) => {
    const name = basename2(token).toLowerCase();
    return name === "claude" || name === "claude.exe";
  });
  if (index === -1) return false;
  const args = command.slice(index + 1);
  if (args.includes("-p") || args.includes("--print")) return false;
  const nonInteractive = /* @__PURE__ */ new Set(["auth", "doctor", "install", "mcp", "plugin", "update", "upgrade"]);
  const commandName = args.find((arg) => !arg.startsWith("-"));
  return !commandName || !nonInteractive.has(commandName);
}
function rootTranscriptPath(path2) {
  const cleaned = path2.replace(/ \(deleted\)$/, "");
  const parent = dirname(cleaned);
  if (basename2(parent) !== "subagents") return cleaned;
  const sessionDir = dirname(parent);
  return join2(dirname(sessionDir), `${basename2(sessionDir)}.jsonl`);
}
function samePath(left, right) {
  const normalize = (value) => value.replace(/\/+$/, "") || "/";
  return normalize(left) === normalize(right);
}
function selectActiveClaudeTranscriptPaths(candidates, discovery, cwdFilter) {
  const eligible = candidates.filter((candidate) => cwdFilter === "all" || Boolean(candidate.cwd && samePath(candidate.cwd, cwdFilter))).sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  const openPaths = discovery.openRootTranscriptPaths ?? /* @__PURE__ */ new Set();
  const selected = /* @__PURE__ */ new Set();
  for (const [cwd, count] of discovery.cwdCounts) {
    const matching = eligible.filter((candidate) => candidate.cwd && samePath(candidate.cwd, cwd));
    const exact = matching.filter((candidate) => openPaths.has(candidate.path)).slice(0, count);
    for (const candidate of exact) selected.add(candidate.path);
    for (const candidate of matching.filter((candidate2) => !selected.has(candidate2.path)).slice(0, count - exact.length)) {
      selected.add(candidate.path);
    }
  }
  if (!discovery.exact) {
    const unresolvedCount = Math.max(0, discovery.processCount - selected.size);
    for (const candidate of eligible.filter((candidate2) => !selected.has(candidate2.path)).slice(0, unresolvedCount)) {
      selected.add(candidate.path);
    }
  }
  return selected;
}
function findInteractiveClaudeCwds(procRoot = "/proc") {
  const cwdCounts = /* @__PURE__ */ new Map();
  const openRootTranscriptPaths = /* @__PURE__ */ new Set();
  let processCount = 0;
  let entries;
  try {
    entries = readdirSync2(procRoot).filter((entry) => /^\d+$/.test(entry));
  } catch {
    return {
      cwdCounts,
      processCount,
      exact: false,
      source: "unsupported",
      openRootTranscriptPaths,
      warning: "Claude process discovery requires procfs on this platform"
    };
  }
  for (const pid of entries) {
    try {
      const command = readFileSync2(join2(procRoot, pid, "cmdline"), "utf8").split("\0").filter(Boolean);
      if (!looksLikeInteractiveClaude(command)) continue;
      processCount += 1;
      const cwd = readlinkSync(join2(procRoot, pid, "cwd"));
      if (cwd) cwdCounts.set(cwd, (cwdCounts.get(cwd) ?? 0) + 1);
      try {
        for (const fd of readdirSync2(join2(procRoot, pid, "fd"))) {
          const target = readlinkSync(join2(procRoot, pid, "fd", fd));
          if (target.replace(/ \(deleted\)$/, "").endsWith(".jsonl")) {
            openRootTranscriptPaths.add(rootTranscriptPath(target));
          }
        }
      } catch {
      }
    } catch {
    }
  }
  return { cwdCounts, processCount, exact: true, source: "procfs", openRootTranscriptPaths };
}
function cliVersion() {
  const result = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 5e3 });
  if (result.error || result.status !== 0) return "unknown";
  return (result.stdout ?? "").trim().replace(/\s*\(Claude Code\)\s*$/, "") || "unknown";
}
var ClaudeCodeAdapter = class {
  provider = "claude";
  mode = "claude";
  #listeners = /* @__PURE__ */ new Set();
  #threads = /* @__PURE__ */ new Map();
  #emittedThreads = /* @__PURE__ */ new Map();
  #seenActivities = /* @__PURE__ */ new Set();
  #seenHistory = /* @__PURE__ */ new Set();
  #seenRequests = /* @__PURE__ */ new Set();
  #lifecycle = /* @__PURE__ */ new Map();
  #timer;
  #connected = false;
  #version = "unknown";
  #claudeHome;
  #cwd;
  #pollIntervalMs;
  #now;
  #processDiscovery;
  #captureContent;
  constructor(options = {}) {
    const environment = options.environment ?? process.env;
    this.#claudeHome = options.claudeHome ?? join2(homedir(), ".claude");
    this.#cwd = options.cwd ?? environment.OBSERVATORY_CWD ?? environment.OBSERVATORY_LAUNCH_CWD ?? environment.INIT_CWD ?? process.cwd();
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#now = options.now ?? Date.now;
    this.#processDiscovery = options.processDiscovery ?? findInteractiveClaudeCwds;
    this.#captureContent = contentCaptureEnabled(environment);
  }
  runtimeInfo() {
    return {
      adapter: "claude",
      provider: "claude",
      observatoryVersion: OBSERVATORY_VERSION,
      claudeCliVersion: this.#version,
      experimentalApi: false,
      discoveryStrategy: "compatibility",
      contentCapture: this.#captureContent ? "enabled" : "metadata-only"
    };
  }
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async connect() {
    if (this.#connected) return;
    this.#connected = true;
    this.#emit({
      type: "connection.changed",
      at: this.#now(),
      connection: { phase: "connecting", attempt: 0, message: "Discovering Claude Code sessions" }
    });
    this.#version = cliVersion();
    await this.#refresh(true);
    this.#emit({ type: "runtime.updated", at: this.#now(), runtime: this.runtimeInfo() });
    this.#emit({
      type: "connection.changed",
      at: this.#now(),
      connection: { phase: "connected", attempt: 0, message: "Observing local Claude Code transcripts" }
    });
    this.#timer = setInterval(() => {
      void this.#refresh(true).catch((error) => this.#debug("Claude compatibility refresh failed", error));
    }, this.#pollIntervalMs);
    this.#timer.unref?.();
  }
  async disconnect() {
    this.#connected = false;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = void 0;
    this.#emit({
      type: "connection.changed",
      at: this.#now(),
      connection: { phase: "disconnected", attempt: 0, message: "Claude observation stopped" }
    });
  }
  async listThreads(options) {
    await this.#refresh(false);
    const all = [...this.#threads.values()].map((thread) => thread.snapshot);
    if (!options?.rootThreadId) return all;
    const rootThreadId = requestedThreadId(options.rootThreadId);
    const descendants = /* @__PURE__ */ new Set();
    let changed = true;
    while (changed) {
      changed = false;
      for (const thread of all) {
        if (thread.parentThreadId === rootThreadId || thread.parentThreadId && descendants.has(thread.parentThreadId)) {
          if (!descendants.has(thread.id)) {
            descendants.add(thread.id);
            changed = true;
          }
        }
      }
    }
    return all.filter((thread) => descendants.has(thread.id));
  }
  async listLoadedThreads() {
    await this.#refresh(false);
    return [...this.#threads.values()].filter((thread) => thread.snapshot.nativeStatus.type !== "notLoaded").map((thread) => thread.snapshot.id);
  }
  async readThread(threadId, _options) {
    await this.#refresh(false);
    const thread = this.#threads.get(requestedThreadId(threadId));
    if (!thread) throw new Error(`Claude thread not found: ${threadId}`);
    return thread.snapshot;
  }
  async #refresh(emit) {
    const processDiscovery = this.#processDiscovery();
    const observed = this.#scanTranscripts(processDiscovery);
    this.#threads = new Map(observed.map((thread) => [thread.snapshot.id, thread]));
    if (!emit) return;
    const observedIds = new Set(this.#threads.keys());
    for (const [id, thread] of this.#emittedThreads) {
      if (observedIds.has(id)) continue;
      this.#forgetThreadEvidence(thread);
      this.#emit({ type: "thread.removed", at: this.#now(), threadId: id });
    }
    for (const thread of observed) this.#emitThread(thread);
    this.#emittedThreads = new Map(observed.map((thread) => [thread.snapshot.id, thread]));
    if (processDiscovery.warning) this.#debug(processDiscovery.warning);
  }
  #scanTranscripts(processDiscovery) {
    const projectsRoot = join2(this.#claudeHome, "projects");
    let projectDirs;
    try {
      projectDirs = readdirSync2(projectsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join2(projectsRoot, entry.name));
    } catch {
      projectDirs = [];
    }
    const candidates = [];
    for (const projectDir of projectDirs) {
      let files;
      try {
        files = readdirSync2(projectDir).filter((name) => name.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const file of files) {
        const path2 = join2(projectDir, file);
        const fallbackSessionId = file.slice(0, -".jsonl".length);
        let rootTail;
        try {
          rootTail = readTail(path2);
        } catch {
          continue;
        }
        const sessionId = this.#sessionId(rootTail.text) ?? fallbackSessionId;
        const fallbackCwd = this.#transcriptCwd(rootTail.text);
        candidates.push({
          path: path2,
          projectDir,
          sessionId,
          rootTail,
          ...fallbackCwd ? { cwd: fallbackCwd } : {},
          updatedAt: rootTail.stat.mtimeMs
        });
      }
    }
    const selectedPaths = selectActiveClaudeTranscriptPaths(candidates, processDiscovery, this.#cwd);
    const results = [];
    for (const candidate of candidates) {
      if (!selectedPaths.has(candidate.path)) continue;
      const { path: path2, projectDir, sessionId, rootTail } = candidate;
      const fallbackCwd = candidate.cwd;
      const rootId = namespaceRoot(sessionId);
      const processActive = true;
      const root = parseClaudeTranscript(rootTail.text, {
        threadId: rootId,
        sessionId,
        fallbackCwd,
        isRoot: true,
        processActive,
        createdAt: rootTail.stat.birthtimeMs || void 0,
        updatedAt: rootTail.stat.mtimeMs,
        captureContent: this.#captureContent
      });
      results.push({ ...root, path: path2 });
      const subagentsDir = join2(projectDir, sessionId, "subagents");
      let agentFiles;
      try {
        agentFiles = readdirSync2(subagentsDir).filter((name) => name.startsWith("agent-") && name.endsWith(".jsonl"));
      } catch {
        continue;
      }
      const parsedAgents = [];
      for (const agentFile of agentFiles) {
        const agentPath = join2(subagentsDir, agentFile);
        const nativeAgentId = agentFile.slice(0, -".jsonl".length);
        const threadId = namespaceSubagent(sessionId, nativeAgentId);
        let tail;
        try {
          tail = readTail(agentPath);
        } catch {
          continue;
        }
        const meta = parseSubagentMeta(join2(subagentsDir, `${nativeAgentId}.meta.json`));
        const parsed = parseClaudeTranscript(tail.text, {
          threadId,
          sessionId,
          parentThreadId: rootId,
          fallbackCwd,
          isRoot: false,
          processActive,
          createdAt: tail.stat.birthtimeMs || void 0,
          updatedAt: tail.stat.mtimeMs,
          meta,
          captureContent: this.#captureContent
        });
        parsedAgents.push({ observed: { ...parsed, path: agentPath }, meta });
      }
      const toolOwner = /* @__PURE__ */ new Map();
      for (const id of root.toolUseIds) toolOwner.set(id, rootId);
      for (const { observed } of parsedAgents) {
        for (const id of observed.toolUseIds) toolOwner.set(id, observed.snapshot.id);
      }
      for (const { observed, meta } of parsedAgents) {
        const parent = meta?.toolUseId ? toolOwner.get(meta.toolUseId) : void 0;
        if (parent && parent !== observed.snapshot.id) observed.snapshot.parentThreadId = parent;
        results.push(observed);
      }
    }
    return applyClaudeTeamEvidence(results, discoverClaudeAgentTeams(this.#claudeHome), this.#cwd);
  }
  #forgetThreadEvidence(thread) {
    for (const activity of thread.activities) this.#seenActivities.delete(activity.id);
    for (const history of thread.history) this.#seenHistory.delete(history.id);
    for (const request of thread.pendingRequests) this.#seenRequests.delete(request.id);
    this.#lifecycle.delete(thread.snapshot.id);
  }
  #sessionId(text) {
    for (const line of text.split("\n")) {
      const sessionId = stringValue2(parseJsonRecord(line)?.sessionId);
      if (sessionId) return sessionId;
    }
    return void 0;
  }
  #transcriptCwd(text) {
    for (const line of text.split("\n")) {
      const cwd = stringValue2(parseJsonRecord(line)?.cwd);
      if (cwd) return cwd;
    }
    return void 0;
  }
  #emitThread(thread) {
    const at = this.#now();
    this.#emit({ type: "thread.discovered", at, thread: thread.snapshot });
    for (const activity of thread.activities) {
      if (this.#seenActivities.has(activity.id)) continue;
      this.#seenActivities.add(activity.id);
      this.#emit({ type: "activity.started", at: activity.startedAt, activity });
      if (activity.completedAt !== void 0) {
        this.#emit({
          type: "activity.completed",
          at: activity.completedAt,
          threadId: activity.agentId,
          activityId: activity.id,
          activity,
          outcome: activity.outcome
        });
      }
    }
    for (const history of thread.history) {
      if (this.#seenHistory.has(history.id)) continue;
      this.#seenHistory.add(history.id);
      this.#emit({ type: "history.recorded", at: history.occurredAt, history });
    }
    const openRequestIds = new Set(thread.pendingRequests.map((request) => request.id));
    for (const request of thread.pendingRequests) {
      if (this.#seenRequests.has(request.id)) continue;
      this.#seenRequests.add(request.id);
      this.#emit({ type: "request.opened", at: request.openedAt, request });
    }
    for (const requestId of [...this.#seenRequests]) {
      if (!requestId.startsWith(`${thread.snapshot.id}:request:`) || openRequestIds.has(requestId)) continue;
      this.#seenRequests.delete(requestId);
      this.#emit({ type: "request.resolved", at, requestId, threadId: thread.snapshot.id });
    }
    if (thread.usage) this.#emit({ type: "token.updated", at, threadId: thread.snapshot.id, usage: thread.usage });
    const previousLifecycle = this.#lifecycle.get(thread.snapshot.id);
    if (thread.lifecycle && previousLifecycle !== thread.lifecycle) {
      this.#lifecycle.set(thread.snapshot.id, thread.lifecycle);
      this.#emit({
        type: "agent.lifecycle",
        at,
        threadId: thread.snapshot.id,
        status: thread.lifecycle
      });
    }
  }
  #emit(event) {
    const tagged = { ...event, provider: "claude" };
    for (const listener of this.#listeners) listener(tagged);
  }
  #debug(summary, payload) {
    const at = this.#now();
    this.#emit({
      type: "debug",
      at,
      entry: {
        id: `${at}:${Math.random().toString(36).slice(2)}`,
        at,
        direction: "internal",
        category: "connection",
        summary,
        ...payload instanceof Error ? { payload: { name: payload.name, message: payload.message } } : {}
      }
    });
  }
};

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
  const providerConnections = Object.fromEntries(
    (runtime.providers ?? []).filter((provider) => provider.connection).map((provider) => [provider.provider, provider.connection])
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
    revision: 0
  };
}
function runtimeProvider(runtime) {
  return runtime.provider ?? (runtime.adapter === "composite" ? "unknown" : runtime.adapter);
}
function eventProvider(state, event) {
  if (event.provider) return event.provider;
  if (event.type === "thread.discovered" && event.thread.provider) return event.thread.provider;
  if (event.type === "activity.started" && event.activity.provider) return event.activity.provider;
  if (event.type === "activity.completed" && event.activity?.provider) return event.activity.provider;
  if (event.type === "history.recorded" && event.history.provider) return event.history.provider;
  if (event.type === "request.opened" && event.request.provider) return event.request.provider;
  if (event.type === "debug" && event.entry.provider) return event.entry.provider;
  return runtimeProvider(state.runtime);
}
function agentFromThread(thread, provider) {
  const projected = projectNativeStatus(thread.nativeStatus);
  return {
    provider: thread.provider ?? provider,
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
    ...thread.path ? { path: thread.path } : {},
    ...thread.evidenceSources ? { evidenceSources: thread.evidenceSources } : {}
  };
}
function ensureAgent(state, threadId, at, provider = runtimeProvider(state.runtime)) {
  return state.agents[threadId] ?? {
    provider,
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
  const actorProvider = history.actor.type === "agent" && history.actor.id ? state.agents[history.actor.id]?.provider : void 0;
  const tagged = { ...history, provider: history.provider ?? actorProvider ?? runtimeProvider(state.runtime) };
  return [tagged, ...state.history.filter((item) => item.id !== history.id)].slice(0, limit);
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
    provider: activity.provider,
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
  const provider = eventProvider(state, event);
  let next = {
    ...state,
    agents: { ...state.agents },
    pendingRequests: { ...state.pendingRequests },
    providerConnections: { ...state.providerConnections },
    revision: state.revision + 1
  };
  switch (event.type) {
    case "thread.discovered": {
      const previous = state.agents[event.thread.id];
      const discovered = agentFromThread(event.thread, provider);
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
          provider,
          kind: "handoff",
          actor: agentActor(event.thread.parentThreadId),
          recipients: [{ type: "agent", id: event.thread.id, label: event.thread.nickname }],
          summary: `Started ${event.thread.nickname ?? event.thread.role ?? "subagent"}`,
          ...event.thread.role ? { content: event.thread.role } : {},
          status: "started",
          correlationId: event.thread.id,
          occurredAt: event.at,
          source: "derived",
          relationKind: "spawn"
        }, historyLimit);
      }
      break;
    }
    case "thread.removed": {
      const removedIds = /* @__PURE__ */ new Set([event.threadId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const agent of Object.values(state.agents)) {
          if (agent.parentId && removedIds.has(agent.parentId) && !removedIds.has(agent.id)) {
            removedIds.add(agent.id);
            changed = true;
          }
        }
      }
      next.agents = rebuildChildren(Object.fromEntries(
        Object.entries(state.agents).filter(([id]) => !removedIds.has(id))
      ));
      next.activities = state.activities.filter((activity) => !removedIds.has(activity.agentId));
      next.history = state.history.filter((history) => {
        const actorRemoved = history.actor.type === "agent" && Boolean(history.actor.id && removedIds.has(history.actor.id));
        const recipientRemoved = (history.recipients ?? []).some((recipient) => recipient.type === "agent" && Boolean(recipient.id && removedIds.has(recipient.id)));
        return !actorRemoved && !recipientRemoved;
      });
      next.pendingRequests = Object.fromEntries(
        Object.entries(state.pendingRequests).filter(([, request]) => !removedIds.has(request.agentId))
      );
      if (state.selectedAgentId && removedIds.has(state.selectedAgentId)) next.selectedAgentId = void 0;
      break;
    }
    case "thread.status": {
      const previous = ensureAgent(state, event.threadId, event.at, provider);
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
      const previous = ensureAgent(state, event.threadId, event.at, provider);
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
          provider,
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
      const previous = ensureAgent(state, event.threadId, event.at, provider);
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
        provider,
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
      const previous = ensureAgent(state, event.threadId, event.at, provider);
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
        provider,
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
      const activity = { ...event.activity, provider: event.activity.provider ?? provider };
      const previous = ensureAgent(state, activity.agentId, event.at, provider);
      next.activities = [activity, ...state.activities.filter((item) => item.id !== activity.id)].slice(
        0,
        limits.activities
      );
      next.agents[activity.agentId] = {
        ...previous,
        currentActivityId: activity.id,
        recentActivityIds: [
          activity.id,
          ...previous.recentActivityIds.filter((id) => id !== activity.id)
        ].slice(0, RECENT_ACTIVITY_LIMIT),
        updatedAt: event.at
      };
      const startedHistory = activityHistory(activity, "running");
      if (startedHistory) next.history = recordHistory(state, startedHistory, historyLimit);
      break;
    }
    case "activity.completed": {
      const previous = ensureAgent(state, event.threadId, event.at, provider);
      const existing = state.activities.find((activity) => activity.id === event.activityId);
      const completedSource = event.activity ?? (existing ? { ...existing, completedAt: event.at, ...event.outcome ? { outcome: event.outcome } : {} } : void 0);
      const completed = completedSource ? { ...completedSource, provider: completedSource.provider ?? provider } : void 0;
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
      next.history = recordHistory(
        state,
        resolveHistoryRecipients(state, { ...event.history, provider: event.history.provider ?? provider }),
        historyLimit
      );
      break;
    case "request.opened": {
      const request = { ...event.request, provider: event.request.provider ?? provider };
      next.pendingRequests[request.id] = request;
      const previous = ensureAgent(state, request.agentId, event.at, provider);
      const reasons = Array.from(/* @__PURE__ */ new Set([...previous.waitingReasons, request.reason]));
      next.agents[request.agentId] = {
        ...previous,
        status: "waiting",
        waitingReasons: reasons,
        updatedAt: event.at
      };
      next.history = recordHistory(state, {
        id: `request:${request.id}`,
        provider,
        kind: "request",
        actor: agentActor(request.agentId),
        recipients: [{ type: "human" }],
        summary: request.title,
        ...request.detail ? { content: request.detail } : {},
        status: "running",
        correlationId: request.id,
        occurredAt: request.openedAt,
        source: "derived"
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
          updatedAt: event.at
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
function relationFromHistory(history) {
  if (history.relationKind) return history.relationKind;
  if (history.kind === "handoff") return "handoff";
  return void 0;
}
function actorAgentId(actor) {
  return actor.type === "agent" ? actor.id : void 0;
}
function buildGraph(agents, history = []) {
  const roots = [];
  const edges = [];
  for (const agent of Object.values(agents)) {
    if (agent.parentId && agents[agent.parentId]) {
      edges.push({
        id: `${agent.parentId}->${agent.id}`,
        source: agent.parentId,
        target: agent.id,
        kind: "spawn",
        evidenceSource: agent.evidenceSources?.[0] ?? "derived"
      });
    } else {
      roots.push(agent.id);
    }
  }
  const seenRelations = /* @__PURE__ */ new Set();
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
        occurredAt: event.occurredAt
      });
    }
  }
  roots.sort((a, b) => (agents[a]?.startedAt ?? 0) - (agents[b]?.startedAt ?? 0));
  return { roots, edges };
}
function toSnapshot(state) {
  return { ...state, ...buildGraph(state.agents, state.history) };
}

// packages/observatory-core/src/runtime-namespace.ts
function providerPrefix(provider) {
  return `${encodeURIComponent(provider)}:`;
}
function namespaceRuntimeId(provider, id) {
  const prefix = providerPrefix(provider);
  return id.startsWith(prefix) ? id : `${prefix}${id}`;
}
function stripRuntimeIdNamespace(provider, id) {
  const prefix = providerPrefix(provider);
  return id.startsWith(prefix) ? id.slice(prefix.length) : void 0;
}
function optionalId(provider, id) {
  return id === void 0 ? void 0 : namespaceRuntimeId(provider, id);
}
function namespaceActor(provider, actor) {
  return actor.type === "agent" && actor.id ? { ...actor, id: namespaceRuntimeId(provider, actor.id) } : actor;
}
function namespaceThreadSnapshot(provider, thread) {
  return {
    ...thread,
    provider,
    id: namespaceRuntimeId(provider, thread.id),
    sessionId: optionalId(provider, thread.sessionId),
    parentThreadId: optionalId(provider, thread.parentThreadId),
    forkedFromId: optionalId(provider, thread.forkedFromId)
  };
}
function namespaceAgentActivity(provider, activity) {
  return {
    ...activity,
    provider,
    id: namespaceRuntimeId(provider, activity.id),
    agentId: namespaceRuntimeId(provider, activity.agentId)
  };
}
function namespaceHistoryEvent(provider, history) {
  return {
    ...history,
    provider,
    id: namespaceRuntimeId(provider, history.id),
    actor: namespaceActor(provider, history.actor),
    recipients: history.recipients?.map((recipient) => namespaceActor(provider, recipient)),
    turnId: optionalId(provider, history.turnId),
    correlationId: optionalId(provider, history.correlationId),
    parentEventId: optionalId(provider, history.parentEventId)
  };
}
function namespacePendingRequest(provider, request) {
  return {
    ...request,
    provider,
    id: namespaceRuntimeId(provider, request.id),
    agentId: namespaceRuntimeId(provider, request.agentId)
  };
}
function providerRuntimeInfo(provider, runtime) {
  return { ...runtime, provider };
}
function namespaceRuntimeEvent(provider, event) {
  switch (event.type) {
    case "thread.discovered":
      return { ...event, provider, thread: namespaceThreadSnapshot(provider, event.thread) };
    case "thread.removed":
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
        turnId: namespaceRuntimeId(provider, event.turnId)
      };
    case "activity.started":
      return { ...event, provider, activity: namespaceAgentActivity(provider, event.activity) };
    case "activity.completed":
      return {
        ...event,
        provider,
        threadId: namespaceRuntimeId(provider, event.threadId),
        activityId: namespaceRuntimeId(provider, event.activityId),
        activity: event.activity ? namespaceAgentActivity(provider, event.activity) : void 0
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
        threadId: optionalId(provider, event.threadId)
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
          id: namespaceRuntimeId(provider, event.entry.id)
        }
      };
  }
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

// apps/server/src/composite-adapter.ts
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
var CompositeRuntimeAdapter = class {
  constructor(adapters) {
    this.adapters = adapters;
    const providers = /* @__PURE__ */ new Set();
    for (const adapter2 of adapters) {
      if (providers.has(adapter2.provider)) {
        throw new Error(`Duplicate runtime provider: ${adapter2.provider}`);
      }
      providers.add(adapter2.provider);
      this.#runtimes.set(adapter2.provider, { ...adapter2.runtimeInfo(), provider: adapter2.provider });
      this.#connections.set(adapter2.provider, { phase: "connecting", attempt: 0 });
    }
  }
  adapters;
  provider = "composite";
  mode = "composite";
  #listeners = /* @__PURE__ */ new Set();
  #unsubscribers = [];
  #connections = /* @__PURE__ */ new Map();
  #runtimes = /* @__PURE__ */ new Map();
  #aggregatePhase = "connecting";
  runtimeInfo() {
    const providers = this.adapters.map((adapter2) => {
      const runtime = this.#runtimes.get(adapter2.provider) ?? adapter2.runtimeInfo();
      return {
        ...runtime,
        provider: adapter2.provider,
        connection: this.#connections.get(adapter2.provider)
      };
    });
    return {
      adapter: "composite",
      provider: "composite",
      observatoryVersion: providers[0]?.observatoryVersion ?? "unknown",
      experimentalApi: providers.some((runtime) => runtime.experimentalApi),
      discoveryStrategy: "composite",
      contentCapture: providers.every((runtime) => runtime.contentCapture === "enabled") ? "enabled" : "metadata-only",
      providers
    };
  }
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async connect() {
    this.#ensureSubscriptions();
    this.#emit({
      type: "connection.changed",
      at: Date.now(),
      provider: this.provider,
      connection: { phase: "connecting", attempt: 0 }
    });
    const results = await Promise.allSettled(this.adapters.map(async (adapter2) => {
      const previous = this.#connections.get(adapter2.provider);
      this.#setProviderConnection(adapter2.provider, {
        phase: previous?.phase === "connected" ? "reconnecting" : "connecting",
        attempt: (previous?.attempt ?? 0) + 1
      });
      try {
        await adapter2.connect();
        this.#setProviderConnection(adapter2.provider, {
          phase: "connected",
          attempt: this.#connections.get(adapter2.provider)?.attempt ?? 1
        });
      } catch (error) {
        this.#setProviderConnection(adapter2.provider, {
          phase: "disconnected",
          attempt: this.#connections.get(adapter2.provider)?.attempt ?? 1,
          message: errorMessage(error)
        });
        throw error;
      }
    }));
    const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (results.length > 0 && failures.length === results.length) {
      this.#emitAggregate("disconnected");
      throw new AggregateError(failures, "All runtime providers failed to connect");
    }
    this.#emitAggregate("connected");
  }
  async disconnect() {
    await Promise.allSettled(this.adapters.map(async (adapter2) => {
      try {
        await adapter2.disconnect();
      } finally {
        this.#setProviderConnection(adapter2.provider, {
          phase: "disconnected",
          attempt: this.#connections.get(adapter2.provider)?.attempt ?? 0
        });
      }
    }));
    this.#emitAggregate("disconnected");
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
  }
  async listThreads(options) {
    const selected = this.#selectAdapters(options?.rootThreadId);
    const results = await Promise.allSettled(selected.map(async ({ adapter: adapter2, localRootThreadId }) => {
      const threads = await adapter2.listThreads(
        localRootThreadId ? { ...options, rootThreadId: localRootThreadId } : options
      );
      return threads.map((thread) => namespaceThreadSnapshot(adapter2.provider, thread));
    }));
    return results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  }
  async listLoadedThreads() {
    const results = await Promise.allSettled(this.adapters.map(async (adapter2) => {
      const ids = await adapter2.listLoadedThreads();
      return ids.map((id) => namespaceRuntimeId(adapter2.provider, id));
    }));
    return results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  }
  async readThread(threadId, options) {
    for (const adapter2 of this.adapters) {
      const localId = stripRuntimeIdNamespace(adapter2.provider, threadId);
      if (localId === void 0) continue;
      return namespaceThreadSnapshot(adapter2.provider, await adapter2.readThread(localId, options));
    }
    throw new Error(`No runtime provider owns thread: ${threadId}`);
  }
  #selectAdapters(rootThreadId) {
    if (!rootThreadId) return this.adapters.map((adapter2) => ({ adapter: adapter2 }));
    for (const adapter2 of this.adapters) {
      const localRootThreadId = stripRuntimeIdNamespace(adapter2.provider, rootThreadId);
      if (localRootThreadId !== void 0) return [{ adapter: adapter2, localRootThreadId }];
    }
    return [];
  }
  #ensureSubscriptions() {
    if (this.#unsubscribers.length > 0) return;
    this.#unsubscribers = this.adapters.map((adapter2) => adapter2.subscribe((event) => {
      if (event.type === "connection.changed") {
        this.#setProviderConnection(adapter2.provider, event.connection, event.at);
        return;
      }
      if (event.type === "runtime.updated") {
        this.#runtimes.set(adapter2.provider, { ...event.runtime, provider: adapter2.provider });
        this.#emit({
          type: "runtime.updated",
          at: event.at,
          provider: this.provider,
          runtime: this.runtimeInfo()
        });
        return;
      }
      this.#emit(namespaceRuntimeEvent(adapter2.provider, event));
    }));
  }
  #setProviderConnection(provider, connection, at = Date.now()) {
    const previous = this.#connections.get(provider);
    this.#connections.set(provider, connection);
    if (previous?.phase !== connection.phase || previous.attempt !== connection.attempt || previous.message !== connection.message || previous.nextRetryAt !== connection.nextRetryAt) {
      this.#emit({ type: "provider.connection.changed", at, provider, connection });
    }
    const phases = Array.from(this.#connections.values(), (state) => state.phase);
    const aggregate = phases.includes("connected") ? "connected" : phases.includes("reconnecting") ? "reconnecting" : phases.includes("connecting") ? "connecting" : "disconnected";
    this.#emitAggregate(aggregate, at);
  }
  #emitAggregate(phase, at = Date.now()) {
    if (this.#aggregatePhase === phase) return;
    this.#aggregatePhase = phase;
    this.#emit({
      type: "connection.changed",
      at,
      provider: this.provider,
      connection: { phase, attempt: 0 }
    });
  }
  #emit(event) {
    for (const listener of this.#listeners) listener(event);
  }
};

// apps/server/src/codex-adapter.ts
import { spawn, spawnSync as spawnSync2 } from "node:child_process";
import readline from "node:readline";

// apps/server/src/normalize.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringValue3(value) {
  return typeof value === "string" ? value : void 0;
}
function numberValue2(value) {
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
  const parentThreadId = stringValue3(value.parentThreadId) ?? stringValue3(spawn2?.parent_thread_id);
  const nickname = stringValue3(value.agentNickname) ?? stringValue3(spawn2?.agent_nickname);
  const role = stringValue3(value.agentRole) ?? stringValue3(spawn2?.agent_role);
  const model = stringValue3(value.model);
  const reasoningEffort = stringValue3(value.reasoningEffort) ?? stringValue3(value.effort);
  const observedSkills = stringArray(value.observedSkills);
  const observedWorkflows = stringArray(value.observedWorkflows);
  const collaborationMode = stringValue3(value.collaborationMode);
  const createdAtSeconds = numberValue2(value.createdAt);
  const updatedAtSeconds = numberValue2(value.updatedAt);
  return {
    id: value.id,
    ...stringValue3(value.sessionId) ? { sessionId: stringValue3(value.sessionId) } : {},
    ...parentThreadId ? { parentThreadId } : {},
    ...stringValue3(value.forkedFromId) ? { forkedFromId: stringValue3(value.forkedFromId) } : {},
    ...nickname ? { nickname } : {},
    ...role ? { role } : {},
    nativeStatus: statusValue(value.status),
    ...createdAtSeconds !== void 0 ? { createdAt: createdAtSeconds * 1e3 } : {},
    ...updatedAtSeconds !== void 0 ? { updatedAt: updatedAtSeconds * 1e3 } : {},
    ...stringValue3(value.cwd) ? { cwd: stringValue3(value.cwd) } : {},
    ...model ? { model } : {},
    ...stringValue3(value.modelProvider) ? { modelProvider: stringValue3(value.modelProvider) } : {},
    ...reasoningEffort ? { reasoningEffort } : {},
    ...observedSkills ? { observedSkills } : {},
    ...observedWorkflows ? { observedWorkflows } : {},
    ...collaborationMode ? { collaborationMode } : {},
    ...value.source !== void 0 ? { source: value.source } : {},
    ...numberValue2(spawn2?.depth) !== void 0 ? { depth: numberValue2(spawn2?.depth) } : {},
    ...stringValue3(spawn2?.agent_path) ? { path: stringValue3(spawn2?.agent_path) } : {}
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
    const text = stringValue3(entry.text) ?? stringValue3(entry.input_text) ?? stringValue3(entry.output_text);
    if (text) parts.push(text);
    else if (entry.type === "skill" && stringValue3(entry.name)) parts.push(`Skill: ${stringValue3(entry.name)}`);
    else if (entry.type === "mention" && stringValue3(entry.name)) parts.push(`Mention: ${stringValue3(entry.name)}`);
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
  const itemId = stringValue3(item.id) ?? `${threadId}:${at}`;
  const base = {
    id: `activity:${itemId}`,
    actor: agentRef(threadId),
    status: historyStatus(item, completed),
    ...turnId ? { turnId } : {},
    correlationId: itemId,
    occurredAt: completed ? at - (numberValue2(item.durationMs) ?? 0) : at,
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
      ...boundedText(stringValue3(item.text)) ? { content: boundedText(stringValue3(item.text)) } : {},
      status: "completed"
    }];
  }
  if (item.type === "agentMessage") {
    const phase = stringValue3(item.phase);
    return [{
      ...base,
      kind: "delivery",
      recipients: [{ type: "human" }],
      summary: phase === "final_answer" ? "Delivered final result" : phase === "commentary" ? "Shared progress update" : "Agent message",
      ...boundedText(stringValue3(item.text)) ? { content: boundedText(stringValue3(item.text)) } : {},
      status: phase === "final_answer" || completed ? "completed" : "sent"
    }];
  }
  if (item.type !== "collabAgentToolCall") return [];
  const senderId = stringValue3(item.senderThreadId) ?? threadId;
  const receivers = stringArray(item.receiverThreadIds) ?? [];
  const recipients = receivers.map((id) => agentRef(id));
  const tool = stringValue3(item.tool) ?? "collaboration";
  const details = {
    spawnAgent: { kind: "handoff", summary: "Delegated work", relationKind: "spawn" },
    sendInput: { kind: "handoff", summary: "Sent message", relationKind: "message" },
    resumeAgent: { kind: "handoff", summary: "Resumed agent", relationKind: "handoff" },
    wait: { kind: "work", summary: "Waited for agents" },
    closeAgent: { kind: "completion", summary: "Closed agent" }
  };
  const detail = details[tool] ?? { kind: "handoff", summary: "Agent collaboration" };
  const events = [{
    ...base,
    kind: detail.kind,
    ...detail.relationKind ? { relationKind: detail.relationKind } : {},
    actor: agentRef(senderId),
    ...recipients.length > 0 ? { recipients } : {},
    summary: detail.summary,
    ...boundedText(stringValue3(item.prompt)) ? { content: boundedText(stringValue3(item.prompt)) } : {}
  }];
  if (isRecord(item.agentsStates)) {
    for (const [receiverId, state] of Object.entries(item.agentsStates)) {
      if (!isRecord(state)) continue;
      const message = boundedText(stringValue3(state.message));
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
  const id = stringValue3(item.id) ?? `${threadId}:${at}`;
  const base = {
    id,
    agentId: threadId,
    startedAt: completed ? at - (numberValue2(item.durationMs) ?? 0) : at,
    ...completed ? { completedAt: at } : {},
    ...itemOutcome(item) ? { outcome: itemOutcome(item) } : {}
  };
  switch (item.type) {
    case "reasoning":
      return { ...base, kind: "thinking", title: "Thinking" };
    case "commandExecution": {
      const command = stringValue3(item.command) ?? "Command";
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
      const paths = changes.map((change) => stringValue3(change.path)).filter((path2) => Boolean(path2));
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
        title: `${stringValue3(item.server) ?? "MCP"} \xB7 ${stringValue3(item.tool) ?? "tool"}`
      };
    case "dynamicToolCall":
      return {
        ...base,
        kind: "tool",
        title: [stringValue3(item.namespace), stringValue3(item.tool)].filter(Boolean).join(" \xB7 ") || "Tool call"
      };
    case "collabAgentToolCall":
      return {
        ...base,
        kind: "tool",
        title: `Agent \xB7 ${stringValue3(item.tool) ?? "collaboration"}`,
        ...stringValue3(item.prompt) ? { detail: stringValue3(item.prompt) } : {},
        metadata: { receiverThreadIds: item.receiverThreadIds }
      };
    case "subAgentActivity":
      return {
        ...base,
        kind: "message",
        title: `Subagent ${stringValue3(item.kind) ?? "activity"}`,
        detail: stringValue3(item.agentPath) ?? stringValue3(item.agentThreadId)
      };
    case "agentMessage":
      return {
        ...base,
        kind: "message",
        title: "Agent message",
        ...stringValue3(item.text) ? { detail: stringValue3(item.text)?.slice(0, 240) } : {}
      };
    case "webSearch":
      return { ...base, kind: "tool", title: "Searching the web" };
    case "imageView":
      return { ...base, kind: "read", title: "Viewing image", detail: stringValue3(item.path) };
    case "imageGeneration":
      return { ...base, kind: "tool", title: "Generating image" };
    case "sleep":
      return { ...base, kind: "tool", title: "Waiting on timer" };
    case "contextCompaction":
      return { ...base, kind: "thinking", title: "Compacting context" };
    default:
      return { ...base, kind: "unknown", title: stringValue3(item.type) ?? "Unknown activity" };
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
      ...stringValue3(state.message) ? { message: stringValue3(state.message) } : {}
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
    ...numberValue2(total.inputTokens) !== void 0 ? { inputTokens: numberValue2(total.inputTokens) } : {},
    ...numberValue2(total.cachedInputTokens) !== void 0 ? { cachedInputTokens: numberValue2(total.cachedInputTokens) } : {},
    ...numberValue2(total.outputTokens) !== void 0 ? { outputTokens: numberValue2(total.outputTokens) } : {},
    ...numberValue2(total.reasoningOutputTokens) !== void 0 ? { reasoningOutputTokens: numberValue2(total.reasoningOutputTokens) } : {},
    ...numberValue2(total.totalTokens) !== void 0 ? { totalTokens: numberValue2(total.totalTokens) } : {},
    ...numberValue2(value.modelContextWindow) !== void 0 ? { modelContextWindow: numberValue2(value.modelContextWindow) } : {}
  };
}
function normalizeEnvelope(envelope, at = Date.now()) {
  const method = envelope.method;
  const params = isRecord(envelope.params) ? envelope.params : {};
  if (!method) return [];
  const request = requestReason(method);
  if (request && envelope.id !== void 0) {
    const threadId = stringValue3(params.threadId);
    if (!threadId) return [];
    const pending = {
      id: String(envelope.id),
      agentId: threadId,
      reason: request.reason,
      title: request.title,
      ...stringValue3(params.reason) ? { detail: stringValue3(params.reason) } : {},
      openedAt: numberValue2(params.startedAtMs) ?? at
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
      const threadId = stringValue3(params.threadId);
      return threadId ? [{ type: "thread.status", at, threadId, status: statusValue(params.status) }] : [];
    }
    case "turn/started": {
      const turn = isRecord(params.turn) ? params.turn : {};
      const threadId = stringValue3(params.threadId);
      const turnId = stringValue3(turn.id);
      return threadId && turnId ? [{ type: "turn.started", at, threadId, turnId }] : [];
    }
    case "turn/completed": {
      const turn = isRecord(params.turn) ? params.turn : {};
      const threadId = stringValue3(params.threadId);
      const turnId = stringValue3(turn.id);
      const status = stringValue3(turn.status);
      if (!threadId || !turnId || !status || !["completed", "interrupted", "failed"].includes(status)) return [];
      const error = isRecord(turn.error) ? stringValue3(turn.error.message) : void 0;
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
      const threadId = stringValue3(params.threadId);
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
        stringValue3(params.turnId)
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
        ...stringValue3(params.threadId) ? { threadId: stringValue3(params.threadId) } : {}
      }];
    }
    case "thread/tokenUsage/updated": {
      const threadId = stringValue3(params.threadId);
      return threadId ? [{ type: "token.updated", at, threadId, usage: tokenUsage(params.tokenUsage) }] : [];
    }
    case "error": {
      const threadId = stringValue3(params.threadId);
      const error = isRecord(params.error) ? params.error : {};
      if (!threadId) return [];
      return [{
        type: "activity.completed",
        at,
        threadId,
        activityId: `error:${stringValue3(params.turnId) ?? at}`,
        activity: {
          id: `error:${stringValue3(params.turnId) ?? at}`,
          agentId: threadId,
          kind: "error",
          title: "Codex error",
          detail: stringValue3(error.message) ?? "Unknown Codex error",
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
  provider = "codex";
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
      provider: this.provider,
      observatoryVersion: OBSERVATORY_VERSION,
      codexCliVersion: this.#codexVersion,
      protocolGenerationVersion: "0.149.0",
      experimentalApi: this.#experimental,
      discoveryStrategy: this.#strategy,
      contentCapture: contentCapturePolicy()
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
    const version = spawnSync2("codex", ["--version"], { encoding: "utf8" });
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
          version: OBSERVATORY_VERSION
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
    const tagged = { ...event, provider: event.provider ?? this.provider };
    for (const listener of this.#listeners) listener(tagged);
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

// apps/server/src/http/public-payload.ts
function mayExpose(provider) {
  return contentCaptureEnabled() || provider === "mock";
}
function publicMetadata(metadata) {
  if (!metadata) return void 0;
  const safeKeys = ["provider", "observation", "nativeTool", "evidenceSource"];
  const entries = safeKeys.filter((key) => metadata[key] !== void 0).map((key) => [key, metadata[key]]);
  return entries.length > 0 ? Object.fromEntries(entries) : void 0;
}
function publicActivity(activity) {
  if (mayExpose(activity.provider)) return activity;
  const { detail: _detail, metadata, ...safe } = activity;
  const sanitizedMetadata = publicMetadata(metadata);
  return { ...safe, ...sanitizedMetadata ? { metadata: sanitizedMetadata } : {} };
}
function publicHistory(history) {
  if (mayExpose(history.provider)) return history;
  const { content: _content, ...safe } = history;
  return safe;
}
function publicRequest(request) {
  if (mayExpose(request.provider)) return request;
  const { detail: _detail, ...safe } = request;
  return safe;
}
function publicAgent(agent) {
  if (mayExpose(agent.provider)) return agent;
  const { source: _source, ...safe } = agent;
  return safe;
}
function publicThread(thread, eventProvider2) {
  if (mayExpose(thread.provider ?? eventProvider2)) return thread;
  const { source: _source, ...safe } = thread;
  return safe;
}
function publicSnapshot(snapshot) {
  return {
    ...snapshot,
    agents: Object.fromEntries(
      Object.entries(snapshot.agents).map(([id, agent]) => [id, publicAgent(agent)])
    ),
    activities: snapshot.activities.map(publicActivity),
    history: snapshot.history.map(publicHistory),
    pendingRequests: Object.fromEntries(
      Object.entries(snapshot.pendingRequests).map(([id, request]) => [id, publicRequest(request)])
    ),
    debug: snapshot.debug.map(({ payload: _payload, ...entry }) => entry)
  };
}
function publicEvent(event) {
  switch (event.type) {
    case "thread.discovered":
      return { ...event, thread: publicThread(event.thread, event.provider) };
    case "activity.started":
      return { ...event, activity: publicActivity(event.activity) };
    case "activity.completed":
      return { ...event, activity: event.activity ? publicActivity(event.activity) : void 0 };
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
function baseThread(id, nickname, role, nativeStatus2, parentThreadId, depth = 0) {
  const now = Date.now();
  return {
    id,
    sessionId: "mock-session",
    ...parentThreadId ? { parentThreadId } : {},
    nickname,
    role,
    nativeStatus: nativeStatus2,
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
function demoThread({
  id,
  sessionId,
  nickname,
  role,
  provider,
  nativeStatus: nativeStatus2,
  parentThreadId,
  depth = 0,
  model,
  modelProvider,
  updatedOffset = 0
}) {
  const now = Date.now();
  return {
    provider,
    id,
    sessionId,
    ...parentThreadId ? { parentThreadId } : {},
    nickname,
    role,
    nativeStatus: nativeStatus2,
    createdAt: now - Math.max(1, 8 - depth) * 38e3,
    updatedAt: now - updatedOffset,
    cwd: "/projects/agent-observatory-demo",
    model,
    modelProvider,
    reasoningEffort: depth === 0 ? "high" : "medium",
    observedSkills: depth === 0 ? [] : [role === "teammate" ? "privacy-review" : "release-verification"],
    observedWorkflows: ["Multi-runtime release"],
    collaborationMode: provider === "claude" ? "claude-agent-team-beta" : "default",
    source: { provider, observation: "demo-fixture", contentCaptured: false },
    evidenceSources: ["mock"],
    depth,
    path: parentThreadId ? `/release/${nickname.toLowerCase().replaceAll(" ", "-")}` : `/release/${provider}`
  };
}
var MockCodexAdapter = class {
  provider = "mock";
  mode = "mock";
  #scenario;
  #threads = /* @__PURE__ */ new Map();
  #listeners = /* @__PURE__ */ new Set();
  #timers = [];
  #connected = false;
  constructor(scenario = "a") {
    this.#scenario = scenario === "b" || scenario === "demo" || scenario === "stress" ? scenario : "a";
    if (this.#scenario === "demo") {
      this.#seedDemo();
      return;
    }
    const root = baseThread("mock-main", "Main", "root", active());
    this.#threads.set(root.id, root);
    if (this.#scenario === "b") this.#seedScenarioB();
    if (this.#scenario === "stress") this.#seedStress();
  }
  runtimeInfo() {
    return {
      adapter: "mock",
      provider: this.provider,
      observatoryVersion: OBSERVATORY_VERSION,
      protocolGenerationVersion: "0.149.0",
      experimentalApi: false,
      discoveryStrategy: "mock",
      scenario: this.#scenario,
      contentCapture: "enabled"
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
    if (this.#scenario === "demo") this.#runDemo();
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
    const tagged = { ...event, provider: event.provider ?? this.provider };
    for (const listener of this.#listeners) listener(tagged);
  }
  #schedule(delay, action) {
    this.#timers.push(setTimeout(() => this.#connected && action(), delay));
  }
  #discover(thread) {
    this.#threads.set(thread.id, thread);
    this.#emit({ type: "thread.discovered", at: Date.now(), thread });
  }
  #activity(agentId, id, kind, title, detail, startedAt = Date.now()) {
    this.#emit({
      type: "activity.started",
      at: startedAt,
      activity: { id, agentId, kind, title, ...detail ? { detail } : {}, startedAt }
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
  #seedDemo() {
    const threads = [
      demoThread({
        provider: "codex",
        id: "codex:demo-orchestrator",
        sessionId: "codex:release-session",
        nickname: "Release Orchestrator",
        role: "root",
        nativeStatus: active(),
        model: "gpt-5.6-sol",
        modelProvider: "openai"
      }),
      demoThread({
        provider: "codex",
        id: "codex:demo-builder",
        sessionId: "codex:release-session",
        nickname: "Runtime Builder",
        role: "implementation",
        nativeStatus: active(),
        parentThreadId: "codex:demo-orchestrator",
        depth: 1,
        model: "gpt-5.6-terra",
        modelProvider: "openai",
        updatedOffset: 4e3
      }),
      demoThread({
        provider: "codex",
        id: "codex:demo-tester",
        sessionId: "codex:release-session",
        nickname: "Browser Tester",
        role: "testing",
        nativeStatus: active(["waitingOnApproval"]),
        parentThreadId: "codex:demo-orchestrator",
        depth: 1,
        model: "gpt-5.6-terra",
        modelProvider: "openai",
        updatedOffset: 7e3
      }),
      demoThread({
        provider: "claude",
        id: "claude:demo-lead",
        sessionId: "claude:team-session",
        nickname: "Claude Team Lead",
        role: "teamLead",
        nativeStatus: active(),
        model: "claude-opus-4-1",
        modelProvider: "anthropic",
        updatedOffset: 1500
      }),
      demoThread({
        provider: "claude",
        id: "claude:demo-reviewer",
        sessionId: "claude:team-session",
        nickname: "Privacy Reviewer",
        role: "teammate",
        nativeStatus: { type: "idle" },
        parentThreadId: "claude:demo-lead",
        depth: 1,
        model: "claude-sonnet-4",
        modelProvider: "anthropic",
        updatedOffset: 5e3
      }),
      demoThread({
        provider: "claude",
        id: "claude:demo-researcher",
        sessionId: "claude:team-session",
        nickname: "Evidence Researcher",
        role: "subagent",
        nativeStatus: { type: "idle" },
        parentThreadId: "claude:demo-lead",
        depth: 1,
        model: "claude-sonnet-4",
        modelProvider: "anthropic",
        updatedOffset: 9e3
      })
    ];
    for (const thread of threads) this.#threads.set(thread.id, thread);
  }
  #runDemo() {
    const now = Date.now();
    this.#emit({
      type: "provider.connection.changed",
      provider: "codex",
      at: now,
      connection: { phase: "connected", attempt: 0, message: "Codex demo observation active" }
    });
    this.#emit({
      type: "provider.connection.changed",
      provider: "claude",
      at: now,
      connection: { phase: "connected", attempt: 0, message: "Claude demo observation active" }
    });
    this.#history({
      id: "demo-request",
      kind: "request",
      actor: { type: "human" },
      recipients: [{ type: "agent", id: "codex:demo-orchestrator" }],
      summary: "Multi-provider release requested",
      content: "Coordinate implementation and verification across Codex and Claude Code.",
      status: "completed",
      occurredAt: now - 50,
      source: "mock"
    });
    this.#history({
      id: "demo-plan",
      kind: "decision",
      actor: { type: "agent", id: "codex:demo-orchestrator" },
      summary: "Release plan confirmed",
      content: "Build the runtime, review privacy, then complete browser verification.",
      status: "completed",
      occurredAt: now - 40,
      source: "mock"
    });
    this.#history({
      id: "demo-provider-handoff",
      kind: "handoff",
      relationKind: "handoff",
      actor: { type: "agent", id: "codex:demo-orchestrator" },
      recipients: [{ type: "agent", id: "claude:demo-lead" }],
      summary: "Claude review requested",
      content: "Validate compatibility evidence and privacy boundaries.",
      status: "sent",
      occurredAt: now - 30,
      source: "mock"
    });
    this.#history({
      id: "demo-team-task",
      kind: "handoff",
      relationKind: "task",
      actor: { type: "agent", id: "claude:demo-lead" },
      recipients: [{ type: "agent", id: "claude:demo-reviewer" }],
      summary: "Privacy review assigned",
      content: "Confirm metadata-only payload behavior.",
      status: "sent",
      occurredAt: now - 20,
      source: "mock"
    });
    this.#history({
      id: "demo-peer-message",
      kind: "handoff",
      relationKind: "message",
      actor: { type: "agent", id: "claude:demo-reviewer" },
      recipients: [{ type: "agent", id: "codex:demo-builder" }],
      summary: "Review evidence shared",
      content: "Raw provider content remains outside the public payload.",
      status: "sent",
      occurredAt: now + 10,
      source: "mock"
    });
    this.#emit({
      type: "token.updated",
      at: now + 4,
      threadId: "codex:demo-orchestrator",
      usage: {
        inputTokens: 2e4,
        cachedInputTokens: 8e3,
        outputTokens: 900,
        reasoningOutputTokens: 300,
        totalTokens: 20900,
        modelContextWindow: 258400
      }
    });
    this.#activity("codex:demo-orchestrator", "demo-coordinate", "message", "Coordinating provider rollout", void 0, now + 15);
    this.#activity("codex:demo-builder", "demo-build", "write", "Implementing composite runtime", "apps/server/src/composite-adapter.ts", now + 20);
    this.#activity("claude:demo-lead", "demo-lead-review", "read", "Reviewing Agent Teams evidence", "metadata-only compatibility evidence", now + 21);
    this.#activity("claude:demo-reviewer", "demo-privacy", "test", "Checking privacy boundary", "provider content redaction", now + 22);
    this.#history({
      id: "demo-build-result",
      kind: "delivery",
      actor: { type: "agent", id: "codex:demo-builder" },
      recipients: [{ type: "agent", id: "codex:demo-orchestrator" }],
      summary: "Runtime implementation completed",
      content: "Composite provider observation and privacy safeguards are ready for verification.",
      status: "completed",
      occurredAt: now + 30,
      source: "mock"
    });
    this.#emit({
      type: "request.opened",
      at: now + 40,
      request: {
        id: "demo-browser-approval",
        agentId: "codex:demo-tester",
        reason: "approval",
        title: "Browser verification approval",
        detail: "Run the deterministic demo capture",
        openedAt: now + 40,
        evidenceSource: "mock"
      }
    });
    this.#emit({
      type: "agent.lifecycle",
      at: now + 50,
      threadId: "claude:demo-researcher",
      status: "completed"
    });
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
  closeSync as closeSync2,
  existsSync as existsSync2,
  fstatSync as fstatSync2,
  openSync as openSync2,
  readSync as readSync2,
  readdirSync as readdirSync4,
  statSync as statSync2,
  watch
} from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join4 } from "node:path";
import { spawnSync as spawnSync4 } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

// apps/server/src/process-discovery.ts
import { readFileSync as readFileSync3, readdirSync as readdirSync3, readlinkSync as readlinkSync2 } from "node:fs";
import { spawnSync as spawnSync3 } from "node:child_process";
import { basename as basename3, join as join3, win32 } from "node:path";
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
    const name = (platform === "win32" ? win32.basename(token) : basename3(token)).toLowerCase();
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
    entries = readdirSync3(procRoot).filter((entry) => /^\d+$/.test(entry));
  } catch {
    return result;
  }
  for (const pid of entries) {
    try {
      const command = readFileSync3(join3(procRoot, pid, "cmdline"), "utf8").split("\0").filter(Boolean);
      if (!codexInvocation(command.map((value) => JSON.stringify(value)).join(" "), "linux")) continue;
      const cwd = readlinkSync2(join3(procRoot, pid, "cwd"));
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
  const ps = spawnSync3("ps", ["-axo", "pid=,command="], {
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
  const lsof = spawnSync3("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"], {
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
  const powershell = spawnSync3("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
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
function samePath2(left, right, platform) {
  return pathKey(left, platform) === pathKey(right, platform);
}
function selectRootThreadIds(roots, discovery, configuredCwd, rootOverride, platform = process.platform) {
  if (rootOverride) return /* @__PURE__ */ new Set([rootOverride]);
  const eligible = configuredCwd === "all" ? roots : roots.filter((root) => root.cwd && samePath2(root.cwd, configuredCwd, platform));
  const selected = /* @__PURE__ */ new Set();
  for (const [cwd, count] of discovery.cwdCounts) {
    for (const root of eligible.filter((candidate) => candidate.cwd && samePath2(candidate.cwd, cwd, platform)).slice(0, count)) {
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
function numberValue3(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return void 0;
}
function stringValue4(value) {
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
function recordValue3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function rolloutTokenUsage(payload) {
  const info = recordValue3(payload.info);
  const total = recordValue3(info?.total_token_usage);
  if (!info || !total) return void 0;
  const usage = {
    ...finiteNumber(total.input_tokens) !== void 0 ? { inputTokens: finiteNumber(total.input_tokens) } : {},
    ...finiteNumber(total.cached_input_tokens) !== void 0 ? { cachedInputTokens: finiteNumber(total.cached_input_tokens) } : {},
    ...finiteNumber(total.output_tokens) !== void 0 ? { outputTokens: finiteNumber(total.output_tokens) } : {},
    ...finiteNumber(total.reasoning_output_tokens) !== void 0 ? { reasoningOutputTokens: finiteNumber(total.reasoning_output_tokens) } : {},
    ...finiteNumber(total.total_tokens) !== void 0 ? { totalTokens: finiteNumber(total.total_tokens) } : {},
    ...finiteNumber(info.model_context_window) !== void 0 ? { modelContextWindow: finiteNumber(info.model_context_window) } : {}
  };
  return Object.keys(usage).length > 0 ? usage : void 0;
}
function timestampValue3(value) {
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
  const parts = payload.content.map((entry) => recordValue3(entry)).map((entry) => boundedHistoryText(entry?.text ?? entry?.input_text ?? entry?.output_text)).filter((entry) => Boolean(entry));
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
    relationKind: name === "spawn_agent" ? "spawn" : name === "followup_task" ? "task" : "message",
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
  const plan = Array.isArray(parsed.plan) ? parsed.plan.map((item) => recordValue3(item)).map((item) => boundedHistoryText(item?.step)).filter((item) => Boolean(item)).map((step, index) => `${index + 1}. ${step}`).join("\n") : void 0;
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
  let tokenUsage2;
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
    const at = timestampValue3(envelope.timestamp);
    if (at !== void 0) lastEventAt = Math.max(lastEventAt ?? at, at);
    const payload = recordValue3(envelope.payload);
    if (!payload) continue;
    if (envelope.type === "turn_context") {
      if (typeof payload.model === "string" && payload.model.length > 0) model = payload.model;
      if (typeof payload.effort === "string" && payload.effort.length > 0) reasoningEffort = payload.effort;
      const mode = recordValue3(payload.collaboration_mode);
      if (typeof mode?.mode === "string" && mode.mode.length > 0) collaborationMode = mode.mode;
      if (collaborationMode === "plan") observedWorkflows.add("Planning");
      continue;
    }
    if (envelope.type === "event_msg") {
      if (payload.type === "token_count") {
        tokenUsage2 = rolloutTokenUsage(payload) ?? tokenUsage2;
        continue;
      }
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
  let nativeStatus2;
  let lifecycle;
  if (isWorking) {
    nativeStatus2 = {
      type: "active",
      activeFlags: waitingOnUserInput ? ["waitingOnUserInput"] : []
    };
    lifecycle = "running";
  } else if (interruptedAt !== void 0 && interruptedAt >= (taskCompletedAt ?? 0)) {
    nativeStatus2 = processActive && isRoot ? { type: "idle" } : { type: "notLoaded" };
    lifecycle = "interrupted";
  } else if (taskCompletedAt !== void 0) {
    nativeStatus2 = processActive && isRoot ? { type: "idle" } : { type: "notLoaded" };
    if (!isRoot) lifecycle = "completed";
  } else {
    nativeStatus2 = processActive && isRoot ? { type: "idle" } : { type: "notLoaded" };
  }
  const activities = [...completedActivities, ...openCalls.values()].sort((a, b) => a.startedAt - b.startedAt).slice(-ACTIVITY_LIMIT_PER_THREAD);
  const history = [...completedHistory, ...openHistory.values()].sort((a, b) => a.occurredAt - b.occurredAt).slice(-HISTORY_LIMIT_PER_THREAD);
  return {
    nativeStatus: nativeStatus2,
    ...lifecycle ? { lifecycle } : {},
    ...lastEventAt ? { lastEventAt } : {},
    ...model ? { model } : {},
    ...reasoningEffort ? { reasoningEffort } : {},
    observedSkills: [...observedSkills].sort(),
    observedWorkflows: [...observedWorkflows].sort(),
    ...collaborationMode ? { collaborationMode } : {},
    ...tokenUsage2 ? { tokenUsage: tokenUsage2 } : {},
    history,
    activities
  };
}
function readRolloutTail(path2) {
  const fd = openSync2(path2, "r");
  try {
    const size = fstatSync2(fd).size;
    const start = Math.max(0, size - ROLLOUT_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    readSync2(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    if (start === 0) return text;
    const firstNewline = text.indexOf("\n");
    return firstNewline === -1 ? "" : text.slice(firstNewline + 1);
  } finally {
    closeSync2(fd);
  }
}
function latestVersionedDatabase(codexHome, prefix) {
  const matches = readdirSync4(codexHome).filter((name) => new RegExp(`^${prefix}_[0-9]+\\.sqlite$`).test(name)).sort((a, b) => {
    const aVersion = Number(a.match(/_([0-9]+)\.sqlite$/)?.[1] ?? 0);
    const bVersion = Number(b.match(/_([0-9]+)\.sqlite$/)?.[1] ?? 0);
    return bVersion - aVersion;
  });
  return matches[0] ? join4(codexHome, matches[0]) : void 0;
}
function rowSnapshot(row, rollout) {
  const id = stringValue4(row.id);
  if (!id) return void 0;
  const createdAt = numberValue3(row.created_at_ms) ?? ((numberValue3(row.created_at) ?? 0) * 1e3 || void 0);
  const updatedAt = rollout.lastEventAt ?? numberValue3(row.updated_at_ms) ?? ((numberValue3(row.updated_at) ?? 0) * 1e3 || void 0);
  return {
    id,
    ...stringValue4(row.parent_thread_id) ? { parentThreadId: stringValue4(row.parent_thread_id) } : {},
    ...stringValue4(row.agent_nickname) ? { nickname: stringValue4(row.agent_nickname) } : {},
    ...stringValue4(row.agent_role) ? { role: stringValue4(row.agent_role) } : {},
    nativeStatus: rollout.nativeStatus,
    ...createdAt ? { createdAt } : {},
    ...updatedAt ? { updatedAt } : {},
    ...stringValue4(row.cwd) ? { cwd: stringValue4(row.cwd) } : {},
    ...rollout.model ? { model: rollout.model } : {},
    ...stringValue4(row.model_provider) ? { modelProvider: stringValue4(row.model_provider) } : {},
    ...rollout.reasoningEffort ? { reasoningEffort: rollout.reasoningEffort } : {},
    observedSkills: rollout.observedSkills,
    observedWorkflows: rollout.observedWorkflows,
    ...rollout.collaborationMode ? { collaborationMode: rollout.collaborationMode } : {},
    ...stringValue4(row.thread_source) ? { source: row.thread_source } : {},
    ...stringValue4(row.agent_path) ? { path: stringValue4(row.agent_path) } : {}
  };
}
var SharedStateCodexAdapter = class {
  provider = "codex";
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
  #lastTokenFingerprint = /* @__PURE__ */ new Map();
  #rolloutCache = /* @__PURE__ */ new Map();
  #processDiscoveryCache;
  #lastDiscoveryWarning;
  runtimeInfo() {
    return {
      adapter: "codex",
      provider: this.provider,
      observatoryVersion: OBSERVATORY_VERSION,
      codexCliVersion: this.#codexVersion,
      protocolGenerationVersion: "0.149.0",
      experimentalApi: false,
      discoveryStrategy: "compatibility",
      contentCapture: contentCapturePolicy()
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
    const version = spawnSync4("codex", ["--version"], { encoding: "utf8" });
    this.#codexVersion = version.stdout.trim().replace(/^codex-cli\s+/, "") || "unknown";
    const codexHome = process.env.CODEX_HOME ?? join4(homedir2(), ".codex");
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
    const sessions = join4(codexHome, "sessions");
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
      const roots = rows.filter((row) => !stringValue4(row.parent_thread_id));
      const rootCandidates = roots.flatMap((row) => {
        const id = stringValue4(row.id);
        if (!id) return [];
        const cwd = stringValue4(row.cwd);
        const updatedAt = numberValue3(row.updated_at_ms);
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
          const id = stringValue4(row.id);
          const parentId = stringValue4(row.parent_thread_id);
          if (id && parentId && selected.has(parentId) && !selected.has(id)) {
            selected.add(id);
            changed = true;
          }
        }
      }
      const next = /* @__PURE__ */ new Map();
      for (const row of rows) {
        const id = stringValue4(row.id);
        if (!id || !selected.has(id)) continue;
        const rolloutPath = stringValue4(row.rollout_path);
        if (!rolloutPath || !existsSync2(rolloutPath)) continue;
        const isRoot = !stringValue4(row.parent_thread_id);
        const processActive = isRoot && selectedRoots.has(id);
        const file = statSync2(rolloutPath);
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
    if (thread.rollout.tokenUsage) {
      const usageFingerprint = JSON.stringify(thread.rollout.tokenUsage);
      if (this.#lastTokenFingerprint.get(thread.snapshot.id) !== usageFingerprint) {
        this.#lastTokenFingerprint.set(thread.snapshot.id, usageFingerprint);
        this.#emit({ type: "token.updated", at, threadId: thread.snapshot.id, usage: thread.rollout.tokenUsage });
      }
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
    const tagged = { ...event, provider: event.provider ?? this.provider };
    for (const listener of this.#listeners) listener(tagged);
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
var adapterMode = process.env.OBSERVATORY_ADAPTER ?? "mock";
var requestedProviders = (process.env.OBSERVATORY_PROVIDERS ?? "codex").split(",").map((provider) => provider.trim()).filter(Boolean);
function codexAdapter() {
  return realTransport === "shared" ? new SharedStateCodexAdapter() : new RealCodexAdapter();
}
function realAdapter() {
  const providers = Array.from(new Set(requestedProviders));
  if (providers.length === 0) throw new Error("At least one runtime provider is required");
  const adapters = providers.map((provider) => {
    if (provider === "codex") return codexAdapter();
    if (provider === "claude") return new ClaudeCodeAdapter();
    throw new Error(`Unsupported runtime provider: ${provider}`);
  });
  return adapters.length === 1 ? adapters[0] : new CompositeRuntimeAdapter(adapters);
}
var adapter = adapterMode === "mock" ? new MockCodexAdapter(process.env.OBSERVATORY_SCENARIO ?? "a") : realAdapter();
var webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
var runningFromSource = fileURLToPath(import.meta.url).includes(`${sep}src${sep}`);
var webPort = Number(process.env.OBSERVATORY_WEB_PORT ?? 4318);
var devWebOrigins = runningFromSource ? [`http://127.0.0.1:${webPort}`, `http://localhost:${webPort}`] : void 0;
var { server, connectAdapter } = createObservatoryHttpServer({ accessToken, adapter, webDist, devWebOrigins });
server.listen(port, "127.0.0.1", () => {
  const bootstrapOrigin = `http://127.0.0.1:${port}`;
  console.log(`Agent Observatory server: ${bootstrapOrigin}/?token=${encodeURIComponent(accessToken)}`);
  console.log(`Adapter: ${adapter.mode}`);
});
void connectAdapter().catch(() => void 0);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void adapter.disconnect().finally(() => server.close(() => process.exit(0)));
  });
}
