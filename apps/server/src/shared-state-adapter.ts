import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentActivity,
  CodexAdapter,
  CodexRuntimeEvent,
  DiscoveryOptions,
  NativeThreadStatus,
  ReadThreadOptions,
  RuntimeInfo,
  ThreadSnapshot,
} from "@observatory/core";
import {
  discoverInteractiveCodexProcesses,
  selectRootThreadIds,
  type InteractiveCodexProcesses,
  type RootThreadCandidate,
} from "./process-discovery.ts";

export { findInteractiveCodexCwds } from "./process-discovery.ts";

type SqlValue = string | number | bigint | null;
type SqlRow = Record<string, SqlValue>;

interface RolloutState {
  nativeStatus: NativeThreadStatus;
  lifecycle?: "running" | "completed" | "interrupted";
  lastEventAt?: number;
  model?: string;
  reasoningEffort?: string;
  observedSkills: string[];
  observedWorkflows: string[];
  collaborationMode?: string;
  activities: AgentActivity[];
}

interface SharedThread {
  snapshot: ThreadSnapshot;
  rolloutPath: string;
  rollout: RolloutState;
}

const ACTIVITY_LIMIT_PER_THREAD = 30;
const GLOBAL_ACTIVITY_LIMIT = 300;
const SAFETY_REFRESH_MS = 15_000;
const PROCESS_DISCOVERY_CACHE_MS = 2_000;
const ROLLOUT_TAIL_BYTES = 2 * 1024 * 1024;
const SEEN_ACTIVITY_LIMIT = 3_000;

function numberValue(value: SqlValue | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return undefined;
}

function stringValue(value: SqlValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function jsonRecord(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function timestampValue(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function activityTitle(name: string): { kind: AgentActivity["kind"]; title: string } {
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

function skillNameFromPath(path: string): string | undefined {
  const parts = path.split("/").filter(Boolean);
  if (parts.at(-1) !== "SKILL.md") return undefined;
  const name = parts.at(-2);
  if (!name || name === "skills") return undefined;
  const skillsIndex = parts.lastIndexOf("skills");
  const pluginName = skillsIndex >= 2 && parts[skillsIndex - 1]?.match(/^\d+\.\d+/)
    ? parts[skillsIndex - 2]
    : undefined;
  return pluginName && pluginName !== ".system" ? `${pluginName}:${name}` : name;
}

export function executionContextFromToolInput(
  input: string,
  toolName: string,
): { skills: string[]; workflows: string[] } {
  let command = "";
  const parsed = jsonRecord(input);
  if (parsed && typeof parsed.cmd === "string") {
    command = parsed.cmd;
  } else {
    const commandLiterals = [...input.matchAll(/(?:^|[,{\s])["']?cmd["']?\s*:\s*("(?:\\.|[^"\\])*")/gs)];
    if (commandLiterals.length > 0) {
      for (const match of commandLiterals) {
        try {
          const decoded: unknown = JSON.parse(match[1] ?? "");
          if (typeof decoded === "string") command += `${command ? "\n" : ""}${decoded}`;
        } catch {
          // A malformed orchestration payload is not execution evidence.
        }
      }
    } else if (/^\s*(?:rtk\s+(?:proxy\s+)?)?(?:cat|sed|head|tail|less|bat|rg)\b/.test(input)) {
      command = input;
    }
  }
  const skills = new Set<string>();
  const workflows = new Set<string>();
  const readsFiles = toolName === "exec"
    && /(?:^|&&|\|\||;|\n)\s*(?:rtk\s+(?:proxy\s+)?)?(?:cat|sed|head|tail|less|bat|rg)\b/m.test(command);
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

export function parseRolloutState(
  text: string,
  threadId: string,
  isRoot: boolean,
  processActive: boolean,
): RolloutState {
  let taskStartedAt: number | undefined;
  let taskCompletedAt: number | undefined;
  let interruptedAt: number | undefined;
  let workItemAt: number | undefined;
  let lastEventAt: number | undefined;
  let model: string | undefined;
  let reasoningEffort: string | undefined;
  let collaborationMode: string | undefined;
  const observedSkills = new Set<string>();
  const observedWorkflows = new Set<string>();
  const openCalls = new Map<string, AgentActivity>();
  const completedActivities: AgentActivity[] = [];

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const envelope = jsonRecord(line);
    if (!envelope) continue;
    const at = timestampValue(envelope.timestamp);
    if (at !== undefined) lastEventAt = Math.max(lastEventAt ?? at, at);
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
      if (payload.type === "task_started" && at !== undefined) taskStartedAt = at;
      if (payload.type === "task_complete" && at !== undefined) taskCompletedAt = at;
      if (payload.type === "turn_aborted" && at !== undefined) interruptedAt = at;
      continue;
    }

    if (envelope.type !== "response_item" || at === undefined) continue;
    workItemAt = at;
    const itemType = typeof payload.type === "string" ? payload.type : "";
    if (itemType === "custom_tool_call" || itemType === "function_call") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : `${threadId}:${at}`;
      const name = typeof payload.name === "string" ? payload.name : "tool";
      const input = typeof payload.input === "string"
        ? payload.input
        : typeof payload.arguments === "string"
          ? payload.arguments
          : "";
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
        startedAt: at,
      });
      continue;
    }

    if (itemType === "custom_tool_call_output" || itemType === "function_call_output") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
      const activity = callId ? openCalls.get(callId) : undefined;
      if (activity) {
        completedActivities.push({ ...activity, completedAt: at, outcome: "completed" });
        openCalls.delete(activity.id);
      }
      continue;
    }

    if (itemType === "message") {
      completedActivities.push({
        id: `message:${threadId}:${at}`,
        agentId: threadId,
        kind: "message",
        title: "Agent message",
        startedAt: at,
        completedAt: at,
        outcome: "completed",
      });
    }
  }

  const latestTerminalAt = Math.max(taskCompletedAt ?? 0, interruptedAt ?? 0);
  const explicitWorking = (taskStartedAt ?? 0) > latestTerminalAt;
  const activeRootWork = isRoot && processActive && (workItemAt ?? 0) > latestTerminalAt;
  const isWorking = explicitWorking || activeRootWork;
  const waitingOnUserInput = [...openCalls.values()].some((activity) => activity.detail === "request_user_input");
  let nativeStatus: NativeThreadStatus;
  let lifecycle: RolloutState["lifecycle"];
  if (isWorking) {
    nativeStatus = {
      type: "active",
      activeFlags: waitingOnUserInput ? ["waitingOnUserInput"] : [],
    };
    lifecycle = "running";
  } else if (interruptedAt !== undefined && interruptedAt >= (taskCompletedAt ?? 0)) {
    nativeStatus = processActive && isRoot ? { type: "idle" } : { type: "notLoaded" };
    lifecycle = "interrupted";
  } else if (taskCompletedAt !== undefined) {
    nativeStatus = processActive && isRoot ? { type: "idle" } : { type: "notLoaded" };
    if (!isRoot) lifecycle = "completed";
  } else {
    nativeStatus = processActive && isRoot ? { type: "idle" } : { type: "notLoaded" };
  }

  const activities = [...completedActivities, ...openCalls.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(-ACTIVITY_LIMIT_PER_THREAD);
  return {
    nativeStatus,
    ...(lifecycle ? { lifecycle } : {}),
    ...(lastEventAt ? { lastEventAt } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    observedSkills: [...observedSkills].sort(),
    observedWorkflows: [...observedWorkflows].sort(),
    ...(collaborationMode ? { collaborationMode } : {}),
    activities,
  };
}

function readRolloutTail(path: string): string {
  const fd = openSync(path, "r");
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

function latestVersionedDatabase(codexHome: string, prefix: string): string | undefined {
  const matches = readdirSync(codexHome)
    .filter((name) => new RegExp(`^${prefix}_[0-9]+\\.sqlite$`).test(name))
    .sort((a, b) => {
      const aVersion = Number(a.match(/_([0-9]+)\.sqlite$/)?.[1] ?? 0);
      const bVersion = Number(b.match(/_([0-9]+)\.sqlite$/)?.[1] ?? 0);
      return bVersion - aVersion;
    });
  return matches[0] ? join(codexHome, matches[0]) : undefined;
}

function rowSnapshot(row: SqlRow, rollout: RolloutState): ThreadSnapshot | undefined {
  const id = stringValue(row.id);
  if (!id) return undefined;
  const createdAt = numberValue(row.created_at_ms) ?? ((numberValue(row.created_at) ?? 0) * 1000 || undefined);
  const updatedAt = rollout.lastEventAt ?? numberValue(row.updated_at_ms) ?? ((numberValue(row.updated_at) ?? 0) * 1000 || undefined);
  return {
    id,
    ...(stringValue(row.parent_thread_id) ? { parentThreadId: stringValue(row.parent_thread_id) } : {}),
    ...(stringValue(row.agent_nickname) ? { nickname: stringValue(row.agent_nickname) } : {}),
    ...(stringValue(row.agent_role) ? { role: stringValue(row.agent_role) } : {}),
    nativeStatus: rollout.nativeStatus,
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(stringValue(row.cwd) ? { cwd: stringValue(row.cwd) } : {}),
    ...(rollout.model ? { model: rollout.model } : {}),
    ...(stringValue(row.model_provider) ? { modelProvider: stringValue(row.model_provider) } : {}),
    ...(rollout.reasoningEffort ? { reasoningEffort: rollout.reasoningEffort } : {}),
    observedSkills: rollout.observedSkills,
    observedWorkflows: rollout.observedWorkflows,
    ...(rollout.collaborationMode ? { collaborationMode: rollout.collaborationMode } : {}),
    ...(stringValue(row.thread_source) ? { source: row.thread_source } : {}),
    ...(stringValue(row.agent_path) ? { path: stringValue(row.agent_path) } : {}),
  };
}

export class SharedStateCodexAdapter implements CodexAdapter {
  readonly mode = "codex" as const;
  #listeners = new Set<(event: CodexRuntimeEvent) => void>();
  #db?: DatabaseSync;
  #threads = new Map<string, SharedThread>();
  #watchers: FSWatcher[] = [];
  #refreshTimer?: ReturnType<typeof setTimeout>;
  #safetyTimer?: ReturnType<typeof setInterval>;
  #connected = false;
  #refreshing = false;
  #refreshQueued = false;
  #codexVersion = "unknown";
  #seenActivities = new Set<string>();
  #seenActivityOrder: string[] = [];
  #lastLifecycle = new Map<string, string>();
  #lastThreadFingerprint = new Map<string, string>();
  #rolloutCache = new Map<string, {
    size: number;
    mtimeMs: number;
    processActive: boolean;
    state: RolloutState;
  }>();
  #processDiscoveryCache?: { at: number; value: InteractiveCodexProcesses };
  #lastDiscoveryWarning?: string;

  runtimeInfo(): RuntimeInfo {
    return {
      adapter: "codex",
      observatoryVersion: "0.1.0",
      codexCliVersion: this.#codexVersion,
      protocolGenerationVersion: "0.149.0",
      experimentalApi: false,
      discoveryStrategy: "compatibility",
    };
  }

  subscribe(listener: (event: CodexRuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async connect(): Promise<void> {
    if (this.#connected) return;
    this.#emit({
      type: "connection.changed",
      at: Date.now(),
      connection: { phase: "connecting", attempt: 0, message: "Connecting to shared Codex state" },
    });
    const version = spawnSync("codex", ["--version"], { encoding: "utf8" });
    this.#codexVersion = version.stdout.trim().replace(/^codex-cli\s+/, "") || "unknown";
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
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
        message: "Connected · shared Codex compatibility mode",
      },
    });
    this.#startWatching(codexHome);
  }

  async disconnect(): Promise<void> {
    this.#connected = false;
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
    if (this.#safetyTimer) clearInterval(this.#safetyTimer);
    this.#refreshTimer = undefined;
    this.#safetyTimer = undefined;
    this.#processDiscoveryCache = undefined;
    for (const watcher of this.#watchers) watcher.close();
    this.#watchers = [];
    this.#db?.close();
    this.#db = undefined;
    this.#emit({
      type: "connection.changed",
      at: Date.now(),
      connection: { phase: "disconnected", attempt: 0, message: "Disconnected" },
    });
  }

  async listThreads(options?: DiscoveryOptions): Promise<ThreadSnapshot[]> {
    const values = [...this.#threads.values()].map((thread) => thread.snapshot);
    if (!options?.rootThreadId) return values;
    const descendants = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const thread of values) {
        if (thread.parentThreadId === options.rootThreadId || (thread.parentThreadId && descendants.has(thread.parentThreadId))) {
          if (!descendants.has(thread.id)) {
            descendants.add(thread.id);
            changed = true;
          }
        }
      }
    }
    return values.filter((thread) => descendants.has(thread.id));
  }

  async listLoadedThreads(): Promise<string[]> {
    return [...this.#threads.values()]
      .filter((thread) => thread.snapshot.nativeStatus.type !== "notLoaded")
      .map((thread) => thread.snapshot.id);
  }

  async readThread(threadId: string, _options?: ReadThreadOptions): Promise<ThreadSnapshot> {
    const thread = this.#threads.get(threadId)?.snapshot;
    if (!thread) throw new Error(`Unknown shared Codex thread ${threadId}`);
    return thread;
  }

  #startWatching(codexHome: string): void {
    const schedule = () => this.#scheduleRefresh();
    try {
      this.#watchers.push(watch(codexHome, (_event, file) => {
        if (!file || String(file).startsWith("state_")) schedule();
      }));
    } catch (error) {
      this.#debug("Unable to watch Codex state database", error);
    }
    const sessions = join(codexHome, "sessions");
    if (existsSync(sessions)) {
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

  #scheduleRefresh(): void {
    if (!this.#connected) return;
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = undefined;
      void this.#refresh().catch((error) => this.#debug("Shared state refresh failed", error));
    }, 150);
  }

  async #refresh(): Promise<void> {
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
      `).all() as SqlRow[];
      const processDiscovery = this.#processDiscovery();
      if (processDiscovery.warning && processDiscovery.warning !== this.#lastDiscoveryWarning) {
        this.#lastDiscoveryWarning = processDiscovery.warning;
        this.#debug(processDiscovery.warning, { source: processDiscovery.source });
      }
      const configuredCwd = process.env.OBSERVATORY_CWD ?? "all";
      const rootOverride = process.env.OBSERVATORY_ROOT_THREAD_ID;
      const roots = rows.filter((row) => !stringValue(row.parent_thread_id));
      const rootCandidates = roots.flatMap((row): RootThreadCandidate[] => {
        const id = stringValue(row.id);
        if (!id) return [];
        const cwd = stringValue(row.cwd);
        const updatedAt = numberValue(row.updated_at_ms);
        return [{
          id,
          ...(cwd ? { cwd } : {}),
          ...(updatedAt !== undefined ? { updatedAt } : {}),
        }];
      });
      const selectedRoots = selectRootThreadIds(
        rootCandidates,
        processDiscovery,
        configuredCwd,
        rootOverride,
      );

      const selected = new Set(selectedRoots);
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of rows) {
          const id = stringValue(row.id);
          const parentId = stringValue(row.parent_thread_id);
          if (id && parentId && selected.has(parentId) && !selected.has(id)) {
            selected.add(id);
            changed = true;
          }
        }
      }

      const next = new Map<string, SharedThread>();
      for (const row of rows) {
        const id = stringValue(row.id);
        if (!id || !selected.has(id)) continue;
        const rolloutPath = stringValue(row.rollout_path);
        if (!rolloutPath || !existsSync(rolloutPath)) continue;
        const isRoot = !stringValue(row.parent_thread_id);
        const processActive = isRoot && selectedRoots.has(id);
        const file = statSync(rolloutPath);
        const cached = this.#rolloutCache.get(rolloutPath);
        const rollout = cached
          && cached.size === file.size
          && cached.mtimeMs === file.mtimeMs
          && cached.processActive === processActive
          ? cached.state
          : parseRolloutState(
              readRolloutTail(rolloutPath),
              id,
              isRoot,
              processActive,
            );
        this.#rolloutCache.set(rolloutPath, {
          size: file.size,
          mtimeMs: file.mtimeMs,
          processActive,
          state: rollout,
        });
        const snapshot = rowSnapshot(row, rollout);
        if (!snapshot) continue;
        next.set(id, { snapshot, rolloutPath, rollout });
      }
      this.#threads = next;
      const activePaths = new Set([...next.values()].map((thread) => thread.rolloutPath));
      for (const path of this.#rolloutCache.keys()) {
        if (!activePaths.has(path)) this.#rolloutCache.delete(path);
      }
      for (const thread of next.values()) this.#projectThread(thread);
      const activities = [...next.values()]
        .flatMap((thread) => thread.rollout.activities)
        .sort((a, b) => a.startedAt - b.startedAt)
        .slice(-GLOBAL_ACTIVITY_LIMIT);
      for (const activity of activities) this.#projectActivity(activity);
    } finally {
      this.#refreshing = false;
      if (this.#refreshQueued) {
        this.#refreshQueued = false;
        this.#scheduleRefresh();
      }
    }
  }

  #processDiscovery(): InteractiveCodexProcesses {
    const now = Date.now();
    if (this.#processDiscoveryCache && now - this.#processDiscoveryCache.at < PROCESS_DISCOVERY_CACHE_MS) {
      return this.#processDiscoveryCache.value;
    }
    const value = discoverInteractiveCodexProcesses();
    this.#processDiscoveryCache = { at: now, value };
    return value;
  }

  #projectThread(thread: SharedThread): void {
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

  #projectActivity(activity: AgentActivity): void {
    const key = `${activity.id}:${activity.completedAt ?? "open"}`;
    if (this.#seenActivities.has(key)) return;
    this.#rememberActivity(key);
    if (activity.completedAt !== undefined) {
      this.#emit({
        type: "activity.completed",
        at: activity.completedAt,
        threadId: activity.agentId,
        activityId: activity.id,
        activity,
        outcome: activity.outcome,
      });
    } else {
      this.#emit({ type: "activity.started", at: activity.startedAt, activity });
    }
  }

  #rememberActivity(key: string): void {
    this.#seenActivities.add(key);
    this.#seenActivityOrder.push(key);
    while (this.#seenActivityOrder.length > SEEN_ACTIVITY_LIMIT) {
      const oldest = this.#seenActivityOrder.shift();
      if (oldest) this.#seenActivities.delete(oldest);
    }
  }

  #emit(event: CodexRuntimeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #debug(summary: string, payload?: unknown): void {
    this.#emit({
      type: "debug",
      at: Date.now(),
      entry: {
        id: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
        at: Date.now(),
        direction: "internal",
        category: "connection",
        summary,
        ...(payload !== undefined ? { payload: payload instanceof Error ? payload.message : payload } : {}),
      },
    });
  }
}
