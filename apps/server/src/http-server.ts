import { createServer } from "node:http";
import type { AgentRuntimeAdapter } from "@observatory/core";
import { ObservatoryStore } from "@observatory/core";
import { handleApiRequest } from "./http/api-router.ts";
import { publicEvent, publicSnapshot } from "./http/public-payload.ts";
import { hasTrustedOrigin, requestAuthority, securityHeaders, sendJson } from "./http/request-security.ts";
import { handleSessionBootstrap, hasSession, OBSERVATORY_SESSION_COOKIE } from "./http/session-auth.ts";
import { isPathWithin, serveWebAsset } from "./http/static-files.ts";
import { createWebSocketTransport, LatestSnapshotBroadcaster } from "./http/websocket-server.ts";

const DEFAULT_RETRY_WINDOW_MS = 1_000;

export { isPathWithin, OBSERVATORY_SESSION_COOKIE };

export interface ObservatoryHttpServerOptions {
  accessToken: string;
  adapter: AgentRuntimeAdapter;
  webDist: string;
  devWebOrigins?: readonly string[];
  retryWindowMs?: number;
}

export function createObservatoryHttpServer(options: ObservatoryHttpServerOptions) {
  const { accessToken, adapter, webDist, devWebOrigins } = options;
  const retryWindowMs = options.retryWindowMs ?? DEFAULT_RETRY_WINDOW_MS;
  const store = new ObservatoryStore(adapter.runtimeInfo());
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

  const server = createServer((request, response) => {
    const authority = requestAuthority(request);
    if (!authority || !hasTrustedOrigin(request, authority, devWebOrigins)) {
      sendJson(response, 403, { error: "Forbidden" });
      return;
    }
    const requestUrl = new URL(request.url ?? "/", authority);
    if (handleSessionBootstrap(requestUrl, response, accessToken, devWebOrigins?.[0] ?? "/")) return;
    if (handleApiRequest(request, response, requestUrl, {
      accessToken,
      connectAdapter,
      retryAllowed,
      retryAfterSeconds: Math.max(1, Math.ceil(retryWindowMs / 1_000)),
      store,
    })) return;
    if (requestUrl.pathname === "/" && devWebOrigins?.[0] && hasSession(request, accessToken)) {
      response.writeHead(302, { ...securityHeaders, location: devWebOrigins[0] });
      response.end();
      return;
    }
    serveWebAsset(response, requestUrl, webDist);
  });

  const webSockets = createWebSocketTransport({
    accessToken,
    connectAdapter,
    devWebOrigins,
    retryAllowed,
    server,
    store,
  });
  const snapshotBroadcaster = new LatestSnapshotBroadcaster(webSockets);
  store.subscribe((snapshot, event) => {
    snapshotBroadcaster.publish(() => JSON.stringify({
      type: "snapshot",
      snapshot: publicSnapshot(snapshot),
      event: publicEvent(event),
    }));
  });

  return { server, webSockets, connectAdapter, store };
}
