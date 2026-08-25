import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

export const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    ...securityHeaders,
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

export function requestAuthority(request: IncomingMessage): string | undefined {
  const host = request.headers.host;
  if (!host || Array.isArray(host)) return undefined;
  const port = request.socket.localPort;
  if (!port) return undefined;
  const allowed = port === 80
    ? ["127.0.0.1", "localhost", "127.0.0.1:80", "localhost:80"]
    : [`127.0.0.1:${port}`, `localhost:${port}`];
  return allowed.includes(host) ? new URL(`http://${host}`).origin : undefined;
}

export function hasTrustedOrigin(
  request: IncomingMessage,
  authority: string,
  devWebOrigins: readonly string[] = [],
  requireOrigin = false,
): boolean {
  const origin = request.headers.origin;
  if (!origin) return !requireOrigin;
  return origin === authority || devWebOrigins.includes(origin);
}

export function rejectUpgrade(socket: Duplex, status: 401 | 403 | 404): void {
  const reason = status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Not Found";
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`);
}
