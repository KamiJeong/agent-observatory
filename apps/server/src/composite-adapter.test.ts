import { describe, expect, it } from "vitest";
import {
  ObservatoryStore,
  type AgentRuntimeAdapter,
  type AgentRuntimeEvent,
  type DiscoveryOptions,
  type ReadThreadOptions,
  type RuntimeInfo,
  type RuntimeProvider,
  type ThreadSnapshot,
} from "@observatory/core";
import { CompositeRuntimeAdapter } from "./composite-adapter.ts";

class TestRuntimeAdapter implements AgentRuntimeAdapter {
  readonly mode: RuntimeProvider;
  #listeners = new Set<(event: AgentRuntimeEvent) => void>();

  constructor(
    readonly provider: RuntimeProvider,
    readonly shouldFail = false,
  ) {
    this.mode = provider;
  }

  async connect(): Promise<void> {
    if (this.shouldFail) throw new Error(`${this.provider} unavailable`);
  }

  async disconnect(): Promise<void> {}

  async listThreads(_options?: DiscoveryOptions): Promise<ThreadSnapshot[]> {
    return [this.thread("root")];
  }

  async listLoadedThreads(): Promise<string[]> {
    return ["root"];
  }

  async readThread(threadId: string, _options?: ReadThreadOptions): Promise<ThreadSnapshot> {
    return this.thread(threadId);
  }

  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  runtimeInfo(): RuntimeInfo {
    return {
      adapter: this.mode,
      provider: this.provider,
      observatoryVersion: "test",
      experimentalApi: false,
      discoveryStrategy: "compatibility",
    };
  }

  emit(event: AgentRuntimeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  thread(id: string): ThreadSnapshot {
    return { id, nativeStatus: { type: "idle" } };
  }
}

describe("CompositeRuntimeAdapter", () => {
  it("merges providers without ID collisions", async () => {
    const codex = new TestRuntimeAdapter("codex");
    const claude = new TestRuntimeAdapter("claude");
    const composite = new CompositeRuntimeAdapter([codex, claude]);

    await composite.connect();

    await expect(composite.listLoadedThreads()).resolves.toEqual(["codex:root", "claude:root"]);
    await expect(composite.listThreads()).resolves.toMatchObject([
      { id: "codex:root", provider: "codex" },
      { id: "claude:root", provider: "claude" },
    ]);
    await expect(composite.readThread("claude:root")).resolves.toMatchObject({
      id: "claude:root",
      provider: "claude",
    });
  });

  it("keeps healthy provider state when another provider fails", async () => {
    const codex = new TestRuntimeAdapter("codex");
    const claude = new TestRuntimeAdapter("claude", true);
    const composite = new CompositeRuntimeAdapter([codex, claude]);
    const store = new ObservatoryStore(composite.runtimeInfo(), 1);
    composite.subscribe((event) => store.apply(event));

    await expect(composite.connect()).resolves.toBeUndefined();
    codex.emit({
      type: "thread.discovered",
      at: 2,
      thread: codex.thread("root"),
    });

    expect(store.snapshot().agents["codex:root"]).toMatchObject({ provider: "codex" });
    expect(store.snapshot().providerConnections).toMatchObject({
      codex: { phase: "connected" },
      claude: { phase: "disconnected", message: "claude unavailable" },
    });
    expect(store.snapshot().connection.phase).toBe("connected");
  });

  it("tracks provider reconnects independently", async () => {
    const codex = new TestRuntimeAdapter("codex");
    const claude = new TestRuntimeAdapter("claude");
    const composite = new CompositeRuntimeAdapter([codex, claude]);
    const store = new ObservatoryStore(composite.runtimeInfo(), 1);
    composite.subscribe((event) => store.apply(event));
    await composite.connect();

    claude.emit({
      type: "connection.changed",
      at: 3,
      connection: { phase: "reconnecting", attempt: 2, nextRetryAt: 10 },
    });

    expect(store.snapshot().providerConnections.claude).toEqual({
      phase: "reconnecting",
      attempt: 2,
      nextRetryAt: 10,
    });
    expect(store.snapshot().providerConnections.codex?.phase).toBe("connected");
    expect(store.snapshot().connection.phase).toBe("connected");

    claude.emit({
      type: "connection.changed",
      at: 4,
      connection: { phase: "connected", attempt: 2 },
    });
    expect(store.snapshot().providerConnections.claude?.phase).toBe("connected");
  });
});
