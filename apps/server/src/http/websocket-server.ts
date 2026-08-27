import type { Server } from "node:http";
import type { ObservatoryStore } from "@observatory/core";
import { WebSocket, WebSocketServer } from "ws";
import { publicSnapshot } from "./public-payload.ts";
import { hasTrustedOrigin, rejectUpgrade, requestAuthority } from "./request-security.ts";
import { hasSession } from "./session-auth.ts";

const MAX_WEBSOCKET_PAYLOAD_BYTES = 8 * 1024;

interface WebSocketTransportOptions {
  accessToken: string;
  connectAdapter(): Promise<void>;
  devWebOrigins?: readonly string[];
  retryAllowed(): boolean;
  server: Server;
  store: ObservatoryStore;
}

export function createWebSocketTransport(options: WebSocketTransportOptions): WebSocketServer {
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES });
  options.server.on("upgrade", (request, socket, head) => {
    const authority = requestAuthority(request);
    if (!authority || !hasTrustedOrigin(request, authority, options.devWebOrigins, true)) {
      rejectUpgrade(socket, 403);
      return;
    }
    const requestUrl = new URL(request.url ?? "/", authority);
    if (requestUrl.pathname !== "/ws") {
      rejectUpgrade(socket, 404);
      return;
    }
    if (!hasSession(request, options.accessToken)) {
      rejectUpgrade(socket, 401);
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (client) => webSockets.emit("connection", client, request));
  });
  webSockets.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "snapshot", snapshot: publicSnapshot(options.store.snapshot()) }));
    socket.on("error", () => undefined);
    socket.on("message", (message) => {
      try {
        const parsed: unknown = JSON.parse(message.toString());
        if (typeof parsed === "object" && parsed !== null && "type" in parsed && parsed.type === "retry" && options.retryAllowed()) {
          void options.connectAdapter().catch(() => undefined);
        }
      } catch {
        // Invalid client control messages are ignored.
      }
    });
  });
  return webSockets;
}

interface ClientSendState {
  pending?: string;
  sending: boolean;
}

export class LatestSnapshotBroadcaster {
  #clientStates = new WeakMap<WebSocket, ClientSendState>();
  #pendingSerializer?: () => string;
  #scheduled = false;

  constructor(readonly webSockets: WebSocketServer) {}

  publish(serialize: () => string): void {
    if (this.webSockets.clients.size === 0) return;
    this.#pendingSerializer = serialize;
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => this.#flush());
  }

  #flush(): void {
    this.#scheduled = false;
    const serialize = this.#pendingSerializer;
    this.#pendingSerializer = undefined;
    if (!serialize || this.webSockets.clients.size === 0) return;
    const payload = serialize();
    for (const client of this.webSockets.clients) this.#enqueue(client, payload);
  }

  #enqueue(client: WebSocket, payload: string): void {
    if (client.readyState !== WebSocket.OPEN) return;
    const state = this.#clientStates.get(client) ?? { sending: false };
    this.#clientStates.set(client, state);
    if (state.sending) {
      state.pending = payload;
      return;
    }
    state.sending = true;
    try {
      client.send(payload, (error) => {
        state.sending = false;
        if (error || client.readyState !== WebSocket.OPEN) {
          state.pending = undefined;
          return;
        }
        const pending = state.pending;
        state.pending = undefined;
        if (pending !== undefined) this.#enqueue(client, pending);
      });
    } catch {
      state.sending = false;
      state.pending = undefined;
    }
  }
}
