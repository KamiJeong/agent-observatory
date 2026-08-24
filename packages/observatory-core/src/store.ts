import {
  createInitialState,
  reduceEvent,
  toSnapshot,
} from "./projector.ts";
import type {
  CodexRuntimeEvent,
  ObservatorySnapshot,
  ObservatoryState,
  RuntimeInfo,
} from "./types.ts";

export class ObservatoryStore {
  #state: ObservatoryState;
  #listeners = new Set<(snapshot: ObservatorySnapshot, event: CodexRuntimeEvent) => void>();

  constructor(runtime: RuntimeInfo, now?: number) {
    this.#state = createInitialState(runtime, now);
  }

  apply(event: CodexRuntimeEvent): ObservatorySnapshot {
    this.#state = reduceEvent(this.#state, event);
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot, event);
    return snapshot;
  }

  snapshot(): ObservatorySnapshot {
    return toSnapshot(this.#state);
  }

  subscribe(listener: (snapshot: ObservatorySnapshot, event: CodexRuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
