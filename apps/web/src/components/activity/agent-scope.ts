import type { HistoryActor, HistoryEvent, ObservatorySnapshot } from "@observatory/core";

export function agentBranchIds(snapshot: ObservatorySnapshot, selectedId?: string): Set<string> {
  const ids = new Set<string>();
  if (!selectedId || !snapshot.agents[selectedId]) return ids;

  const pending = [selectedId];
  while (pending.length > 0) {
    const id = pending.pop();
    if (!id || ids.has(id)) continue;
    ids.add(id);
    for (const childId of snapshot.agents[id]?.children ?? []) pending.push(childId);
  }
  return ids;
}

function actorIsInBranch(actor: HistoryActor, branchIds: Set<string>): boolean {
  return actor.type === "agent" && Boolean(actor.id && branchIds.has(actor.id));
}

export function historyEventIsInBranch(event: HistoryEvent, branchIds: Set<string>): boolean {
  return actorIsInBranch(event.actor, branchIds)
    || (event.recipients ?? []).some((recipient) => actorIsInBranch(recipient, branchIds));
}
