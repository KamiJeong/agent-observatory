#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const help = `agent-observatory ${packageJson.version}

Run a local dashboard for Codex multi-agent workflows.

Usage:
  agent-observatory [options]

Options:
  --real                 Observe active local Codex sessions
  --port <number>        HTTP/WebSocket port (default: 4317)
  --cwd <path|all>       Restrict Real Mode to one working directory
  --root-thread <id>     Restrict Real Mode to one root thread tree
  --transport <mode>     shared, standalone, or proxy (default: shared)
  --scenario <name>      Mock scenario: a, b, or stress (default: a)
  --open                 Open the dashboard in the default browser
  --no-open              Do not open a browser
  -h, --help             Show this help
  -v, --version          Show the package version

Examples:
  bunx agent-observatory
  bunx agent-observatory --real
  bunx agent-observatory --real --cwd /projects/design-system
  bunx agent-observatory --scenario stress --no-open
`;

let values;
try {
  ({ values } = parseArgs({
    options: {
      real: { type: "boolean" },
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

const port = Number(values.port ?? 4317);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error(`Invalid port: ${values.port ?? ""}`);
  process.exit(1);
}

const transports = new Set(["shared", "standalone", "proxy"]);
if (values.transport && !transports.has(values.transport)) {
  console.error(`Invalid transport: ${values.transport}. Use shared, standalone, or proxy.`);
  process.exit(1);
}

const scenarios = new Set(["a", "b", "stress"]);
if (values.scenario && !scenarios.has(values.scenario)) {
  console.error(`Invalid scenario: ${values.scenario}. Use a, b, or stress.`);
  process.exit(1);
}

process.env.OBSERVATORY_PORT = String(port);
process.env.OBSERVATORY_ADAPTER = values.real ? "codex" : "mock";
if (values.cwd) process.env.OBSERVATORY_CWD = values.cwd;
if (values["root-thread"]) process.env.OBSERVATORY_ROOT_THREAD_ID = values["root-thread"];
if (values.transport) process.env.OBSERVATORY_CODEX_TRANSPORT = values.transport;
if (values.scenario) process.env.OBSERVATORY_SCENARIO = values.scenario;

const url = `http://127.0.0.1:${port}`;
const shouldOpen = values.open || (!values["no-open"] && process.stdout.isTTY && !process.env.CI);

function openBrowser(target) {
  const command = process.platform === "darwin"
    ? { file: "open", args: [target] }
    : process.platform === "win32"
      ? { file: "cmd", args: ["/c", "start", "", target] }
      : { file: "xdg-open", args: [target] };
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
      const response = await fetch(`${url}/api/health`);
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
