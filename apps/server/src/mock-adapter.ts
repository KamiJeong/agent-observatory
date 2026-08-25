import type {
  AgentActivity,
  AgentRuntimeAdapter,
  AgentRuntimeEvent,
  DiscoveryOptions,
  HistoryEvent,
  NativeThreadStatus,
  ReadThreadOptions,
  RuntimeInfo,
  RuntimeProvider,
  ThreadSnapshot,
} from "@observatory/core";
import { OBSERVATORY_VERSION } from "./version.ts";

type Scenario = "a" | "b" | "demo" | "stress";

const active = (flags: string[] = []): NativeThreadStatus => ({ type: "active", activeFlags: flags });

function baseThread(
  id: string,
  nickname: string,
  role: string,
  nativeStatus: NativeThreadStatus,
  parentThreadId?: string,
  depth = 0,
): ThreadSnapshot {
  const now = Date.now();
  return {
    id,
    sessionId: "mock-session",
    ...(parentThreadId ? { parentThreadId } : {}),
    nickname,
    role,
    nativeStatus,
    createdAt: now - Math.max(1, 7 - depth) * 42_000,
    updatedAt: now,
    cwd: "/projects/codex-agent-observatory",
    model: depth === 0 ? "gpt-5.6-sol" : "gpt-5.6-terra",
    modelProvider: "openai",
    reasoningEffort: depth === 0 ? "high" : "medium",
    observedSkills: depth === 0 ? [] : [`mock-${role}`],
    observedWorkflows: ["Mock lifecycle"],
    collaborationMode: "default",
    source: parentThreadId
      ? { subAgent: { thread_spawn: { parent_thread_id: parentThreadId, depth } } }
      : "cli",
    depth,
    path: parentThreadId ? `/root/${nickname.toLowerCase()}` : "/root",
  };
}

function demoThread({
  id,
  sessionId,
  nickname,
  role,
  provider,
  nativeStatus,
  parentThreadId,
  depth = 0,
  model,
  modelProvider,
  updatedOffset = 0,
}: {
  id: string;
  sessionId: string;
  nickname: string;
  role: string;
  provider: RuntimeProvider;
  nativeStatus: NativeThreadStatus;
  parentThreadId?: string;
  depth?: number;
  model: string;
  modelProvider: string;
  updatedOffset?: number;
}): ThreadSnapshot {
  const now = Date.now();
  return {
    provider,
    id,
    sessionId,
    ...(parentThreadId ? { parentThreadId } : {}),
    nickname,
    role,
    nativeStatus,
    createdAt: now - Math.max(1, 8 - depth) * 38_000,
    updatedAt: now - updatedOffset,
    cwd: "/projects/agent-observatory-demo",
    model,
    modelProvider,
    reasoningEffort: depth === 0 ? "high" : "medium",
    observedSkills: depth === 0 ? [] : [role === "teammate" ? "privacy-review" : "release-verification"],
    observedWorkflows: ["Multi-runtime release"],
    collaborationMode: provider === "claude" ? "claude-agent-team-beta" : "default",
    source: { provider, observation: "demo-fixture", contentCaptured: false },
    evidenceSources: ["mock"],
    depth,
    path: parentThreadId ? `/release/${nickname.toLowerCase().replaceAll(" ", "-")}` : `/release/${provider}`,
  };
}

export class MockCodexAdapter implements AgentRuntimeAdapter {
  readonly provider = "mock" as const;
  readonly mode = "mock" as const;
  #scenario: Scenario;
  #threads = new Map<string, ThreadSnapshot>();
  #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  #timers: Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>> = [];
  #connected = false;

  constructor(scenario: string = "a") {
    this.#scenario = scenario === "b" || scenario === "demo" || scenario === "stress" ? scenario : "a";
    if (this.#scenario === "demo") {
      this.#seedDemo();
      return;
    }
    const root = baseThread("mock-main", "Main", "root", active());
    this.#threads.set(root.id, root);
    if (this.#scenario === "b") this.#seedScenarioB();
    if (this.#scenario === "stress") this.#seedStress();
  }

  runtimeInfo(): RuntimeInfo {
    return {
      adapter: "mock",
      provider: this.provider,
      observatoryVersion: OBSERVATORY_VERSION,
      protocolGenerationVersion: "0.149.0",
      experimentalApi: false,
      discoveryStrategy: "mock",
      scenario: this.#scenario,
      contentCapture: "enabled",
    };
  }

  async connect(): Promise<void> {
    if (this.#connected) return;
    this.#connected = true;
    for (const thread of this.#threads.values()) {
      this.#emit({ type: "thread.discovered", at: Date.now(), thread });
    }
    this.#emit({
      type: "connection.changed",
      at: Date.now(),
      connection: { phase: "connected", attempt: 0, message: `Mock scenario ${this.#scenario.toUpperCase()}` },
    });
    if (this.#scenario === "a") {
      const now = Date.now();
      this.#history({
        id: "mock-request",
        kind: "request",
        actor: { type: "human" },
        recipients: [{ type: "agent", id: "mock-main" }],
        summary: "Request received",
        content: "Inspect the Codex agent run and report verified results.",
        status: "completed",
        occurredAt: now,
        source: "mock",
      });
      this.#history({
        id: "mock-decision",
        kind: "decision",
        actor: { type: "agent", id: "mock-main" },
        summary: "Plan updated",
        content: "Research the protocol, implement the projector, then verify it in the browser.",
        status: "completed",
        occurredAt: now + 1,
        source: "mock",
      });
      this.#runScenarioA();
    }
    if (this.#scenario === "b") this.#runScenarioB();
    if (this.#scenario === "demo") this.#runDemo();
    if (this.#scenario === "stress") this.#runStress();
  }

  async disconnect(): Promise<void> {
    this.#connected = false;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers = [];
    this.#emit({
      type: "connection.changed",
      at: Date.now(),
      connection: { phase: "disconnected", attempt: 0, message: "Mock stream stopped" },
    });
  }

  async listThreads(options?: DiscoveryOptions): Promise<ThreadSnapshot[]> {
    const threads = Array.from(this.#threads.values());
    if (!options?.rootThreadId) return threads;
    const descendants = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const thread of threads) {
        if (
          thread.parentThreadId === options.rootThreadId ||
          (thread.parentThreadId && descendants.has(thread.parentThreadId))
        ) {
          if (!descendants.has(thread.id)) {
            descendants.add(thread.id);
            changed = true;
          }
        }
      }
    }
    return threads.filter((thread) => descendants.has(thread.id));
  }

  async listLoadedThreads(): Promise<string[]> {
    return Array.from(this.#threads.values())
      .filter((thread) => thread.nativeStatus.type !== "notLoaded")
      .map((thread) => thread.id);
  }

  async readThread(threadId: string, _options?: ReadThreadOptions): Promise<ThreadSnapshot> {
    const thread = this.#threads.get(threadId);
    if (!thread) throw new Error(`Mock thread not found: ${threadId}`);
    return thread;
  }

  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: AgentRuntimeEvent): void {
    const tagged = { ...event, provider: event.provider ?? this.provider } as AgentRuntimeEvent;
    for (const listener of this.#listeners) listener(tagged);
  }

  #schedule(delay: number, action: () => void): void {
    this.#timers.push(setTimeout(() => this.#connected && action(), delay));
  }

  #discover(thread: ThreadSnapshot): void {
    this.#threads.set(thread.id, thread);
    this.#emit({ type: "thread.discovered", at: Date.now(), thread });
  }

  #activity(
    agentId: string,
    id: string,
    kind: AgentActivity["kind"],
    title: string,
    detail?: string,
    startedAt = Date.now(),
  ): void {
    this.#emit({
      type: "activity.started",
      at: startedAt,
      activity: { id, agentId, kind, title, ...(detail ? { detail } : {}), startedAt },
    });
  }

  #history(history: HistoryEvent): void {
    this.#emit({ type: "history.recorded", at: history.occurredAt, history });
  }

  #runScenarioA(): void {
    this.#schedule(500, () => {
      this.#discover(baseThread("mock-researcher", "Researcher", "research", active(), "mock-main", 1));
      this.#history({
        id: "mock-research-handoff",
        kind: "handoff",
        actor: { type: "agent", id: "mock-main" },
        recipients: [{ type: "agent", id: "mock-researcher" }],
        summary: "Delegated work",
        content: "Identify the protocol events needed for agent status projection.",
        status: "sent",
        occurredAt: Date.now(),
        source: "mock",
      });
      this.#activity("mock-researcher", "research-web", "tool", "Searching Codex protocol", "thread/status/changed");
    });
    this.#schedule(1_100, () => {
      this.#discover(baseThread("mock-implementer", "Implementer", "implementation", active(), "mock-main", 1));
      this.#activity("mock-implementer", "edit-store", "write", "Editing AgentStore.ts", "packages/core/AgentStore.ts");
    });
    this.#schedule(3_000, () => {
      this.#emit({ type: "agent.lifecycle", at: Date.now(), threadId: "mock-researcher", status: "completed" });
      this.#emit({
        type: "activity.completed",
        at: Date.now(),
        threadId: "mock-researcher",
        activityId: "research-web",
        outcome: "completed",
      });
      this.#history({
        id: "mock-research-delivery",
        kind: "delivery",
        actor: { type: "agent", id: "mock-researcher" },
        recipients: [{ type: "agent", id: "mock-main" }],
        summary: "Reported result",
        content: "Confirmed thread/status/changed as the primary native status signal.",
        status: "completed",
        occurredAt: Date.now(),
        source: "mock",
      });
    });
    this.#schedule(3_800, () => {
      this.#discover(baseThread("mock-tester", "Tester", "testing", active(), "mock-main", 1));
      this.#activity("mock-tester", "run-tests", "test", "Running vitest", "bun run test");
    });
    this.#schedule(5_100, () => {
      this.#emit({
        type: "request.opened",
        at: Date.now(),
        request: {
          id: "mock-approval",
          agentId: "mock-tester",
          reason: "approval",
          title: "Waiting for approval",
          detail: "Run browser outside sandbox",
          openedAt: Date.now(),
        },
      });
    });
    this.#schedule(8_000, () => {
      this.#emit({ type: "request.resolved", at: Date.now(), requestId: "mock-approval", threadId: "mock-tester" });
      this.#activity("mock-tester", "browser-e2e", "test", "Running Playwright", "mock runtime lifecycle");
    });
    this.#schedule(10_500, () => {
      this.#emit({ type: "agent.lifecycle", at: Date.now(), threadId: "mock-tester", status: "completed" });
      this.#emit({ type: "agent.lifecycle", at: Date.now(), threadId: "mock-implementer", status: "completed" });
      this.#history({
        id: "mock-final-delivery",
        kind: "delivery",
        actor: { type: "agent", id: "mock-main" },
        recipients: [{ type: "human" }],
        summary: "Delivered final result",
        content: "Implementation and browser verification completed.",
        status: "completed",
        occurredAt: Date.now(),
        source: "mock",
      });
    });
  }

  #seedScenarioB(): void {
    const entries = [
      baseThread("mock-frontend", "Frontend", "frontend", active(), "mock-main", 1),
      baseThread("mock-test", "Test", "testing", active(), "mock-frontend", 2),
      baseThread("mock-backend", "Backend", "backend", { type: "idle" }, "mock-main", 1),
      baseThread("mock-reviewer", "Reviewer", "review", { type: "systemError" }, "mock-main", 1),
    ];
    for (const entry of entries) this.#threads.set(entry.id, entry);
  }

  #runScenarioB(): void {
    this.#schedule(300, () => this.#activity("mock-frontend", "front-edit", "write", "Editing Dashboard.tsx"));
    this.#schedule(700, () => this.#activity("mock-test", "test-unit", "test", "Running component tests"));
    this.#schedule(1_200, () =>
      this.#emit({ type: "agent.lifecycle", at: Date.now(), threadId: "mock-backend", status: "completed" }),
    );
    this.#schedule(1_400, () =>
      this.#activity("mock-reviewer", "review-error", "error", "Review failed", "Malformed tool response"),
    );
  }

  #seedDemo(): void {
    const threads = [
      demoThread({
        provider: "codex", id: "codex:demo-orchestrator", sessionId: "codex:release-session",
        nickname: "Release Orchestrator", role: "root", nativeStatus: active(),
        model: "gpt-5.6-sol", modelProvider: "openai",
      }),
      demoThread({
        provider: "codex", id: "codex:demo-builder", sessionId: "codex:release-session",
        nickname: "Runtime Builder", role: "implementation", nativeStatus: active(),
        parentThreadId: "codex:demo-orchestrator", depth: 1,
        model: "gpt-5.6-terra", modelProvider: "openai", updatedOffset: 4_000,
      }),
      demoThread({
        provider: "codex", id: "codex:demo-tester", sessionId: "codex:release-session",
        nickname: "Browser Tester", role: "testing", nativeStatus: active(["waitingOnApproval"]),
        parentThreadId: "codex:demo-orchestrator", depth: 1,
        model: "gpt-5.6-terra", modelProvider: "openai", updatedOffset: 7_000,
      }),
      demoThread({
        provider: "claude", id: "claude:demo-lead", sessionId: "claude:team-session",
        nickname: "Claude Team Lead", role: "teamLead", nativeStatus: active(),
        model: "claude-opus-4-1", modelProvider: "anthropic", updatedOffset: 1_500,
      }),
      demoThread({
        provider: "claude", id: "claude:demo-reviewer", sessionId: "claude:team-session",
        nickname: "Privacy Reviewer", role: "teammate", nativeStatus: { type: "idle" },
        parentThreadId: "claude:demo-lead", depth: 1,
        model: "claude-sonnet-4", modelProvider: "anthropic", updatedOffset: 5_000,
      }),
      demoThread({
        provider: "claude", id: "claude:demo-researcher", sessionId: "claude:team-session",
        nickname: "Evidence Researcher", role: "subagent", nativeStatus: { type: "idle" },
        parentThreadId: "claude:demo-lead", depth: 1,
        model: "claude-sonnet-4", modelProvider: "anthropic", updatedOffset: 9_000,
      }),
    ];
    for (const thread of threads) this.#threads.set(thread.id, thread);
  }

  #runDemo(): void {
    const now = Date.now();
    this.#emit({
      type: "provider.connection.changed",
      provider: "codex",
      at: now,
      connection: { phase: "connected", attempt: 0, message: "Codex demo observation active" },
    });
    this.#emit({
      type: "provider.connection.changed",
      provider: "claude",
      at: now,
      connection: { phase: "connected", attempt: 0, message: "Claude demo observation active" },
    });
    this.#history({
      id: "demo-request", kind: "request", actor: { type: "human" },
      recipients: [{ type: "agent", id: "codex:demo-orchestrator" }],
      summary: "Multi-provider release requested",
      content: "Coordinate implementation and verification across Codex and Claude Code.",
      status: "completed", occurredAt: now - 50, source: "mock",
    });
    this.#history({
      id: "demo-plan", kind: "decision", actor: { type: "agent", id: "codex:demo-orchestrator" },
      summary: "Release plan confirmed",
      content: "Build the runtime, review privacy, then complete browser verification.",
      status: "completed", occurredAt: now - 40, source: "mock",
    });
    this.#history({
      id: "demo-provider-handoff", kind: "handoff", relationKind: "handoff",
      actor: { type: "agent", id: "codex:demo-orchestrator" },
      recipients: [{ type: "agent", id: "claude:demo-lead" }],
      summary: "Claude review requested", content: "Validate compatibility evidence and privacy boundaries.",
      status: "sent", occurredAt: now - 30, source: "mock",
    });
    this.#history({
      id: "demo-team-task", kind: "handoff", relationKind: "task",
      actor: { type: "agent", id: "claude:demo-lead" },
      recipients: [{ type: "agent", id: "claude:demo-reviewer" }],
      summary: "Privacy review assigned", content: "Confirm metadata-only payload behavior.",
      status: "sent", occurredAt: now - 20, source: "mock",
    });
    this.#history({
      id: "demo-peer-message", kind: "handoff", relationKind: "message",
      actor: { type: "agent", id: "claude:demo-reviewer" },
      recipients: [{ type: "agent", id: "codex:demo-builder" }],
      summary: "Review evidence shared", content: "Raw provider content remains outside the public payload.",
      status: "sent", occurredAt: now + 10, source: "mock",
    });
    this.#emit({
      type: "token.updated",
      at: now + 4,
      threadId: "codex:demo-orchestrator",
      usage: {
        inputTokens: 20_000,
        cachedInputTokens: 8_000,
        outputTokens: 900,
        reasoningOutputTokens: 300,
        totalTokens: 20_900,
        modelContextWindow: 258_400,
      },
    });
    this.#activity("codex:demo-orchestrator", "demo-coordinate", "message", "Coordinating provider rollout", undefined, now + 15);
    this.#activity("codex:demo-builder", "demo-build", "write", "Implementing composite runtime", "apps/server/src/composite-adapter.ts", now + 20);
    this.#activity("claude:demo-lead", "demo-lead-review", "read", "Reviewing Agent Teams evidence", "metadata-only compatibility evidence", now + 21);
    this.#activity("claude:demo-reviewer", "demo-privacy", "test", "Checking privacy boundary", "provider content redaction", now + 22);
    this.#history({
      id: "demo-build-result", kind: "delivery",
      actor: { type: "agent", id: "codex:demo-builder" },
      recipients: [{ type: "agent", id: "codex:demo-orchestrator" }],
      summary: "Runtime implementation completed",
      content: "Composite provider observation and privacy safeguards are ready for verification.",
      status: "completed", occurredAt: now + 30, source: "mock",
    });
    this.#emit({
      type: "request.opened", at: now + 40,
      request: {
        id: "demo-browser-approval", agentId: "codex:demo-tester", reason: "approval",
        title: "Browser verification approval", detail: "Run the deterministic demo capture",
        openedAt: now + 40, evidenceSource: "mock",
      },
    });
    this.#emit({
      type: "agent.lifecycle", at: now + 50,
      threadId: "claude:demo-researcher", status: "completed",
    });
  }

  #seedStress(): void {
    for (let index = 1; index <= 35; index += 1) {
      const parent = index <= 6 ? "mock-main" : `mock-agent-${((index - 1) % 6) + 1}`;
      const status = index % 7 === 0 ? { type: "idle" as const } : active();
      const thread = baseThread(`mock-agent-${index}`, `Agent ${index}`, index % 3 === 0 ? "testing" : "worker", status, parent, index <= 6 ? 1 : 2);
      this.#threads.set(thread.id, thread);
    }
  }

  #runStress(): void {
    let tick = 0;
    const timer = setInterval(() => {
      if (!this.#connected) return;
      tick += 1;
      const index = (tick % 35) + 1;
      const threadId = `mock-agent-${index}`;
      const waiting = tick % 5 === 0;
      this.#emit({
        type: "thread.status",
        at: Date.now(),
        threadId,
        status: waiting ? active(["waitingOnUserInput"]) : active(),
      });
      this.#activity(threadId, `stress-${tick}`, tick % 3 === 0 ? "test" : "command", tick % 3 === 0 ? "Running tests" : "Running command", `task ${tick}`);
    }, 900);
    this.#timers.push(timer);
  }
}
