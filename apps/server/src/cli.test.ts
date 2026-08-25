import { spawn } from "node:child_process";
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
      const snapshot = await fetch(`http://127.0.0.1:${port}/api/snapshot`, {
        headers: { authorization: `Bearer ${token}` },
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
