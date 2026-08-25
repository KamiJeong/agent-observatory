export type AgentRuntimeStatus =
  | "working"
  | "waiting"
  | "idle"
  | "completed"
  | "failed"
  | "unknown";

export type WaitingReason = "approval" | "userInput" | "elicitation";

export type NativeThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | {
      type: "active";
      activeFlags: Array<"waitingOnApproval" | "waitingOnUserInput" | string>;
    };

export type ActivityKind =
  | "thinking"
  | "tool"
  | "command"
  | "read"
  | "write"
  | "test"
  | "message"
  | "approval"
  | "error"
  | "unknown";

export interface AgentActivity {
  id: string;
  agentId: string;
  kind: ActivityKind;
  title: string;
  detail?: string;
  startedAt: number;
  completedAt?: number;
  outcome?: "completed" | "failed" | "declined" | "interrupted";
  metadata?: Record<string, unknown>;
}

export type HistoryActor =
  | { type: "human"; label?: string }
  | { type: "agent"; id?: string; label?: string }
  | { type: "system"; label?: string };

export type HistoryEventKind =
  | "request"
  | "decision"
  | "work"
  | "handoff"
  | "delivery"
  | "completion";

export interface HistoryEvent {
  id: string;
  kind: HistoryEventKind;
  actor: HistoryActor;
  recipients?: HistoryActor[];
  summary: string;
  content?: string;
  status?: "started" | "running" | "sent" | "completed" | "failed" | "interrupted";
  turnId?: string;
  correlationId?: string;
  parentEventId?: string;
  occurredAt: number;
  source: "protocol" | "compatibility" | "derived" | "mock";
}

export interface TokenUsageSnapshot {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  modelContextWindow?: number;
}

export interface AgentNode {
  id: string;
  threadId: string;
  parentId?: string;
  sessionId?: string;
  nickname?: string;
  role?: string;
  status: AgentRuntimeStatus;
  nativeStatus?: NativeThreadStatus;
  waitingReasons: WaitingReason[];
  startedAt?: number;
  updatedAt?: number;
  completedAt?: number;
  currentActivityId?: string;
  recentActivityIds: string[];
  children: string[];
  cwd?: string;
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string;
  observedSkills?: string[];
  observedWorkflows?: string[];
  collaborationMode?: string;
  currentTurnId?: string;
  tokenUsage?: TokenUsageSnapshot;
  source?: unknown;
  depth?: number;
  path?: string;
  completionEvidence?: "collab-completed" | "collab-errored" | "turn-failed";
}

export interface ThreadSnapshot {
  id: string;
  sessionId?: string;
  parentThreadId?: string;
  forkedFromId?: string;
  nickname?: string;
  role?: string;
  nativeStatus: NativeThreadStatus;
  createdAt?: number;
  updatedAt?: number;
  cwd?: string;
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string;
  observedSkills?: string[];
  observedWorkflows?: string[];
  collaborationMode?: string;
  source?: unknown;
  depth?: number;
  path?: string;
}

export interface AgentGraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface PendingRequest {
  id: string;
  agentId: string;
  reason: WaitingReason;
  title: string;
  detail?: string;
  openedAt: number;
}

export type ConnectionPhase =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

export interface ConnectionState {
  phase: ConnectionPhase;
  attempt: number;
  message?: string;
  nextRetryAt?: number;
}

export interface RuntimeInfo {
  adapter: "mock" | "codex";
  observatoryVersion: string;
  codexCliVersion?: string;
  protocolGenerationVersion?: string;
  experimentalApi: boolean;
  discoveryStrategy: "mock" | "experimental-descendants" | "compatibility";
  scenario?: string;
}

export interface DebugEntry {
  id: string;
  at: number;
  direction: "in" | "out" | "internal";
  category: "protocol" | "normalized" | "connection" | "malformed";
  method?: string;
  summary: string;
  payload?: unknown;
}

export interface ObservatoryState {
  agents: Record<string, AgentNode>;
  activities: AgentActivity[];
  history: HistoryEvent[];
  pendingRequests: Record<string, PendingRequest>;
  selectedAgentId?: string;
  connection: ConnectionState;
  runtime: RuntimeInfo;
  debug: DebugEntry[];
  startedAt: number;
  revision: number;
}

export interface ObservatorySnapshot extends ObservatoryState {
  roots: string[];
  edges: AgentGraphEdge[];
}

export type AgentLifecycleStatus =
  | "pendingInit"
  | "running"
  | "interrupted"
  | "completed"
  | "errored"
  | "shutdown"
  | "notFound";

export type CodexRuntimeEvent =
  | { type: "thread.discovered"; at: number; thread: ThreadSnapshot }
  | {
      type: "thread.status";
      at: number;
      threadId: string;
      status: NativeThreadStatus;
    }
  | {
      type: "agent.lifecycle";
      at: number;
      threadId: string;
      status: AgentLifecycleStatus;
      message?: string;
    }
  | { type: "turn.started"; at: number; threadId: string; turnId: string }
  | {
      type: "turn.completed";
      at: number;
      threadId: string;
      turnId: string;
      status: "completed" | "interrupted" | "failed";
      error?: string;
    }
  | { type: "activity.started"; at: number; activity: AgentActivity }
  | {
      type: "activity.completed";
      at: number;
      threadId: string;
      activityId: string;
      activity?: AgentActivity;
      outcome?: AgentActivity["outcome"];
    }
  | { type: "history.recorded"; at: number; history: HistoryEvent }
  | { type: "request.opened"; at: number; request: PendingRequest }
  | {
      type: "request.resolved";
      at: number;
      requestId: string;
      threadId?: string;
    }
  | { type: "token.updated"; at: number; threadId: string; usage: TokenUsageSnapshot }
  | { type: "connection.changed"; at: number; connection: ConnectionState }
  | { type: "runtime.updated"; at: number; runtime: RuntimeInfo }
  | { type: "debug"; at: number; entry: DebugEntry };

export interface DiscoveryOptions {
  rootThreadId?: string;
}

export interface ReadThreadOptions {
  includeTurns?: boolean;
}

export interface CodexAdapter {
  readonly mode: "mock" | "codex";
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  listThreads(options?: DiscoveryOptions): Promise<ThreadSnapshot[]>;
  listLoadedThreads(): Promise<string[]>;
  readThread(threadId: string, options?: ReadThreadOptions): Promise<ThreadSnapshot>;
  subscribe(listener: (event: CodexRuntimeEvent) => void): () => void;
  runtimeInfo(): RuntimeInfo;
}
