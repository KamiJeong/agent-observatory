import type { IncomingMessage, ServerResponse } from "node:http";
import type { ObservatoryStore } from "@observatory/core";
import { publicSnapshot } from "./public-payload.ts";
import { sendJson } from "./request-security.ts";
import { hasSession } from "./session-auth.ts";

interface ApiRouterOptions {
  accessToken: string;
  connectAdapter(): Promise<void>;
  retryAllowed(): boolean;
  retryAfterSeconds: number;
  store: ObservatoryStore;
}

export function handleApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  options: ApiRouterOptions,
): boolean {
  if (requestUrl.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, connection: options.store.snapshot().connection });
    return true;
  }
  if (requestUrl.pathname === "/api/snapshot") {
    if (!hasSession(request, options.accessToken)) {
      sendJson(response, 401, { error: "Unauthorized" }, { "www-authenticate": "ObservatorySession" });
      return true;
    }
    sendJson(response, 200, publicSnapshot(options.store.snapshot()));
    return true;
  }
  if (requestUrl.pathname === "/api/retry" && request.method === "POST") {
    if (!hasSession(request, options.accessToken)) {
      sendJson(response, 401, { error: "Unauthorized" }, { "www-authenticate": "ObservatorySession" });
      return true;
    }
    if (!options.retryAllowed()) {
      sendJson(response, 429, { error: "Retry rate limit exceeded" }, {
        "retry-after": String(options.retryAfterSeconds),
      });
      return true;
    }
    void options.connectAdapter().catch(() => undefined);
    sendJson(response, 202, { accepted: true });
    return true;
  }
  if (!requestUrl.pathname.startsWith("/api/")) return false;
  sendJson(response, 404, { error: "Not found" });
  return true;
}
