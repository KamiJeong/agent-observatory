import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executionContextFromToolInput, findInteractiveCodexCwds, parseRolloutState } from "./shared-state-adapter.ts";

function line(timestamp: string, type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp, type, payload });
}

describe("shared Codex state compatibility", () => {
  it("projects an unfinished root turn as working", () => {
    const state = parseRolloutState(
      [
        line("2026-08-24T00:59:59.000Z", "turn_context", {
          model: "gpt-5.6-sol",
          effort: "high",
          collaboration_mode: { mode: "plan" },
        }),
        line("2026-08-24T01:00:00.000Z", "event_msg", { type: "task_started" }),
      ].join("\n"),
      "root-1",
      true,
      true,
    );

    expect(state.nativeStatus).toEqual({ type: "active", activeFlags: [] });
    expect(state.lifecycle).toBe("running");
    expect(state).toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      collaborationMode: "plan",
      observedWorkflows: ["Planning"],
    });
  });

  it("extracts only observed skill and workflow evidence from tool input", () => {
    expect(executionContextFromToolInput(JSON.stringify({
      cmd: "rtk cat .agents/skills/sdd-plan/SKILL.md && rtk sed -n '1,80p' .sdd/workflow.yaml",
    }), "exec")).toEqual({ skills: ["sdd-plan"], workflows: ["SDD"] });
    expect(executionContextFromToolInput("installed skill: sdd-plan", "message")).toEqual({
      skills: [],
      workflows: [],
    });
    expect(executionContextFromToolInput(JSON.stringify({
      cmd: "rtk proxy node -e 'const example = \"rtk cat .agents/skills/sdd-plan/SKILL.md\"'",
    }), "exec")).toEqual({ skills: [], workflows: [] });
    expect(executionContextFromToolInput(
      'await tools.exec_command({ cmd: "rtk cat .agents/skills/sdd-run/SKILL.md" });',
      "exec",
    )).toEqual({ skills: ["sdd-run"], workflows: ["SDD"] });
    expect(executionContextFromToolInput(
      'await tools.exec_command({"cmd":"rtk sed -n \'1,80p\' .agents/skills/sdd-review/SKILL.md"});',
      "exec",
    )).toEqual({ skills: ["sdd-review"], workflows: ["SDD"] });
    expect(executionContextFromToolInput(
      'const patch = "test cmd: \\\"rtk cat .agents/skills/sdd-plan/SKILL.md\\\"";',
      "exec",
    )).toEqual({ skills: [], workflows: [] });
  });

  it("uses explicit task completion for a child without treating notLoaded as completion", () => {
    const text = [
      line("2026-08-24T01:00:00.000Z", "event_msg", { type: "task_started" }),
      line("2026-08-24T01:00:01.000Z", "response_item", {
        type: "custom_tool_call",
        name: "exec",
        call_id: "call-1",
      }),
      line("2026-08-24T01:00:02.000Z", "response_item", {
        type: "custom_tool_call_output",
        call_id: "call-1",
      }),
      line("2026-08-24T01:00:03.000Z", "event_msg", { type: "task_complete" }),
    ].join("\n");

    const completed = parseRolloutState(text, "child-1", false, false);
    const unknown = parseRolloutState("", "child-2", false, false);

    expect(completed.lifecycle).toBe("completed");
    expect(completed.activities[0]).toMatchObject({
      id: "call-1",
      kind: "command",
      outcome: "completed",
    });
    expect(unknown.nativeStatus).toEqual({ type: "notLoaded" });
    expect(unknown.lifecycle).toBeUndefined();
  });

  it("keeps a completed interactive root ready for another turn", () => {
    const state = parseRolloutState(
      [
        line("2026-08-24T01:00:00.000Z", "event_msg", { type: "task_started" }),
        line("2026-08-24T01:00:01.000Z", "event_msg", { type: "task_complete" }),
      ].join("\n"),
      "root-1",
      true,
      true,
    );

    expect(state.nativeStatus).toEqual({ type: "idle" });
    expect(state.lifecycle).toBeUndefined();
  });

  it("recognizes a long-running turn when its task_started event is outside the retained tail", () => {
    const state = parseRolloutState(
      line("2026-08-24T01:00:02.000Z", "response_item", {
        type: "custom_tool_call",
        name: "exec",
        call_id: "call-late",
      }),
      "root-1",
      true,
      true,
    );

    expect(state.nativeStatus).toEqual({ type: "active", activeFlags: [] });
    expect(state.lifecycle).toBe("running");
  });

  it("reports user-input waiting only while the request call is unresolved", () => {
    const state = parseRolloutState(
      [
        line("2026-08-24T01:00:00.000Z", "event_msg", { type: "task_started" }),
        line("2026-08-24T01:00:01.000Z", "response_item", {
          type: "function_call",
          name: "request_user_input",
          call_id: "question-1",
        }),
      ].join("\n"),
      "root-1",
      true,
      true,
    );

    expect(state.nativeStatus).toEqual({ type: "active", activeFlags: ["waitingOnUserInput"] });
  });

  it("finds interactive Codex cwd values and ignores service subcommands", () => {
    const procRoot = mkdtempSync(join(tmpdir(), "observatory-proc-"));
    const project = join(procRoot, "project");
    mkdirSync(project);
    for (const [pid, command] of [
      ["101", ["/usr/local/bin/codex", "--yolo", "resume"]],
      ["102", ["/usr/local/bin/codex", "app-server", "--listen", "unix://"]],
    ] as const) {
      const dir = join(procRoot, pid);
      mkdirSync(dir);
      writeFileSync(join(dir, "cmdline"), `${command.join("\0")}\0`);
      symlinkSync(project, join(dir, "cwd"));
    }

    expect(findInteractiveCodexCwds(procRoot)).toEqual(new Map([[project, 1]]));
  });
});
