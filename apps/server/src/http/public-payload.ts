import type { CodexRuntimeEvent, ObservatorySnapshot } from "@observatory/core";

export function publicSnapshot(snapshot: ObservatorySnapshot): ObservatorySnapshot {
  return { ...snapshot, debug: snapshot.debug.map(({ payload: _payload, ...entry }) => entry) };
}

export function publicEvent(event: CodexRuntimeEvent): CodexRuntimeEvent {
  if (event.type !== "debug") return event;
  const { payload: _payload, ...entry } = event.entry;
  return { ...event, entry };
}
