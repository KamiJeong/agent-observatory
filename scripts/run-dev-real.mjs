import { spawn } from "node:child_process";

const env = { ...process.env, OBSERVATORY_ADAPTER: "codex" };
const optionToEnvironment = new Map([
  ["--cwd", "OBSERVATORY_CWD"],
  ["--root-thread", "OBSERVATORY_ROOT_THREAD_ID"],
  ["--transport", "OBSERVATORY_CODEX_TRANSPORT"],
]);
for (let index = 2; index < process.argv.length; index += 1) {
  const option = process.argv[index] ?? "";
  const environmentName = optionToEnvironment.get(option);
  const value = process.argv[index + 1];
  if (!environmentName || !value) {
    console.error(`Unknown or incomplete Real Mode option: ${option}`);
    console.error("Use --cwd <path|all>, --root-thread <id>, or --transport <mode>.");
    process.exit(1);
  }
  env[environmentName] = value;
  index += 1;
}
const command = process.platform === "win32"
  ? { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", "npm run dev"] }
  : { file: "npm", args: ["run", "dev"] };
const child = spawn(command.file, command.args, { env, stdio: "inherit" });

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
