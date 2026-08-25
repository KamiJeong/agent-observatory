#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { browserCommand, resolveRuntimeConfiguration, selectAvailablePort } from "./cli-runtime.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const help = `agent-observatory ${packageJson.version}

Run a local dashboard for Codex and Claude multi-agent workflows.

Usage:
  agent-observatory [options]

Options:
  --real                 Observe active local agent sessions (default)
  --mock                 Run with deterministic local fixtures
  --provider <name>      codex, claude, or all (default: all)
  --port <number>        HTTP/WebSocket port (preferred default: 4317)
  --cwd <path|all>       Restrict Real Mode to one working directory
  --root-thread <id>     Restrict Real Mode to one root thread tree
  --transport <mode>     shared, standalone, or proxy (default: shared)
  --scenario <name>      Mock scenario: a, b, demo, or stress (implies --mock)
  --open                 Open the dashboard in the default browser
  --no-open              Do not open a browser
  -h, --help             Show this help
  -v, --version          Show the package version

Examples:
  bunx agent-observatory
  bunx agent-observatory --provider codex
  bunx agent-observatory --provider claude
  bunx agent-observatory --cwd /projects/design-system
  bunx agent-observatory --mock
  bunx agent-observatory --scenario demo --no-open
  bunx agent-observatory --scenario stress --no-open
`;

let values;
try {
  ({ values } = parseArgs({
    options: {
      real: { type: "boolean" },
      mock: { type: "boolean" },
      provider: { type: "string" },
      port: { type: "string" },
      cwd: { type: "string" },
      "root-thread": { type: "string" },
      transport: { type: "string" },
      scenario: { type: "string" },
      open: { type: "boolean" },
      "no-open": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    strict: true,
  }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("Run agent-observatory --help for usage.");
  process.exit(1);
}

if (values.help) {
  console.log(help);
  process.exit(0);
}
if (values.version) {
  console.log(packageJson.version);
  process.exit(0);
}
if (values.open && values["no-open"]) {
  console.error("Use either --open or --no-open, not both.");
  process.exit(1);
}

const preferredPort = Number(values.port ?? process.env.OBSERVATORY_PORT ?? 4317);
if (!Number.isInteger(preferredPort) || preferredPort < 1 || preferredPort > 65_535) {
  console.error(`Invalid port: ${values.port ?? ""}`);
  process.exit(1);
}

const transports = new Set(["shared", "standalone", "proxy"]);
if (values.transport && !transports.has(values.transport)) {
  console.error(`Invalid transport: ${values.transport}. Use shared, standalone, or proxy.`);
  process.exit(1);
}

const scenarios = new Set(["a", "b", "demo", "stress"]);
if (values.scenario && !scenarios.has(values.scenario)) {
  console.error(`Invalid scenario: ${values.scenario}. Use a, b, demo, or stress.`);
  process.exit(1);
}

const providers = new Set(["codex", "claude", "all"]);
if (values.provider && !providers.has(values.provider)) {
  console.error(`Invalid provider: ${values.provider}. Use codex, claude, or all.`);
  process.exit(1);
}

let runtime;
try {
  runtime = resolveRuntimeConfiguration(values);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

let port;
try {
  port = await selectAvailablePort(preferredPort, { allowFallback: values.port === undefined });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
if (port !== preferredPort) {
  console.warn(`Port ${preferredPort} is already in use; using ${port} instead.`);
}

process.env.OBSERVATORY_PORT = String(port);
process.env.OBSERVATORY_ADAPTER = runtime.adapter;
if (runtime.providers) process.env.OBSERVATORY_PROVIDERS = runtime.providers;
if (values.cwd) process.env.OBSERVATORY_CWD = values.cwd;
if (values["root-thread"]) process.env.OBSERVATORY_ROOT_THREAD_ID = values["root-thread"];
if (values.transport) process.env.OBSERVATORY_CODEX_TRANSPORT = values.transport;
if (values.scenario) process.env.OBSERVATORY_SCENARIO = values.scenario;

const accessToken = randomBytes(32).toString("base64url");
process.env.OBSERVATORY_ACCESS_TOKEN = accessToken;
const baseUrl = `http://127.0.0.1:${port}`;
const url = `${baseUrl}/?token=${encodeURIComponent(accessToken)}`;
const shouldOpen = values.open || (!values["no-open"] && !process.env.CI);

function openBrowser(target) {
  const command = browserCommand(process.platform, process.env, target);
  const reportFailure = () => {
    console.warn(`Could not open a browser automatically. Open ${target} manually.`);
  };
  try {
    const child = spawn(command.file, command.args, { detached: true, stdio: "ignore" });
    child.once("error", reportFailure);
    child.unref();
  } catch {
    reportFailure();
  }
}

async function openWhenReady() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        openBrowser(url);
        return;
      }
    } catch {
      // The server may still be binding the local port.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

process.title = "agent-observatory";
await import("../apps/server/dist/index.js");
if (shouldOpen) void openWhenReady();
