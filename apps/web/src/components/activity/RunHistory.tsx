import { useMemo, type CSSProperties } from "react";
import type { HistoryActor, HistoryEvent, ObservatorySnapshot } from "@observatory/core";
import { agentProvider, formatTime, ProviderBadge, roleColor, shortId } from "../shared/presentation.tsx";
import { agentBranchIds, historyEventIsInBranch } from "./agent-scope.ts";

export type RunHistoryMode = "story" | "messages";

const STORY_KINDS: HistoryEvent["kind"][] = ["request", "decision", "handoff", "delivery", "completion"];
const MESSAGE_KINDS: HistoryEvent["kind"][] = ["request", "handoff", "delivery"];

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
  return (
    <span className="history-event__route">
      {actor && <ProviderBadge provider={agentProvider(actor, snapshot.runtime.adapter)} compact />}
      <strong>{actorLabel(event.actor, snapshot)}</strong>
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
  const events = useMemo(() => [...snapshot.history]
    .filter((event) => historyEventIsInBranch(event, branchIds))
    .filter((event) => (mode === "story" ? STORY_KINDS : MESSAGE_KINDS).includes(event.kind))
    .filter((event) => event.kind !== "delivery" || event.source !== "derived")
    .sort((a, b) => a.occurredAt - b.occurredAt), [branchIds, mode, snapshot.history]);

  return (
    <ol className="run-history" aria-label={`${mode === "story" ? "Run history" : "Messages"}, ${events.length} events`}>
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
              <div className="history-event__meta">
                <HistoryRoute event={event} snapshot={snapshot} />
                <span className={`history-event__status history-event__status--${event.status ?? "recorded"}`}>
                  {event.status ?? event.kind}
                </span>
              </div>
              <strong className="history-event__summary">{event.summary}</strong>
              {event.content && <HistoryContent content={event.content} />}
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
  );
}
