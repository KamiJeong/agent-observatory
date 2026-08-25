import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { securityHeaders, sendJson } from "./request-security.ts";

export const OBSERVATORY_SESSION_COOKIE = "observatory_session";

function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const actualBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function sessionToken(request: IncomingMessage): string | undefined {
  const cookie = request.headers.cookie;
  if (!cookie) return undefined;
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== OBSERVATORY_SESSION_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function hasSession(request: IncomingMessage, accessToken: string): boolean {
  return tokenMatches(sessionToken(request), accessToken);
}

export function handleSessionBootstrap(
  requestUrl: URL,
  response: ServerResponse,
  accessToken: string,
  redirectLocation: string,
): boolean {
  if (requestUrl.pathname !== "/" || !requestUrl.searchParams.has("token")) return false;
  if (!tokenMatches(requestUrl.searchParams.get("token") ?? undefined, accessToken)) {
    sendJson(response, 401, { error: "Unauthorized" }, { "www-authenticate": "ObservatoryBootstrap" });
    return true;
  }
  response.writeHead(302, {
    ...securityHeaders,
    location: redirectLocation,
    "set-cookie": `${OBSERVATORY_SESSION_COOKIE}=${encodeURIComponent(accessToken)}; HttpOnly; SameSite=Strict; Path=/`,
  });
  response.end();
  return true;
}
