import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type {
  CodexAdapter,
  CodexRuntimeEvent,
  DiscoveryOptions,
  ReadThreadOptions,
  RuntimeInfo,
  ThreadSnapshot,
} from "@observatory/core";
import { normalizeEnvelope, parseEnvelope, toThreadSnapshot, type JsonRpcEnvelope } from "./normalize.ts";

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

const ALL_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
];

function messageFromError(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "message" in value && typeof value.message === "string") {
    return value.message;
  }
  return "Unknown App Server error";
}

export class RealCodexAdapter implements CodexAdapter {
  readonly mode = "codex" as const;
  #listeners = new Set<(event: CodexRuntimeEvent) => void>();
  #child?: ChildProcessWithoutNullStreams;
  #pending = new Map<string | number, PendingCall>();
  #nextId = 1;
  #connected = false;
  #closing = false;
  #reconnectTimer?: ReturnType<typeof setTimeout>;
  #attempt = 0;
  #experimental = true;
  #strategy: RuntimeInfo["discoveryStrategy"] = "experimental-descendants";
  #codexVersion = "unknown";

  runtimeInfo(): RuntimeInfo {
    return {
      adapter: "codex",
      observatoryVersion: "0.1.0",
      codexCliVersion: this.#codexVersion,
      protocolGenerationVersion: "0.149.0",
      experimentalApi: this.#experimental,
      discoveryStrategy: this.#strategy,
    };
  }

  async connect(): Promise<void> {
    this.#closing = false;
    await this.#open();
  }

  async disconnect(): Promise<void> {
    this.#closing = true;
    this.#connected = false;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#child?.kill("SIGTERM");
    this.#child = undefined;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("App Server disconnected"));
    }
    this.#pending.clear();
    this.#emit({
      type: "connection.changed",
      at: Date.now(),
      connection: { phase: "disconnected", attempt: this.#attempt, message: "Disconnected" },
    });
  }

  subscribe(listener: (event: CodexRuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async listThreads(options?: DiscoveryOptions): Promise<ThreadSnapshot[]> {
    if (options?.rootThreadId && this.#experimental) {
      try {
        const descendants = await this.#pageThreads({ ancestorThreadId: options.rootThreadId });
        this.#strategy = "experimental-descendants";
        return descendants;
      } catch (error) {
        this.#experimental = false;
        this.#strategy = "compatibility";
        this.#emit({ type: "runtime.updated", at: Date.now(), runtime: this.runtimeInfo() });
        this.#debug("connection", "Experimental descendant discovery unavailable; using compatibility mode", error);
      }
    }
    const threads = await this.#pageThreads({});
    if (!options?.rootThreadId) return threads;
    const ids = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const thread of threads) {
        if (
          thread.parentThreadId === options.rootThreadId ||
          (thread.parentThreadId && ids.has(thread.parentThreadId))
        ) {
          if (!ids.has(thread.id)) {
            ids.add(thread.id);
            changed = true;
          }
        }
      }
    }
    return threads.filter((thread) => ids.has(thread.id));
  }

  async listLoadedThreads(): Promise<string[]> {
    const result = await this.#request("thread/loaded/list", {});
    if (!result || typeof result !== "object" || !("data" in result) || !Array.isArray(result.data)) return [];
    return result.data.filter((id): id is string => typeof id === "string");
  }

  async readThread(threadId: string, options?: ReadThreadOptions): Promise<ThreadSnapshot> {
    const result = await this.#request("thread/read", {
      threadId,
      includeTurns: options?.includeTurns ?? false,
    });
    const thread = result && typeof result === "object" && "thread" in result ? toThreadSnapshot(result.thread) : undefined;
    if (!thread) throw new Error(`Invalid thread/read response for ${threadId}`);
    return thread;
  }

  async #open(): Promise<void> {
    this.#emit({
      type: "connection.changed",
      at: Date.now(),
      connection: {
        phase: this.#attempt === 0 ? "connecting" : "reconnecting",
        attempt: this.#attempt,
        message: "Connecting to Codex App Server",
      },
    });
    const version = spawnSync("codex", ["--version"], { encoding: "utf8" });
    this.#codexVersion = version.stdout.trim().replace(/^codex-cli\s+/, "") || "unknown";

    const transport = process.env.OBSERVATORY_CODEX_TRANSPORT ?? "standalone";
    const args = transport === "proxy" ? ["app-server", "proxy"] : ["app-server"];

    const child = spawn("codex", args, { stdio: ["pipe", "pipe", "pipe"] });
    this.#child = child;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.#onLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) this.#debug("protocol", text);
    });
    child.once("exit", (code, signal) => this.#onExit(code, signal));

    try {
      await this.#request("initialize", {
        clientInfo: {
          name: "codex_agent_observatory",
          title: "Codex Agent Observatory",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      });
      this.#send({ method: "initialized", params: {} });
      this.#connected = true;
      this.#attempt = 0;
      this.#emit({
        type: "connection.changed",
        at: Date.now(),
        connection: {
          phase: "connected",
          attempt: 0,
          message: args.at(-1) === "proxy" ? "Connected through App Server daemon" : "Connected to child App Server",
        },
      });
      this.#emit({ type: "runtime.updated", at: Date.now(), runtime: this.runtimeInfo() });
      await this.#refreshDiscovery();
    } catch (error) {
      child.kill("SIGTERM");
      throw error;
    }
  }

  async #refreshDiscovery(): Promise<void> {
    const rootThreadId = process.env.OBSERVATORY_ROOT_THREAD_ID;
    const threads = rootThreadId
      ? [await this.readThread(rootThreadId), ...(await this.listThreads({ rootThreadId }))]
      : await this.listThreads();
    for (const thread of threads) this.#emit({ type: "thread.discovered", at: Date.now(), thread });
  }

  async #pageThreads(extra: Record<string, unknown>): Promise<ThreadSnapshot[]> {
    const all: ThreadSnapshot[] = [];
    const configuredCwd = process.env.OBSERVATORY_CWD ?? process.env.INIT_CWD ?? process.cwd();
    let cursor: string | null = null;
    do {
      const result = await this.#request("thread/list", {
        ...extra,
        cursor,
        limit: 100,
        sourceKinds: ALL_SOURCE_KINDS,
        archived: false,
      });
      if (!result || typeof result !== "object") break;
      const data = "data" in result && Array.isArray(result.data) ? result.data : [];
      for (const value of data) {
        const thread = toThreadSnapshot(value);
        if (thread) all.push(thread);
      }
      cursor = "nextCursor" in result && typeof result.nextCursor === "string" ? result.nextCursor : null;
    } while (cursor);
    return configuredCwd === "all" || "ancestorThreadId" in extra
      ? all
      : all.filter((thread) => thread.cwd === configuredCwd);
  }

  #request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after 10 seconds`));
      }, 10_000);
      this.#pending.set(id, { resolve, reject, timeout });
      try {
        this.#send({ method, id, params });
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #send(envelope: JsonRpcEnvelope): void {
    if (!this.#child?.stdin.writable) throw new Error("Codex App Server stdin is not writable");
    this.#child.stdin.write(`${JSON.stringify(envelope)}\n`);
    this.#debug("protocol", `→ ${envelope.method ?? "response"}`, envelope, "out");
  }

  #onLine(line: string): void {
    const envelope = parseEnvelope(line);
    if (!envelope) {
      this.#debug("malformed", "Malformed JSONL message", line);
      return;
    }
    this.#debug("protocol", `← ${envelope.method ?? "response"}`, envelope);
    if (envelope.id !== undefined && !envelope.method) {
      const pending = this.#pending.get(envelope.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.#pending.delete(envelope.id);
        if (envelope.error !== undefined) pending.reject(new Error(messageFromError(envelope.error)));
        else pending.resolve(envelope.result);
      }
      return;
    }
    for (const event of normalizeEnvelope(envelope)) {
      this.#emit(event);
      this.#debug("normalized", event.type, event);
    }
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.#connected = false;
    this.#child = undefined;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Codex App Server exited"));
    }
    this.#pending.clear();
    if (this.#closing) return;
    this.#attempt += 1;
    const base = Math.min(15_000, 500 * 2 ** Math.min(this.#attempt - 1, 5));
    const delay = base + Math.floor(Math.random() * Math.max(1, base * 0.2));
    this.#emit({
      type: "connection.changed",
      at: Date.now(),
      connection: {
        phase: "reconnecting",
        attempt: this.#attempt,
        message: `App Server exited (${code ?? signal ?? "unknown"})`,
        nextRetryAt: Date.now() + delay,
      },
    });
    this.#reconnectTimer = setTimeout(() => {
      void this.#open().catch((error) => {
        this.#debug("connection", "Reconnect failed", error);
      });
    }, delay);
  }

  #emit(event: CodexRuntimeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #debug(
    category: "protocol" | "normalized" | "connection" | "malformed",
    summary: string,
    payload?: unknown,
    direction: "in" | "out" | "internal" = "in",
  ): void {
    this.#emit({
      type: "debug",
      at: Date.now(),
      entry: {
        id: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
        at: Date.now(),
        direction: category === "connection" ? "internal" : direction,
        category,
        summary,
        ...(payload !== undefined ? { payload } : {}),
      },
    });
  }
}
