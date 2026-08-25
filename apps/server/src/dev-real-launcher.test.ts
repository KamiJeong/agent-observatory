import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const launcherPath = join(repositoryRoot, "scripts", "run-dev-real.mjs");
const temporaryDirectories: string[] = [];

function runLauncher(args: string[] = [], providers?: string) {
  const binDirectory = mkdtempSync(join(tmpdir(), "observatory-launcher-"));
  temporaryDirectories.push(binDirectory);
  const fakeBun = join(binDirectory, "bun");
  writeFileSync(fakeBun, [
    "#!/bin/sh",
    "printf '{\"providers\":\"%s\",\"adapter\":\"%s\",\"args\":\"%s\"}\\n' \"$OBSERVATORY_PROVIDERS\" \"$OBSERVATORY_ADAPTER\" \"$*\"",
  ].join("\n"));
  chmodSync(fakeBun, 0o755);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: "1",
    PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
  };
  if (providers === undefined) delete env.OBSERVATORY_PROVIDERS;
  else env.OBSERVATORY_PROVIDERS = providers;
  const result = spawnSync(process.execPath, [launcherPath, ...args], {
    cwd: repositoryRoot,
    env,
    encoding: "utf8",
  });
  const jsonLine = result.stdout.split("\n").find((line) => line.startsWith("{"));
  return { ...result, payload: jsonLine ? JSON.parse(jsonLine) as Record<string, string> : undefined };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("dev:real launcher", () => {
  it("observes Codex and Claude by default", () => {
    const result = runLauncher();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Real Mode providers: codex,claude");
    expect(result.payload).toEqual({ providers: "codex,claude", adapter: "real", args: "run dev" });
  });

  it.each(["codex", "claude", "codex,claude"])("preserves the explicit %s CLI provider override", (providers) => {
    const cliOverride = runLauncher(["--provider", providers, "--no-open"]);
    expect(cliOverride.status).toBe(0);
    expect(cliOverride.payload?.providers).toBe(providers);
  });

  it("preserves an environment provider override", () => {
    const environmentOverride = runLauncher([], "codex");
    expect(environmentOverride.status).toBe(0);
    expect(environmentOverride.payload?.providers).toBe("codex");
  });

  it("normalizes provider order and rejects unsupported providers before starting Bun", () => {
    const normalized = runLauncher([], "claude,codex");
    expect(normalized.status).toBe(0);
    expect(normalized.payload?.providers).toBe("codex,claude");

    const invalid = runLauncher(["--provider", "unknown"]);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("Invalid Real Mode provider selection");
    expect(invalid.payload).toBeUndefined();
  });
});
