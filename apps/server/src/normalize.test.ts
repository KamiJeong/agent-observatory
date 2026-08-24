import { describe, expect, it } from "vitest";
import { normalizeEnvelope, parseEnvelope, toThreadSnapshot } from "./normalize.ts";

describe("protocol normalization", () => {
  it("builds subagent metadata from current Thread fields", () => {
    const thread = toThreadSnapshot({
      id: "child",
      sessionId: "session",
      parentThreadId: "root",
      agentNickname: "Builder",
      agentRole: "implementation",
      status: { type: "active", activeFlags: [] },
      createdAt: 100,
      updatedAt: 101,
      cwd: "/repo",
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
      unknownFutureField: true,
    });
    expect(thread).toMatchObject({
      id: "child",
      parentThreadId: "root",
      nickname: "Builder",
      role: "implementation",
      createdAt: 100_000,
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
    });
  });

  it("falls back to source thread_spawn metadata", () => {
    expect(toThreadSnapshot({
      id: "child",
      status: { type: "idle" },
      source: {
        subAgent: {
          thread_spawn: {
            parent_thread_id: "root",
            depth: 2,
            agent_nickname: "Nested",
          },
        },
      },
    })).toMatchObject({ parentThreadId: "root", depth: 2, nickname: "Nested" });
  });

  it("normalizes approval and resolution evidence", () => {
    const opened = normalizeEnvelope({
      method: "item/commandExecution/requestApproval",
      id: 42,
      params: { threadId: "tester", startedAtMs: 500, reason: "network" },
    }, 600);
    expect(opened[0]).toMatchObject({
      type: "request.opened",
      request: { id: "42", agentId: "tester", reason: "approval" },
    });
    expect(normalizeEnvelope({
      method: "serverRequest/resolved",
      params: { threadId: "tester", requestId: 42 },
    }, 700)[0]).toMatchObject({ type: "request.resolved", requestId: "42" });
  });

  it("classifies a test command and ignores additive fields", () => {
    for (const command of ["npm run test -- --watch=false", "bun run test -- --watch=false"]) {
      const events = normalizeEnvelope({
        method: "item/started",
        params: {
          threadId: "tester",
          turnId: "turn",
          future: "allowed",
          item: {
            type: "commandExecution",
            id: "cmd",
            command,
            cwd: "/repo",
            status: "inProgress",
            commandActions: [],
            addedLater: 1,
          },
        },
      }, 1000);
      expect(events[0]).toMatchObject({
        type: "activity.started",
        activity: { id: "cmd", kind: "test", title: "Running tests" },
      });
    }
  });

  it("extracts explicit collab completion states", () => {
    const events = normalizeEnvelope({
      method: "item/completed",
      params: {
        threadId: "root",
        item: {
          type: "collabAgentToolCall",
          id: "wait",
          tool: "wait",
          status: "completed",
          agentsStates: { child: { status: "completed", message: "done" } },
        },
      },
    }, 2000);
    expect(events).toContainEqual({
      type: "agent.lifecycle",
      at: 2000,
      threadId: "child",
      status: "completed",
      message: "done",
    });
  });

  it("quarantines malformed and unknown envelopes", () => {
    expect(parseEnvelope("not json")).toBeUndefined();
    expect(normalizeEnvelope({ method: "future/event", params: { anything: true } })).toEqual([]);
  });
});
