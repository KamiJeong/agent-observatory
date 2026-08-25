import { afterEach, describe, expect, it, vi } from "vitest";
import { ObservatoryStore } from "@observatory/core";
import { MockCodexAdapter } from "./mock-adapter.ts";

describe("mock adapter integration", () => {
  afterEach(() => vi.useRealTimers());

  it("projects spawn, completion, and waiting updates without refresh", async () => {
    vi.useFakeTimers();
    const adapter = new MockCodexAdapter("a");
    const store = new ObservatoryStore(adapter.runtimeInfo(), Date.now());
    adapter.subscribe((event) => store.apply(event));
    for (const thread of await adapter.listThreads()) {
      store.apply({ type: "thread.discovered", at: Date.now(), thread });
    }
    await adapter.connect();
    await vi.advanceTimersByTimeAsync(5_200);
    const snapshot = store.snapshot();
    expect(snapshot.agents["mock-researcher"]?.status).toBe("completed");
    expect(snapshot.agents["mock-implementer"]?.status).toBe("working");
    expect(snapshot.agents["mock-tester"]?.status).toBe("waiting");
    expect(snapshot.edges).toContainEqual({
      id: "mock-main->mock-tester",
      source: "mock-main",
      target: "mock-tester",
      kind: "spawn",
      evidenceSource: "derived",
    });
    await adapter.disconnect();
  });

  it("provides a deterministic mixed-provider demo without private session data", async () => {
    const adapter = new MockCodexAdapter("demo");
    const store = new ObservatoryStore(adapter.runtimeInfo(), Date.now());
    adapter.subscribe((event) => store.apply(event));

    await adapter.connect();
    const snapshot = store.snapshot();

    expect(new Set(Object.values(snapshot.agents).map((agent) => agent.provider))).toEqual(new Set(["codex", "claude"]));
    expect(snapshot.providerConnections).toMatchObject({
      codex: { phase: "connected" },
      claude: { phase: "connected" },
    });
    expect(snapshot.agents["codex:demo-tester"]).toMatchObject({ status: "waiting", waitingReasons: ["approval"] });
    expect(snapshot.agents["claude:demo-researcher"]?.status).toBe("completed");
    expect(snapshot.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "codex:demo-orchestrator", target: "claude:demo-lead", kind: "handoff" }),
      expect.objectContaining({ source: "claude:demo-lead", target: "claude:demo-reviewer", kind: "task" }),
      expect.objectContaining({ source: "claude:demo-reviewer", target: "codex:demo-builder", kind: "message" }),
    ]));
    expect(JSON.stringify(snapshot)).not.toContain("/home/");
    await adapter.disconnect();
  });
});
