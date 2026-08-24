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
    });
    await adapter.disconnect();
  });
});
