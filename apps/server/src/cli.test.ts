import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { browserCommand, resolveRuntimeConfiguration, selectAvailablePort } from "../../../bin/cli-runtime.js";

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
  it("defaults to Real Mode with Codex and Claude while preserving explicit Mock Mode", () => {
    expect(resolveRuntimeConfiguration({})).toEqual({ adapter: "real", providers: "codex,claude", cwd: "all" });
    expect(resolveRuntimeConfiguration({ real: true })).toEqual({ adapter: "real", providers: "codex,claude", cwd: "all" });
    expect(resolveRuntimeConfiguration({ provider: "codex" })).toEqual({ adapter: "real", providers: "codex", cwd: "all" });
    expect(resolveRuntimeConfiguration({ cwd: "/projects/selected" })).toEqual({
      adapter: "real",
      providers: "codex,claude",
      cwd: "/projects/selected",
    });
    expect(resolveRuntimeConfiguration({ mock: true })).toEqual({ adapter: "mock", providers: undefined, cwd: undefined });
    expect(resolveRuntimeConfiguration({ scenario: "demo" })).toEqual({ adapter: "mock", providers: undefined, cwd: undefined });
    expect(() => resolveRuntimeConfiguration({ real: true, mock: true })).toThrow("Use either --real or --mock");
    expect(() => resolveRuntimeConfiguration({ real: true, scenario: "demo" })).toThrow("scenarios run in Mock Mode");
  });

  it("falls back from an occupied preferred port but honors an explicit port", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolve);
    });
    const address = occupied.address();
    const occupiedPort = typeof address === "object" && address ? address.port : 0;
    try {
      await expect(selectAvailablePort(occupiedPort)).resolves.not.toBe(occupiedPort);
      await expect(selectAvailablePort(occupiedPort, { allowFallback: false }))
        .rejects.toThrow(`Port ${occupiedPort} is already in use.`);
    } finally {
      await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("uses the selected fallback port for both the API and web bootstrap", async () => {
    const occupied = createServer((_request, response) => response.end("occupied"));
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolve);
    });
    const address = occupied.address();
    const occupiedPort = typeof address === "object" && address ? address.port : 0;
    const child = spawn(process.execPath, [cliPath, "--mock", "--no-open"], {
      cwd: repositoryRoot,
      env: { ...process.env, OBSERVATORY_PORT: String(occupiedPort) },
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
      await waitUntil(() => /Agent Observatory server: http:\/\/127\.0\.0\.1:\d+\/\?token=/.test(stdout));
      const bootstrapUrl = stdout.match(/Agent Observatory server: (http:\/\/[^\s]+)/)?.[1];
      expect(bootstrapUrl).toBeTruthy();
      const parsed = new URL(bootstrapUrl ?? "http://127.0.0.1");
      expect(Number(parsed.port)).not.toBe(occupiedPort);
      expect(stderr).toContain(`Port ${occupiedPort} is already in use; using ${parsed.port} instead.`);

      const bootstrap = await fetch(parsed, { redirect: "manual" });
      const sessionCookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      const origin = parsed.origin;
      const [web, snapshot] = await Promise.all([
        fetch(origin, { headers: { cookie: sessionCookie } }),
        fetch(`${origin}/api/snapshot`, { headers: { cookie: sessionCookie } }),
      ]);
      expect(web.status).toBe(200);
      expect(await web.text()).toContain("Agent Observatory");
      expect(snapshot.status).toBe(200);
      expect((await snapshot.json()).runtime.adapter).toBe("mock");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
      await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
    }
  }, 10_000);

  it("opens WSL URLs with the Windows browser bridge", () => {
    const target = "http://127.0.0.1:4318/?token=test";
    expect(browserCommand("linux", { WSL_INTEROP: "/run/WSL/interop" }, target)).toEqual({
      file: "cmd.exe",
      args: ["/c", "start", "", target],
    });
    expect(browserCommand("linux", {}, target)).toEqual({ file: "xdg-open", args: [target] });
    expect(browserCommand("darwin", {}, target)).toEqual({ file: "open", args: [target] });
  });

  it("starts the combined Codex and Claude runtime by default", async () => {
    const port = await findFreePort();
    const child = spawn(process.execPath, [cliPath, "--port", String(port), "--no-open"], {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    try {
      await waitUntil(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
        } catch {
          return false;
        }
      });
      await waitUntil(() => /\?token=[A-Za-z0-9_-]{40,}/.test(stdout));
      const token = stdout.match(/\?token=([A-Za-z0-9_-]{40,})/)?.[1] ?? "";
      const bootstrap = await fetch(`http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`, {
        redirect: "manual",
      });
      const sessionCookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      const response = await fetch(`http://127.0.0.1:${port}/api/snapshot`, {
        headers: { cookie: sessionCookie },
      });
      const snapshot = await response.json();

      expect(snapshot.runtime.adapter).toBe("composite");
      expect(snapshot.runtime.providers.map((provider: { provider: string }) => provider.provider))
        .toEqual(["codex", "claude"]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
    }
  }, 10_000);

  it("documents provider selection and rejects unsupported providers", () => {
    const help = spawnSync(process.execPath, [cliPath, "--help"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--mock");
    expect(help.stdout).toContain("--provider <name>");
    expect(help.stdout).toContain("codex, claude, or all (default: all)");
    expect(help.stdout).toContain("--scenario demo");

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
      "--mock",
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
