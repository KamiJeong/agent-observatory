import type {
  AgentRuntimeAdapter,
  AgentRuntimeEvent,
  ConnectionState,
  DiscoveryOptions,
  ProviderRuntimeInfo,
  ReadThreadOptions,
  RuntimeInfo,
  RuntimeProvider,
  ThreadSnapshot,
} from "@observatory/core";
import {
  namespaceRuntimeEvent,
  namespaceRuntimeId,
  namespaceThreadSnapshot,
  stripRuntimeIdNamespace,
} from "@observatory/core";

interface SelectedAdapter {
  adapter: AgentRuntimeAdapter;
  localRootThreadId?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class CompositeRuntimeAdapter implements AgentRuntimeAdapter {
  readonly provider = "composite" as const;
  readonly mode = "composite" as const;

  #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  #unsubscribers: Array<() => void> = [];
  #connections = new Map<RuntimeProvider, ConnectionState>();
  #runtimes = new Map<RuntimeProvider, RuntimeInfo>();
  #aggregatePhase: ConnectionState["phase"] = "connecting";

  constructor(readonly adapters: readonly AgentRuntimeAdapter[]) {
    const providers = new Set<RuntimeProvider>();
    for (const adapter of adapters) {
      if (providers.has(adapter.provider)) {
        throw new Error(`Duplicate runtime provider: ${adapter.provider}`);
      }
      providers.add(adapter.provider);
      this.#runtimes.set(adapter.provider, { ...adapter.runtimeInfo(), provider: adapter.provider });
      this.#connections.set(adapter.provider, { phase: "connecting", attempt: 0 });
    }
  }

  runtimeInfo(): RuntimeInfo {
    const providers: ProviderRuntimeInfo[] = this.adapters.map((adapter) => {
      const runtime = this.#runtimes.get(adapter.provider) ?? adapter.runtimeInfo();
      return {
        ...runtime,
        provider: adapter.provider,
        connection: this.#connections.get(adapter.provider),
      };
    });
    return {
      adapter: "composite",
      provider: "composite",
      observatoryVersion: providers[0]?.observatoryVersion ?? "unknown",
      experimentalApi: providers.some((runtime) => runtime.experimentalApi),
      discoveryStrategy: "composite",
      providers,
    };
  }

  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async connect(): Promise<void> {
    this.#ensureSubscriptions();
    this.#emit({
      type: "connection.changed",
      at: Date.now(),
      provider: this.provider,
      connection: { phase: "connecting", attempt: 0 },
    });
    const results = await Promise.allSettled(this.adapters.map(async (adapter) => {
      const previous = this.#connections.get(adapter.provider);
      this.#setProviderConnection(adapter.provider, {
        phase: previous?.phase === "connected" ? "reconnecting" : "connecting",
        attempt: (previous?.attempt ?? 0) + 1,
      });
      try {
        await adapter.connect();
        this.#setProviderConnection(adapter.provider, {
          phase: "connected",
          attempt: (this.#connections.get(adapter.provider)?.attempt ?? 1),
        });
      } catch (error) {
        this.#setProviderConnection(adapter.provider, {
          phase: "disconnected",
          attempt: (this.#connections.get(adapter.provider)?.attempt ?? 1),
          message: errorMessage(error),
        });
        throw error;
      }
    }));

    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (results.length > 0 && failures.length === results.length) {
      this.#emitAggregate("disconnected");
      throw new AggregateError(failures, "All runtime providers failed to connect");
    }
    this.#emitAggregate("connected");
  }

  async disconnect(): Promise<void> {
    await Promise.allSettled(this.adapters.map(async (adapter) => {
      try {
        await adapter.disconnect();
      } finally {
        this.#setProviderConnection(adapter.provider, {
          phase: "disconnected",
          attempt: this.#connections.get(adapter.provider)?.attempt ?? 0,
        });
      }
    }));
    this.#emitAggregate("disconnected");
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
  }

  async listThreads(options?: DiscoveryOptions): Promise<ThreadSnapshot[]> {
    const selected = this.#selectAdapters(options?.rootThreadId);
    const results = await Promise.allSettled(selected.map(async ({ adapter, localRootThreadId }) => {
      const threads = await adapter.listThreads(
        localRootThreadId ? { ...options, rootThreadId: localRootThreadId } : options,
      );
      return threads.map((thread) => namespaceThreadSnapshot(adapter.provider, thread));
    }));
    return results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  }

  async listLoadedThreads(): Promise<string[]> {
    const results = await Promise.allSettled(this.adapters.map(async (adapter) => {
      const ids = await adapter.listLoadedThreads();
      return ids.map((id) => namespaceRuntimeId(adapter.provider, id));
    }));
    return results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  }

  async readThread(threadId: string, options?: ReadThreadOptions): Promise<ThreadSnapshot> {
    for (const adapter of this.adapters) {
      const localId = stripRuntimeIdNamespace(adapter.provider, threadId);
      if (localId === undefined) continue;
      return namespaceThreadSnapshot(adapter.provider, await adapter.readThread(localId, options));
    }
    throw new Error(`No runtime provider owns thread: ${threadId}`);
  }

  #selectAdapters(rootThreadId?: string): SelectedAdapter[] {
    if (!rootThreadId) return this.adapters.map((adapter) => ({ adapter }));
    for (const adapter of this.adapters) {
      const localRootThreadId = stripRuntimeIdNamespace(adapter.provider, rootThreadId);
      if (localRootThreadId !== undefined) return [{ adapter, localRootThreadId }];
    }
    return [];
  }

  #ensureSubscriptions(): void {
    if (this.#unsubscribers.length > 0) return;
    this.#unsubscribers = this.adapters.map((adapter) => adapter.subscribe((event) => {
      if (event.type === "connection.changed") {
        this.#setProviderConnection(adapter.provider, event.connection, event.at);
        return;
      }
      if (event.type === "runtime.updated") {
        this.#runtimes.set(adapter.provider, { ...event.runtime, provider: adapter.provider });
        this.#emit({
          type: "runtime.updated",
          at: event.at,
          provider: this.provider,
          runtime: this.runtimeInfo(),
        });
        return;
      }
      this.#emit(namespaceRuntimeEvent(adapter.provider, event));
    }));
  }

  #setProviderConnection(provider: RuntimeProvider, connection: ConnectionState, at = Date.now()): void {
    const previous = this.#connections.get(provider);
    this.#connections.set(provider, connection);
    if (
      previous?.phase !== connection.phase
      || previous.attempt !== connection.attempt
      || previous.message !== connection.message
      || previous.nextRetryAt !== connection.nextRetryAt
    ) {
      this.#emit({ type: "provider.connection.changed", at, provider, connection });
    }
    const phases = Array.from(this.#connections.values(), (state) => state.phase);
    const aggregate = phases.includes("connected")
      ? "connected"
      : phases.includes("reconnecting")
        ? "reconnecting"
        : phases.includes("connecting")
          ? "connecting"
          : "disconnected";
    this.#emitAggregate(aggregate, at);
  }

  #emitAggregate(phase: ConnectionState["phase"], at = Date.now()): void {
    if (this.#aggregatePhase === phase) return;
    this.#aggregatePhase = phase;
    this.#emit({
      type: "connection.changed",
      at,
      provider: this.provider,
      connection: { phase, attempt: 0 },
    });
  }

  #emit(event: AgentRuntimeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
