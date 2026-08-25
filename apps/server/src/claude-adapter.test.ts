import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRuntimeEvent } from "@observatory/core";
import {
  ClaudeCodeAdapter,
  findInteractiveClaudeCwds,
  parseClaudeTranscript,
} from "./claude-adapter.ts";
import {
  discoverClaudeAgentTeams,
  parseClaudeTeamConfig,
  parseClaudeTeamInbox,
  parseClaudeTeamTask,
} from "./claude-team-observer.ts";

const fixtureDir = fileURLToPath(new URL("./test-fixtures/claude", import.meta.url));
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

  it("emits sanitized compatibility events once", async () => {
    const claudeHome = temporaryDirectory();
    const projectDir = join(claudeHome, "projects", "-workspace-demo");
    write(join(projectDir, "session-1.jsonl"), fixture("root.jsonl"));
    const adapter = new ClaudeCodeAdapter({
      claudeHome,
      cwd: "/workspace/demo",
      pollIntervalMs: 60_000,
      processDiscovery: () => ({ cwdCounts: new Map(), processCount: 0, exact: true, source: "procfs" }),
    });
    const events: AgentRuntimeEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    await adapter.connect();
    await adapter.listThreads();
    await adapter.disconnect();

    expect(events.some((event) => event.type === "thread.discovered")).toBe(true);
    expect(events.filter((event) => event.type === "activity.started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "history.recorded")).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain("private");
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

  it("keeps config-only teammates idle even when a persisted task says in progress", async () => {
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
    expect(threads).toHaveLength(2);
    expect(threads.every((thread) => thread.nativeStatus.type === "idle")).toBe(true);
    expect(JSON.stringify(threads)).not.toContain("private");
  });
});

function recordedSummaries(events: AgentRuntimeEvent[]): string[] {
  return events.flatMap((event) => event.type === "history.recorded" ? [event.history.summary] : []);
}
