import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRuntimeAdapter } from "@observatory/core";
import { consumeAccessToken } from "./access-token.ts";
import { ClaudeCodeAdapter } from "./claude-adapter.ts";
import { CompositeRuntimeAdapter } from "./composite-adapter.ts";
import { RealCodexAdapter } from "./codex-adapter.ts";
import { createObservatoryHttpServer } from "./http-server.ts";
import { MockCodexAdapter } from "./mock-adapter.ts";
import { SharedStateCodexAdapter } from "./shared-state-adapter.ts";

const accessToken = consumeAccessToken();
const port = Number(process.env.OBSERVATORY_PORT ?? 4317);
const realTransport = process.env.OBSERVATORY_CODEX_TRANSPORT ?? "shared";
const adapterMode = process.env.OBSERVATORY_ADAPTER ?? "mock";
const requestedProviders = (process.env.OBSERVATORY_PROVIDERS ?? "codex")
  .split(",")
  .map((provider) => provider.trim())
  .filter(Boolean);

function codexAdapter(): AgentRuntimeAdapter {
  return realTransport === "shared" ? new SharedStateCodexAdapter() : new RealCodexAdapter();
}

function realAdapter(): AgentRuntimeAdapter {
  const providers = Array.from(new Set(requestedProviders));
  if (providers.length === 0) throw new Error("At least one runtime provider is required");
  const adapters = providers.map((provider): AgentRuntimeAdapter => {
    if (provider === "codex") return codexAdapter();
    if (provider === "claude") return new ClaudeCodeAdapter();
    throw new Error(`Unsupported runtime provider: ${provider}`);
  });
  return adapters.length === 1 ? adapters[0]! : new CompositeRuntimeAdapter(adapters);
}

const adapter: AgentRuntimeAdapter = adapterMode === "mock"
  ? new MockCodexAdapter(process.env.OBSERVATORY_SCENARIO ?? "a")
  : realAdapter();
const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
const runningFromSource = fileURLToPath(import.meta.url).includes(`${sep}src${sep}`);
const webPort = Number(process.env.OBSERVATORY_WEB_PORT ?? 4318);
const devWebOrigins = runningFromSource
  ? [`http://127.0.0.1:${webPort}`, `http://localhost:${webPort}`]
  : undefined;
const { server, connectAdapter } = createObservatoryHttpServer({ accessToken, adapter, webDist, devWebOrigins });

server.listen(port, "127.0.0.1", () => {
  const bootstrapOrigin = `http://127.0.0.1:${port}`;
  console.log(`Agent Observatory server: ${bootstrapOrigin}/?token=${encodeURIComponent(accessToken)}`);
  console.log(`Adapter: ${adapter.mode}`);
});

void connectAdapter().catch(() => undefined);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void adapter.disconnect().finally(() => server.close(() => process.exit(0)));
  });
}
