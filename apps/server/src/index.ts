import { existsSync, createReadStream } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { ObservatoryStore, type CodexAdapter, type CodexRuntimeEvent } from "@observatory/core";
import { WebSocketServer, WebSocket } from "ws";
import { RealCodexAdapter } from "./codex-adapter.ts";
import { MockCodexAdapter } from "./mock-adapter.ts";
import { SharedStateCodexAdapter } from "./shared-state-adapter.ts";

const port = Number(process.env.OBSERVATORY_PORT ?? 4317);
const realTransport = process.env.OBSERVATORY_CODEX_TRANSPORT ?? "shared";
const adapter: CodexAdapter = process.env.OBSERVATORY_ADAPTER === "codex"
  ? realTransport === "shared"
    ? new SharedStateCodexAdapter()
    : new RealCodexAdapter()
  : new MockCodexAdapter(process.env.OBSERVATORY_SCENARIO ?? "a");
const store = new ObservatoryStore(adapter.runtimeInfo());
const clients = new Set<WebSocket>();

adapter.subscribe((event) => store.apply(event));
store.subscribe((snapshot, event) => {
  const payload = JSON.stringify({ type: "snapshot", snapshot, event });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
});

const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (requestUrl.pathname === "/api/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, connection: store.snapshot().connection }));
    return;
  }
  if (requestUrl.pathname === "/api/snapshot") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(store.snapshot()));
    return;
  }
  if (requestUrl.pathname === "/api/retry" && request.method === "POST") {
    void adapter.connect().catch((error) => {
      const event: CodexRuntimeEvent = {
        type: "connection.changed",
        at: Date.now(),
        connection: { phase: "disconnected", attempt: 0, message: error instanceof Error ? error.message : String(error) },
      };
      store.apply(event);
    });
    response.writeHead(202).end();
    return;
  }

  if (!existsSync(webDist)) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Web build not found. Run the Vite development server." }));
    return;
  }
  const relative = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
  const candidate = normalize(join(webDist, relative));
  const safePath = candidate.startsWith(webDist) && existsSync(candidate) ? candidate : join(webDist, "index.html");
  response.writeHead(200, { "content-type": contentTypes[extname(safePath)] ?? "application/octet-stream" });
  createReadStream(safePath).pipe(response);
});

const webSockets = new WebSocketServer({ server, path: "/ws" });
webSockets.on("connection", (socket) => {
  clients.add(socket);
  socket.send(JSON.stringify({ type: "snapshot", snapshot: store.snapshot() }));
  socket.on("close", () => clients.delete(socket));
  socket.on("message", (message) => {
    try {
      const parsed: unknown = JSON.parse(message.toString());
      if (typeof parsed === "object" && parsed !== null && "type" in parsed && parsed.type === "retry") {
        void adapter.connect();
      }
    } catch {
      // Client control messages are optional and deliberately tiny.
    }
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Codex Agent Observatory server: http://127.0.0.1:${port}`);
  console.log(`Adapter: ${adapter.mode}`);
});

void adapter.connect().catch((error) => {
  store.apply({
    type: "connection.changed",
    at: Date.now(),
    connection: {
      phase: "disconnected",
      attempt: 0,
      message: error instanceof Error ? error.message : String(error),
    },
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void adapter.disconnect().finally(() => server.close(() => process.exit(0)));
  });
}
