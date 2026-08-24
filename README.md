# Codex Agent Observatory

Codex Agent Observatory는 Codex root agent와 subagent의 관계, 실행 상태,
현재 활동, approval/user-input 대기, 최근 tool/file/command를 한 화면에서 보는
로컬 Agent Observability Dashboard입니다.

로그를 그대로 출력하는 viewer가 아니라 Codex App Server protocol을
Observatory domain event로 정규화한 뒤, agent graph와 bounded activity timeline으로
projection합니다.

여러 Codex가 병렬로 일할 때 다음 질문에 빠르게 답하는 것이 목표입니다.

- 지금 누가 작업 중인가?
- 어떤 Agent가 사용자 입력이나 approval을 기다리는가?
- Parent와 subagent는 어떻게 연결되어 있는가?
- 각 Agent는 어떤 model, effort, skill, workflow evidence를 사용하는가?
- 최근 어떤 command, tool, file activity가 발생했는가?
- 어느 작업이 끝났고 어디에서 문제가 발생했는가?

![Status](https://img.shields.io/badge/status-MVP-3b82f6)
![Codex](https://img.shields.io/badge/Codex-0.149.0-64748b)

## Quick Start

### npx로 바로 실행

npm package를 별도로 설치하지 않고 실행할 수 있습니다. 기본값은 Codex가 없어도
동작하는 Mock Mode이며, 실행 후 브라우저가 자동으로 열립니다.

```bash
npx agent-observatory
```

현재 머신에서 실행 중인 Codex agent들을 관측하려면 Real Mode를 사용합니다.

```bash
npx agent-observatory --real
```

특정 working directory만 보거나 브라우저를 자동으로 열지 않을 수도 있습니다.

```bash
npx agent-observatory --real --cwd /absolute/path/to/project
npx agent-observatory --scenario stress --no-open
```

기본 주소는 <http://127.0.0.1:4317>입니다. 모든 옵션은
`npx agent-observatory --help`로 확인할 수 있습니다.

### 저장소를 clone해서 개발

#### 1. Mock Mode로 시작

Codex가 설치되어 있지 않아도 fixture와 실시간 mock event로 전체 UI를 확인할 수
있습니다.

```bash
git clone https://github.com/KamiJeong/agent-observatory.git
cd agent-observatory
npm install
npm run dev
```

브라우저에서 <http://127.0.0.1:4318>을 엽니다.

#### 2. 현재 실행 중인 Codex 관측

Codex CLI가 설치되어 있고 로컬에서 Agent workflow가 실행 중이라면 Real Mode를
사용합니다.

```bash
codex --version
npm run dev:real
```

브라우저에서 <http://127.0.0.1:4318>을 엽니다. 기본 shared compatibility transport는
현재 머신에서 관측 가능한 active Codex working directory를 함께 탐색합니다.

특정 프로젝트만 보고 싶다면 정확한 working directory를 지정합니다.

```bash
OBSERVATORY_CWD=/absolute/path/to/project npm run dev:real
```

## 화면 구성

- **Agents**: Parent/child tree, status, role, model/effort, skill/workflow evidence
- **Agent Graph**: root와 subagent topology, pan/zoom/fit, node selection
- **Workflow Board**: 관측된 workflow별 Agent lane과 Started/Status/Updated 정렬
- **Activity**: tool, command, file, test, error event를 필터링하는 virtualized timeline
- **Inspector**: 선택한 Agent의 runtime metadata와 virtualized recent activity
- **Debug**: protocol event, normalized event, connection/version diagnostics

Workflow Board의 `Observed order`는 Agent 시작 시각이나 업데이트 시각으로 계산한
관측 순서입니다. Codex가 선언한 workflow stage 또는 orchestration ownership으로
간주하지 않습니다. 근거가 없으면 추측하지 않고 `No workflow evidence`로 표시합니다.

## Architecture

```text
Codex App Server (JSONL over stdio)
             │
             ▼
      RealCodexAdapter ───── MockCodexAdapter
             │                       │
             └──── normalized events ┘
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
  server/                 App Server adapter, normalizer, local WebSocket server
  web/                    React/Vite dashboard
packages/
  codex-protocol/         generated-protocol version boundary
  observatory-core/       domain types, graph/status projector, state store
generated/
  codex*/                 Codex 0.149.0 generated TS and JSON Schema
docs/
  codex-protocol.md       Phase 1 protocol findings and mapping decisions
```

Raw Codex JSON is never consumed by React components. Known envelopes are
tolerantly normalized; additive fields are allowed, malformed events go to a
bounded debug buffer, and unknown methods do not crash the dashboard.

## Features

- Collapsible parent/child agent list with native-evidence-based status
- Root/subagent tree with semantic HTML nodes and SVG connectors
- Graph pan, zoom, fit, keyboard selection, and active selection highlight
- Agent list, graph nodes, and Inspector expose observed model and reasoning effort
- Observed skill/workflow context with Agent filters and per-node markers
- Evidence-based Workflow Board with observed-order/status/update sorting
- Inspector with virtualized recent activity, thread, cwd, and optional token usage
- Virtualized activity timeline with filters and a 300-event memory bound
- Explicit approval and user-input waiting reasons
- Connection state and exponential reconnect with jitter
- Optional bounded protocol debug panel
- Mock scenarios A, B, and 35-agent stress mode
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

## Requirements

- Node.js 20.19 이상
- npm 또는 호환되는 `npx` 실행 환경
- Codex CLI 0.149.x for Real Mode

Mock Mode에는 Codex CLI가 필요하지 않습니다.

## Development

```bash
npm run dev          # server :4317 + Vite :4318, Mock scenario A
npm run typecheck
npm test
npm run test:e2e
npm run build
```

After `npm run build`, the local backend can serve the production web bundle:

```bash
npm run start -w @observatory/server
```

Then open <http://127.0.0.1:4317>.

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
OBSERVATORY_SCENARIO=b npm run dev
OBSERVATORY_SCENARIO=stress npm run dev
```

- `a`: spawn, activity, completion, approval waiting, recovery
- `b`: nested frontend/test agent, completed backend, failed reviewer
- `stress`: 35 agents with continuous deterministic status/activity updates

## Real Codex Mode

Real Mode defaults to the shared compatibility transport. It discovers the
interactive Codex processes currently running on the machine, selects their
root threads from Codex's versioned state database, builds descendant trees
from `thread_spawn_edges`, and follows their rollout events with filesystem
watchers. This allows one dashboard to show multiple working directories such
as `project-a` and `project-b` together.

```bash
npm run dev:real
```

The shared transport defaults to every active Codex working directory. Set
`OBSERVATORY_CWD` only when a dashboard should be restricted to one exact path.

Environment options:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OBSERVATORY_ADAPTER` | `mock` | Set to `codex` for Real Mode |
| `OBSERVATORY_PORT` | `4317` | Backend HTTP/WebSocket port |
| `OBSERVATORY_CWD` | `all` in shared mode | Exact cwd filter; use `all` to disable |
| `OBSERVATORY_ROOT_THREAD_ID` | unset | Include one root plus its descendants |
| `OBSERVATORY_CODEX_TRANSPORT` | `shared` | `shared`, `standalone`, or experimental `proxy` |
| `OBSERVATORY_SCENARIO` | `a` | Mock fixture: `a`, `b`, or `stress` |

Example:

```bash
OBSERVATORY_ADAPTER=codex \
OBSERVATORY_ROOT_THREAD_ID=019f... \
npm run dev
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
npm test             # 33 unit, integration, and UI tests
npm run test:e2e     # Chromium mock lifecycle
npm run build        # typecheck + production frontend build
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

### Dashboard stays disconnected

Check the backend first:

```bash
curl http://127.0.0.1:4317/api/health
```

The browser retries its local WebSocket with exponential backoff. The Real
adapter separately retries App Server process exits. Use the Debug panel for
connection and protocol summaries; raw stack traces are not exposed in the
main UI.

### Real Mode shows UNKNOWN

This usually means App Server returned `status: { type: "notLoaded" }`. That is
valid and does not mean the task completed. Confirm that Observatory is attached
to the runtime that owns the thread, or use Mock Mode while developing the UI.

### No threads appear in Real Mode

The default cwd scope may not match the thread. Supply the exact directory or
disable the scope:

```bash
OBSERVATORY_CWD=/path/to/project npm run dev:real
OBSERVATORY_CWD=all npm run dev:real
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
