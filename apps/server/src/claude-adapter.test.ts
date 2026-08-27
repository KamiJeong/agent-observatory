import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRuntimeEvent } from "@observatory/core";
import {
  ClaudeCodeAdapter,
  findInteractiveClaudeCwds,
  parseClaudeTranscript,
  selectActiveClaudeTranscriptPaths,
} from "./claude-adapter.ts";
import {
  discoverClaudeAgentTeams,
  parseClaudeTeamConfig,
  parseClaudeTeamInbox,
  parseClaudeTeamTask,
} from "./claude-team-observer.ts";

const fixtureDir = fileURLToPath(new URL("./test-fixtures/claude", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "observatory-claude-"));
  temporaryDirectories.push(path);
  return path;
}

function fixture(name: string): string {
  return readFileSync(join(fixtureDir, name), "utf8");
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Claude transcript compatibility parser", () => {
  it("normalizes lifecycle, tools, history, and usage without exposing contents", () => {
    const parsed = parseClaudeTranscript(fixture("root.jsonl"), {
      threadId: "claude:session-1",
      sessionId: "session-1",
      isRoot: true,
      processActive: true,
    });

    expect(parsed.snapshot).toMatchObject({
      id: "claude:session-1",
      sessionId: "session-1",
      cwd: "/workspace/demo",
      model: "claude-sonnet-test",
      modelProvider: "anthropic",
      nativeStatus: { type: "idle" },
    });
    expect(parsed.activities).toEqual([
      expect.objectContaining({
        id: "claude:session-1:activity:tool-agent-1",
        kind: "tool",
        title: "Starting subagent",
        outcome: "completed",
      }),
    ]);
    expect(parsed.usage).toMatchObject({ inputTokens: 22, cachedInputTokens: 2, outputTokens: 7 });
    expect(parsed.history.map((event) => event.summary)).toEqual([
      "User request",
      "Agent response",
    ]);
    expect(JSON.stringify(parsed)).not.toContain("private");
  });

  it("retains only bounded request and final-response text with explicit content capture", () => {
    const parsed = parseClaudeTranscript(fixture("root.jsonl"), {
      threadId: "claude:session-1",
      sessionId: "session-1",
      isRoot: true,
      processActive: true,
      captureContent: true,
    });

    expect(parsed.history.map((event) => event.content)).toEqual([
      "private prompt must not escape",
      "private response must not escape",
    ]);
    expect(JSON.stringify(parsed)).not.toContain("private delegation");
    expect(JSON.stringify(parsed)).not.toContain("private result");
    expect(parsed.snapshot.source).toMatchObject({ contentCaptured: true });
  });

  it("ignores malformed and future records", () => {
    const parsed = parseClaudeTranscript([
      "not-json",
      JSON.stringify({ type: "future-event", cwd: "/workspace/demo", payload: { secret: "private" } }),
      "{\"type\":\"assistant\"",
    ].join("\n"), {
      threadId: "claude:future",
      sessionId: "future",
      isRoot: true,
      processActive: false,
    });
    expect(parsed.snapshot.nativeStatus).toEqual({ type: "notLoaded" });
    expect(parsed.activities).toEqual([]);
    expect(JSON.stringify(parsed)).not.toContain("private");
  });
});

describe("Claude process discovery", () => {
  it("finds passive interactive process cwd entries and ignores maintenance commands", () => {
    const procRoot = temporaryDirectory();
    for (const [pid, command, cwd] of [
      ["101", ["/usr/bin/claude"], "/workspace/one"],
      ["102", ["/usr/bin/claude", "doctor"], "/workspace/two"],
    ] as const) {
      const processDir = join(procRoot, pid);
      mkdirSync(processDir);
      writeFileSync(join(processDir, "cmdline"), `${command.join("\0")}\0`);
      symlinkSync(cwd, join(processDir, "cwd"));
    }
    const discovered = findInteractiveClaudeCwds(procRoot);
    expect(discovered.processCount).toBe(1);
    expect(discovered.cwdCounts).toEqual(new Map([["/workspace/one", 1]]));
  });

  it("resolves an open subagent transcript to its root transcript", () => {
    const procRoot = temporaryDirectory();
    const processDir = join(procRoot, "101");
    const subagentPath = join(procRoot, "projects", "demo", "session-1", "subagents", "agent-a1.jsonl");
    mkdirSync(join(processDir, "fd"), { recursive: true });
    writeFileSync(join(processDir, "cmdline"), "/usr/bin/claude\0");
    symlinkSync("/workspace/demo", join(processDir, "cwd"));
    symlinkSync(subagentPath, join(processDir, "fd", "7"));

    const discovered = findInteractiveClaudeCwds(procRoot);

    expect(discovered.openRootTranscriptPaths).toEqual(new Set([
      join(procRoot, "projects", "demo", "session-1.jsonl"),
    ]));
  });

  it("prefers exact open transcripts and otherwise selects the newest N roots per active cwd", () => {
    const candidates = [
      { path: "/transcripts/old.jsonl", cwd: "/workspace/demo", updatedAt: 10 },
      { path: "/transcripts/new.jsonl", cwd: "/workspace/demo", updatedAt: 30 },
      { path: "/transcripts/middle.jsonl", cwd: "/workspace/demo", updatedAt: 20 },
      { path: "/transcripts/other.jsonl", cwd: "/workspace/other", updatedAt: 40 },
    ];
    expect(selectActiveClaudeTranscriptPaths(candidates, {
      cwdCounts: new Map([["/workspace/demo", 1]]),
      processCount: 1,
      exact: true,
      source: "procfs",
      openRootTranscriptPaths: new Set(["/transcripts/old.jsonl"]),
    }, "all")).toEqual(new Set(["/transcripts/old.jsonl"]));
    expect(selectActiveClaudeTranscriptPaths(candidates, {
      cwdCounts: new Map([["/workspace/demo", 2]]),
      processCount: 2,
      exact: true,
      source: "procfs",
    }, "all")).toEqual(new Set(["/transcripts/new.jsonl", "/transcripts/middle.jsonl"]));
    expect(selectActiveClaudeTranscriptPaths(candidates, {
      cwdCounts: new Map(),
      processCount: 1,
      exact: false,
      source: "unsupported",
    }, "/workspace/demo")).toEqual(new Set(["/transcripts/new.jsonl"]));
  });
});

describe("Claude agent-team compatibility evidence", () => {
  it("parses member kinds, task state, and mailbox protocols without retaining contents", () => {
    const config = parseClaudeTeamConfig(JSON.stringify({
      name: "session-12345678",
      description: "private team description",
      leadAgentId: "team-lead@session-12345678",
      leadSessionId: "lead-session",
      members: [
        {
          agentId: "team-lead@session-12345678",
          name: "team-lead",
          agentType: "team-lead",
          sessionId: "lead-session",
          cwd: "/workspace/demo",
        },
        {
          agentId: "reviewer@session-12345678",
          name: "reviewer",
          agentType: "security-reviewer",
          sessionId: "teammate-session",
          prompt: "private spawn prompt",
          cwd: "/workspace/demo",
        },
      ],
    }), "fallback");
    const task = parseClaudeTeamTask(JSON.stringify({
      id: "1",
      subject: "private task subject",
      description: "private task description",
      status: "in_progress",
      owner: "reviewer",
      blocks: [],
      blockedBy: [],
    }), 1234);
    const inbox = parseClaudeTeamInbox(JSON.stringify([
      {
        from: "reviewer",
        text: "private peer message",
        summary: "private summary",
        timestamp: "2026-08-25T01:00:00.000Z",
        read: false,
      },
      {
        from: "reviewer",
        text: JSON.stringify({
          type: "idle_notification",
          summary: "private idle details",
          timestamp: "2026-08-25T01:01:00.000Z",
        }),
        timestamp: "2026-08-25T01:01:00.000Z",
        read: true,
      },
      {
        from: "reviewer",
        text: JSON.stringify({
          type: "shutdown_response",
          request_id: "shutdown-1",
          approve: true,
          content: "private response",
        }),
        timestamp: "2026-08-25T01:02:00.000Z",
        read: true,
      },
    ]), "team-lead");

    expect(config?.members.map((member) => member.kind)).toEqual(["teamLead", "teammate"]);
    expect(task).toMatchObject({ id: "1", status: "in_progress", owner: "reviewer", internal: false });
    expect(inbox.map((message) => message.type)).toEqual(["message", "idle_notification", "shutdown_approved"]);
    expect(inbox[2]?.requestId).toBe("shutdown-1");
    expect(JSON.stringify({ config, task, inbox })).not.toContain("private");
  });

  it("ignores persisted tasks when no active team config exists", () => {
    const claudeHome = temporaryDirectory();
    write(join(claudeHome, "tasks", "stale-team", "1.json"), JSON.stringify({
      id: "1",
      subject: "private stale task",
      status: "in_progress",
      owner: "departed",
    }));
    write(join(claudeHome, "teams", "transient", "config.json"), "{\"members\":");

    expect(discoverClaudeAgentTeams(claudeHome)).toEqual([]);
  });
});

describe("Claude adapter", () => {
  it("advertises the configured content-capture policy", () => {
    expect(new ClaudeCodeAdapter({ environment: {} }).runtimeInfo().contentCapture).toBe("metadata-only");
    expect(new ClaudeCodeAdapter({
      environment: { OBSERVATORY_CAPTURE_CONTENT: "1" },
    }).runtimeInfo().contentCapture).toBe("enabled");
  });

  it("uses the preserved launcher cwd instead of the nested server cwd", async () => {
    const claudeHome = temporaryDirectory();
    const projectDir = join(claudeHome, "projects", "-workspace-demo");
    write(join(projectDir, "session-1.jsonl"), fixture("root.jsonl"));
    const adapter = new ClaudeCodeAdapter({
      claudeHome,
      environment: {
        OBSERVATORY_LAUNCH_CWD: "/workspace/demo",
        INIT_CWD: "/workspace/server-package",
      },
      processDiscovery: () => ({
        cwdCounts: new Map([["/workspace/demo", 1]]),
        processCount: 1,
        exact: true,
        source: "procfs",
      }),
    });

    const threads = await adapter.listThreads();

    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ cwd: "/workspace/demo" });

    const explicitlyRestricted = new ClaudeCodeAdapter({
      claudeHome,
      environment: {
        OBSERVATORY_CWD: "/workspace/other",
        OBSERVATORY_LAUNCH_CWD: "/workspace/demo",
      },
      processDiscovery: () => ({
        cwdCounts: new Map([["/workspace/demo", 1]]),
        processCount: 1,
        exact: true,
        source: "procfs",
      }),
    });
    await expect(explicitlyRestricted.listThreads()).resolves.toEqual([]);
  });

  it("shows only the newest root for one active process and keeps its subagents", async () => {
    const claudeHome = temporaryDirectory();
    const projectDir = join(claudeHome, "projects", "-workspace-demo");
    const oldRoot = join(projectDir, "session-old.jsonl");
    const activeRoot = join(projectDir, "session-active.jsonl");
    write(oldRoot, fixture("root.jsonl").replaceAll("session-1", "session-old"));
    write(activeRoot, fixture("root.jsonl").replaceAll("session-1", "session-active"));
    write(join(projectDir, "session-active", "subagents", "agent-a1.jsonl"), fixture("subagent.jsonl")
      .replaceAll("session-1", "session-active"));
    write(join(projectDir, "session-active", "subagents", "agent-a1.meta.json"), fixture("subagent.meta.json"));
    utimesSync(oldRoot, new Date(1_000), new Date(1_000));
    utimesSync(activeRoot, new Date(2_000), new Date(2_000));
    const adapter = new ClaudeCodeAdapter({
      claudeHome,
      cwd: "/workspace/demo",
      processDiscovery: () => ({
        cwdCounts: new Map([["/workspace/demo", 1]]),
        processCount: 1,
        exact: true,
        source: "procfs",
      }),
    });

    const threads = await adapter.listThreads();

    expect(threads.map((thread) => thread.id).sort()).toEqual([
      "claude:session-active",
      "claude:session-active:agent-a1",
    ]);
    expect(threads.every((thread) => thread.id !== "claude:session-old")).toBe(true);
  });

  it("keeps archived transcript scanning below a constrained Node heap", () => {
    const claudeHome = temporaryDirectory();
    const projectDir = join(claudeHome, "projects", "-workspace-demo");
    const archivedPayload = "가".repeat(400_000);
    for (let index = 0; index < 80; index += 1) {
      write(join(projectDir, `archived-${index}.jsonl`), JSON.stringify({
        type: "user",
        sessionId: `archived-${index}`,
        cwd: "/workspace/demo",
        message: { role: "user", content: archivedPayload },
      }));
    }
    const activePath = join(projectDir, "session-1.jsonl");
    write(activePath, fixture("root.jsonl"));
    const script = `
      import { ClaudeCodeAdapter } from "./apps/server/src/claude-adapter.ts";
      const activePath = ${JSON.stringify(activePath)};
      const adapter = new ClaudeCodeAdapter({
        claudeHome: ${JSON.stringify(claudeHome)},
        cwd: "all",
        processDiscovery: () => ({
          cwdCounts: new Map([["/workspace/demo", 1]]),
          processCount: 1,
          exact: true,
          source: "procfs",
          openRootTranscriptPaths: new Set([activePath]),
        }),
      });
      const threads = await adapter.listThreads();
      if (threads.length !== 1 || threads[0]?.id !== "claude:session-1") process.exit(2);
    `;

    const result = spawnSync("node", [
      "--max-old-space-size=64",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      script,
    ], { cwd: repositoryRoot, encoding: "utf8", timeout: 20_000 });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it("discovers a namespaced root and subagent with a mapped parent", async () => {
    const claudeHome = temporaryDirectory();
    const projectDir = join(claudeHome, "projects", "-workspace-demo");
    write(join(projectDir, "session-1.jsonl"), fixture("root.jsonl"));
    write(join(projectDir, "session-1", "subagents", "agent-a1.jsonl"), fixture("subagent.jsonl"));
    write(join(projectDir, "session-1", "subagents", "agent-a1.meta.json"), fixture("subagent.meta.json"));
    const adapter = new ClaudeCodeAdapter({
      claudeHome,
      cwd: "/workspace/demo",
      processDiscovery: () => ({
        cwdCounts: new Map([["/workspace/demo", 1]]),
        processCount: 1,
        exact: true,
        source: "procfs",
      }),
    });

    const threads = await adapter.listThreads();
    expect(threads).toHaveLength(2);
    expect(threads).toContainEqual(expect.objectContaining({
      id: "claude:session-1:agent-a1",
      parentThreadId: "claude:session-1",
      role: "general-purpose",
      depth: 1,
      source: expect.objectContaining({ agentKind: "subagent" }),
    }));
    expect(await adapter.listThreads({ rootThreadId: "claude:session-1" })).toHaveLength(1);
    expect((await adapter.readThread("claude:session-1")).id).toBe("claude:session-1");
    expect(await adapter.listThreads({ rootThreadId: "session-1" })).toHaveLength(1);
    expect((await adapter.readThread("session-1")).id).toBe("claude:session-1");
  });

  it("does not re-emit unchanged thread and token snapshots while polling", async () => {
    const claudeHome = temporaryDirectory();
    const projectDir = join(claudeHome, "projects", "-workspace-demo");
    write(join(projectDir, "session-1.jsonl"), fixture("root.jsonl"));
    const adapter = new ClaudeCodeAdapter({
      claudeHome,
      cwd: "/workspace/demo",
      pollIntervalMs: 10,
      processDiscovery: () => ({
        cwdCounts: new Map([["/workspace/demo", 1]]), processCount: 1, exact: true, source: "procfs",
      }),
    });
    const events: AgentRuntimeEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    await adapter.connect();
    await new Promise((resolve) => setTimeout(resolve, 35));
    await adapter.disconnect();

    expect(events.filter((event) => event.type === "thread.discovered")).toHaveLength(1);
    expect(events.filter((event) => event.type === "token.updated")).toHaveLength(1);
    expect(events.filter((event) => event.type === "activity.started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "history.recorded")).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain("private");
  });

  it("emits an activity completion when an open tool finishes on a later poll", async () => {
    const claudeHome = temporaryDirectory();
    const transcriptPath = join(claudeHome, "projects", "-workspace-demo", "session-1.jsonl");
    const lines = fixture("root.jsonl").trim().split("\n");
    write(transcriptPath, lines.slice(0, 2).join("\n"));
    const adapter = new ClaudeCodeAdapter({
      claudeHome,
      cwd: "/workspace/demo",
      pollIntervalMs: 10,
      processDiscovery: () => ({
        cwdCounts: new Map([["/workspace/demo", 1]]), processCount: 1, exact: true, source: "procfs",
      }),
    });
    const events: AgentRuntimeEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    await adapter.connect();

    write(transcriptPath, lines.slice(0, 3).join("\n"));
    await new Promise((resolve) => setTimeout(resolve, 35));
    await adapter.disconnect();

    const activityEvents = events.filter((event) => (
      event.type === "activity.started" || event.type === "activity.completed"
    ));
    expect(activityEvents.map((event) => event.type)).toEqual([
      "activity.started",
      "activity.completed",
    ]);
    expect(activityEvents[1]).toMatchObject({
      type: "activity.completed",
      activityId: "claude:session-1:activity:tool-agent-1",
      outcome: "completed",
    });
  });

  it("distinguishes a team lead and teammate and normalizes task, message, idle, and shutdown evidence", async () => {
    const claudeHome = temporaryDirectory();
    const projectDir = join(claudeHome, "projects", "-workspace-demo");
    write(join(projectDir, "session-1.jsonl"), fixture("root.jsonl"));
    write(
      join(projectDir, "session-2.jsonl"),
      fixture("root.jsonl").replaceAll("session-1", "session-2"),
    );
    const teamName = "session-session";
    write(join(claudeHome, "teams", teamName, "config.json"), JSON.stringify({
      name: teamName,
      createdAt: Date.parse("2026-08-25T00:00:00.000Z"),
      leadAgentId: `team-lead@${teamName}`,
      leadSessionId: "session-1",
      members: [
        {
          agentId: `team-lead@${teamName}`,
          name: "team-lead",
          agentType: "team-lead",
          sessionId: "session-1",
          cwd: "/workspace/demo",
        },
        {
          agentId: `reviewer@${teamName}`,
          name: "reviewer",
          agentType: "security-reviewer",
          sessionId: "session-2",
          prompt: "private teammate prompt",
          cwd: "/workspace/demo",
        },
      ],
    }));
    write(join(claudeHome, "tasks", teamName, "1.json"), JSON.stringify({
      id: "1",
      subject: "private assigned task",
      description: "private task details",
      status: "completed",
      owner: "reviewer",
    }));
    write(join(claudeHome, "teams", teamName, "inboxes", "reviewer.json"), JSON.stringify([
      {
        from: "team-lead",
        text: JSON.stringify({ type: "task_assignment", taskId: "1", subject: "private assigned task" }),
        timestamp: "2026-08-25T00:01:00.000Z",
        read: true,
      },
      {
        from: "team-lead",
        text: JSON.stringify({ type: "shutdown_request", requestId: "shutdown-1", reason: "private reason" }),
        timestamp: "2026-08-25T00:04:00.000Z",
        read: true,
      },
    ]));
    write(join(claudeHome, "teams", teamName, "inboxes", "team-lead.json"), JSON.stringify([
      {
        from: "reviewer",
        text: "private peer result",
        timestamp: "2026-08-25T00:02:00.000Z",
        read: true,
      },
      {
        from: "reviewer",
        text: JSON.stringify({ type: "idle_notification", summary: "private idle summary" }),
        timestamp: "2026-08-25T00:03:00.000Z",
        read: true,
      },
      {
        from: "reviewer",
        text: JSON.stringify({
          type: "shutdown_response",
          request_id: "shutdown-1",
          approve: true,
          content: "private approval response",
        }),
        timestamp: "2026-08-25T00:05:00.000Z",
        read: true,
      },
    ]));

    const adapter = new ClaudeCodeAdapter({
      claudeHome,
      cwd: "/workspace/demo",
      pollIntervalMs: 60_000,
      now: () => Date.parse("2026-08-25T00:06:00.000Z"),
      processDiscovery: () => ({
        cwdCounts: new Map([["/workspace/demo", 2]]),
        processCount: 2,
        exact: true,
        source: "procfs",
      }),
    });
    const events: AgentRuntimeEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    await adapter.connect();
    const threads = await adapter.listThreads();
    await adapter.disconnect();

    const lead = threads.find((thread) => thread.sessionId === "session-1");
    const teammate = threads.find((thread) => thread.sessionId === "session-2");
    expect(lead).toMatchObject({ role: "teamLead", collaborationMode: "claude-agent-team-beta" });
    expect(teammate).toMatchObject({
      role: "teammate",
      parentThreadId: lead?.id,
      collaborationMode: "claude-agent-team-beta",
      nativeStatus: { type: "idle" },
    });
    expect(recordedSummaries(events)).toEqual(expect.arrayContaining([
      "Team task completed",
      "Team task assigned",
      "Teammate message",
      "Teammate became idle",
      "Teammate shutdown requested",
      "Teammate shutdown approved",
    ]));
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent.lifecycle",
      threadId: teammate?.id,
      status: "shutdown",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "thread.discovered",
      thread: expect.objectContaining({
        id: teammate?.id,
        role: "teammate",
        source: expect.objectContaining({ beta: true, agentKind: "teammate" }),
      }),
    }));
    const peerMessage = events.find((event) =>
      event.type === "history.recorded" && event.history.summary === "Teammate message"
    );
    expect(peerMessage).toMatchObject({
      history: {
        actor: { type: "agent", id: teammate?.id },
        recipients: [{ type: "agent", id: lead?.id }],
        source: "compatibility",
        relationKind: "message",
      },
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "history.recorded",
      history: expect.objectContaining({ summary: "Team task assigned", relationKind: "task" }),
    }));
    expect(JSON.stringify({ threads, events })).not.toContain("private");
  });

  it("ignores an unanchored persisted team when no active root transcript exists", async () => {
    const claudeHome = temporaryDirectory();
    const teamName = "session-stale1";
    write(join(claudeHome, "teams", teamName, "config.json"), JSON.stringify({
      name: teamName,
      leadAgentId: `team-lead@${teamName}`,
      members: [
        {
          agentId: `team-lead@${teamName}`,
          name: "team-lead",
          agentType: "team-lead",
          cwd: "/workspace/demo",
        },
        {
          agentId: `worker@${teamName}`,
          name: "worker",
          cwd: "/workspace/demo",
        },
      ],
    }));
    write(join(claudeHome, "tasks", teamName, "1.json"), JSON.stringify({
      id: "1",
      subject: "private stale task",
      status: "in_progress",
      owner: "worker",
    }));
    const adapter = new ClaudeCodeAdapter({
      claudeHome,
      cwd: "/workspace/demo",
      processDiscovery: () => ({
        cwdCounts: new Map([["/workspace/demo", 1]]),
        processCount: 1,
        exact: true,
        source: "procfs",
      }),
    });

    const threads = await adapter.listThreads();
    expect(threads).toEqual([]);
    expect(JSON.stringify(threads)).not.toContain("private");
  });

  it("emits removal when the active Claude process exits", async () => {
    const claudeHome = temporaryDirectory();
    const projectDir = join(claudeHome, "projects", "-workspace-demo");
    write(join(projectDir, "session-1.jsonl"), fixture("root.jsonl"));
    let active = true;
    const adapter = new ClaudeCodeAdapter({
      claudeHome,
      cwd: "/workspace/demo",
      pollIntervalMs: 10,
      processDiscovery: () => ({
        cwdCounts: active ? new Map([["/workspace/demo", 1]]) : new Map(),
        processCount: active ? 1 : 0,
        exact: true,
        source: "procfs",
      }),
    });
    const events: AgentRuntimeEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    await adapter.connect();
    active = false;
    await new Promise((resolve) => setTimeout(resolve, 30));
    await adapter.disconnect();

    expect(events).toContainEqual(expect.objectContaining({
      type: "thread.removed",
      threadId: "claude:session-1",
    }));
  });
});

function recordedSummaries(events: AgentRuntimeEvent[]): string[] {
  return events.flatMap((event) => event.type === "history.recorded" ? [event.history.summary] : []);
}
