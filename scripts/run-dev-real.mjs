import { spawn } from "node:child_process";

const env = {
  ...process.env,
  OBSERVATORY_ADAPTER: "real",
  OBSERVATORY_LAUNCH_CWD: process.cwd(),
};
let openPreference;
const optionToEnvironment = new Map([
  ["--cwd", "OBSERVATORY_CWD"],
  ["--root-thread", "OBSERVATORY_ROOT_THREAD_ID"],
  ["--transport", "OBSERVATORY_CODEX_TRANSPORT"],
  ["--provider", "OBSERVATORY_PROVIDERS"],
]);
for (let index = 2; index < process.argv.length; index += 1) {
  const option = process.argv[index] ?? "";
  if (option === "--open" || option === "--no-open") {
    const nextPreference = option === "--open";
    if (openPreference !== undefined && openPreference !== nextPreference) {
      console.error("Use either --open or --no-open, not both.");
      process.exit(1);
    }
    openPreference = nextPreference;
    continue;
  }
  if (option === "--capture-content") {
    env.OBSERVATORY_CAPTURE_CONTENT = "1";
    continue;
  }
  const environmentName = optionToEnvironment.get(option);
  const value = process.argv[index + 1];
  if (!environmentName || !value) {
    console.error(`Unknown or incomplete Real Mode option: ${option}`);
    console.error("Use --cwd <path|all>, --root-thread <id>, --transport <mode>, --provider <codex|claude|codex,claude>, or --capture-content.");
    process.exit(1);
  }
  env[environmentName] = value;
  index += 1;
}
const configuredProviders = (env.OBSERVATORY_PROVIDERS ?? "codex,claude")
  .split(",")
  .map((provider) => provider.trim())
  .filter(Boolean);
const unknownProviders = configuredProviders.filter((provider) => provider !== "codex" && provider !== "claude");
if (configuredProviders.length === 0 || unknownProviders.length > 0) {
  console.error("Invalid Real Mode provider selection. Use codex, claude, or codex,claude.");
  process.exit(1);
}
const includesCodex = configuredProviders.includes("codex");
const includesClaude = configuredProviders.includes("claude");
const selectedProviders = includesCodex && includesClaude
  ? "codex,claude"
  : includesCodex
    ? "codex"
    : "claude";
env.OBSERVATORY_PROVIDERS = selectedProviders;
console.log(`Real Mode providers: ${selectedProviders}`);
const command = { file: "bun", args: ["run", "dev"] };
const child = spawn(command.file, command.args, { env, stdio: ["inherit", "pipe", "pipe"] });
const shouldOpen = openPreference ?? (Boolean(process.stdout.isTTY) && !process.env.CI);
let opened = false;
let outputBuffer = "";
const stripAnsi = (value) => value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");

function openBrowser(target) {
  const command = process.platform === "darwin"
    ? { file: "open", args: [target] }
    : process.platform === "win32"
      ? { file: "cmd", args: ["/c", "start", "", target] }
      : { file: "xdg-open", args: [target] };
  try {
    const browser = spawn(command.file, command.args, { detached: true, stdio: "ignore" });
    browser.once("error", () => {
      console.warn(`Could not open a browser automatically. Open ${target} manually.`);
    });
    browser.unref();
  } catch {
    console.warn(`Could not open a browser automatically. Open ${target} manually.`);
  }
}

function forwardOutput(chunk, destination) {
  destination.write(chunk);
  if (opened) return;
  outputBuffer = stripAnsi(`${outputBuffer}${chunk.toString("utf8")}`).slice(-4_096);
  const match = outputBuffer.match(/Agent Observatory server: (http:\/\/[^\s]+)/);
  if (!match?.[1]) return;
  opened = true;
  console.log(`Dashboard bootstrap: ${match[1]}`);
  if (shouldOpen) openBrowser(match[1]);
}

child.stdout.on("data", (chunk) => forwardOutput(chunk, process.stdout));
child.stderr.on("data", (chunk) => forwardOutput(chunk, process.stderr));

child.once("error", (error) => {
  console.error(`Unable to start Real Mode: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`Real Mode stopped by ${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}
