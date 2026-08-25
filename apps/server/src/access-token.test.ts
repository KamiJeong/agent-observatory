import { describe, expect, it } from "vitest";
import { consumeAccessToken } from "./access-token.ts";

describe("consumeAccessToken", () => {
  it("removes the inherited token before adapters can spawn child processes", () => {
    const environment: NodeJS.ProcessEnv = { OBSERVATORY_ACCESS_TOKEN: "cli-generated-token" };
    expect(consumeAccessToken(environment)).toBe("cli-generated-token");
    expect(environment).not.toHaveProperty("OBSERVATORY_ACCESS_TOKEN");
  });

  it("generates a random base64url token when launched without the CLI", () => {
    const first = consumeAccessToken({});
    const second = consumeAccessToken({});
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
  });
});
