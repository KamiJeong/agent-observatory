import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { win32 } from "node:path";
import type {
  CodexAdapter,
  CodexRuntimeEvent,
  DiscoveryOptions,
  ReadThreadOptions,
  RuntimeInfo,
  ThreadSnapshot,
} from "@observatory/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  createObservatoryHttpServer,
  isPathWithin,
  OBSERVATORY_SESSION_COOKIE,
} from "./http-server.ts";

const ACCESS_TOKEN = "test-access-token-with-enough-entropy";
const SESSION_COOKIE = `${OBSERVATORY_SESSION_COOKIE}=${encodeURIComponent(ACCESS_TOKEN)}`;

class TestAdapter implements CodexAdapter {
  readonly mode = "mock" as const;
  connectCalls = 0;
  #listeners = new Set<(event: CodexRuntimeEvent) => void>();
  #connectResult: Promise<void> = Promise.resolve();

  setConnectResult(result: Promise<void>): void {
    this.#connectResult = result;
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    await this.#connectResult;
  }

  async disconnect(): Promise<void> {}
  async listThreads(_options?: DiscoveryOptions): Promise<ThreadSnapshot[]> { return []; }
  async listLoadedThreads(): Promise<string[]> { return []; }
  async readThread(threadId: string, _options?: ReadThreadOptions): Promise<ThreadSnapshot> {
    throw new Error(`Unknown thread ${threadId}`);
  }
  subscribe(listener: (event: CodexRuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  runtimeInfo(): RuntimeInfo {
    return {
      adapter: "mock",
      observatoryVersion: "test",
      experimentalApi: false,
      discoveryStrategy: "mock",
    };
  }
  emit(event: CodexRuntimeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

function websocketStatus(url: string, origin?: string, cookie?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      ...(origin ? { origin } : {}),
      ...(cookie ? { headers: { cookie } } : {}),
    });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once("open", () => {
      socket.close();
      reject(new Error("WebSocket unexpectedly opened"));
    });
    socket.once("error", () => undefined);
  });
}

describe("Observatory HTTP trust boundary", () => {
  let adapter: TestAdapter;
  let instance: ReturnType<typeof createObservatoryHttpServer>;
  let baseUrl: string;

  beforeEach(async () => {
    adapter = new TestAdapter();
    instance = createObservatoryHttpServer({
      accessToken: ACCESS_TOKEN,
      adapter,
      webDist: "/definitely/not/a/web/build",
      devWebOrigins: ["http://127.0.0.1:4318", "http://localhost:4318"],
    });
    await new Promise<void>((resolve, reject) => {
      instance.server.once("error", reject);
      instance.server.listen(0, "127.0.0.1", resolve);
    });
    const port = (instance.server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    for (const client of instance.webSockets.clients) client.terminate();
    await new Promise<void>((resolve) => instance.webSockets.close(() => resolve()));
    await new Promise<void>((resolve, reject) => instance.server.close((error) => error ? reject(error) : resolve()));
  });

  it("bootstraps an HttpOnly same-site session cookie", async () => {
    const invalid = await fetch(`${baseUrl}/?token=invalid`, { redirect: "manual" });
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("set-cookie")).toBeNull();

    const bootstrap = await fetch(`${baseUrl}/?token=${encodeURIComponent(ACCESS_TOKEN)}`, { redirect: "manual" });
    expect(bootstrap.status).toBe(302);
    expect(bootstrap.headers.get("location")).toBe("http://127.0.0.1:4318");
    expect(bootstrap.headers.get("set-cookie")).toBe(
      `${SESSION_COOKIE}; HttpOnly; SameSite=Strict; Path=/`,
    );
    expect(bootstrap.headers.get("cache-control")).toBe("no-store");
    expect(bootstrap.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("requires the session cookie and rejects cross-origin API requests", async () => {
    const missing = await fetch(`${baseUrl}/api/snapshot`);
    expect(missing.status).toBe(401);
    const legacyBearer = await fetch(`${baseUrl}/api/snapshot`, {
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    expect(legacyBearer.status).toBe(401);
    const retryWithoutToken = await fetch(`${baseUrl}/api/retry`, { method: "POST" });
    expect(retryWithoutToken.status).toBe(401);
    expect(adapter.connectCalls).toBe(0);

    const hostile = await fetch(`${baseUrl}/api/snapshot`, {
      headers: { cookie: SESSION_COOKIE, origin: "https://attacker.example" },
    });
    expect(hostile.status).toBe(403);

    const allowed = await fetch(`${baseUrl}/api/snapshot`, {
      headers: { cookie: SESSION_COOKIE, origin: baseUrl },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("cache-control")).toBe("no-store");
    expect(allowed.headers.get("x-content-type-options")).toBe("nosniff");
    expect(allowed.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");

    const localhostDevOrigin = await fetch(`${baseUrl}/api/snapshot`, {
      headers: { cookie: SESSION_COOKIE, origin: "http://localhost:4318" },
    });
    expect(localhostDevOrigin.status).toBe(200);
  });

  it("rejects a non-loopback Host header", async () => {
    const port = (instance.server.address() as AddressInfo).port;
    const status = await new Promise<number>((resolve, reject) => {
      const outgoing = request({
        hostname: "127.0.0.1",
        port,
        path: "/api/health",
        headers: { host: `attacker.example:${port}` },
      }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      outgoing.once("error", reject);
      outgoing.end();
    });
    expect(status).toBe(403);
  });

  it("requires the session cookie and same-origin checks during WebSocket upgrade", async () => {
    const wsBase = baseUrl.replace("http:", "ws:");
    await expect(websocketStatus(`${wsBase}/ws`, baseUrl)).resolves.toBe(401);
    await expect(websocketStatus(`${wsBase}/ws`, undefined, SESSION_COOKIE)).resolves.toBe(403);
    await expect(websocketStatus(`${wsBase}/ws?token=${encodeURIComponent(ACCESS_TOKEN)}`, baseUrl)).resolves.toBe(401);
    await expect(websocketStatus(`${wsBase}/ws`, "https://attacker.example", SESSION_COOKIE)).resolves.toBe(403);
    const port = (instance.server.address() as AddressInfo).port;
    const hostileHost = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`${wsBase}/ws`, {
        origin: baseUrl,
        headers: { cookie: SESSION_COOKIE, host: `attacker.example:${port}` },
      });
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      socket.once("open", () => {
        socket.close();
        reject(new Error("WebSocket unexpectedly opened"));
      });
      socket.once("error", () => undefined);
    });
    expect(hostileHost).toBe(403);

    const message = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(`${wsBase}/ws`, {
        origin: baseUrl,
        headers: { cookie: SESSION_COOKIE },
      });
      socket.once("message", (data) => {
        resolve(data.toString());
        socket.close();
      });
      socket.once("error", reject);
    });
    expect(JSON.parse(message)).toMatchObject({ type: "snapshot" });
  });

  it("closes WebSockets that exceed the small inbound payload limit", async () => {
    const wsBase = baseUrl.replace("http:", "ws:");
    const closeCode = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`${wsBase}/ws`, {
        origin: baseUrl,
        headers: { cookie: SESSION_COOKIE },
      });
      socket.once("open", () => socket.send("x".repeat(8 * 1024 + 1)));
      socket.once("close", resolve);
      socket.once("error", reject);
    });
    expect(closeCode).toBe(1009);
  });

  it("coalesces concurrent retries and rate limits repeated requests", async () => {
    let finishConnect: (() => void) | undefined;
    adapter.setConnectResult(new Promise<void>((resolve) => { finishConnect = resolve; }));
    const headers = { cookie: SESSION_COOKIE, origin: baseUrl };
    const first = await fetch(`${baseUrl}/api/retry`, { method: "POST", headers });
    const limited = await fetch(`${baseUrl}/api/retry`, { method: "POST", headers });
    expect(first.status).toBe(202);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("1");
    expect(adapter.connectCalls).toBe(1);
    finishConnect?.();
  });

  it("uses one adapter connection for concurrent connect requests", async () => {
    let finishConnect: (() => void) | undefined;
    adapter.setConnectResult(new Promise<void>((resolve) => { finishConnect = resolve; }));
    const first = instance.connectAdapter();
    const concurrent = instance.connectAdapter();
    expect(adapter.connectCalls).toBe(1);
    finishConnect?.();
    await Promise.all([first, concurrent]);
  });

  it("never serializes raw debug payloads to browser snapshots", async () => {
    adapter.emit({
      type: "debug",
      at: Date.now(),
      entry: {
        id: "secret-debug",
        at: Date.now(),
        direction: "in",
        category: "protocol",
        summary: "redacted",
        payload: { command: "secret command", token: "secret token" },
      },
    });
    const response = await fetch(`${baseUrl}/api/snapshot`, {
      headers: { cookie: SESSION_COOKIE },
    });
    const snapshot = await response.json() as { debug: Array<Record<string, unknown>> };
    expect(snapshot.debug[0]).not.toHaveProperty("payload");
  });
});

describe("static path containment", () => {
  it("accepts Windows descendants and rejects sibling-prefix paths", () => {
    expect(isPathWithin("C:\\repo\\dist", "C:\\repo\\dist\\assets\\app.js", win32)).toBe(true);
    expect(isPathWithin("C:\\repo\\dist", "C:\\repo\\dist-evil\\app.js", win32)).toBe(false);
    expect(isPathWithin("C:\\repo\\dist", "C:\\repo\\secret.txt", win32)).toBe(false);
  });
});
