import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join, win32 } from "node:path";

const NON_INTERACTIVE_COMMANDS = new Set([
  "agents",
  "app-server",
  "apply",
  "archive",
  "cloud",
  "completion",
  "debug",
  "delete",
  "doctor",
  "exec",
  "exec-server",
  "features",
  "login",
  "logout",
  "mcp",
  "mcp-server",
  "plugin",
  "queue",
  "remote-control",
  "review",
  "sandbox",
  "unarchive",
  "update",
]);

const OPTIONS_WITH_VALUES = new Set([
  "-a",
  "--add-dir",
  "--ask-for-approval",
  "-c",
  "--cd",
  "--config",
  "-C",
  "-i",
  "--image",
  "--local-provider",
  "-m",
  "--model",
  "-p",
  "--profile",
  "--remote",
  "--remote-auth-token-env",
  "-s",
  "--sandbox",
]);

export interface InteractiveCodexProcesses {
  cwdCounts: Map<string, number>;
  processCount: number;
  exact: boolean;
  source: "procfs" | "macos-ps-lsof" | "windows-cim" | "unsupported";
  warning?: string;
}

interface CodexInvocation {
  explicitCwd?: string;
}

interface WindowsProcessRecord {
  ProcessId?: unknown;
  CommandLine?: unknown;
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Split the subset of POSIX and Windows command-line quoting used by Codex launchers. */
export function splitProcessCommandLine(commandLine: string): string[] {
  const tokens: string[] = [];
  const pattern = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  for (const match of commandLine.matchAll(pattern)) {
    tokens.push((match[1] ?? match[2] ?? match[3] ?? "").replace(/\\"/g, '"'));
  }
  return tokens;
}

function codexInvocation(commandLine: string, platform: NodeJS.Platform): CodexInvocation | undefined {
  const tokens = splitProcessCommandLine(commandLine);
  const codexIndex = tokens.findIndex((token) => {
    const name = (platform === "win32" ? win32.basename(token) : basename(token)).toLowerCase();
    return name === "codex" || name === "codex.exe";
  });
  if (codexIndex === -1) return undefined;
  const args = tokens.slice(codexIndex + 1);
  let explicitCwd: string | undefined;
  let subcommand: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index] ?? "";
    if (value.startsWith("--cd=")) {
      explicitCwd = value.slice("--cd=".length);
      continue;
    }
    if (value === "-C" || value === "--cd") {
      explicitCwd = args[index + 1];
      index += 1;
      continue;
    }
    if (OPTIONS_WITH_VALUES.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith("-")) continue;
    subcommand = value;
    break;
  }
  if (subcommand && NON_INTERACTIVE_COMMANDS.has(subcommand)) return undefined;
  return explicitCwd ? { explicitCwd } : {};
}

export function findInteractiveCodexCwds(procRoot = "/proc"): Map<string, number> {
  const result = new Map<string, number>();
  let entries: string[];
  try {
    entries = readdirSync(procRoot).filter((entry) => /^\d+$/.test(entry));
  } catch {
    return result;
  }

  for (const pid of entries) {
    try {
      const command = readFileSync(join(procRoot, pid, "cmdline"), "utf8")
        .split("\0")
        .filter(Boolean);
      if (!codexInvocation(command.map((value) => JSON.stringify(value)).join(" "), "linux")) continue;
      const cwd = readlinkSync(join(procRoot, pid, "cwd"));
      if (cwd) increment(result, cwd);
    } catch {
      // Processes can disappear while /proc is being scanned.
    }
  }
  return result;
}

export function parseMacProcessList(output: string): number[] {
  const result: number[] = [];
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (Number.isInteger(pid) && codexInvocation(match[2] ?? "", "darwin")) result.push(pid);
  }
  return result;
}

export function parseLsofCwds(output: string): Map<number, string> {
  const result = new Map<number, string>();
  let pid: number | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      const value = Number(line.slice(1));
      pid = Number.isInteger(value) ? value : undefined;
    } else if (pid !== undefined && line.startsWith("n") && line.length > 1) {
      result.set(pid, line.slice(1));
    }
  }
  return result;
}

export function parseWindowsProcessList(output: string): InteractiveCodexProcesses {
  const cwdCounts = new Map<string, number>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(output || "[]");
  } catch {
    return {
      cwdCounts,
      processCount: 0,
      exact: false,
      source: "windows-cim",
      warning: "Windows process discovery returned invalid JSON",
    };
  }
  const records = (Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : []) as WindowsProcessRecord[];
  let processCount = 0;
  for (const record of records) {
    if (typeof record.CommandLine !== "string") continue;
    const invocation = codexInvocation(record.CommandLine, "win32");
    if (!invocation) continue;
    processCount += 1;
    if (invocation.explicitCwd && win32.isAbsolute(invocation.explicitCwd)) {
      increment(cwdCounts, invocation.explicitCwd);
    }
  }
  const resolvedCwdCount = [...cwdCounts.values()].reduce((sum, count) => sum + count, 0);
  return {
    cwdCounts,
    processCount,
    exact: processCount === resolvedCwdCount,
    source: "windows-cim",
    ...(processCount > 0 && processCount !== resolvedCwdCount
      ? { warning: "Windows does not expose process working directories; using the newest matching Codex roots" }
      : {}),
  };
}

function discoverMacProcesses(): InteractiveCodexProcesses {
  const ps = spawnSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (ps.error || ps.status !== 0) {
    return {
      cwdCounts: new Map(),
      processCount: 0,
      exact: false,
      source: "macos-ps-lsof",
      warning: ps.error?.message ?? (ps.stderr?.trim() || "ps failed"),
    };
  }
  const pids = parseMacProcessList(ps.stdout ?? "");
  if (pids.length === 0) {
    return { cwdCounts: new Map(), processCount: 0, exact: true, source: "macos-ps-lsof" };
  }
  const lsof = spawnSync("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const byPid = parseLsofCwds(lsof.stdout ?? "");
  const cwdCounts = new Map<string, number>();
  for (const cwd of byPid.values()) increment(cwdCounts, cwd);
  const exact = byPid.size === pids.length;
  return {
    cwdCounts,
    processCount: pids.length,
    exact,
    source: "macos-ps-lsof",
    ...(!exact ? { warning: lsof.error?.message ?? (lsof.stderr?.trim() || "lsof could not resolve every Codex cwd") } : {}),
  };
}

function discoverWindowsProcesses(): InteractiveCodexProcesses {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Get-CimInstance Win32_Process |",
    "Where-Object { $_.Name -ieq 'codex.exe' -or $_.CommandLine -match '(?:^|[\\\\/])codex(?:\\.exe)?(?:\"|\\s|$)' } |",
    "Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress",
  ].join(" ");
  const powershell = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 8_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (powershell.error || powershell.status !== 0) {
    return {
      cwdCounts: new Map(),
      processCount: 0,
      exact: false,
      source: "windows-cim",
      warning: powershell.error?.message ?? (powershell.stderr?.trim() || "PowerShell process discovery failed"),
    };
  }
  return parseWindowsProcessList(powershell.stdout?.trim() ?? "");
}

export function discoverInteractiveCodexProcesses(
  platform: NodeJS.Platform = process.platform,
): InteractiveCodexProcesses {
  if (platform === "linux") {
    const cwdCounts = findInteractiveCodexCwds();
    return {
      cwdCounts,
      processCount: [...cwdCounts.values()].reduce((sum, count) => sum + count, 0),
      exact: true,
      source: "procfs",
    };
  }
  if (platform === "darwin") return discoverMacProcesses();
  if (platform === "win32") return discoverWindowsProcesses();
  return {
    cwdCounts: new Map(),
    processCount: 0,
    exact: false,
    source: "unsupported",
    warning: `Process discovery is not implemented for ${platform}`,
  };
}

export interface RootThreadCandidate {
  id: string;
  cwd?: string;
  updatedAt?: number;
}

function pathKey(value: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return win32.normalize(value).replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "").toLowerCase();
  }
  return value.replace(/\/+$/, "") || "/";
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  return pathKey(left, platform) === pathKey(right, platform);
}

export function selectRootThreadIds(
  roots: RootThreadCandidate[],
  discovery: InteractiveCodexProcesses,
  configuredCwd: string,
  rootOverride: string | undefined,
  platform: NodeJS.Platform = process.platform,
): Set<string> {
  if (rootOverride) return new Set([rootOverride]);
  const eligible = configuredCwd === "all"
    ? roots
    : roots.filter((root) => root.cwd && samePath(root.cwd, configuredCwd, platform));
  const selected = new Set<string>();

  for (const [cwd, count] of discovery.cwdCounts) {
    for (const root of eligible.filter((candidate) => candidate.cwd && samePath(candidate.cwd, cwd, platform)).slice(0, count)) {
      selected.add(root.id);
    }
  }
  if (discovery.exact) return selected;

  const unresolvedCount = Math.max(0, discovery.processCount - selected.size);
  for (const root of eligible
    .filter((candidate) => !selected.has(candidate.id))
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
    .slice(0, unresolvedCount)) {
    selected.add(root.id);
  }
  return selected;
}
