import { spawnSync } from "node:child_process";
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type {
  AgentActivity,
  AgentRuntimeAdapter,
  AgentRuntimeEvent,
  DiscoveryOptions,
  HistoryEvent,
  NativeThreadStatus,
  PendingRequest,
  ReadThreadOptions,
  RuntimeInfo,
  ThreadSnapshot,
  TokenUsageSnapshot,
} from "@observatory/core";
import {
  discoverClaudeAgentTeams,
  type ClaudeTeamMemberEvidence,
  type ClaudeTeamMessageEvidence,
  type ClaudeTeamObservation,
} from "./claude-team-observer.ts";

const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const HISTORY_LIMIT = 80;
const ACTIVITY_LIMIT = 50;

type JsonRecord = Record<string, unknown>;

interface ClaudeSubagentMeta {
  agentType?: string;
  toolUseId?: string;
  spawnDepth?: number;
  stoppedByUser?: boolean;
}

interface ClaudeTranscriptContext {
  threadId: string;
  sessionId: string;
  parentThreadId?: string;
  fallbackCwd?: string;
  isRoot: boolean;
  processActive: boolean;
  createdAt?: number;
  updatedAt?: number;
  meta?: ClaudeSubagentMeta;
}

export interface ParsedClaudeTranscript {
  snapshot: ThreadSnapshot;
  activities: AgentActivity[];
  history: HistoryEvent[];
  pendingRequests: PendingRequest[];
  usage?: TokenUsageSnapshot;
  lifecycle?: "running" | "completed" | "interrupted" | "shutdown";
  toolUseIds: string[];
}

interface ObservedClaudeThread extends ParsedClaudeTranscript {
  path: string;
}

export interface ClaudeProcessDiscovery {
  cwdCounts: Map<string, number>;
  processCount: number;
  exact: boolean;
  source: "procfs" | "unsupported";
  warning?: string;
}

export interface ClaudeAdapterOptions {
  claudeHome?: string;
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  pollIntervalMs?: number;
  now?: () => number;
  processDiscovery?: () => ClaudeProcessDiscovery;
}

function recordValue(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestampValue(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseJsonRecord(line: string): JsonRecord | undefined {
  try {
    return recordValue(JSON.parse(line));
  } catch {
    // Claude transcripts are append-only; an incomplete final line is expected.
    return undefined;
  }
}

function namespaceRoot(sessionId: string): string {
  return `claude:${sessionId}`;
}

function namespaceSubagent(sessionId: string, agentId: string): string {
  return `claude:${sessionId}:${agentId}`;
}

function requestedThreadId(threadId: string): string {
  return threadId.startsWith("claude:") ? threadId : `claude:${threadId}`;
}

function activityPresentation(name: string): { kind: AgentActivity["kind"]; title: string } {
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

function safeModelProvider(model: string | undefined): string | undefined {
  return model ? "anthropic" : undefined;
}

function nativeStatus(
  context: ClaudeTranscriptContext,
  hasFinalResponse: boolean,
  hasUnresolvedTool: boolean,
): NativeThreadStatus {
  if (context.meta?.stoppedByUser) return { type: "idle" };
  if (hasFinalResponse && !hasUnresolvedTool) return { type: "idle" };
  if (context.processActive) return { type: "active", activeFlags: [] };
  return context.isRoot ? { type: "notLoaded" } : { type: "idle" };
}

function addUsage(total: Required<TokenUsageSnapshot>, usage: JsonRecord): void {
  total.inputTokens += numberValue(usage.input_tokens) ?? 0;
  total.cachedInputTokens += numberValue(usage.cache_read_input_tokens) ?? 0;
  total.outputTokens += numberValue(usage.output_tokens) ?? 0;
  total.reasoningOutputTokens += 0;
  total.totalTokens = total.inputTokens + total.cachedInputTokens + total.outputTokens;
  total.modelContextWindow += 0;
}

/**
 * Parse Claude Code's local JSONL compatibility format without retaining prompt,
 * response, thinking, command, path, or tool-input contents.
 *
 * This is deliberately tolerant: unknown records and malformed lines are ignored,
 * because the on-disk format is not a public stability contract.
 */
export function parseClaudeTranscript(text: string, context: ClaudeTranscriptContext): ParsedClaudeTranscript {
  const activities = new Map<string, AgentActivity>();
  const history: HistoryEvent[] = [];
  const pending = new Map<string, PendingRequest>();
  const completedToolIds = new Set<string>();
  const toolUseIds = new Set<string>();
  const usage: Required<TokenUsageSnapshot> = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    modelContextWindow: 0,
  };
  let hasUsage = false;
  let cwd = context.fallbackCwd;
  let model: string | undefined;
  let firstTimestamp = context.createdAt;
  let lastTimestamp = context.updatedAt;
  let latestMessageKind: "assistant-final" | "assistant-tool" | "user" | undefined;

  for (const line of text.split("\n")) {
    const row = parseJsonRecord(line);
    if (!row) continue;
    cwd ??= stringValue(row.cwd);
    const at = timestampValue(row.timestamp);
    if (at !== undefined) {
      firstTimestamp = firstTimestamp === undefined ? at : Math.min(firstTimestamp, at);
      lastTimestamp = lastTimestamp === undefined ? at : Math.max(lastTimestamp, at);
    }
    const message = recordValue(row.message);
    const role = stringValue(message?.role);
    model = stringValue(message?.model) ?? model;
    const messageUsage = recordValue(message?.usage);
    if (messageUsage) {
      addUsage(usage, messageUsage);
      hasUsage = true;
    }
    const content = Array.isArray(message?.content) ? message.content : [];

    if (role === "assistant") {
      let hasText = false;
      let hasTool = false;
      for (const item of content) {
        const block = recordValue(item);
        if (!block) continue;
        if (block.type === "text") hasText = true;
        if (block.type !== "tool_use") continue;
        hasTool = true;
        const nativeId = stringValue(block.id);
        if (!nativeId) continue;
        const name = stringValue(block.name) ?? "Tool";
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
          metadata: { provider: "claude", observation: "transcript", nativeTool: name },
        });
        if (name === "AskUserQuestion") {
          pending.set(nativeId, {
            provider: "claude",
            id: `${context.threadId}:request:${nativeId}`,
            agentId: context.threadId,
            reason: "userInput",
            title: "Claude is waiting for user input",
            openedAt: at ?? lastTimestamp ?? Date.now(),
            evidenceSource: "transcript",
          });
        }
      }
      latestMessageKind = hasTool ? "assistant-tool" : hasText ? "assistant-final" : latestMessageKind;
      const uuid = stringValue(row.uuid);
      if (hasText && uuid) {
        history.push({
          provider: "claude",
          id: `${context.threadId}:history:${uuid}`,
          kind: "delivery",
          actor: { type: "agent", id: context.threadId },
          summary: "Agent response",
          status: "sent",
          occurredAt: at ?? lastTimestamp ?? Date.now(),
          source: "transcript",
        });
      }
    } else if (role === "user") {
      let hasToolResult = false;
      for (const item of content) {
        const block = recordValue(item);
        if (block?.type !== "tool_result") continue;
        hasToolResult = true;
        const nativeId = stringValue(block.tool_use_id);
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
        const uuid = stringValue(row.uuid);
        if (uuid) {
          history.push({
            provider: "claude",
            id: `${context.threadId}:history:${uuid}`,
            kind: "request",
            actor: { type: "human" },
            recipients: [{ type: "agent", id: context.threadId }],
            summary: "User request",
            status: "sent",
            occurredAt: at ?? lastTimestamp ?? Date.now(),
            source: "transcript",
          });
        }
      }
    }
  }

  const hasFinalResponse = latestMessageKind === "assistant-final";
  const hasUnresolvedTool = [...toolUseIds].some((id) => !completedToolIds.has(id));
  const status = nativeStatus(context, hasFinalResponse, hasUnresolvedTool);
  const lifecycle = context.meta?.stoppedByUser
    ? "interrupted"
    : !context.isRoot && hasFinalResponse && !hasUnresolvedTool
      ? "completed"
      : status.type === "active"
        ? "running"
        : undefined;
  const nickname = context.isRoot ? "Claude session" : undefined;
  const role = context.meta?.agentType;
  const snapshot: ThreadSnapshot = {
    provider: "claude",
    id: context.threadId,
    sessionId: context.sessionId,
    ...(context.parentThreadId ? { parentThreadId: context.parentThreadId } : {}),
    ...(nickname ? { nickname } : {}),
    ...(role ? { role } : {}),
    nativeStatus: status,
    ...(firstTimestamp !== undefined ? { createdAt: firstTimestamp } : {}),
    ...(lastTimestamp !== undefined ? { updatedAt: lastTimestamp } : {}),
    ...(cwd ? { cwd } : {}),
    ...(model ? { model, modelProvider: safeModelProvider(model) } : {}),
    source: {
      provider: "claude",
      observation: "transcript",
      schema: "compatibility",
      contentCaptured: false,
      agentKind: context.isRoot ? "session" : "subagent",
    },
    evidenceSources: ["transcript"],
    ...(context.meta?.spawnDepth !== undefined ? { depth: context.meta.spawnDepth } : {}),
  };
  return {
    snapshot,
    activities: [...activities.values()].slice(-ACTIVITY_LIMIT),
    history: history.slice(-HISTORY_LIMIT),
    pendingRequests: [...pending.values()],
    ...(hasUsage ? { usage } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    toolUseIds: [...toolUseIds],
  };
}

function teamThreadId(teamName: string, agentId: string): string {
  return `claude:team:${encodeURIComponent(teamName)}:${encodeURIComponent(agentId)}`;
}

function emptyTeamThread(
  team: ClaudeTeamObservation,
  member: ClaudeTeamMemberEvidence,
  parentThreadId?: string,
): ObservedClaudeThread {
  const id = teamThreadId(team.name, member.agentId);
  return {
    path: join("teams", team.name, "config.json"),
    snapshot: {
      provider: "claude",
      id,
      ...(member.sessionId ? { sessionId: member.sessionId } : {}),
      ...(parentThreadId ? { parentThreadId } : {}),
      nickname: member.name,
      role: member.kind,
      nativeStatus: { type: "idle" },
      ...(member.joinedAt !== undefined ? { createdAt: member.joinedAt, updatedAt: member.joinedAt } : {}),
      ...(member.cwd ? { cwd: member.cwd } : {}),
      ...(member.model ? { model: member.model, modelProvider: "anthropic" } : {}),
      collaborationMode: "claude-agent-team-beta",
      source: {
        provider: "claude",
        observation: "team-config",
        schema: "compatibility",
        contentCaptured: false,
        beta: true,
        agentKind: member.kind,
        ...(member.agentType ? { agentType: member.agentType } : {}),
      },
      evidenceSources: ["compatibility"],
      ...(member.kind === "teammate" ? { depth: 1 } : {}),
    },
    activities: [],
    history: [],
    pendingRequests: [],
    toolUseIds: [],
  };
}

function enrichTeamThread(
  thread: ObservedClaudeThread,
  team: ClaudeTeamObservation,
  member: ClaudeTeamMemberEvidence,
  parentThreadId?: string,
): void {
  const source = recordValue(thread.snapshot.source) ?? {};
  thread.snapshot = {
    ...thread.snapshot,
    ...(parentThreadId ? { parentThreadId } : {}),
    nickname: member.name,
    role: member.kind,
    ...(member.model && !thread.snapshot.model ? { model: member.model, modelProvider: "anthropic" } : {}),
    collaborationMode: "claude-agent-team-beta",
    source: {
      ...source,
      teamObservation: "config",
      beta: true,
      agentKind: member.kind,
      ...(member.agentType ? { agentType: member.agentType } : {}),
    },
    evidenceSources: [...new Set([...(thread.snapshot.evidenceSources ?? []), "compatibility" as const])],
    ...(member.kind === "teammate" && thread.snapshot.depth === undefined ? { depth: 1 } : {}),
  };
}

function teamMessageHistory(
  team: ClaudeTeamObservation,
  message: ClaudeTeamMessageEvidence,
  actorId: string,
  recipientId: string,
): HistoryEvent {
  const common = {
    provider: "claude" as const,
    id: `claude:team:${encodeURIComponent(team.name)}:message:${message.id}`,
    occurredAt: message.occurredAt,
    source: "compatibility" as const,
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
        ...(message.taskId ? { correlationId: `claude:team:${team.name}:task:${message.taskId}` } : {}),
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
        ...(message.taskId ? { correlationId: `claude:team:${team.name}:task:${message.taskId}` } : {}),
      };
    case "idle_notification":
      return {
        ...common,
        kind: "completion",
        actor: { type: "agent", id: actorId },
        recipients: [{ type: "agent", id: recipientId }],
        summary: "Teammate became idle",
        status: "completed",
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
        ...(message.requestId ? { correlationId: message.requestId } : {}),
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
        ...(message.requestId ? { correlationId: message.requestId } : {}),
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
        ...(message.requestId ? { correlationId: message.requestId } : {}),
      };
    case "teammate_terminated":
      return {
        ...common,
        kind: "completion",
        actor: { type: "agent", id: actorId },
        recipients: [{ type: "agent", id: recipientId }],
        summary: "Teammate terminated",
        status: "completed",
        relationKind: "handoff",
      };
    default:
      return {
        ...common,
        kind: "handoff",
        actor: { type: "agent", id: actorId },
        recipients: [{ type: "agent", id: recipientId }],
        summary: "Teammate message",
        status: "sent",
        relationKind: "message",
      };
  }
}

function teamTaskHistory(
  team: ClaudeTeamObservation,
  task: ClaudeTeamObservation["tasks"][number],
  ownerId?: string,
): HistoryEvent {
  const status = task.status === "in_progress" ? "running" : task.status === "completed" ? "completed" : "started";
  return {
    provider: "claude",
    id: `claude:team:${encodeURIComponent(team.name)}:task:${task.id}:${task.status}`,
    kind: task.status === "completed" ? "completion" : "work",
    actor: ownerId ? { type: "agent", id: ownerId } : { type: "system", label: "Claude team task list" },
    summary: task.status === "completed"
      ? "Team task completed"
      : task.status === "in_progress"
        ? "Team task in progress"
        : "Team task created",
    status,
    correlationId: `claude:team:${team.name}:task:${task.id}`,
    occurredAt: task.updatedAt,
    source: "compatibility",
    relationKind: "task",
  };
}

/** Merge explicit team topology and coordination evidence into transcript observations. */
export function applyClaudeTeamEvidence(
  observed: ObservedClaudeThread[],
  teams: ClaudeTeamObservation[],
  cwdFilter: string,
): ObservedClaudeThread[] {
  const results = [...observed];
  const sessionThreads = new Map<string, ObservedClaudeThread>();
  for (const thread of results) {
    if (thread.snapshot.sessionId) sessionThreads.set(thread.snapshot.sessionId, thread);
  }

  for (const team of teams) {
    const hasMatchingCwd = cwdFilter === "all"
      || team.members.some((member) => member.cwd === cwdFilter)
      || (team.leadSessionId ? sessionThreads.get(team.leadSessionId)?.snapshot.cwd === cwdFilter : false);
    if (!hasMatchingCwd) continue;

    const leadMember = team.members.find((member) => member.kind === "teamLead");
    const leadSessionId = leadMember?.sessionId ?? team.leadSessionId;
    let leadThread = leadSessionId ? sessionThreads.get(leadSessionId) : undefined;
    if (!leadThread && leadMember) {
      leadThread = emptyTeamThread(team, leadMember);
      results.push(leadThread);
    }
    if (leadThread && leadMember) enrichTeamThread(leadThread, team, leadMember);
    const leadThreadId = leadThread?.snapshot.id;

    const nameToThread = new Map<string, ObservedClaudeThread>();
    const agentIdToThread = new Map<string, ObservedClaudeThread>();
    for (const member of team.members) {
      const memberSessionId = member.kind === "teamLead" ? member.sessionId ?? team.leadSessionId : member.sessionId;
      let thread = memberSessionId ? sessionThreads.get(memberSessionId) : undefined;
      if (!thread) {
        thread = emptyTeamThread(team, member, member.kind === "teammate" ? leadThreadId : undefined);
        results.push(thread);
      } else {
        enrichTeamThread(thread, team, member, member.kind === "teammate" ? leadThreadId : undefined);
      }
      nameToThread.set(member.name, thread);
      agentIdToThread.set(member.agentId, thread);
    }

    const ensureFormerTeammate = (name: string): ObservedClaudeThread => {
      const known = nameToThread.get(name) ?? agentIdToThread.get(name);
      if (known) return known;
      const member: ClaudeTeamMemberEvidence = {
        agentId: `${name}@${team.name}`,
        name,
        kind: name === "team-lead" ? "teamLead" : "teammate",
      };
      const thread = emptyTeamThread(team, member, member.kind === "teammate" ? leadThreadId : undefined);
      thread.snapshot.source = {
        ...recordValue(thread.snapshot.source),
        teamObservation: "mailbox",
        formerMember: true,
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

function readTail(path: string, maxBytes = TRANSCRIPT_TAIL_BYTES): { text: string; stat: Stats } {
  const fd = openSync(path, "r");
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

function parseSubagentMeta(path: string): ClaudeSubagentMeta | undefined {
  try {
    const parsed = recordValue(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed) return undefined;
    return {
      ...(stringValue(parsed.agentType) ? { agentType: stringValue(parsed.agentType) } : {}),
      ...(stringValue(parsed.toolUseId) ? { toolUseId: stringValue(parsed.toolUseId) } : {}),
      ...(numberValue(parsed.spawnDepth) !== undefined ? { spawnDepth: numberValue(parsed.spawnDepth) } : {}),
      ...(typeof parsed.stoppedByUser === "boolean" ? { stoppedByUser: parsed.stoppedByUser } : {}),
    };
  } catch {
    return undefined;
  }
}

function looksLikeInteractiveClaude(command: string[]): boolean {
  const index = command.findIndex((token) => {
    const name = basename(token).toLowerCase();
    return name === "claude" || name === "claude.exe";
  });
  if (index === -1) return false;
  const args = command.slice(index + 1);
  if (args.includes("-p") || args.includes("--print")) return false;
  const nonInteractive = new Set(["auth", "doctor", "install", "mcp", "plugin", "update", "upgrade"]);
  const commandName = args.find((arg) => !arg.startsWith("-"));
  return !commandName || !nonInteractive.has(commandName);
}

/** Passive process discovery; it never attaches to or mutates a Claude process. */
export function findInteractiveClaudeCwds(procRoot = "/proc"): ClaudeProcessDiscovery {
  const cwdCounts = new Map<string, number>();
  let processCount = 0;
  let entries: string[];
  try {
    entries = readdirSync(procRoot).filter((entry) => /^\d+$/.test(entry));
  } catch {
    return {
      cwdCounts,
      processCount,
      exact: false,
      source: "unsupported",
      warning: "Claude process discovery requires procfs on this platform",
    };
  }
  for (const pid of entries) {
    try {
      const command = readFileSync(join(procRoot, pid, "cmdline"), "utf8").split("\0").filter(Boolean);
      if (!looksLikeInteractiveClaude(command)) continue;
      processCount += 1;
      const cwd = readlinkSync(join(procRoot, pid, "cwd"));
      if (cwd) cwdCounts.set(cwd, (cwdCounts.get(cwd) ?? 0) + 1);
    } catch {
      // Processes can disappear between directory enumeration and inspection.
    }
  }
  return { cwdCounts, processCount, exact: true, source: "procfs" };
}

function cliVersion(): string {
  const result = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 5_000 });
  if (result.error || result.status !== 0) return "unknown";
  return (result.stdout ?? "").trim().replace(/\s*\(Claude Code\)\s*$/, "") || "unknown";
}

export class ClaudeCodeAdapter implements AgentRuntimeAdapter {
  readonly provider = "claude" as const;
  readonly mode = "claude" as const;
  #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  #threads = new Map<string, ObservedClaudeThread>();
  #seenActivities = new Set<string>();
  #seenHistory = new Set<string>();
  #seenRequests = new Set<string>();
  #lifecycle = new Map<string, ParsedClaudeTranscript["lifecycle"]>();
  #timer?: ReturnType<typeof setInterval>;
  #connected = false;
  #version = "unknown";
  readonly #claudeHome: string;
  readonly #cwd: string;
  readonly #pollIntervalMs: number;
  readonly #now: () => number;
  readonly #processDiscovery: () => ClaudeProcessDiscovery;

  constructor(options: ClaudeAdapterOptions = {}) {
    const environment = options.environment ?? process.env;
    this.#claudeHome = options.claudeHome ?? join(homedir(), ".claude");
    this.#cwd = options.cwd
      ?? environment.OBSERVATORY_CWD
      ?? environment.OBSERVATORY_LAUNCH_CWD
      ?? environment.INIT_CWD
      ?? process.cwd();
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#now = options.now ?? Date.now;
    this.#processDiscovery = options.processDiscovery ?? findInteractiveClaudeCwds;
  }

  runtimeInfo(): RuntimeInfo {
    return {
      adapter: "claude",
      provider: "claude",
      observatoryVersion: "0.1.0",
      claudeCliVersion: this.#version,
      experimentalApi: false,
      discoveryStrategy: "compatibility",
      contentCapture: "metadata-only",
    };
  }

  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async connect(): Promise<void> {
    if (this.#connected) return;
    this.#connected = true;
    this.#emit({
      type: "connection.changed",
      at: this.#now(),
      connection: { phase: "connecting", attempt: 0, message: "Discovering Claude Code sessions" },
    });
    this.#version = cliVersion();
    await this.#refresh(true);
    this.#emit({ type: "runtime.updated", at: this.#now(), runtime: this.runtimeInfo() });
    this.#emit({
      type: "connection.changed",
      at: this.#now(),
      connection: { phase: "connected", attempt: 0, message: "Observing local Claude Code transcripts" },
    });
    this.#timer = setInterval(() => {
      void this.#refresh(true).catch((error) => this.#debug("Claude compatibility refresh failed", error));
    }, this.#pollIntervalMs);
    this.#timer.unref?.();
  }

  async disconnect(): Promise<void> {
    this.#connected = false;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#emit({
      type: "connection.changed",
      at: this.#now(),
      connection: { phase: "disconnected", attempt: 0, message: "Claude observation stopped" },
    });
  }

  async listThreads(options?: DiscoveryOptions): Promise<ThreadSnapshot[]> {
    await this.#refresh(false);
    const all = [...this.#threads.values()].map((thread) => thread.snapshot);
    if (!options?.rootThreadId) return all;
    const rootThreadId = requestedThreadId(options.rootThreadId);
    const descendants = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const thread of all) {
        if (thread.parentThreadId === rootThreadId || (thread.parentThreadId && descendants.has(thread.parentThreadId))) {
          if (!descendants.has(thread.id)) {
            descendants.add(thread.id);
            changed = true;
          }
        }
      }
    }
    return all.filter((thread) => descendants.has(thread.id));
  }

  async listLoadedThreads(): Promise<string[]> {
    await this.#refresh(false);
    return [...this.#threads.values()]
      .filter((thread) => thread.snapshot.nativeStatus.type !== "notLoaded")
      .map((thread) => thread.snapshot.id);
  }

  async readThread(threadId: string, _options?: ReadThreadOptions): Promise<ThreadSnapshot> {
    await this.#refresh(false);
    const thread = this.#threads.get(requestedThreadId(threadId));
    if (!thread) throw new Error(`Claude thread not found: ${threadId}`);
    return thread.snapshot;
  }

  async #refresh(emit: boolean): Promise<void> {
    const processDiscovery = this.#processDiscovery();
    const observed = this.#scanTranscripts(processDiscovery.cwdCounts);
    this.#threads = new Map(observed.map((thread) => [thread.snapshot.id, thread]));
    if (!emit) return;
    for (const thread of observed) this.#emitThread(thread);
    if (processDiscovery.warning) this.#debug(processDiscovery.warning);
  }

  #scanTranscripts(activeCwds: Map<string, number>): ObservedClaudeThread[] {
    const projectsRoot = join(this.#claudeHome, "projects");
    let projectDirs: string[];
    try {
      projectDirs = readdirSync(projectsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(projectsRoot, entry.name));
    } catch {
      projectDirs = [];
    }
    const results: ObservedClaudeThread[] = [];
    for (const projectDir of projectDirs) {
      let files: string[];
      try {
        files = readdirSync(projectDir).filter((name) => name.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const file of files) {
        const path = join(projectDir, file);
        const fallbackSessionId = file.slice(0, -".jsonl".length);
        let rootTail: ReturnType<typeof readTail>;
        try {
          rootTail = readTail(path);
        } catch {
          continue;
        }
        const sessionId = this.#sessionId(rootTail.text) ?? fallbackSessionId;
        const rootId = namespaceRoot(sessionId);
        const fallbackCwd = this.#transcriptCwd(rootTail.text);
        if (this.#cwd !== "all" && fallbackCwd !== this.#cwd) continue;
        const processActive = fallbackCwd ? (activeCwds.get(fallbackCwd) ?? 0) > 0 : false;
        const root = parseClaudeTranscript(rootTail.text, {
          threadId: rootId,
          sessionId,
          fallbackCwd,
          isRoot: true,
          processActive,
          createdAt: rootTail.stat.birthtimeMs || undefined,
          updatedAt: rootTail.stat.mtimeMs,
        });
        results.push({ ...root, path });

        const subagentsDir = join(projectDir, sessionId, "subagents");
        let agentFiles: string[];
        try {
          agentFiles = readdirSync(subagentsDir).filter((name) => name.startsWith("agent-") && name.endsWith(".jsonl"));
        } catch {
          continue;
        }
        const parsedAgents: Array<{ observed: ObservedClaudeThread; meta?: ClaudeSubagentMeta }> = [];
        for (const agentFile of agentFiles) {
          const agentPath = join(subagentsDir, agentFile);
          const nativeAgentId = agentFile.slice(0, -".jsonl".length);
          const threadId = namespaceSubagent(sessionId, nativeAgentId);
          let tail: ReturnType<typeof readTail>;
          try {
            tail = readTail(agentPath);
          } catch {
            continue;
          }
          const meta = parseSubagentMeta(join(subagentsDir, `${nativeAgentId}.meta.json`));
          const parsed = parseClaudeTranscript(tail.text, {
            threadId,
            sessionId,
            parentThreadId: rootId,
            fallbackCwd,
            isRoot: false,
            processActive,
            createdAt: tail.stat.birthtimeMs || undefined,
            updatedAt: tail.stat.mtimeMs,
            meta,
          });
          parsedAgents.push({ observed: { ...parsed, path: agentPath }, meta });
        }

        const toolOwner = new Map<string, string>();
        for (const id of root.toolUseIds) toolOwner.set(id, rootId);
        for (const { observed } of parsedAgents) {
          for (const id of observed.toolUseIds) toolOwner.set(id, observed.snapshot.id);
        }
        for (const { observed, meta } of parsedAgents) {
          const parent = meta?.toolUseId ? toolOwner.get(meta.toolUseId) : undefined;
          if (parent && parent !== observed.snapshot.id) observed.snapshot.parentThreadId = parent;
          results.push(observed);
        }
      }
    }
    return applyClaudeTeamEvidence(results, discoverClaudeAgentTeams(this.#claudeHome), this.#cwd);
  }

  #sessionId(text: string): string | undefined {
    for (const line of text.split("\n")) {
      const sessionId = stringValue(parseJsonRecord(line)?.sessionId);
      if (sessionId) return sessionId;
    }
    return undefined;
  }

  #transcriptCwd(text: string): string | undefined {
    for (const line of text.split("\n")) {
      const cwd = stringValue(parseJsonRecord(line)?.cwd);
      if (cwd) return cwd;
    }
    return undefined;
  }

  #emitThread(thread: ObservedClaudeThread): void {
    const at = this.#now();
    this.#emit({ type: "thread.discovered", at, thread: thread.snapshot });
    for (const activity of thread.activities) {
      if (this.#seenActivities.has(activity.id)) continue;
      this.#seenActivities.add(activity.id);
      this.#emit({ type: "activity.started", at: activity.startedAt, activity });
      if (activity.completedAt !== undefined) {
        this.#emit({
          type: "activity.completed",
          at: activity.completedAt,
          threadId: activity.agentId,
          activityId: activity.id,
          activity,
          outcome: activity.outcome,
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
        status: thread.lifecycle,
      });
    }
  }

  #emit(event: AgentRuntimeEvent): void {
    const tagged = { ...event, provider: "claude" as const } as AgentRuntimeEvent;
    for (const listener of this.#listeners) listener(tagged);
  }

  #debug(summary: string, payload?: unknown): void {
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
        ...(payload instanceof Error ? { payload: { name: payload.name, message: payload.message } } : {}),
      },
    });
  }
}
