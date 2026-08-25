# Architecture boundaries

The repository keeps transport, domain state, and presentation concerns in
separate modules. New code should follow the dependency direction below:

```text
provider adapters -> composite adapter -> observatory-core -> HTTP/WebSocket transport -> UI store -> feature components
```

## Runtime boundary

Every provider implements the provider-neutral `AgentRuntimeAdapter` contract
and emits `AgentRuntimeEvent`. The old `CodexAdapter` and `CodexRuntimeEvent`
exports are compatibility aliases only; new shared code must not depend on
them.

Provider adapters normalize native protocol, hook, or transcript evidence into
the shared event model. Unknown or weak native evidence stays `unknown` rather
than being promoted to a stronger lifecycle state. `CompositeRuntimeAdapter`
merges those streams. At that boundary, all provider-owned identifiers are
namespaced (`codex:<id>`, `claude:<id>`, and so on), including relationship,
activity, history, request, session, and debug identifiers. This makes equal
native IDs safe in one `ObservatoryStore`.

The snapshot exposes two different health concepts:

- `connection` describes the aggregate adapter/dashboard data stream and
  remains compatible with existing clients.
- `providerConnections` records each runtime independently. A failed provider
  therefore does not erase agents or health from providers that remain live.

Runtime-specific implementation details belong in their adapter. The core,
HTTP transport, store, and UI should consume only the provider-neutral names.

## Server modules

`apps/server/src/http-server.ts` is the composition root. It owns adapter
lifecycle and retry state, then wires the following modules together:

- `http/api-router.ts`: HTTP API endpoint routing and responses.
- `http/session-auth.ts`: bootstrap token validation and session cookies.
- `http/request-security.ts`: trusted authority/origin checks and common
  security headers.
- `http/websocket-server.ts`: authenticated WebSocket upgrades, control
  messages, and snapshot broadcasting.
- `http/static-files.ts`: safe dashboard asset resolution and delivery.
- `http/public-payload.ts`: metadata-only filtering of provider content, raw
  thread source, and private debug payloads at the transport boundary.

Adapters emit two complementary streams through `observatory-core`:

- `AgentActivity` retains low-level execution trace such as commands, tools,
  tests, reads, and writes.
- `HistoryEvent` retains the human-readable narrative: requests, explicit
  decisions, work, agent handoffs, deliveries, and completion.

History actors and recipients are first-class fields. Protocol normalizers must
preserve explicit sender, receiver, and bounded message content rather than
placing them in opaque metadata. A decision is recorded only from explicit plan
or commentary evidence; tool execution alone is not treated as a decision.

Add a small endpoint to `api-router.ts`. If an API area gains its own state or
several endpoints, put it in a dedicated module and let the router delegate to
it. Authentication and response headers remain shared boundary concerns.

## Web modules

`apps/web/src/components` is organized by dashboard feature:

- `dashboard`: page composition and application lifecycle.
- `agents`: reusable list and interactive graph views.
- `workflows`: the evidence-based workflow board.
- `activity`: story/messages/trace history, recent activity, and inspector views.
- `shared`: presentation helpers and small shared UI elements.

Framework-independent graph calculations live in `apps/web/src/lib`. Feature
components receive snapshots, selection state, and callbacks through props;
only the dashboard shell connects directly to `uiStore`. `App.tsx` is a public
barrel that preserves stable imports for tests and consumers.

When adding a view, keep data access in the dashboard shell, pass only the
required data through props, and extract pure calculations to `lib` when they
can be tested without React.
