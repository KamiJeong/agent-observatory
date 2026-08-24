import { describe, expect, it } from "vitest";
import {
  parseLsofCwds,
  parseMacProcessList,
  parseWindowsProcessList,
  selectRootThreadIds,
  splitProcessCommandLine,
  type InteractiveCodexProcesses,
} from "./process-discovery.ts";

describe("cross-platform Codex process discovery", () => {
  it("splits quoted native command lines", () => {
    expect(splitProcessCommandLine('"C:\\Program Files\\Codex\\codex.exe" -C "C:\\Work Space\\app"')).toEqual([
      "C:\\Program Files\\Codex\\codex.exe",
      "-C",
      "C:\\Work Space\\app",
    ]);
  });

  it("finds interactive macOS processes and ignores App Server services", () => {
    expect(parseMacProcessList([
      "  101 /opt/homebrew/bin/codex --model gpt-5.6",
      "  102 /opt/homebrew/bin/codex app-server",
      "  103 /opt/homebrew/bin/codex resume --last",
      "  104 /usr/bin/node vite",
    ].join("\n"))).toEqual([101, 103]);
  });

  it("maps macOS lsof cwd records to process ids", () => {
    expect(parseLsofCwds("p101\nfcwd\nn/Users/me/alpha\np103\nfcwd\nn/Users/me/beta\n")).toEqual(new Map([
      [101, "/Users/me/alpha"],
      [103, "/Users/me/beta"],
    ]));
  });

  it("uses explicit Windows --cd paths and marks unresolved cwd values as approximate", () => {
    const result = parseWindowsProcessList(JSON.stringify([
      { ProcessId: 201, CommandLine: '"C:\\Tools\\codex.exe" -C "C:\\Work\\Alpha"' },
      { ProcessId: 202, CommandLine: '"C:\\Tools\\codex.exe" resume --last' },
      { ProcessId: 203, CommandLine: '"C:\\Tools\\codex.exe" app-server' },
    ]));

    expect(result.processCount).toBe(2);
    expect(result.cwdCounts).toEqual(new Map([["C:\\Work\\Alpha", 1]]));
    expect(result.exact).toBe(false);
    expect(result.warning).toContain("Windows");
  });

  it("selects newest Windows roots for processes whose cwd cannot be inspected", () => {
    const discovery: InteractiveCodexProcesses = {
      cwdCounts: new Map([["C:\\WORK\\ALPHA\\", 1]]),
      processCount: 2,
      exact: false,
      source: "windows-cim",
    };
    const selected = selectRootThreadIds([
      { id: "alpha-new", cwd: "c:\\work\\alpha", updatedAt: 30 },
      { id: "beta-new", cwd: "C:\\work\\beta", updatedAt: 20 },
      { id: "alpha-old", cwd: "C:\\work\\alpha", updatedAt: 10 },
    ], discovery, "all", undefined, "win32");

    expect(selected).toEqual(new Set(["alpha-new", "beta-new"]));
  });

  it("honors an exact cwd filter during approximate Windows discovery", () => {
    const discovery: InteractiveCodexProcesses = {
      cwdCounts: new Map(),
      processCount: 1,
      exact: false,
      source: "windows-cim",
    };
    const selected = selectRootThreadIds([
      { id: "alpha", cwd: "C:\\work\\alpha", updatedAt: 10 },
      { id: "beta", cwd: "C:\\work\\beta", updatedAt: 20 },
    ], discovery, "c:\\WORK\\alpha\\", undefined, "win32");

    expect(selected).toEqual(new Set(["alpha"]));
  });
});
