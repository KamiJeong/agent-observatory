# Claude Code compatibility adapter

The Claude adapter is a passive, read-only compatibility collector. It does not
inject hooks, attach to a Claude process, or modify `~/.claude`.

## Observed sources

The implementation has been verified against Claude Code 2.1.241 and tolerates
unknown or malformed JSONL records. It currently observes:

- interactive process working directories from Linux procfs;
- root transcript file descriptors exposed by Linux procfs when Claude keeps
  them open;
- root transcripts at `~/.claude/projects/<encoded-project>/<session>.jsonl`;
- subagent transcripts and metadata under
  `<session>/subagents/agent-*.{jsonl,meta.json}`.

These paths and record shapes are compatibility inputs, not a public Claude Code
API. The parser therefore ignores fields it does not understand and uses the
`compatibility` evidence label.

## Live-session selection

The live graph never loads every transcript for a matching project directory.
For each interactive Claude process, the adapter first selects a root transcript
that appears in `/proc/<pid>/fd`. An open subagent transcript is resolved back to
its owning root. When Claude does not keep a transcript descriptor open, the
adapter selects the newest root transcript for that process cwd. N processes in
one cwd select at most N roots.

Only selected roots and their transcript subagents are parsed. Agent Team
metadata is applied only when a selected root session anchors that team. When a
process exits, the root subtree and its projected activity, narrative history,
and pending requests are removed from the live state. Transcript files are never
deleted or modified.

## Agent teams beta

Agent-team observation is explicitly beta. It has been checked against the local
storage and protocol discriminators shipped with Claude Code 2.1.241. Agent teams
must be enabled in Claude Code itself with
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`; Observatory never enables the feature
or creates a team.

For a live team, the adapter passively reads:

- `~/.claude/teams/<session-derived-name>/config.json` for the lead and current
  member roster;
- `~/.claude/tasks/<session-derived-name>/*.json` for task IDs, owners, and the
  `pending`, `in_progress`, or `completed` state;
- `~/.claude/teams/<session-derived-name>/inboxes/*.json` for sender, recipient,
  timestamp, read state, and supported protocol discriminators.

The adapter labels config members as `teamLead` or `teammate` and labels ordinary
transcript children as `subagent` in their source metadata. Team members also
carry `collaborationMode: claude-agent-team-beta`. When member session IDs are
available, the config evidence enriches the matching independent transcript;
otherwise a metadata-only team node is shown as idle rather than inventing an
active state.

Supported beta coordination events are:

| Claude evidence | Normalized result |
| --- | --- |
| task file state | Generic task-created, in-progress, or completed history |
| `task_assignment` mailbox protocol | Task relationship from sender to recipient |
| `task_completed` mailbox protocol | Generic task completion relationship |
| plain mailbox envelope | Peer message relationship |
| `idle_notification` | Teammate idle state and generic completion history |
| `shutdown_request` | Generic shutdown-request handoff |
| approved `shutdown_response` or legacy `shutdown_approved` | Shutdown lifecycle and generic completion history |
| rejected `shutdown_response` or `shutdown_rejected` | Generic rejection history; teammate remains idle/running as otherwise observed |
| `teammate_terminated` | Shutdown lifecycle from explicit termination evidence |

Only these exact states and protocol types are interpreted. A shutdown request
does not itself mark a teammate as stopped. Unknown message protocols remain a
generic peer message, and task state is not used to infer that a process is
working because Claude task status can lag.

Team configs are transient in current Claude Code and are removed at session
teardown, while task directories can persist. Observatory reads task lists only
when a corresponding valid live team config exists. A malformed config during an
atomic update is treated as temporarily unavailable evidence, not as a shutdown.
Mailbox evidence can preserve an explicit shutdown approval for a member already
removed from the current roster, preventing that member from remaining working.

## Identity and relationships

- A root thread is namespaced as `claude:<session-id>`.
- A subagent is namespaced as `claude:<session-id>:<agent-id>`.
- A subagent metadata `toolUseId` is matched to the thread that emitted that tool
  call. If no owner can be established, the root session is used as the parent.
- `spawnDepth` and `agentType` are retained when present. Descriptions are not
  retained because they can contain task content.

## Privacy boundary

Bounded prompt and final-response text is copied only when the runtime content
capture policy is enabled. Thinking, commands, paths from tool inputs, tool
results, and subagent descriptions are never copied into Observatory events.
Without content capture, the adapter emits generic request, response, and tool
labels plus timing, lifecycle, model, and token metadata.

The same boundary applies to agent teams. Team descriptions, teammate prompts,
task subjects/descriptions/active forms, mailbox text and summaries, idle
summaries, shutdown reasons, pane IDs, and unknown fields are discarded. Member
names, agent IDs/types, session IDs, models, working directories, task IDs/status,
owners, sender/recipient identities, and timestamps are treated as observability
metadata.

## Runtime integration

`ClaudeCodeAdapter` implements the provider-neutral runtime adapter contract. A
single-provider launch can select it directly; simultaneous Codex and Claude
observation should wrap it with the composite adapter. `OBSERVATORY_CWD=all`
disables working-directory filtering, while the normal default is the launch
working directory.

## Known limits and future enrichment

- Process and cwd discovery is exact on Linux procfs; transcript file-descriptor
  matching is best-effort because Claude may open files only while writing.
- Other platforms do not currently expose Claude sessions in the live graph
  because reliable process matching is not implemented. Historical transcripts
  are deliberately not used as a substitute for live state.
- Root idle/working and subagent completion are inferred from transcript tails;
  unsupported records remain unknown/idle instead of inventing activity.
- Very large transcripts are read from a bounded tail, so token totals represent
  the observed window rather than guaranteed lifetime totals.
- Official `SubagentStart`/`SubagentStop`, permission, and tool hooks can later
  improve real-time precision. OpenTelemetry can enrich parent IDs, model, and
  usage. Those sources should normalize to the same runtime events and take
  precedence over compatibility inference when available.
- Agent teams are an experimental Claude Code capability and their local config,
  mailbox, and task formats can change without a compatibility guarantee. The
  adapter deliberately has no inference for plan approval, rejected shutdown,
  pane/process health, deleted tasks, or unknown message protocols.
- In-process teammate resumption and task coordination have upstream limitations.
  A surviving stale task directory is not evidence that its former team is live.
