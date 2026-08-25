import { describe, expect, it } from "vitest";
import {
  buildGraph,
  createInitialState,
  projectNativeStatus,
  reduceEvent,
  type RuntimeInfo,
} from "./index.ts";

const runtime: RuntimeInfo = {
  adapter: "mock",
  observatoryVersion: "test",
  experimentalApi: false,
  discoveryStrategy: "mock",
};

describe("status projection", () => {
  it("projects native states without treating notLoaded as completed", () => {
    expect(projectNativeStatus({ type: "notLoaded" }).status).toBe("unknown");
    expect(projectNativeStatus({ type: "idle" }).status).toBe("idle");
    expect(projectNativeStatus({ type: "systemError" }).status).toBe("failed");
    expect(projectNativeStatus({ type: "active", activeFlags: [] }).status).toBe("working");
  });

  it("preserves both native waiting reasons", () => {
    expect(projectNativeStatus({
      type: "active",
      activeFlags: ["waitingOnApproval", "waitingOnUserInput", "futureFlag"],
    })).toEqual({ status: "waiting", waitingReasons: ["approval", "userInput"] });
  });

  it("keeps explicit subagent completion across a notLoaded update", () => {
    let state = createInitialState(runtime, 1);
    state = reduceEvent(state, {
      type: "thread.discovered",
      at: 2,
      thread: { id: "child", nativeStatus: { type: "active", activeFlags: [] } },
    });
    state = reduceEvent(state, {
      type: "agent.lifecycle",
      at: 3,
      threadId: "child",
      status: "completed",
    });
    state = reduceEvent(state, {
      type: "thread.status",
      at: 4,
      threadId: "child",
      status: { type: "notLoaded" },
    });
    expect(state.agents.child?.status).toBe("completed");
    expect(state.agents.child?.nativeStatus).toEqual({ type: "notLoaded" });
  });

  it("projects model and reasoning effort from thread evidence", () => {
    const state = reduceEvent(createInitialState(runtime, 1), {
      type: "thread.discovered",
      at: 2,
      thread: {
        id: "worker",
        nativeStatus: { type: "active", activeFlags: [] },
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
        observedSkills: ["sdd-plan"],
        observedWorkflows: ["SDD"],
        collaborationMode: "default",
      },
    });

    expect(state.agents.worker).toMatchObject({
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
      observedSkills: ["sdd-plan"],
      observedWorkflows: ["SDD"],
      collaborationMode: "default",
    });
  });

  it("keeps single-provider health separate from the aggregate connection", () => {
    const state = reduceEvent(createInitialState({ ...runtime, adapter: "claude", provider: "claude" }, 1), {
      type: "connection.changed",
      provider: "claude",
      at: 2,
      connection: { phase: "connected", attempt: 0, message: "Observing local sessions" },
    });

    expect(state.connection.phase).toBe("connected");
    expect(state.providerConnections.claude).toEqual(state.connection);
  });
});

describe("graph construction", () => {
  it("builds parent-child edges and treats missing parents as roots", () => {
    const graph = buildGraph({
      root: {
        provider: "mock",
        id: "root", threadId: "root", status: "working", waitingReasons: [], recentActivityIds: [], children: ["child"],
      },
      child: {
        provider: "mock",
        id: "child", threadId: "child", parentId: "root", status: "idle", waitingReasons: [], recentActivityIds: [], children: [],
      },
      orphan: {
        provider: "mock",
        id: "orphan", threadId: "orphan", parentId: "missing", status: "unknown", waitingReasons: [], recentActivityIds: [], children: [],
      },
    });
    expect(graph.roots).toEqual(["root", "orphan"]);
    expect(graph.edges).toEqual([{
      id: "root->child",
      source: "root",
      target: "child",
      kind: "spawn",
      evidenceSource: "derived",
    }]);
  });

  it("preserves evidence for mixed agent relations without changing spawn roots", () => {
    const agents = {
      lead: {
        provider: "claude", id: "lead", threadId: "lead", status: "working" as const,
        waitingReasons: [], recentActivityIds: [], children: ["worker"], evidenceSources: ["hook" as const],
      },
      worker: {
        provider: "claude", id: "worker", threadId: "worker", parentId: "lead", status: "working" as const,
        waitingReasons: [], recentActivityIds: [], children: [], evidenceSources: ["transcript" as const],
      },
      peer: {
        provider: "codex", id: "peer", threadId: "peer", status: "idle" as const,
        waitingReasons: [], recentActivityIds: [], children: [],
      },
    };
    const graph = buildGraph(agents, [
      {
        id: "message-1", kind: "handoff", relationKind: "message", actor: { type: "agent", id: "worker" },
        recipients: [{ type: "agent", id: "peer" }], summary: "Asked for review", occurredAt: 5, source: "protocol",
      },
      {
        id: "task-1", kind: "handoff", relationKind: "task", actor: { type: "agent", id: "peer" },
        recipients: [{ type: "agent", id: "worker" }], summary: "Assigned verification", occurredAt: 4, source: "hook",
      },
      {
        id: "self-message", kind: "handoff", relationKind: "message", actor: { type: "agent", id: "peer" },
        recipients: [{ type: "agent", id: "peer" }], summary: "Recorded note", occurredAt: 3, source: "otel",
      },
    ]);

    expect(graph.roots).toEqual(["lead", "peer"]);
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "lead", target: "worker", kind: "spawn", evidenceSource: "transcript" }),
      expect.objectContaining({ source: "worker", target: "peer", kind: "message", evidenceSource: "protocol" }),
      expect.objectContaining({ source: "peer", target: "worker", kind: "task", evidenceSource: "hook" }),
      expect.objectContaining({ source: "peer", target: "peer", kind: "message", evidenceSource: "otel" }),
    ]));
  });
});

describe("bounded event state", () => {
  it("removes a vanished thread subtree and its live-session evidence", () => {
    let state = createInitialState(runtime, 1);
    state = reduceEvent(state, {
      type: "thread.discovered",
      at: 2,
      thread: { id: "root", nativeStatus: { type: "active", activeFlags: [] } },
    });
    state = reduceEvent(state, {
      type: "thread.discovered",
      at: 3,
      thread: { id: "child", parentThreadId: "root", nativeStatus: { type: "active", activeFlags: [] } },
    });
    state = reduceEvent(state, {
      type: "activity.started",
      at: 4,
      activity: { id: "child-work", agentId: "child", kind: "read", title: "Reading", startedAt: 4 },
    });
    state = reduceEvent(state, {
      type: "request.opened",
      at: 5,
      request: { id: "child-input", agentId: "child", reason: "userInput", title: "Input", openedAt: 5 },
    });
    state = { ...state, selectedAgentId: "child" };

    state = reduceEvent(state, { type: "thread.removed", at: 6, threadId: "root" });

    expect(state.agents).toEqual({});
    expect(state.activities).toEqual([]);
    expect(state.history).toEqual([]);
    expect(state.pendingRequests).toEqual({});
    expect(state.selectedAgentId).toBeUndefined();
  });

  it("caps activity accumulation", () => {
    let state = createInitialState(runtime, 1);
    for (let index = 0; index < 8; index += 1) {
      state = reduceEvent(state, {
        type: "activity.started",
        at: index,
        activity: { id: String(index), agentId: "root", kind: "command", title: "cmd", startedAt: index },
      }, { activities: 3, debug: 2 });
    }
    expect(state.activities.map((activity) => activity.id)).toEqual(["7", "6", "5"]);
  });

  it("routes a subagent delivery to its parent when the protocol only identifies a human-facing message", () => {
    let state = createInitialState(runtime, 1);
    state = reduceEvent(state, {
      type: "thread.discovered",
      at: 2,
      thread: { id: "root", nativeStatus: { type: "active", activeFlags: [] } },
    });
    state = reduceEvent(state, {
      type: "thread.discovered",
      at: 3,
      thread: { id: "child", parentThreadId: "root", nativeStatus: { type: "active", activeFlags: [] } },
    });
    state = reduceEvent(state, {
      type: "history.recorded",
      at: 4,
      history: {
        id: "child-result",
        kind: "delivery",
        actor: { type: "agent", id: "child" },
        recipients: [{ type: "human" }],
        summary: "Delivered final result",
        occurredAt: 4,
        source: "protocol",
      },
    });

    expect(state.history[0]?.recipients).toEqual([{ type: "agent", id: "root" }]);
  });

  it("keeps semantic history separate from low-level activity and bounds it", () => {
    let state = createInitialState(runtime, 1);
    state = reduceEvent(state, {
      type: "activity.started",
      at: 2,
      activity: { id: "cmd", agentId: "root", kind: "command", title: "Running command", startedAt: 2 },
    }, { activities: 3, history: 2, debug: 2 });
    expect(state.history[0]).toMatchObject({
      id: "activity:cmd",
      kind: "work",
      actor: { type: "agent", id: "root" },
      status: "running",
      source: "derived",
    });

    for (let index = 0; index < 3; index += 1) {
      state = reduceEvent(state, {
        type: "history.recorded",
        at: 10 + index,
        history: {
          id: `history-${index}`,
          kind: "decision",
          actor: { type: "agent", id: "root" },
          summary: `Decision ${index}`,
          occurredAt: 10 + index,
          source: "protocol",
        },
      }, { activities: 3, history: 2, debug: 2 });
    }
    expect(state.history.map((item) => item.id)).toEqual(["history-2", "history-1"]);
    expect(state.activities.map((activity) => activity.id)).toEqual(["cmd"]);
  });
});
