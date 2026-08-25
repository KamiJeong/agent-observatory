import { describe, expect, it } from "vitest";
import type { AgentNode, ObservatorySnapshot } from "@observatory/core";
import { layoutGraph } from "./graph-layout.ts";

function agent(id: string, parentId?: string): AgentNode {
  return {
    provider: "mock",
    id,
    threadId: id,
    ...(parentId ? { parentId } : {}),
    status: "working",
    waitingReasons: [],
    recentActivityIds: [],
    children: [],
  };
}

function snapshotWithLargeTeam(): ObservatorySnapshot {
  const childIds = Array.from({ length: 36 }, (_, index) => `worker-${index + 1}`);
  const agents = Object.fromEntries([
    ["lead", { ...agent("lead"), children: childIds }],
    ...childIds.map((id) => [id, agent(id, "lead")] as const),
  ]);
  return {
    agents,
    activities: [],
    history: [],
    pendingRequests: {},
    connection: { phase: "connected", attempt: 0 },
    providerConnections: { mock: { phase: "connected", attempt: 0 } },
    runtime: { adapter: "mock", observatoryVersion: "test", experimentalApi: false, discoveryStrategy: "mock" },
    debug: [],
    startedAt: 0,
    revision: 1,
    roots: ["lead"],
    edges: [
      ...childIds.map((id) => ({
        id: `lead->${id}`, source: "lead", target: id, kind: "spawn" as const, evidenceSource: "mock" as const,
      })),
      {
        id: "message-cycle", source: "worker-2", target: "worker-1", kind: "message", evidenceSource: "hook",
      },
      {
        id: "message-self", source: "worker-3", target: "worker-3", kind: "message", evidenceSource: "otel",
      },
    ],
  };
}

describe("graph layout", () => {
  it("keeps a 35+ agent spawn topology compact and ignores secondary cycles", () => {
    const snapshot = snapshotWithLargeTeam();
    const layout = layoutGraph(snapshot);
    const spawnOnly = layoutGraph({ ...snapshot, edges: snapshot.edges.filter((edge) => edge.kind === "spawn") });

    expect(Object.keys(layout.positions)).toHaveLength(37);
    expect(layout.width).toBeLessThan(2_000);
    expect(layout.positions).toEqual(spawnOnly.positions);
  });
});
