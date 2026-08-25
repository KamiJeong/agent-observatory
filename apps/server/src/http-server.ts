import { timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path, { extname } from "node:path";
import type { Duplex } from "node:stream";
import { ObservatoryStore, type CodexAdapter, type CodexRuntimeEvent, type ObservatorySnapshot } from "@observatory/core";
import { WebSocketServer, WebSocket } from "ws";

const MAX_WEBSOCKET_PAYLOAD_BYTES = 8 * 1024;
const DEFAULT_RETRY_WINDOW_MS = 1_000;

const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

export interface ObservatoryHttpServerOptions {
  accessToken: string;
  adapter: CodexAdapter;
  webDist: string;
  devWebOrigins?: readonly string[];
  retryWindowMs?: number;
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { ...securityHeaders, "content-type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(body));
}

function requestAuthority(request: IncomingMessage): string | undefined {
  const host = request.headers.host;
  if (!host || Array.isArray(host)) return undefined;
  const port = request.socket.localPort;
  if (!port) return undefined;
  const allowed = port === 80
    ? ["127.0.0.1", "localhost", "127.0.0.1:80", "localhost:80"]
    : [`127.0.0.1:${port}`, `localhost:${port}`];
  return allowed.includes(host) ? new URL(`http://${host}`).origin : undefined;
}

function hasTrustedOrigin(
  request: IncomingMessage,
  authority: string,
  devWebOrigins: readonly string[] = [],
  requireOrigin = false,
): boolean {
  const origin = request.headers.origin;
  if (!origin) return !requireOrigin;
  return origin === authority || devWebOrigins.includes(origin);
}

interface PathOperations {
  isAbsolute(value: string): boolean;
  relative(from: string, to: string): string;
  resolve(...values: string[]): string;
  sep: string;
}

export function isPathWithin(root: string, candidate: string, pathOperations: PathOperations = path): boolean {
  const relativePath = pathOperations.relative(pathOperations.resolve(root), pathOperations.resolve(candidate));
  return relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${pathOperations.sep}`) && !pathOperations.isAbsolute(relativePath);
}

function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const actualBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
}

function publicSnapshot(snapshot: ObservatorySnapshot): ObservatorySnapshot {
  return { ...snapshot, debug: snapshot.debug.map(({ payload: _payload, ...entry }) => entry) };
}

function publicEvent(event: CodexRuntimeEvent): CodexRuntimeEvent {
  if (event.type !== "debug") return event;
  const { payload: _payload, ...entry } = event.entry;
  return { ...event, entry };
}

function rejectUpgrade(socket: Duplex, status: 401 | 403 | 404): void {
  const reason = status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Not Found";
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`);
}

export function createObservatoryHttpServer(options: ObservatoryHttpServerOptions) {
  const { accessToken, adapter, webDist, devWebOrigins } = options;
  const retryWindowMs = options.retryWindowMs ?? DEFAULT_RETRY_WINDOW_MS;
  const store = new ObservatoryStore(adapter.runtimeInfo());
  const clients = new Set<WebSocket>();
  let connectPromise: Promise<void> | undefined;
  let connectedOnce = false;
  let lastRetryAt = Number.NEGATIVE_INFINITY;

  function connectAdapter(): Promise<void> {
    if (connectedOnce) return Promise.resolve();
    if (connectPromise) return connectPromise;
    const pending = adapter.connect()
      .then(() => {
        connectedOnce = true;
      })
      .catch((error) => {
        store.apply({
          type: "connection.changed",
          at: Date.now(),
          connection: {
            phase: "disconnected",
            attempt: 0,
            message: error instanceof Error ? error.message : String(error),
          },
        });
        throw error;
      })
      .finally(() => {
        if (connectPromise === pending) connectPromise = undefined;
      });
    connectPromise = pending;
    return pending;
  }

  function retryAllowed(): boolean {
    const now = Date.now();
    if (now - lastRetryAt < retryWindowMs) return false;
    lastRetryAt = now;
    return true;
  }

  adapter.subscribe((event) => {
    if (event.type === "connection.changed") {
      if (event.connection.phase === "connected") connectedOnce = true;
      if (event.connection.phase === "disconnected" || event.connection.phase === "reconnecting") connectedOnce = false;
    }
    store.apply(event);
  });
  store.subscribe((snapshot, event) => {
    const payload = JSON.stringify({ type: "snapshot", snapshot: publicSnapshot(snapshot), event: publicEvent(event) });
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  });

  const server = createServer((request, response) => {
    const authority = requestAuthority(request);
    if (!authority || !hasTrustedOrigin(request, authority, devWebOrigins)) {
      sendJson(response, 403, { error: "Forbidden" });
      return;
    }
    const requestUrl = new URL(request.url ?? "/", authority);
    if (requestUrl.pathname === "/api/health") {
      sendJson(response, 200, { ok: true, connection: store.snapshot().connection });
      return;
    }
    if (requestUrl.pathname === "/api/snapshot") {
      if (!tokenMatches(bearerToken(request), accessToken)) {
        sendJson(response, 401, { error: "Unauthorized" }, { "www-authenticate": "Bearer" });
        return;
      }
      sendJson(response, 200, publicSnapshot(store.snapshot()));
      return;
    }
    if (requestUrl.pathname === "/api/retry" && request.method === "POST") {
      if (!tokenMatches(bearerToken(request), accessToken)) {
        sendJson(response, 401, { error: "Unauthorized" }, { "www-authenticate": "Bearer" });
        return;
      }
      if (!retryAllowed()) {
        sendJson(response, 429, { error: "Retry rate limit exceeded" }, { "retry-after": String(Math.max(1, Math.ceil(retryWindowMs / 1_000))) });
        return;
      }
      void connectAdapter().catch(() => undefined);
      sendJson(response, 202, { accepted: true });
      return;
    }

    if (requestUrl.pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    if (requestUrl.pathname === "/" && devWebOrigins?.[0]) {
      response.writeHead(302, { ...securityHeaders, location: `${devWebOrigins[0]}/?token=${encodeURIComponent(accessToken)}` });
      response.end();
      return;
    }
    if (!existsSync(webDist)) {
      sendJson(response, 404, { error: "Web build not found. Run the Vite development server." });
      return;
    }
    const relative = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
    const candidate = path.resolve(webDist, relative);
    const safePath = isPathWithin(webDist, candidate) && existsSync(candidate) ? candidate : path.resolve(webDist, "index.html");
    response.writeHead(200, {
      ...securityHeaders,
      "cache-control": safePath.endsWith("index.html") ? "no-store" : "public, max-age=3600",
      "content-type": contentTypes[extname(safePath)] ?? "application/octet-stream",
    });
    createReadStream(safePath).pipe(response);
  });

  const webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES });
  server.on("upgrade", (request, socket, head) => {
    const authority = requestAuthority(request);
    if (!authority || !hasTrustedOrigin(request, authority, devWebOrigins, true)) {
      rejectUpgrade(socket, 403);
      return;
    }
    const requestUrl = new URL(request.url ?? "/", authority);
    if (requestUrl.pathname !== "/ws") {
      rejectUpgrade(socket, 404);
      return;
    }
    if (!tokenMatches(requestUrl.searchParams.get("token") ?? undefined, accessToken)) {
      rejectUpgrade(socket, 401);
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (client) => webSockets.emit("connection", client, request));
  });
  webSockets.on("connection", (socket) => {
    clients.add(socket);
    socket.send(JSON.stringify({ type: "snapshot", snapshot: publicSnapshot(store.snapshot()) }));
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
    socket.on("message", (message) => {
      try {
        const parsed: unknown = JSON.parse(message.toString());
        if (typeof parsed === "object" && parsed !== null && "type" in parsed && parsed.type === "retry" && retryAllowed()) {
          void connectAdapter().catch(() => undefined);
        }
      } catch {
        // Invalid client control messages are ignored.
      }
    });
  });

  return { server, webSockets, connectAdapter, store };
}
