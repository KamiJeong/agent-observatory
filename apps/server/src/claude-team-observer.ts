import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_TASK_BYTES = 1024 * 1024;
const MAX_INBOX_BYTES = 4 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

export type ClaudeTeamMemberKind = "teamLead" | "teammate";
export type ClaudeTeamTaskStatus = "pending" | "in_progress" | "completed";
export type ClaudeTeamMessageType =
  | "message"
  | "task_assignment"
  | "task_completed"
  | "idle_notification"
  | "shutdown_request"
  | "shutdown_approved"
  | "shutdown_rejected"
  | "teammate_terminated";

export interface ClaudeTeamMemberEvidence {
  agentId: string;
  name: string;
  kind: ClaudeTeamMemberKind;
  agentType?: string;
  sessionId?: string;
  model?: string;
  cwd?: string;
  joinedAt?: number;
}

export interface ClaudeTeamTaskEvidence {
  id: string;
  status: ClaudeTeamTaskStatus;
  owner?: string;
  internal: boolean;
  updatedAt: number;
}

export interface ClaudeTeamMessageEvidence {
  id: string;
  type: ClaudeTeamMessageType;
  from: string;
  recipient: string;
  occurredAt: number;
  taskId?: string;
  requestId?: string;
  read?: boolean;
}

export interface ClaudeTeamObservation {
  name: string;
  createdAt?: number;
  leadAgentId?: string;
  leadSessionId?: string;
  members: ClaudeTeamMemberEvidence[];
  tasks: ClaudeTeamTaskEvidence[];
  messages: ClaudeTeamMessageEvidence[];
  evidenceSource: "compatibility";
  beta: true;
}

function recordValue(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function timestampValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readBoundedJson(path: string, maxBytes: number): unknown {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > maxBytes) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Parses only identity and topology fields from Claude's transient team config.
 * Prompt, description, color, paths outside cwd, and unknown fields are dropped.
 */
export function parseClaudeTeamConfig(text: string, fallbackName: string): Omit<ClaudeTeamObservation, "tasks" | "messages"> | undefined {
  let parsed: JsonRecord | undefined;
  try {
    parsed = recordValue(JSON.parse(text));
  } catch {
    return undefined;
  }
  if (!parsed || !Array.isArray(parsed.members)) return undefined;
  // The directory is the storage identity. Config name/teamName fields have been
  // deprecated across Claude versions and must not redirect filesystem reads.
  const name = fallbackName;
  const leadAgentId = stringValue(parsed.leadAgentId);
  const leadSessionId = stringValue(parsed.leadSessionId);
  const members: ClaudeTeamMemberEvidence[] = [];
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
      ...(agentType ? { agentType } : {}),
      ...(stringValue(member.sessionId) ? { sessionId: stringValue(member.sessionId) } : {}),
      ...(stringValue(member.model) ? { model: stringValue(member.model) } : {}),
      ...(stringValue(member.cwd) ? { cwd: stringValue(member.cwd) } : {}),
      ...(timestampValue(member.joinedAt) !== undefined ? { joinedAt: timestampValue(member.joinedAt) } : {}),
    });
  }
  if (members.length === 0) return undefined;
  return {
    name,
    ...(timestampValue(parsed.createdAt) !== undefined ? { createdAt: timestampValue(parsed.createdAt) } : {}),
    ...(leadAgentId ? { leadAgentId } : {}),
    ...(leadSessionId ? { leadSessionId } : {}),
    members,
    evidenceSource: "compatibility",
    beta: true,
  };
}

/** Parses a task state without retaining its subject, description, or active form. */
export function parseClaudeTeamTask(text: string, updatedAt: number): ClaudeTeamTaskEvidence | undefined {
  let task: JsonRecord | undefined;
  try {
    task = recordValue(JSON.parse(text));
  } catch {
    return undefined;
  }
  if (!task) return undefined;
  const id = stringValue(task.id);
  const rawStatus = stringValue(task.status);
  if (!id || (rawStatus !== "pending" && rawStatus !== "in_progress" && rawStatus !== "completed")) return undefined;
  const metadata = recordValue(task.metadata);
  return {
    id,
    status: rawStatus,
    ...(stringValue(task.owner) ? { owner: stringValue(task.owner) } : {}),
    internal: metadata?._internal === true,
    updatedAt,
  };
}

function protocolMessage(text: string): JsonRecord | undefined {
  if (!text.startsWith("{")) return undefined;
  try {
    return recordValue(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * Parses the mailbox envelope and protocol discriminator only. Message text,
 * summaries, task subjects, shutdown reasons, and other content are discarded.
 */
export function parseClaudeTeamInbox(text: string, recipient: string): ClaudeTeamMessageEvidence[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const messages: ClaudeTeamMessageEvidence[] = [];
  parsed.forEach((item, index) => {
    const envelope = recordValue(item);
    const from = stringValue(envelope?.from);
    const occurredAt = timestampValue(envelope?.timestamp);
    const textValue = stringValue(envelope?.text);
    if (!envelope || !from || occurredAt === undefined || !textValue) return;
    const protocol = protocolMessage(textValue);
    const rawType = stringValue(protocol?.type);
    let type: ClaudeTeamMessageType = rawType === "task_assignment"
      || rawType === "task_completed"
      || rawType === "idle_notification"
      || rawType === "shutdown_request"
      || rawType === "shutdown_approved"
      || rawType === "shutdown_rejected"
      || rawType === "teammate_terminated"
      ? rawType
      : "message";
    if (rawType === "shutdown_response" && protocol?.approve === true) type = "shutdown_approved";
    if (rawType === "shutdown_response" && protocol?.approve === false) type = "shutdown_rejected";
    const taskId = type === "task_assignment" || type === "task_completed"
      ? stringValue(protocol?.taskId)
      : undefined;
    const requestId = type === "shutdown_request" || type === "shutdown_approved" || type === "shutdown_rejected"
      ? stringValue(protocol?.requestId) ?? stringValue(protocol?.request_id)
      : undefined;
    messages.push({
      id: `${recipient}:${occurredAt}:${index}:${type}`,
      type,
      from,
      recipient,
      occurredAt,
      ...(taskId ? { taskId } : {}),
      ...(requestId ? { requestId } : {}),
      ...(typeof envelope.read === "boolean" ? { read: envelope.read } : {}),
    });
  });
  return messages;
}

function readTasks(claudeHome: string, teamName: string): ClaudeTeamTaskEvidence[] {
  const directory = join(claudeHome, "tasks", teamName);
  let files: string[];
  try {
    files = readdirSync(directory).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
  const tasks: ClaudeTeamTaskEvidence[] = [];
  for (const file of files) {
    const path = join(directory, file);
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > MAX_TASK_BYTES) continue;
      const task = parseClaudeTeamTask(readFileSync(path, "utf8"), stat.mtimeMs);
      if (task) tasks.push(task);
    } catch {
      // Team task writes are atomic but can race with a passive scan.
    }
  }
  return tasks;
}

function readMessages(teamDirectory: string): ClaudeTeamMessageEvidence[] {
  const inboxes = join(teamDirectory, "inboxes");
  let files: string[];
  try {
    files = readdirSync(inboxes).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
  const messages: ClaudeTeamMessageEvidence[] = [];
  for (const file of files) {
    const path = join(inboxes, file);
    try {
      const parsed = readBoundedJson(path, MAX_INBOX_BYTES);
      if (!Array.isArray(parsed)) continue;
      messages.push(...parseClaudeTeamInbox(JSON.stringify(parsed), basename(file, ".json")));
    } catch {
      // Mailboxes are mutable queues; malformed/transient entries are unavailable.
    }
  }
  return messages;
}

/**
 * Reads active team configs first, then only the matching task list/mailboxes.
 * Persisted task directories without a live config are intentionally ignored so
 * stale completed sessions cannot be presented as active teams.
 */
export function discoverClaudeAgentTeams(claudeHome: string): ClaudeTeamObservation[] {
  const teamsRoot = join(claudeHome, "teams");
  let directories: string[];
  try {
    directories = readdirSync(teamsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(teamsRoot, entry.name));
  } catch {
    return [];
  }
  const teams: ClaudeTeamObservation[] = [];
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
        messages: readMessages(directory),
      });
    } catch {
      // Configs are transient and removed at session teardown. A failed read is
      // treated as unavailable evidence, never as a lifecycle transition.
    }
  }
  return teams;
}
