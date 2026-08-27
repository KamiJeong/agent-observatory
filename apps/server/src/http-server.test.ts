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
import { WebSocket, type WebSocketServer } from "ws";
import {
  createObservatoryHttpServer,
  isPathWithin,
  OBSERVATORY_SESSION_COOKIE,
} from "./http-server.ts";
import { publicEvent } from "./http/public-payload.ts";
import { LatestSnapshotBroadcaster } from "./http/websocket-server.ts";

const ACCESS_TOKEN = "test-access-token-with-enough-entropy";
const SESSION_COOKIE = `${OBSERVATORY_SESSION_COOKIE}=${encodeURIComponent(ACCESS_TOKEN)}`;

class TestAdapter implements CodexAdapter {
  readonly provider = "mock" as const;
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

  it("coalesces a synchronous event burst into the latest snapshot", async () => {
    const wsBase = baseUrl.replace("http:", "ws:");
    const socket = new WebSocket(`${wsBase}/ws`, {
      origin: baseUrl,
      headers: { cookie: SESSION_COOKIE },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("message", () => resolve());
      socket.once("error", reject);
    });
    const messages: string[] = [];
    socket.on("message", (data) => messages.push(data.toString()));

    for (let index = 0; index < 3; index += 1) {
      adapter.emit({
        type: "thread.discovered",
        at: index + 1,
        thread: { id: `thread-${index}`, nativeStatus: { type: "idle" } },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    socket.close();

    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]!)).toMatchObject({
      type: "snapshot",
      snapshot: {
        revision: 3,
        agents: {
          "thread-0": { id: "thread-0" },
          "thread-1": { id: "thread-1" },
          "thread-2": { id: "thread-2" },
        },
      },
      event: { type: "thread.discovered", thread: { id: "thread-2" } },
    });
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

  it("redacts provider content and unsafe metadata by default", async () => {
    const at = Date.now();
    adapter.emit({
      type: "thread.discovered",
      provider: "claude",
      at,
      thread: {
        provider: "claude",
        id: "claude:session",
        nativeStatus: { type: "active", activeFlags: [] },
        source: { agentKind: "subagent", prompt: "secret delegated prompt" },
      },
    });
    adapter.emit({
      type: "activity.started",
      provider: "claude",
      at,
      activity: {
        provider: "claude",
        id: "claude:activity",
        agentId: "claude:session",
        kind: "command",
        title: "Running command",
        detail: "secret command",
        startedAt: at,
        metadata: { nativeTool: "Bash", toolInput: "secret input" },
      },
    });
    adapter.emit({
      type: "history.recorded",
      provider: "claude",
      at,
      history: {
        provider: "claude",
        id: "claude:history",
        kind: "request",
        actor: { type: "human" },
        summary: "User request",
        content: "secret prompt",
        occurredAt: at,
        source: "transcript",
      },
    });
    adapter.emit({
      type: "request.opened",
      provider: "claude",
      at,
      request: {
        provider: "claude",
        id: "claude:request",
        agentId: "claude:session",
        reason: "userInput",
        title: "Waiting for input",
        detail: "secret question",
        openedAt: at,
      },
    });

    const response = await fetch(`${baseUrl}/api/snapshot`, {
      headers: { cookie: SESSION_COOKIE },
    });
    const snapshot = await response.json() as {
      agents: Record<string, Record<string, unknown>>;
      activities: Array<Record<string, unknown>>;
      history: Array<Record<string, unknown>>;
      pendingRequests: Record<string, Record<string, unknown>>;
    };
    expect(snapshot.agents["claude:session"]).not.toHaveProperty("source");
    expect(snapshot.activities[0]).not.toHaveProperty("detail");
    expect(snapshot.activities[0]?.metadata).toEqual({ nativeTool: "Bash" });
    expect(snapshot.history[0]).not.toHaveProperty("content");
    expect(snapshot.pendingRequests["claude:request"]).not.toHaveProperty("detail");
    expect(publicEvent({
      type: "thread.discovered",
      provider: "claude",
      at,
      thread: {
        provider: "claude",
        id: "claude:child",
        nativeStatus: { type: "notLoaded" },
        source: { prompt: "secret delegated prompt" },
      },
    })).toEqual(expect.objectContaining({
      thread: expect.not.objectContaining({ source: expect.anything() }),
    }));
  });
});

describe("latest snapshot broadcaster", () => {
  it("does not serialize snapshots without connected clients", async () => {
    const webSockets = { clients: new Set<WebSocket>() } as unknown as WebSocketServer;
    const broadcaster = new LatestSnapshotBroadcaster(webSockets);
    let serialized = 0;

    broadcaster.publish(() => {
      serialized += 1;
      return "unused";
    });
    await Promise.resolve();

    expect(serialized).toBe(0);
  });

  it("coalesces bursts and retains only the latest snapshot for a slow client", async () => {
    const sent: string[] = [];
    const completions: Array<(error?: Error) => void> = [];
    const client = {
      readyState: WebSocket.OPEN,
      send(payload: string, callback: (error?: Error) => void) {
        sent.push(payload);
        completions.push(callback);
      },
    } as unknown as WebSocket;
    const webSockets = { clients: new Set([client]) } as unknown as WebSocketServer;
    const broadcaster = new LatestSnapshotBroadcaster(webSockets);

    broadcaster.publish(() => "snapshot-1");
    broadcaster.publish(() => "snapshot-2");
    broadcaster.publish(() => "snapshot-3");
    await Promise.resolve();
    expect(sent).toEqual(["snapshot-3"]);

    broadcaster.publish(() => "snapshot-4");
    broadcaster.publish(() => "snapshot-5");
    await Promise.resolve();
    expect(sent).toEqual(["snapshot-3"]);

    completions.shift()?.();
    expect(sent).toEqual(["snapshot-3", "snapshot-5"]);
  });
});

describe("static path containment", () => {
  it("accepts Windows descendants and rejects sibling-prefix paths", () => {
    expect(isPathWithin("C:\\repo\\dist", "C:\\repo\\dist\\assets\\app.js", win32)).toBe(true);
    expect(isPathWithin("C:\\repo\\dist", "C:\\repo\\dist-evil\\app.js", win32)).toBe(false);
    expect(isPathWithin("C:\\repo\\dist", "C:\\repo\\secret.txt", win32)).toBe(false);
  });
});
