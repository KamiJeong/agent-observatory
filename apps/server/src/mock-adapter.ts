import type {
  AgentActivity,
  CodexAdapter,
  CodexRuntimeEvent,
  DiscoveryOptions,
  NativeThreadStatus,
  ReadThreadOptions,
  RuntimeInfo,
  ThreadSnapshot,
} from "@observatory/core";

type Scenario = "a" | "b" | "stress";

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

export class MockCodexAdapter implements CodexAdapter {
  readonly mode = "mock" as const;
  #scenario: Scenario;
  #threads = new Map<string, ThreadSnapshot>();
  #listeners = new Set<(event: CodexRuntimeEvent) => void>();
  #timers: Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>> = [];
  #connected = false;

  constructor(scenario: string = "a") {
    this.#scenario = scenario === "b" || scenario === "stress" ? scenario : "a";
    const root = baseThread("mock-main", "Main", "root", active());
    this.#threads.set(root.id, root);
    if (this.#scenario === "b") this.#seedScenarioB();
    if (this.#scenario === "stress") this.#seedStress();
  }

  runtimeInfo(): RuntimeInfo {
    return {
      adapter: "mock",
      observatoryVersion: "0.1.0",
      protocolGenerationVersion: "0.149.0",
      experimentalApi: false,
      discoveryStrategy: "mock",
      scenario: this.#scenario,
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
    if (this.#scenario === "a") this.#runScenarioA();
    if (this.#scenario === "b") this.#runScenarioB();
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

  subscribe(listener: (event: CodexRuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: CodexRuntimeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #schedule(delay: number, action: () => void): void {
    this.#timers.push(setTimeout(() => this.#connected && action(), delay));
  }

  #discover(thread: ThreadSnapshot): void {
    this.#threads.set(thread.id, thread);
    this.#emit({ type: "thread.discovered", at: Date.now(), thread });
  }

  #activity(agentId: string, id: string, kind: AgentActivity["kind"], title: string, detail?: string): void {
    const now = Date.now();
    this.#emit({
      type: "activity.started",
      at: now,
      activity: { id, agentId, kind, title, ...(detail ? { detail } : {}), startedAt: now },
    });
  }

  #runScenarioA(): void {
    this.#schedule(500, () => {
      this.#discover(baseThread("mock-researcher", "Researcher", "research", active(), "mock-main", 1));
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
