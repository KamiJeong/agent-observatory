# Agent Observatory

[English](README.md) | [한국어](README.ko.md)

Agent Observatory is a local agent observability dashboard for viewing Codex and
Claude Code root-agent and subagent relationships, execution status, current activity,
approval or user-input waits, and recent tool, file, and command activity in one
place.

Rather than displaying raw logs, it normalizes provider protocol and local
compatibility evidence into Observatory domain events and projects them onto an
agent graph and a bounded activity timeline.

Its goal is to quickly answer the following questions when multiple agents
are working in parallel:

- Who is working right now?
- Which agents are waiting for user input or approval?
- How are parent agents and subagents connected?
- Which model, effort, skill, and workflow evidence does each agent use?
- Which command, tool, and file activities occurred recently?
- Which tasks finished, and where did problems occur?

![Status](https://img.shields.io/badge/status-MVP-3b82f6)
![Codex](https://img.shields.io/badge/Codex-0.149.0-64748b)
![Claude Code](https://img.shields.io/badge/Claude_Code-2.1.241-d97757)
[![npm version](https://img.shields.io/npm/v/agent-observatory)](https://www.npmjs.com/package/agent-observatory)
[![npm downloads](https://img.shields.io/npm/dm/agent-observatory)](https://www.npmjs.com/package/agent-observatory)

## Demo

![Agent Observatory showing Codex and Claude agents in one dashboard](docs/assets/agent-observatory-demo.png)

<details>
<summary>Watch the provider filter, relationship view, Inspector, and Workflow Board</summary>

![Agent Observatory multi-provider interaction demo](docs/assets/agent-observatory-demo.gif)

</details>

The demo uses a deterministic, content-safe fixture rather than local session
data. Reproduce it with `bunx agent-observatory --scenario demo`.

## Quick Start

### Run directly with bunx

Run without installing the npm package separately. The default is Mock Mode,
which works without either provider CLI and opens a browser automatically.

```bash
bunx agent-observatory
```

Use Real Mode to observe Codex, Claude Code, or both on the current machine.

```bash
bunx agent-observatory --real
bunx agent-observatory --real --provider claude
bunx agent-observatory --real --provider all
```

For backward compatibility, `--real` defaults to Codex. Use `--provider all`
for the combined dashboard.

You can also limit observation to a specific working directory or disable
automatic browser launch.

```bash
bunx agent-observatory --real --cwd /absolute/path/to/project
bunx agent-observatory --scenario stress --no-open
```

The default address is <http://127.0.0.1:4317>. Run
`bunx agent-observatory --help` to see all options.

### Package registry

The canonical public package is
[`agent-observatory` on npmjs.org](https://www.npmjs.com/package/agent-observatory).
The repository intentionally does not publish a duplicate scoped package to
GitHub Packages, so an empty **Packages** section in the GitHub repository
sidebar is expected. GitHub Releases and npm versions are kept aligned by the
release workflow.

### Clone the repository for development

#### 1. Start in Mock Mode

Explore the complete UI with fixtures and real-time mock events, even when
Codex is not installed.

```bash
git clone https://github.com/KamiJeong/agent-observatory.git
cd agent-observatory
bun install
bun run dev
```

Open the `Agent Observatory server` bootstrap URL printed by the backend.
It sets an HttpOnly local session cookie and redirects to
<http://127.0.0.1:4318> without leaving credentials in the dashboard URL.

#### 2. Observe currently running agents

Use Real Mode when at least one selected provider CLI is installed and an agent
workflow is running locally.

```bash
codex --version
claude --version
bun run dev:real
bun run dev:real -- --provider codex
bun run dev:real -- --provider claude
```

The development launcher opens the authenticated dashboard automatically when
possible. Otherwise, open the printed `Dashboard bootstrap` URL. It observes
Codex and Claude by default; `--provider codex` or `--provider claude` limits the
run to one provider. The shared compatibility transport discovers all active
Codex working directories observable on the current machine. Use `--no-open` to
suppress the browser launch.

To view only one project, specify its exact working directory. The development
launcher accepts the same scope on Linux, macOS, PowerShell, and Command Prompt.

```bash
bun run dev:real -- --cwd /absolute/path/to/project
```

## Dashboard layout

- **Agents**: Parent/child tree, status, role, model/effort, and skill/workflow evidence
- **Provider Health & Filters**: Independent Codex/Claude health plus provider, workspace, session, status, and search filters
- **Agent Graph**: Spawn topology plus task, handoff, and message relationships with evidence
- **Workflow Board**: Agent lanes grouped by observed workflow, sortable by Started/Status/Updated
- **Run History**: Human-readable request, decision, handoff, delivery, and completion story scoped to the selected agent branch
- **Trace**: Selected-branch low-level timeline with virtualized tool, command, file, test, and error filters
- **Inspector**: Runtime metadata, available token usage, and virtualized recent activity for the selected agent
- **Debug**: Protocol events, normalized events, and connection/version diagnostics

The Workflow Board's `Observed order` is derived from agent start or update
times. It does not represent a workflow stage or orchestration ownership
declared by a provider. When no supporting evidence exists, the UI displays
`No workflow evidence` instead of guessing.

## Architecture

```text
Codex protocol/state ── RealCodexAdapter ─┐
                                         │
Claude transcripts ── ClaudeCodeAdapter ─┼─ CompositeRuntimeAdapter
                                         │             │
Mock scenario ──────── MockCodexAdapter ─┘             ▼
                                              normalized events
                                                      │
                                                      ▼
                                             Agent state projector
                                                      │
                                                      ▼
                                           Local HTTP/WebSocket server
                                                      │
                                                      ▼
                                                React dashboard
```

```text
apps/
  server/src/http/        API routing, session, WebSocket, and static-delivery modules
  web/src/components/    Reusable React components grouped by dashboard feature
  web/src/lib/           Framework-independent graph layout utilities
packages/
  codex-protocol/         generated-protocol version boundary
  observatory-core/       domain types, graph/status projector, state store
generated/
  codex*/                 Codex 0.149.0 generated TS and JSON Schema
docs/
  architecture.md         Module boundaries and dependency rules
  accessibility.md        WCAG measurements and release verification checklist
  codex-protocol.md       Phase 1 protocol findings and mapping decisions
```

See [Architecture boundaries](docs/architecture.md) for the module ownership,
dependency direction, and extension points used by the server and dashboard.
The [accessibility verification guide](docs/accessibility.md) records measured
contrast, automated coverage, and the manual release checklist.

Raw provider records are never consumed by React components. Known envelopes
are tolerantly normalized; additive fields are allowed, malformed events go to
a bounded debug buffer, and unknown methods do not crash the dashboard.

## Features

- Collapsible parent/child agent list with native-evidence-based status
- Codex and Claude agents in one failure-isolated composite runtime
- Provider health plus provider/session/workspace/status/search filters
- Actionable setup, empty, permission, unsupported-version, and partial-failure states
- Root/subagent tree with semantic HTML nodes and SVG connectors
- Spawn, task, handoff, and message relationships with evidence provenance
- Graph pan, zoom, fit, keyboard selection, and active selection highlight
- Agent list, graph nodes, and Inspector expose observed model and reasoning effort
- Observed skill/workflow context with Agent filters and per-node markers
- Evidence-based Workflow Board with observed-order/status/update sorting
- Human/agent run history with explicit sender, recipients, and completion state; bounded content appears only for fixtures or explicit opt-in capture
- Selection-scoped Story, Messages, and low-level Trace views; no global history is shown without an agent selection
- Inspector with virtualized recent activity, thread, cwd, and provider-reported token usage details
- Virtualized activity timeline with filters and a 300-event memory bound
- Explicit approval and user-input waiting reasons
- Claude Agent Teams beta roles, task coordination, peer messages, and shutdown evidence
- Connection state and exponential reconnect with jitter
- Optional bounded protocol debug panel
- Mock scenarios A, B, demo, and 35-agent stress mode
- Responsive reflow: agent list → graph → activity

Status is not guessed:

```text
active + waiting flag  → WAITING
active                 → WORKING
idle                   → IDLE
systemError            → FAILED
notLoaded              → UNKNOWN
collab completed       → COMPLETED
```

In particular, `notLoaded` and `thread/closed` never imply completion.

## Platform support

| Provider | Platform | Real Mode discovery | Status |
| --- | --- | --- | --- |
| Codex | Linux / WSL2 | Reads interactive process cwd values from `/proc` | Supported; locally verified on WSL2 Linux |
| Codex | macOS | Finds processes with `ps` and resolves cwd values with `lsof` | Implemented; native-device verification pending |
| Codex | Windows | Uses PowerShell CIM; honors `-C`/`--cd`, otherwise selects recent Codex state | Implemented; native-device verification pending |
| Claude | Linux / WSL2 | Uses procfs cwd discovery plus bounded transcript and Agent Teams compatibility evidence | Supported; locally verified on WSL2 Linux |
| Claude | macOS / Windows | Uses transcript-only historical discovery without exact live process mapping | Compatibility fallback; native-device verification pending |

Codex and Observatory must run in the same OS environment and use the same
`CODEX_HOME`. For example, a native Windows Observatory cannot discover Codex
running inside WSL; run both inside WSL or both on Windows.

On native Windows, starting Codex with an explicit cwd gives Observatory an
exact process-to-project mapping:

```powershell
codex -C C:\projects\my-app
bun run dev:real -- --cwd C:\projects\my-app
```

Without `-C`/`--cd`, Windows does not expose a process working directory through
CIM. Observatory remains usable by selecting the newest unarchived root per
detected interactive Codex process, and records that approximation in Debug.

## Requirements

- Node.js 22.13 or later (`node:sqlite` is required)
- Bun 1.3.14
- Codex CLI 0.149.x for Real Mode
- Claude Code 2.1.241 for the currently verified Claude compatibility adapter
- macOS: the system `ps` and `lsof` commands
- Windows: Windows PowerShell with CIM available

Mock Mode does not require either agent CLI. Real Mode requires only the
provider selected with `--provider`.

## Development

```bash
bun run dev          # server :4317 + Vite :4318, Mock scenario A
bun run dev:real     # Real Mode launcher; observes Codex + Claude by default
bun run typecheck
bun run test
bun run test:e2e
bun run build
bun run demo:capture # regenerate the content-safe README PNG/GIF; requires ffmpeg
```

Contributions use short-lived branches and pull requests into `main`. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the branch, review, CI, and npm release
workflow.

After `bun run build`, the local backend can serve the production web bundle:

```bash
bun run --filter @observatory/server start
```

Then open the tokenized local bootstrap URL printed by the server. The token is
used once to establish an HttpOnly, SameSite session cookie and is removed from
the browser URL by a redirect.

## Mock Mode

Scenario A is the Definition-of-Done lifecycle:

```text
Main ●
├─ Researcher ● → ✓
├─ Implementer ● → ✓
└─ Tester ● → ◐ approval → ● → ✓
```

Run another fixture with:

```bash
OBSERVATORY_SCENARIO=b bun run dev
OBSERVATORY_SCENARIO=demo bun run dev
OBSERVATORY_SCENARIO=stress bun run dev
```

- `a`: spawn, activity, completion, approval waiting, recovery
- `b`: nested frontend/test agent, completed backend, failed reviewer
- `demo`: deterministic Codex + Claude provider, relationship, filter, and workflow showcase
- `stress`: 35 agents with continuous deterministic status/activity updates

## Real Codex Mode

Real Mode defaults to the shared compatibility transport. It discovers the
interactive Codex processes currently running on the machine, selects their
root threads from Codex's versioned state database, builds descendant trees
from `thread_spawn_edges`, and follows their rollout events with filesystem
watchers. This allows one dashboard to show multiple working directories such
as `project-a` and `project-b` together.

```bash
bun run dev:real
```

The shared transport defaults to every active Codex working directory. Set
`OBSERVATORY_CWD` only when a dashboard should be restricted to one exact path.

Environment options:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OBSERVATORY_ADAPTER` | `mock` | Set to `real` for provider-backed Real Mode |
| `OBSERVATORY_PROVIDERS` | `codex` in the server; `codex,claude` in `dev:real` | `codex`, `claude`, or comma-separated providers |
| `OBSERVATORY_PORT` | `4317` | Backend HTTP/WebSocket port |
| `OBSERVATORY_CWD` | `all` in shared mode | Exact cwd filter; use `all` to disable |
| `OBSERVATORY_ROOT_THREAD_ID` | unset | Include one root plus its descendants |
| `OBSERVATORY_CODEX_TRANSPORT` | `shared` | `shared`, `standalone`, or experimental `proxy` |
| `OBSERVATORY_SCENARIO` | `a` | Mock fixture: `a`, `b`, `demo`, or `stress` |
| `OBSERVATORY_CAPTURE_CONTENT` | unset | Set to `1` to expose bounded provider content in the local browser; metadata-only by default |

Example:

```bash
bun run dev:real -- --root-thread 019f...
bun run dev:real -- --provider codex,claude
```

### Real-time observation boundary

The preferred source remains the generated App Server protocol. App Server
subscriptions are connection/runtime scoped, however, and a newly spawned
dedicated App Server cannot reconstruct live state owned by another process.
The `shared` transport is an isolated compatibility adapter for the surveyed
Codex 0.149.0 environment. It uses explicit `task_started`, `task_complete`,
`turn_context` model/effort, and tool-call evidence from bounded rollout tails;
it never treats `notLoaded` as completion. Updates are driven by filesystem
notifications with a 15-second safety refresh, rather than aggressive polling.
Skill badges mean a recent tool command explicitly read that skill's `SKILL.md`;
they do not mean the skill is merely installed. Workflow badges currently use
explicit collaboration mode/plan tools and observed `.sdd` workflow evidence.

`OBSERVATORY_CODEX_TRANSPORT=proxy` is reserved for attaching through the
managed App Server daemon. The current host uses an internal control-socket
framing path: the official `codex agents` screen can browse it, but a public
JSON-RPC initialize sent through `codex app-server proxy` does not receive a
response. Proxy therefore remains progressive enhancement.

Use `OBSERVATORY_CODEX_TRANSPORT=standalone` to test the generated JSONL
protocol adapter directly. Persisted threads belonging to other runtimes are
correctly shown as `UNKNOWN` in that mode.

## Supported Codex version

The checked-in protocol artifacts and normalizer were reviewed against:

```text
codex-cli 0.149.0
```

The shared compatibility adapter is also smoke-tested with `codex-cli 0.149.1`.

At runtime the debug panel records:

- Codex CLI version
- generated protocol version
- Observatory version
- experimental API state
- active discovery strategy

Other Codex versions may work because parsing is additive-field tolerant, but
they are not claimed as supported until bindings are regenerated and tests pass.

## Real Claude Code Mode

Claude observation is a version-aware, read-only compatibility adapter. It
discovers active working directories on Linux and reads bounded root/subagent
transcript tails plus Agent Teams beta config, task, and mailbox metadata. It
does not retain prompts, responses, thinking, commands, tool input, task text,
or mailbox content. Other platforms currently use transcript-only historical
discovery. Official hooks and OpenTelemetry remain planned accuracy
enhancements. See [Claude compatibility](docs/claude-compatibility.md) for the
evidence, privacy, and version boundaries.

## Protocol generation

After changing the installed Codex version:

```bash
codex --version
codex app-server --help
codex app-server generate-ts --help
codex app-server generate-json-schema --help

codex app-server generate-ts --out ./generated/codex
codex app-server generate-json-schema --out ./generated/codex-schema
codex app-server generate-ts --out ./generated/codex-experimental --experimental
codex app-server generate-json-schema --out ./generated/codex-schema-experimental --experimental
```

Then update the reviewed version constant in
`packages/codex-protocol/src/index.ts`, revise
[`docs/codex-protocol.md`](docs/codex-protocol.md), and run the full test suite.
Generated files must not be edited manually.

Experimental APIs used when available:

- `thread/list({ ancestorThreadId })`
- `thread/list({ parentThreadId })`
- `thread/turns/list`
- `thread/items/list`

Failure falls back to compatibility discovery from thread metadata and observed
events.

## Testing

```bash
bun run test         # unit, integration, CLI, and UI test suite
bun run test:e2e     # Chromium mock lifecycle
bun run build        # typecheck + production frontend build
```

Coverage includes:

- native → Observatory status projection
- parent-child graph construction
- malformed/unknown protocol input
- command/test/file/tool activity normalization
- explicit collab completion evidence
- mock adapter → state integration
- graph/list node selection and waiting-state inspector
- browser spawn → complete → wait → inspector flow

## Troubleshooting

### Browser does not open automatically

Minimal Linux containers and headless environments may not provide `xdg-open`.
Observatory continues running and prints its local URL when automatic browser
launch is unavailable. Disable browser launch explicitly and open the URL
manually:

```bash
bunx agent-observatory --real --no-open
```

### Dashboard stays disconnected

Check the backend first:

```bash
curl http://127.0.0.1:4317/api/health
```

The browser retries its local WebSocket with exponential backoff. The Real
adapter separately retries App Server process exits. Use the Debug panel for
connection and protocol summaries; raw stack traces are not exposed in the
main UI.

If the dashboard reports that authentication is required, do not open the Vite
port directly. Restart Observatory and use the newest `Agent Observatory server`
or `Dashboard bootstrap` URL. Sessions from an earlier server process
are intentionally invalid after restart.

### Real Mode shows UNKNOWN

This usually means App Server returned `status: { type: "notLoaded" }`. That is
valid and does not mean the task completed. Confirm that Observatory is attached
to the runtime that owns the thread, or use Mock Mode while developing the UI.

### No threads appear in Real Mode

The default cwd scope may not match the thread. Supply the exact directory or
disable the scope:

```bash
bun run dev:real -- --cwd /path/to/project
bun run dev:real -- --cwd all
```

For a known workflow root, prefer `OBSERVATORY_ROOT_THREAD_ID` so experimental
descendant discovery can be used without loading unrelated history into the UI.

### Experimental discovery is unavailable

The adapter logs a compatibility notice, disables the experimental strategy,
and continues with stable metadata. The dashboard should remain usable.

## Scope

This MVP intentionally does not provide a terminal emulator, orchestration
engine, IDE, Git client, session replay, cloud sync, analytics, or token billing.
Its job is to answer who is working, what they are doing, what is waiting, what
finished, and where an error occurred.
