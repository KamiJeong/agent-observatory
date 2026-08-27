import { useMemo, type CSSProperties } from "react";
import type { HistoryActor, HistoryEvent, ObservatorySnapshot } from "@observatory/core";
import { agentProvider, formatTime, ProviderBadge, roleColor, shortId } from "../shared/presentation.tsx";
import { agentBranchIds, historyEventIsInBranch } from "./agent-scope.ts";
import { useLatestFeed } from "./use-latest-feed.ts";

export type RunHistoryMode = "story" | "messages";

const STORY_KINDS: HistoryEvent["kind"][] = ["request", "decision", "work", "handoff", "delivery", "completion"];
const MESSAGE_KINDS: HistoryEvent["kind"][] = ["request", "handoff", "delivery"];

interface StoryEvent extends HistoryEvent {
  basis?: HistoryEvent;
  workSteps?: HistoryEvent[];
}

function agentId(actor: HistoryActor): string | undefined {
  return actor.type === "agent" ? actor.id : undefined;
}

function eventAddressesAgent(event: HistoryEvent, id: string): boolean {
  return (event.recipients ?? []).some((recipient) => agentId(recipient) === id);
}

function observedBasis(events: HistoryEvent[], work: HistoryEvent): HistoryEvent | undefined {
  const id = agentId(work.actor);
  if (!id) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    if (
      (event.kind === "decision" && agentId(event.actor) === id)
      || (event.kind === "handoff" && eventAddressesAgent(event, id))
      || (event.kind === "request" && event.actor.type === "human" && eventAddressesAgent(event, id))
    ) return event;
  }
  return undefined;
}

function storyEvents(events: HistoryEvent[]): StoryEvent[] {
  const result: StoryEvent[] = [];
  const observed: HistoryEvent[] = [];
  const workGroups = new Map<string, StoryEvent>();
  for (const event of events) {
    if (event.kind !== "work") {
      result.push(event);
      observed.push(event);
      continue;
    }
    const basis = observedBasis(observed, event);
    const actor = agentId(event.actor) ?? "unknown";
    const groupKey = `${actor}:${event.turnId ?? "no-turn"}:${basis?.id ?? Math.floor(event.occurredAt / 300_000)}`;
    const existing = workGroups.get(groupKey);
    if (existing) {
      existing.workSteps?.push(event);
      existing.status = event.status ?? existing.status;
      continue;
    }
    const grouped: StoryEvent = {
      ...event,
      id: `story-execution:${groupKey}`,
      summary: "Observed execution",
      ...(basis ? { basis } : {}),
      workSteps: [event],
    };
    workGroups.set(groupKey, grouped);
    result.push(grouped);
  }
  return result;
}

function phaseLabel(event: HistoryEvent): string {
  if (event.kind === "request") return event.actor.type === "human" ? "Request" : "Approval";
  if (event.kind === "decision") return "Decision";
  if (event.kind === "work") return "Execution";
  if (event.kind === "handoff") return "Handoff";
  if (event.kind === "delivery") return "Result";
  return "Completion";
}

function capturePolicy(snapshot: ObservatorySnapshot, branchIds: Set<string>): "metadata-only" | "enabled" | undefined {
  const providers = new Set([...branchIds].map((id) => snapshot.agents[id]?.provider).filter(Boolean));
  const providerPolicies = (snapshot.runtime.providers ?? [])
    .filter((runtime) => providers.has(runtime.provider))
    .map((runtime) => runtime.contentCapture)
    .filter((policy): policy is "metadata-only" | "enabled" => policy !== undefined);
  if (providerPolicies.length > 0) {
    return providerPolicies.every((policy) => policy === "enabled") ? "enabled" : "metadata-only";
  }
  return snapshot.runtime.contentCapture;
}

function actorLabel(actor: HistoryActor, snapshot: ObservatorySnapshot): string {
  if (actor.type === "human") return "Human";
  if (actor.type === "system") return "System";
  const agent = actor.id ? snapshot.agents[actor.id] : undefined;
  return agent?.nickname ?? agent?.role ?? actor.label ?? (actor.id ? shortId(actor.id) : "Agent");
}

function actorColor(actor: HistoryActor, snapshot: ObservatorySnapshot): string {
  if (actor.type === "human") return "#fcd34d";
  if (actor.type === "system") return "#94a3b8";
  return roleColor(actor.id ? snapshot.agents[actor.id]?.role : undefined);
}

function HistoryRoute({ event, snapshot }: { event: HistoryEvent; snapshot: ObservatorySnapshot }) {
  const actor = event.actor.type === "agent" && event.actor.id ? snapshot.agents[event.actor.id] : undefined;
  const recipients = event.recipients ?? [];
  const senderLabel = actorLabel(event.actor, snapshot);
  const recipientLabels = recipients.map((recipient) => actorLabel(recipient, snapshot));
  return (
    <span
      className="history-event__route"
      aria-label={recipientLabels.length > 0
        ? `From ${senderLabel} to ${recipientLabels.join(", ")}`
        : `From ${senderLabel}`}
    >
      {actor && <ProviderBadge provider={agentProvider(actor, snapshot.runtime.adapter)} compact />}
      <strong>{senderLabel}</strong>
      {recipients.length > 0 && <>
        <span aria-hidden="true">→</span>
        <span className="history-event__recipients">
          {recipients.map((recipient, index) => {
            const recipientId = recipient.type === "agent" ? recipient.id : undefined;
            const recipientAgent = recipientId ? snapshot.agents[recipientId] : undefined;
            return <span key={`${recipient.type}:${recipientId ?? recipient.label ?? index}`}>
              {recipientAgent && <ProviderBadge provider={agentProvider(recipientAgent, snapshot.runtime.adapter)} compact />}
              {actorLabel(recipient, snapshot)}{index < recipients.length - 1 ? "," : ""}
            </span>;
          })}
        </span>
      </>}
    </span>
  );
}

function HistoryContent({ content }: { content: string }) {
  if (content.length <= 240) return <p>{content}</p>;
  return (
    <details className="history-event__content">
      <summary>{content.slice(0, 239)}…</summary>
      <p>{content}</p>
    </details>
  );
}

function ExecutionDetail({ event }: { event: StoryEvent }) {
  const uniqueSteps = [...new Map((event.workSteps ?? []).map((step) => [
    `${step.summary}:${step.content ?? ""}`,
    step,
  ])).values()];
  const shownSteps = uniqueSteps.slice(0, 3);
  return <>
    {event.basis && (
      <p className="history-event__basis">
        <span>Observed basis</span>
        {phaseLabel(event.basis)} · {event.basis.summary}
      </p>
    )}
    <ul className="history-event__steps" aria-label={`${uniqueSteps.length} observed execution steps`}>
      {shownSteps.map((step) => (
        <li key={step.id}>
          <span>{step.summary}</span>
          {step.content && <small>{step.content}</small>}
        </li>
      ))}
    </ul>
    {uniqueSteps.length > shownSteps.length && (
      <small className="history-event__more">+{uniqueSteps.length - shownSteps.length} more in Timeline</small>
    )}
  </>;
}

export function RunHistory({
  snapshot,
  selectedId,
  mode = "story",
}: {
  snapshot: ObservatorySnapshot;
  selectedId?: string;
  mode?: RunHistoryMode;
}) {
  const branchIds = useMemo(() => agentBranchIds(snapshot, selectedId), [selectedId, snapshot.agents]);
  const events = useMemo(() => {
    const filtered = [...snapshot.history]
      .filter((event) => historyEventIsInBranch(event, branchIds))
      .filter((event) => (mode === "story" ? STORY_KINDS : MESSAGE_KINDS).includes(event.kind))
      .filter((event) => event.kind !== "delivery" || event.source !== "derived")
      .sort((a, b) => a.occurredAt - b.occurredAt);
    return mode === "story" ? storyEvents(filtered) : filtered;
  }, [branchIds, mode, snapshot.history]);
  const contentPolicy = capturePolicy(snapshot, branchIds);
  const eventIds = useMemo(() => events.map((event) => event.id), [events]);
  const {
    atLatest,
    containerRef,
    handleScroll,
    jumpToLatest,
    newItemCount,
  } = useLatestFeed<HTMLOListElement>({
    itemIds: eventIds,
    scopeKey: `${selectedId ?? "none"}:${mode}`,
  });

  return (
    <div className="run-history-shell">
      {mode === "story" && selectedId && contentPolicy === "metadata-only" && (
        <aside className="run-history__privacy" role="note">
          <strong>Content privacy is on</strong>
          <span>Story shows observed metadata. Restart with <code>bun run dev:real -- --capture-content</code> to include bounded request and result text.</span>
        </aside>
      )}
      <ol
        className="run-history"
        ref={containerRef}
        aria-label={`${mode === "story" ? "Run history" : "Messages"}, ${events.length} events`}
        onScroll={handleScroll}
      >
        {events.map((event) => {
        const style = {
          "--history-color": actorColor(event.actor, snapshot),
        } as CSSProperties;
        return (
          <li className={`history-event history-event--${event.kind}`} key={event.id} style={style}>
            <time dateTime={new Date(event.occurredAt).toISOString()}>{formatTime(event.occurredAt)}</time>
            <span className="history-event__graph" aria-hidden="true">
              <i className="history-event__node" />
            </span>
            <article>
              <div className="history-event__phase">
                <span className="history-event__phase-label">{phaseLabel(event)}</span>
                <span className={`history-event__status history-event__status--${event.status ?? "recorded"}`}>
                  {event.status ?? event.kind}
                </span>
              </div>
              <div className="history-event__meta">
                <HistoryRoute event={event} snapshot={snapshot} />
              </div>
              <strong className="history-event__summary">{event.summary}</strong>
              {event.kind === "work"
                ? <ExecutionDetail event={event} />
                : event.content && <HistoryContent content={event.content} />}
              <small className="history-event__evidence">Evidence · {event.source}</small>
            </article>
          </li>
        );
        })}
        {events.length === 0 && (
          <li className="run-history__empty">
            {selectedId ? "No narrative history for this agent branch yet." : "Select an agent to view its run history."}
            <small>{selectedId
              ? "Timeline may still contain low-level execution activity."
              : "History is scoped to the selected agent and its children."}</small>
          </li>
        )}
      </ol>
      {!atLatest && events.length > 0 && (
        <button className="latest-feed-button" onClick={jumpToLatest}>
          {newItemCount > 0 ? `${newItemCount} new · ` : ""}Latest ↓
        </button>
      )}
    </div>
  );
}
