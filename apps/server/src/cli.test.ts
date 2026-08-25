import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cliPath = fileURLToPath(new URL("../../../bin/agent-observatory.js", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the Observatory CLI");
}

describe("agent-observatory CLI", () => {
  it("documents provider selection and rejects unsupported providers", () => {
    const help = spawnSync(process.execPath, [cliPath, "--help"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--provider <name>");
    expect(help.stdout).toContain("--real --provider all");

    const invalid = spawnSync(process.execPath, [cliPath, "--real", "--provider", "unknown"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("Invalid provider: unknown. Use codex, claude, or all.");
  });

  it("keeps the server running when the platform browser command is missing", async () => {
    const port = await findFreePort();
    const child = spawn(process.execPath, [
      cliPath,
      "--port",
      String(port),
      "--open",
    ], {
      cwd: repositoryRoot,
      env: { ...process.env, PATH: "/path/without/xdg-open" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    try {
      await waitUntil(async () => {
        if (child.exitCode !== null) return true;
        try {
          return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
        } catch {
          return false;
        }
      });
      await waitUntil(() => stderr.includes("Could not open a browser automatically"));
      await waitUntil(() => /\?token=[A-Za-z0-9_-]{40,}/.test(stdout));

      expect(child.exitCode).toBeNull();
      expect(stderr).toMatch(/\?token=[A-Za-z0-9_-]{40,}/);
      const health = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(health.ok).toBe(true);
      const token = stdout.match(/\?token=([A-Za-z0-9_-]{40,})/)?.[1];
      expect(token).toBeTruthy();
      const unauthorized = await fetch(`http://127.0.0.1:${port}/api/snapshot`);
      expect(unauthorized.status).toBe(401);
      const bootstrap = await fetch(`http://127.0.0.1:${port}/?token=${encodeURIComponent(token ?? "")}`, {
        redirect: "manual",
      });
      expect(bootstrap.status).toBe(302);
      expect(bootstrap.headers.get("location")).toBe("/");
      const sessionCookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
      expect(sessionCookie).toMatch(/^observatory_session=/);
      const snapshot = await fetch(`http://127.0.0.1:${port}/api/snapshot`, {
        headers: { cookie: sessionCookie ?? "" },
      });
      expect(snapshot.status).toBe(200);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
    }
  }, 10_000);
});
