import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const serverPort = process.env.OBSERVATORY_E2E_SERVER_PORT ?? "4417";
const webPort = process.env.OBSERVATORY_E2E_WEB_PORT ?? "4418";
const webUrl = `http://127.0.0.1:${webPort}`;
const accessToken = randomBytes(32).toString("base64url");
const stripAnsi = (value) => value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");

const dev = spawn("bun", ["run", "dev"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    OBSERVATORY_ADAPTER: "mock",
    OBSERVATORY_ACCESS_TOKEN: accessToken,
    OBSERVATORY_PORT: serverPort,
    OBSERVATORY_SCENARIO: "a",
    OBSERVATORY_WEB_PORT: webPort,
  },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});

let output = "";
let settled = false;

const stopDev = () => {
  if (dev.pid) {
    try {
      process.kill(-dev.pid, "SIGTERM");
    } catch {
      // The process group may already be gone.
    }
  }
};

const ready = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`Development servers did not start:\n${output}`)), 20_000);
  const consume = (chunk) => {
    const text = stripAnsi(chunk.toString("utf8"));
    output += text;
    if (!settled && output.includes(`Local:   ${webUrl}`) && /Observatory server:/.test(output)) {
      settled = true;
      clearTimeout(timeout);
      resolve();
    }
  };
  dev.stdout.on("data", consume);
  dev.stderr.on("data", consume);
  dev.once("exit", (code) => {
    if (!settled) reject(new Error(`Development servers exited with ${code}:\n${output}`));
  });
});

try {
  await ready;
  const test = spawn("bunx", ["playwright", "test"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OBSERVATORY_E2E_ACCESS_TOKEN: accessToken,
      OBSERVATORY_WEB_URL: webUrl,
    },
    stdio: "inherit",
  });
  const code = await new Promise((resolve) => test.once("exit", (exitCode) => resolve(exitCode ?? 1)));
  stopDev();
  process.exitCode = code;
} catch (error) {
  stopDev();
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
