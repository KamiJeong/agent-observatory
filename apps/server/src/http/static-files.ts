import { createReadStream, existsSync } from "node:fs";
import type { ServerResponse } from "node:http";
import path, { extname } from "node:path";
import { securityHeaders, sendJson } from "./request-security.ts";

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

export interface PathOperations {
  isAbsolute(value: string): boolean;
  relative(from: string, to: string): string;
  resolve(...values: string[]): string;
  sep: string;
}

export function isPathWithin(root: string, candidate: string, pathOperations: PathOperations = path): boolean {
  const relativePath = pathOperations.relative(pathOperations.resolve(root), pathOperations.resolve(candidate));
  return relativePath !== ""
    && relativePath !== ".."
    && !relativePath.startsWith(`..${pathOperations.sep}`)
    && !pathOperations.isAbsolute(relativePath);
}

export function serveWebAsset(response: ServerResponse, requestUrl: URL, webDist: string): void {
  if (!existsSync(webDist)) {
    sendJson(response, 404, { error: "Web build not found. Run the Vite development server." });
    return;
  }
  const relative = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
  const candidate = path.resolve(webDist, relative);
  const safePath = isPathWithin(webDist, candidate) && existsSync(candidate)
    ? candidate
    : path.resolve(webDist, "index.html");
  response.writeHead(200, {
    ...securityHeaders,
    "cache-control": safePath.endsWith("index.html") ? "no-store" : "public, max-age=3600",
    "content-type": contentTypes[extname(safePath)] ?? "application/octet-stream",
  });
  createReadStream(safePath).pipe(response);
}
