# Codex App Server protocol survey

This document records the Phase 1 protocol findings for Codex Agent Observatory.
It is intentionally tied to the locally installed Codex version. Generated types,
not remembered method names, are the implementation source of truth.

## Survey baseline

- Survey date: 2026-08-24
- Codex CLI: `codex-cli 0.149.0`
- Node.js: `v24.15.0`
- Bun: `1.3.14`
- Host: WSL2 Linux x86_64
- Official reference: [Codex App Server](https://learn.chatgpt.com/docs/app-server)

The following artifacts were generated from this exact CLI version:

```text
generated/codex/                       stable TypeScript bindings
generated/codex-schema/                stable JSON Schema bundle
generated/codex-experimental/          experimental TypeScript bindings
generated/codex-schema-experimental/   experimental JSON Schema bundle
```

Regenerate them after every Codex CLI upgrade:

```bash
codex app-server generate-ts --out ./generated/codex
codex app-server generate-json-schema --out ./generated/codex-schema
codex app-server generate-ts --out ./generated/codex-experimental --experimental
codex app-server generate-json-schema --out ./generated/codex-schema-experimental --experimental
```

Generated files must not be edited by hand.

## Transport and handshake

App Server uses bidirectional JSON-RPC 2.0-shaped messages but omits the
`jsonrpc: "2.0"` member on the wire.

- `stdio://` is the default transport and uses one JSON object per line.
- `ws://IP:PORT` uses one message per WebSocket text frame. The official docs
  classify this transport as experimental and unsupported for production.
- `unix://` and `unix://PATH` expose WebSocket connections over a Unix socket.

The Observatory backend should initially own a child `codex app-server` process
and communicate over stdio. This keeps process, filesystem, and protocol access
out of the browser and avoids depending on the experimental App Server
WebSocket listener. The backend exposes its own normalized WebSocket contract to
the React application.

### Local transport validation

On the surveyed machine, a dedicated `codex app-server` child completed the
initialize handshake, paginated `thread/list`, and returned the expected runtime
version. The managed daemon also reported `running` at version 0.149.0, but
`codex app-server proxy` did not forward an initialize response and timed out.
The official `codex agents` command does attach to the shared local runtime and
was verified to show active sessions from multiple working directories. Its
host control socket uses internal framing that is not part of the generated
App Server schema, so Observatory does not parse or imitate it.

Real Mode therefore defaults to an isolated `shared` compatibility adapter in
this environment. It reads Codex's versioned `threads` and
`thread_spawn_edges` state tables read-only, selects roots backed by live Codex
process working directories, and follows bounded rollout tails using filesystem
events. Completion requires an explicit `task_complete` event; missing or
unloaded state remains unknown. The generated JSONL App Server adapter remains
available as `standalone`, while daemon `proxy` stays opt-in.

Every connection must perform this sequence before other requests:

1. Send `initialize` once with Observatory client metadata.
2. Wait for a successful response.
3. Send the `initialized` notification.
4. Start discovery and continue consuming notifications and server requests.

Experimental methods and fields require
`initialize.params.capabilities.experimentalApi = true`. The adapter should be
able to reconnect without that capability when experimental negotiation or an
experimental discovery request fails.

## Stable discovery API

The stable bindings expose these APIs needed by the MVP:

| Method | Use in Observatory | Important behavior |
| --- | --- | --- |
| `thread/list` | Discover persisted threads and metadata | Cursor-paginated; `turns` is empty in list results |
| `thread/loaded/list` | Find thread IDs currently loaded in memory | Being absent does not mean completed |
| `thread/read` | Read one thread, optionally with turns | Does not resume or subscribe to the thread |
| `thread/start` | Create a thread owned by a client | Emits `thread/started` and subscribes that connection |
| `thread/resume` | Load and subscribe to an existing thread | Must not be used merely to inspect history |
| `thread/unsubscribe` | Drop this connection's subscription | A later `thread/closed` indicates unloading, not completion |

`thread/list` defaults to interactive source kinds when `sourceKinds` is omitted.
Discovery that needs subagents must explicitly include relevant source kinds:

```text
subAgent
subAgentReview
subAgentCompact
subAgentThreadSpawn
subAgentOther
```

Use cursor pagination and a bounded initial horizon. Do not repeatedly scan full
history or poll the list at a short interval.

## Experimental discovery API

Codex 0.149.0 exposes two useful `thread/list` filters only in the experimental
bindings:

- `parentThreadId`: direct children of a thread.
- `ancestorThreadId`: all spawned descendants at any depth, excluding the
  ancestor. It is mutually exclusive with `parentThreadId`.

It also exposes:

- `thread/turns/list`: cursor-paginated turn history with `itemsView` equal to
  `notLoaded`, `summary`, or `full`.
- `thread/items/list`: cursor-paginated persisted items, optionally scoped to a
  turn.

These features belong behind an adapter-owned `AgentDiscoveryStrategy`. The
preferred strategy uses `ancestorThreadId`; compatibility mode combines stable
thread listing, loaded thread IDs, persisted parent metadata, and observed live
events. Experimental failure must not stop the dashboard.

## Thread and subagent metadata

The generated `Thread` type contains the graph fields needed by the MVP:

| Field | Meaning |
| --- | --- |
| `id` | Thread ID; generated Codex IDs are UUIDv7 |
| `sessionId` | Session ID shared by threads in one session tree |
| `parentThreadId` | Parent thread ID when this thread is a subagent |
| `forkedFromId` | Source thread for a fork; not interchangeable with parent |
| `agentNickname` | Optional nickname assigned to a spawned subagent |
| `agentRole` | Optional spawned-agent role |
| `source` | CLI/app-server/subagent origin metadata |
| `cwd` | Thread working directory |
| `createdAt`, `updatedAt` | Unix timestamps in seconds |
| `status` | Native runtime status, kept separate from Observatory status |

For thread-spawned agents, `source.subAgent.thread_spawn` additionally carries
`parent_thread_id`, `depth`, `agent_path`, `agent_nickname`, and `agent_role`.
The normalizer may use these as corroborating metadata but should prefer the
top-level, camel-cased `Thread` fields for the normal graph projection.

Do not treat a fork as a subagent solely because `forkedFromId` is present.

Two item variants provide additional live multi-agent evidence:

- `collabAgentToolCall`: tool (`spawnAgent`, `sendInput`, `resumeAgent`, `wait`,
  or `closeAgent`), sender thread ID, receiver thread IDs, prompt, model,
  reasoning effort, call status, and last-known receiver states.
- `subAgentActivity`: activity kind (`started`, `interacted`, or `interrupted`),
  agent thread ID, and agent path.

`CollabAgentStatus` values are `pendingInit`, `running`, `interrupted`,
`completed`, `errored`, `shutdown`, and `notFound`.

## Runtime status projection

Native status and Observatory status remain distinct fields. The initial
projection is evidence-based:

| Protocol evidence | Observatory status | Notes |
| --- | --- | --- |
| `active` with `waitingOnApproval` | `waiting` | Waiting reason: approval |
| `active` with `waitingOnUserInput` | `waiting` | Waiting reason: user input |
| `active` without waiting flags | `working` | A turn is active |
| `idle` | `idle` | Loaded but no active turn |
| `systemError` | `failed` | Native thread error evidence |
| `notLoaded` | `unknown` | Runtime is unloaded; completion is not implied |
| collab state `completed` | `completed` | Explicit subagent completion evidence |
| collab state `errored` | `failed` | Explicit subagent failure evidence |
| completed turn | no automatic thread completion | A thread can accept another turn |
| `thread/closed` | no automatic completion | It can mean unload after inactivity |

If both waiting flags are present, preserve both reasons in the domain state and
choose a deterministic short label in the UI. Unknown future flags must be
retained in debug data and otherwise ignored safely.

## Runtime event surface

The primary incremental inputs are:

| Event/request | Projection use |
| --- | --- |
| `thread/started` | Add or refresh an agent node and graph metadata |
| `thread/status/changed` | Update native and Observatory runtime status |
| `turn/started` | Mark current turn and working activity |
| `turn/completed` | Record completed/interrupted/failed turn outcome |
| `item/started` | Start a normalized activity |
| `item/completed` | Complete or fail the matching activity |
| `item/agentMessage/delta` | Optional bounded message preview update |
| command/file/tool delta events | Optional live detail without replacing item lifecycle |
| `thread/tokenUsage/updated` | Attach current usage when available |
| `error` | Record retryable or terminal turn error evidence |
| `serverRequest/resolved` | Clear a pending approval/input request |

Server-initiated requests are stronger waiting evidence than text inference:

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `item/tool/requestUserInput`
- `mcpServer/elicitation/request`

All relevant request payloads carry a `threadId`; approval and user-input
requests also carry turn/item identifiers. Pending request IDs should be tracked
per thread and removed on `serverRequest/resolved`. The native
`ThreadStatus.activeFlags` remains the canonical compact status signal, while
the pending request record supplies inspector detail.

## Item-to-activity normalization

The stable `ThreadItem` union supports a useful human-readable activity model:

| Item variant | Initial activity kind |
| --- | --- |
| `reasoning` | `thinking` |
| `commandExecution` | `command`, or `read` when parsed actions prove a read |
| `fileChange` | `write` |
| `mcpToolCall`, `dynamicToolCall` | `tool` |
| `collabAgentToolCall`, `subAgentActivity` | `tool` or `message` with agent context |
| `agentMessage`, `userMessage` | `message` |
| failed item/turn | `error` |
| unknown future variant | `unknown` |

`commandExecution.commandActions` can prove `read`, `listFiles`, and `search`
operations. It cannot generally prove that an arbitrary command is a test, so a
`test` activity classification must only be added through a deliberately narrow,
tested command classifier. `fileChange.changes` supplies path, change kind, and
diff; UI summaries should not expose the whole diff by default.

## Compatibility and parsing decisions

1. Keep generated bindings in a dedicated protocol package and regenerate them
   rather than hand-maintaining a broad protocol mirror.
2. Parse the outer JSON-RPC envelope tolerantly. Route known methods to narrow
   validation/normalization functions and retain unknown methods only in the
   bounded debug buffer.
3. Do not reject a known event solely because it has additional fields.
4. A malformed event is quarantined in a bounded debug log and must not crash
   the connection or state store.
5. Preserve raw native status separately from the projected Observatory status.
6. Cap normalized timeline history (MVP target: 300 events) and debug protocol
   history independently.
7. Record at runtime: CLI version, generated-protocol version, Observatory
   version, experimental capability state, and active discovery strategy.

## Adapter implications

The Phase 2 adapter boundary should support read-only observation without making
the UI understand JSON-RPC:

```ts
interface CodexAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  listThreads(options?: ThreadDiscoveryOptions): Promise<ThreadSnapshot[]>;
  listLoadedThreads(): Promise<string[]>;
  readThread(threadId: string, options?: ReadThreadOptions): Promise<ThreadSnapshot>;
  discoverDescendants(rootThreadId: string): Promise<AgentGraphSnapshot>;
  subscribe(listener: (event: CodexRuntimeEvent) => void): () => void;
}
```

This is an Observatory-owned interface, not a copy of generated protocol types.
The real adapter converts generated DTOs at its boundary. A mock adapter emits
the same domain-facing snapshots and runtime events.

One implementation question remains for Phase 5 validation: whether connecting
to an already-running App Server and discovering loaded threads is sufficient to
receive every subsequent event for those threads, or whether an explicit
resume/subscription action is needed. The dashboard must not mutate or resume
threads merely to observe them until that behavior is verified against the
running server.

## Phase 1 conclusion

Codex 0.149.0 provides enough stable metadata and live events for the MVP tree,
status, inspector, and timeline. Experimental descendant filters improve tree
discovery materially but are not required for correctness. Completion cannot be
derived from load state or a completed turn; the projector must keep `unknown`
or `idle` unless explicit subagent completion/failure evidence exists.
