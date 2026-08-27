import { useMemo, type CSSProperties } from "react";
import type { HistoryActor, HistoryEvent, ObservatorySnapshot } from "@observatory/core";
import { agentProvider, formatTime, ProviderBadge, roleColor, shortId } from "../shared/presentation.tsx";
import { useLatestFeed } from "../activity/use-latest-feed.ts";

function actorAgentId(actor: HistoryActor): string | undefined {
  return actor.type === "agent" ? actor.id : undefined;
}

function actorLabel(actor: HistoryActor, snapshot: ObservatorySnapshot): string {
  if (actor.type === "human") return actor.label ?? "Human";
  if (actor.type === "system") return actor.label ?? "System";
  const agent = actor.id ? snapshot.agents[actor.id] : undefined;
  return agent?.nickname ?? agent?.role ?? actor.label ?? (actor.id ? shortId(actor.id) : "Agent");
}

function directlyInvolves(event: HistoryEvent, selectedId: string): boolean {
  return actorAgentId(event.actor) === selectedId
    || (event.recipients ?? []).some((recipient) => actorAgentId(recipient) === selectedId);
}

function isConversationEvent(event: HistoryEvent): boolean {
  if (event.kind === "request") return event.actor.type === "human";
  if (event.kind === "delivery") return event.source !== "derived";
  return event.kind === "handoff" && event.relationKind === "message";
}

function routeLabel(event: HistoryEvent, snapshot: ObservatorySnapshot): string {
  const sender = actorLabel(event.actor, snapshot);
  const recipients = (event.recipients ?? []).map((recipient) => actorLabel(recipient, snapshot));
  return recipients.length > 0 ? `${sender} → ${recipients.join(", ")}` : sender;
}

function mentionHandle(actor: HistoryActor, snapshot: ObservatorySnapshot): string {
  const label = actorLabel(actor, snapshot)
    .trim()
    .toLocaleLowerCase()
    .replaceAll("@", "")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return `@${label || actor.type}`;
}

function capturePolicy(snapshot: ObservatorySnapshot, selectedId: string): "metadata-only" | "enabled" | undefined {
  const provider = snapshot.agents[selectedId]?.provider;
  return snapshot.runtime.providers?.find((runtime) => runtime.provider === provider)?.contentCapture
    ?? snapshot.runtime.contentCapture;
}

export function AgentConversation({
  snapshot,
  selectedId,
  onClose,
}: {
  snapshot: ObservatorySnapshot;
  selectedId: string;
  onClose(): void;
}) {
  const agent = snapshot.agents[selectedId];
  const events = useMemo(() => [...snapshot.history]
    .filter((event) => directlyInvolves(event, selectedId))
    .filter(isConversationEvent)
    .sort((a, b) => a.occurredAt - b.occurredAt || a.id.localeCompare(b.id)), [selectedId, snapshot.history]);
  const eventIds = useMemo(() => events.map((event) => event.id), [events]);
  const {
    atLatest,
    containerRef,
    handleScroll,
    jumpToLatest,
    newItemCount,
  } = useLatestFeed<HTMLOListElement>({ itemIds: eventIds, scopeKey: selectedId });
  const contentPolicy = capturePolicy(snapshot, selectedId);
  const agentName = agent?.nickname ?? agent?.role ?? shortId(selectedId);

  return (
    <section className="agent-conversation" aria-labelledby="agent-conversation-heading">
      <header className="agent-conversation__heading">
        <div>
          <span>Conversation</span>
          <h3 id="agent-conversation-heading">{agentName}</h3>
        </div>
        <div className="agent-conversation__heading-meta">
          {agent && <ProviderBadge provider={agentProvider(agent, snapshot.runtime.adapter)} />}
          <span>{events.length} message{events.length === 1 ? "" : "s"}</span>
          <button onClick={onClose} aria-label={`Close ${agentName} conversation`}>×</button>
        </div>
      </header>
      {contentPolicy === "metadata-only" && (
        <aside className="agent-conversation__privacy" role="note">
          Content privacy is on. Message summaries remain visible; bounded message text requires content capture.
        </aside>
      )}
      <ol
        className="agent-conversation__list"
        ref={containerRef}
        aria-label={`${agentName} conversation, ${events.length} messages`}
        onScroll={handleScroll}
      >
        {events.map((event) => {
          const route = routeLabel(event, snapshot);
          const human = event.actor.type === "human";
          const actor = event.actor.type === "agent" && event.actor.id ? snapshot.agents[event.actor.id] : undefined;
          const recipients = event.recipients ?? [];
          const style = {
            "--conversation-color": human ? "#fcd34d" : roleColor(actor?.role),
          } as CSSProperties;
          return (
            <li className="conversation-event" data-side={human ? "human" : "agent"} key={event.id} style={style}>
              <article aria-label={`${route}, ${formatTime(event.occurredAt)}`}>
                <header>
                  <span className="conversation-event__sender">
                    {actor && <ProviderBadge provider={agentProvider(actor, snapshot.runtime.adapter)} compact />}
                    <strong>{actorLabel(event.actor, snapshot)}</strong>
                    {recipients.length > 0 && (
                      <span
                        className="conversation-event__mentions"
                        aria-label={`To ${recipients.map((recipient) => actorLabel(recipient, snapshot)).join(", ")}`}
                      >
                        {recipients.map((recipient, index) => (
                          <span key={`${recipient.type}:${actorAgentId(recipient) ?? recipient.label ?? index}`}>
                            {mentionHandle(recipient, snapshot)}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                  <time dateTime={new Date(event.occurredAt).toISOString()}>{formatTime(event.occurredAt)}</time>
                </header>
                <p data-content-unavailable={!event.content || undefined}>
                  {event.content ?? "Message content was not captured."}
                </p>
              </article>
            </li>
          );
        })}
        {events.length === 0 && (
          <li className="agent-conversation__empty">
            No direct messages observed for this agent yet.
            <small>Human and agent messages appear here as provider evidence arrives.</small>
          </li>
        )}
      </ol>
      {!atLatest && events.length > 0 && (
        <button className="latest-feed-button" onClick={jumpToLatest}>
          {newItemCount > 0 ? `${newItemCount} new · ` : ""}Latest ↓
        </button>
      )}
    </section>
  );
}
