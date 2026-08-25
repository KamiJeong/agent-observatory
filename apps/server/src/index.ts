import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodexAdapter } from "@observatory/core";
import { consumeAccessToken } from "./access-token.ts";
import { RealCodexAdapter } from "./codex-adapter.ts";
import { createObservatoryHttpServer } from "./http-server.ts";
import { MockCodexAdapter } from "./mock-adapter.ts";
import { SharedStateCodexAdapter } from "./shared-state-adapter.ts";

const accessToken = consumeAccessToken();
const port = Number(process.env.OBSERVATORY_PORT ?? 4317);
const realTransport = process.env.OBSERVATORY_CODEX_TRANSPORT ?? "shared";
const adapter: CodexAdapter = process.env.OBSERVATORY_ADAPTER === "codex"
  ? realTransport === "shared"
    ? new SharedStateCodexAdapter()
    : new RealCodexAdapter()
  : new MockCodexAdapter(process.env.OBSERVATORY_SCENARIO ?? "a");
const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
const runningFromSource = fileURLToPath(import.meta.url).includes(`${sep}src${sep}`);
const webPort = Number(process.env.OBSERVATORY_WEB_PORT ?? 4318);
const devWebOrigins = runningFromSource
  ? [`http://127.0.0.1:${webPort}`, `http://localhost:${webPort}`]
  : undefined;
const { server, connectAdapter } = createObservatoryHttpServer({ accessToken, adapter, webDist, devWebOrigins });

server.listen(port, "127.0.0.1", () => {
  const bootstrapOrigin = `http://127.0.0.1:${port}`;
  console.log(`Codex Agent Observatory server: ${bootstrapOrigin}/?token=${encodeURIComponent(accessToken)}`);
  console.log(`Adapter: ${adapter.mode}`);
});

void connectAdapter().catch(() => undefined);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void adapter.disconnect().finally(() => server.close(() => process.exit(0)));
  });
}
