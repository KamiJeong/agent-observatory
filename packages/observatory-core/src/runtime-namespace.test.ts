import { describe, expect, it } from "vitest";
import {
  namespaceRuntimeEvent,
  namespaceRuntimeId,
  stripRuntimeIdNamespace,
} from "./runtime-namespace.ts";

describe("runtime namespaces", () => {
  it("prevents equal provider-local IDs from colliding", () => {
    expect(namespaceRuntimeId("codex", "root")).toBe("codex:root");
    expect(namespaceRuntimeId("claude", "root")).toBe("claude:root");
    expect(namespaceRuntimeId("codex", "codex:root")).toBe("codex:root");
    expect(stripRuntimeIdNamespace("codex", "codex:root")).toBe("root");
    expect(stripRuntimeIdNamespace("claude", "codex:root")).toBeUndefined();
  });

  it("namespaces nested event identifiers and tags evidence", () => {
    const event = namespaceRuntimeEvent("claude", {
      type: "activity.started",
      at: 1,
      activity: {
        id: "tool-1",
        agentId: "root",
        kind: "tool",
        title: "Read",
        startedAt: 1,
      },
    });

    expect(event).toMatchObject({
      provider: "claude",
      activity: {
        provider: "claude",
        id: "claude:tool-1",
        agentId: "claude:root",
      },
    });
  });
});
