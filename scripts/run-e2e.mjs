import { spawn } from "node:child_process";

const dev = spawn("npm", ["run", "dev"], {
  cwd: process.cwd(),
  env: { ...process.env, OBSERVATORY_ADAPTER: "mock", OBSERVATORY_SCENARIO: "a" },
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
    const text = chunk.toString("utf8");
    output += text;
    if (!settled && /Local:\s+http:\/\/127\.0\.0\.1:4318/.test(output) && /Observatory server:/.test(output)) {
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
  const test = spawn("npx", ["playwright", "test"], {
    cwd: process.cwd(),
    env: process.env,
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
