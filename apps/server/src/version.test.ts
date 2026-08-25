import { describe, expect, it } from "vitest";
import packageManifest from "../../../package.json";
import { ClaudeCodeAdapter } from "./claude-adapter.ts";
import { RealCodexAdapter } from "./codex-adapter.ts";
import { MockCodexAdapter } from "./mock-adapter.ts";
import { SharedStateCodexAdapter } from "./shared-state-adapter.ts";
import { OBSERVATORY_VERSION } from "./version.ts";

describe("Observatory version", () => {
  it("uses the published package version across runtime adapters", () => {
    expect(OBSERVATORY_VERSION).toBe(packageManifest.version);
    expect([
      new RealCodexAdapter(),
      new SharedStateCodexAdapter(),
      new ClaudeCodeAdapter({ environment: {} }),
      new MockCodexAdapter(),
    ].map((adapter) => adapter.runtimeInfo().observatoryVersion)).toEqual([
      packageManifest.version,
      packageManifest.version,
      packageManifest.version,
      packageManifest.version,
    ]);
  });
});
