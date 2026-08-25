import {
  createInitialState,
  reduceEvent,
  toSnapshot,
} from "./projector.ts";
import type {
  AgentRuntimeEvent,
  ObservatorySnapshot,
  ObservatoryState,
  RuntimeInfo,
} from "./types.ts";

export class ObservatoryStore {
  #state: ObservatoryState;
  #listeners = new Set<(snapshot: ObservatorySnapshot, event: AgentRuntimeEvent) => void>();

  constructor(runtime: RuntimeInfo, now?: number) {
    this.#state = createInitialState(runtime, now);
  }

  apply(event: AgentRuntimeEvent): ObservatorySnapshot {
    this.#state = reduceEvent(this.#state, event);
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot, event);
    return snapshot;
  }

  snapshot(): ObservatorySnapshot {
    return toSnapshot(this.#state);
  }

  subscribe(listener: (snapshot: ObservatorySnapshot, event: AgentRuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
