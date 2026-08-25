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

  it("preserves human requests, decisions, deliveries, and agent handoffs", () => {
    const request = normalizeEnvelope({
      method: "item/completed",
      params: {
        threadId: "root",
        item: { type: "userMessage", id: "user-1", content: [{ type: "text", text: "Review authentication" }] },
      },
    }, 1_000);
    expect(request).toContainEqual(expect.objectContaining({
      type: "history.recorded",
      history: expect.objectContaining({
        kind: "request",
        actor: { type: "human" },
        recipients: [{ type: "agent", id: "root" }],
        content: "Review authentication",
      }),
    }));

    const plan = normalizeEnvelope({
      method: "item/completed",
      params: { threadId: "root", item: { type: "plan", id: "plan-1", text: "Inspect, fix, verify" } },
    }, 1_100);
    expect(plan).toContainEqual(expect.objectContaining({
      type: "history.recorded",
      history: expect.objectContaining({ kind: "decision", summary: "Plan updated", content: "Inspect, fix, verify" }),
    }));

    const handoff = normalizeEnvelope({
      method: "item/completed",
      params: {
        threadId: "root",
        item: {
          type: "collabAgentToolCall",
          id: "send-1",
          tool: "sendInput",
          status: "completed",
          senderThreadId: "root",
          receiverThreadIds: ["reviewer"],
          prompt: "Check the cookie boundary",
          agentsStates: { reviewer: { status: "completed", message: "Cookie boundary is safe" } },
        },
      },
    }, 1_200);
    expect(handoff).toContainEqual(expect.objectContaining({
      type: "history.recorded",
      history: expect.objectContaining({
        kind: "handoff",
        actor: { type: "agent", id: "root" },
        recipients: [{ type: "agent", id: "reviewer" }],
        content: "Check the cookie boundary",
      }),
    }));
    expect(handoff).toContainEqual(expect.objectContaining({
      type: "history.recorded",
      history: expect.objectContaining({
        kind: "delivery",
        actor: { type: "agent", id: "reviewer" },
        recipients: [{ type: "agent", id: "root" }],
        content: "Cookie boundary is safe",
      }),
    }));

    const delivery = normalizeEnvelope({
      method: "item/completed",
      params: {
        threadId: "root",
        item: { type: "agentMessage", id: "answer-1", phase: "final_answer", text: "Completed the review" },
      },
    }, 1_300);
    expect(delivery).toContainEqual(expect.objectContaining({
      type: "history.recorded",
      history: expect.objectContaining({ kind: "delivery", summary: "Delivered final result", content: "Completed the review" }),
    }));
  });

  it("quarantines malformed and unknown envelopes", () => {
    expect(parseEnvelope("not json")).toBeUndefined();
    expect(normalizeEnvelope({ method: "future/event", params: { anything: true } })).toEqual([]);
  });
});
