import { useMemo, type CSSProperties } from "react";
import type { HistoryActor, HistoryEvent, ObservatorySnapshot } from "@observatory/core";
import { agentProvider, formatTime, ProviderBadge, roleColor, shortId } from "../shared/presentation.tsx";

export type RunHistoryMode = "story" | "messages";

function actorLabel(actor: HistoryActor, snapshot: ObservatorySnapshot): string {
  if (actor.type === "human") return "Human";
  if (actor.type === "system") return "System";
  const agent = actor.id ? snapshot.agents[actor.id] : undefined;
  return agent?.nickname ?? agent?.role ?? actor.label ?? (actor.id ? shortId(actor.id) : "Agent");
}

function actorDepth(actor: HistoryActor, snapshot: ObservatorySnapshot): number {
  if (actor.type === "human") return 0;
  if (actor.type === "system") return 1;
  return Math.min(4, Math.max(1, (actor.id ? snapshot.agents[actor.id]?.depth : undefined) ?? 1));
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

export function RunHistory({ snapshot, mode = "story" }: { snapshot: ObservatorySnapshot; mode?: RunHistoryMode }) {
  const events = useMemo(() => [...snapshot.history]
    .filter((event) => mode === "story" || ["request", "handoff", "delivery"].includes(event.kind))
    .sort((a, b) => a.occurredAt - b.occurredAt), [mode, snapshot.history]);

  return (
    <ol className="run-history" aria-label={`${mode === "story" ? "Run history" : "Messages"}, ${events.length} events`}>
      {events.map((event) => {
        const depth = actorDepth(event.actor, snapshot);
        const recipientDepth = event.recipients?.[0] ? actorDepth(event.recipients[0], snapshot) : depth;
        const style = {
          "--history-depth": depth,
          "--history-target-depth": recipientDepth,
          "--history-branch-left": Math.min(depth, recipientDepth),
          "--history-branch-width": Math.abs(depth - recipientDepth),
          "--history-color": actorColor(event.actor, snapshot),
        } as CSSProperties;
        return (
          <li className={`history-event history-event--${event.kind}`} key={event.id} style={style}>
            <time dateTime={new Date(event.occurredAt).toISOString()}>{formatTime(event.occurredAt)}</time>
            <span className="history-event__graph" aria-hidden="true">
              <i className="history-event__line" />
              {recipientDepth !== depth && <i className="history-event__branch" />}
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
          No narrative history yet.<small>Trace still contains low-level execution activity.</small>
        </li>
      )}
    </ol>
  );
}
