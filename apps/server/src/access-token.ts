import { randomBytes } from "node:crypto";

export function consumeAccessToken(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.OBSERVATORY_ACCESS_TOKEN;
  delete environment.OBSERVATORY_ACCESS_TOKEN;
  return configured ?? randomBytes(32).toString("base64url");
}
