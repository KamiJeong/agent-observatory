# Architecture boundaries

The repository keeps transport, domain state, and presentation concerns in
separate modules. New code should follow the dependency direction below:

```text
Codex adapters -> observatory-core -> HTTP/WebSocket transport -> UI store -> feature components
```

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
- `http/public-payload.ts`: removal of private debug payloads at the transport
  boundary.

Add a small endpoint to `api-router.ts`. If an API area gains its own state or
several endpoints, put it in a dedicated module and let the router delegate to
it. Authentication and response headers remain shared boundary concerns.

## Web modules

`apps/web/src/components` is organized by dashboard feature:

- `dashboard`: page composition and application lifecycle.
- `agents`: reusable list and interactive graph views.
- `workflows`: the evidence-based workflow board.
- `activity`: timeline, recent activity, and inspector views.
- `shared`: presentation helpers and small shared UI elements.

Framework-independent graph calculations live in `apps/web/src/lib`. Feature
components receive snapshots, selection state, and callbacks through props;
only the dashboard shell connects directly to `uiStore`. `App.tsx` is a public
barrel that preserves stable imports for tests and consumers.

When adding a view, keep data access in the dashboard shell, pass only the
required data through props, and extract pure calculations to `lib` when they
can be tested without React.
