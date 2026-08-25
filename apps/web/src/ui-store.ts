import type { ObservatorySnapshot } from "@observatory/core";

type Listener = () => void;

const emptySnapshot: ObservatorySnapshot = {
  agents: {},
  activities: [],
  history: [],
  pendingRequests: {},
  connection: { phase: "connecting", attempt: 0, message: "Connecting to local backend" },
  providerConnections: {},
  runtime: {
    adapter: "mock",
    observatoryVersion: "unknown",
    experimentalApi: false,
    discoveryStrategy: "mock",
  },
  debug: [],
  startedAt: Date.now(),
  revision: 0,
  roots: [],
  edges: [],
};

class UiStore {
  #snapshot = emptySnapshot;
  #listeners = new Set<Listener>();
  #socket?: WebSocket;
  #retryTimer?: ReturnType<typeof setTimeout>;
  #attempt = 0;
  #stopped = false;

  getSnapshot = (): ObservatorySnapshot => this.#snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  start(): void {
    if (this.#socket || this.#stopped) return;
    void this.#loadInitial();
    this.#openSocket();
  }

  retry(): void {
    this.#stopped = false;
    this.#attempt = 0;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#socket?.close();
    this.#socket = undefined;
    void fetch("/api/retry", { method: "POST" }).catch(() => undefined);
    this.#openSocket();
  }

  async #loadInitial(): Promise<void> {
    try {
      const response = await fetch("/api/snapshot");
      if (response.status === 401) {
        this.#stopped = true;
        this.#socket?.close();
        this.#set({
          ...this.#snapshot,
          connection: {
            phase: "disconnected",
            attempt: 0,
            message: "Authentication required. Reopen the dashboard from the current Observatory server URL.",
          },
        });
        return;
      }
      if (!response.ok) return;
      this.#set((await response.json()) as ObservatorySnapshot);
    } catch {
      // The WebSocket retry loop owns the visible connection state.
    }
  }

  #openSocket(): void {
    if (this.#stopped || this.#socket) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socketUrl = new URL(`${protocol}//${window.location.host}/ws`);
    const socket = new WebSocket(socketUrl);
    this.#socket = socket;
    socket.addEventListener("open", () => {
      this.#attempt = 0;
    });
    socket.addEventListener("message", (event) => {
      try {
        const message: unknown = JSON.parse(String(event.data));
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "snapshot" &&
          "snapshot" in message
        ) {
          this.#set(message.snapshot as ObservatorySnapshot);
        }
      } catch {
        // Invalid backend frames are ignored; the backend keeps its own debug log.
      }
    });
    socket.addEventListener("close", () => {
      if (this.#socket === socket) this.#socket = undefined;
      if (this.#stopped) return;
      this.#attempt += 1;
      const base = Math.min(15_000, 500 * 2 ** Math.min(this.#attempt - 1, 5));
      const delay = base + Math.floor(Math.random() * base * 0.2);
      this.#set({
        ...this.#snapshot,
        connection: {
          phase: "reconnecting",
          attempt: this.#attempt,
          message: "Dashboard transport disconnected",
          nextRetryAt: Date.now() + delay,
        },
      });
      this.#retryTimer = setTimeout(() => this.#openSocket(), delay);
    });
    socket.addEventListener("error", () => socket.close());
  }

  #set(snapshot: ObservatorySnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }

}

export const uiStore = new UiStore();
