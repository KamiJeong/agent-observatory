import { useEffect, useMemo, useRef, useState } from "react";
import type * as React from "react";
import type { ActivityKind, AgentActivity, AgentNode, ObservatorySnapshot } from "@observatory/core";
import { formatDuration, formatTime, shortId, StatusBadge, type TimelineFilter } from "../shared/presentation.tsx";

function filterKinds(filter: TimelineFilter, kind: ActivityKind): boolean {
  if (filter === "all") return true;
  if (filter === "agent") return kind === "message" || kind === "thinking";
  if (filter === "tool") return kind === "tool" || kind === "approval";
  if (filter === "file") return kind === "read" || kind === "write";
  if (filter === "command") return kind === "command" || kind === "test";
  return kind === "error";
}

const TIMELINE_ITEM_HEIGHT = 64;
const TIMELINE_OVERSCAN = 6;

export function ActivityTimeline({ snapshot }: { snapshot: ObservatorySnapshot }) {
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });
  const listRef = useRef<HTMLOListElement>(null);
  const previousFirstActivityId = useRef<string | undefined>(undefined);
  const activities = useMemo(
    () => snapshot.activities.filter((activity) => filterKinds(filter, activity.kind)),
    [filter, snapshot.activities],
  );
  const firstIndex = Math.max(0, Math.floor(viewport.scrollTop / TIMELINE_ITEM_HEIGHT) - TIMELINE_OVERSCAN);
  const lastIndex = Math.min(
    activities.length,
    Math.ceil((viewport.scrollTop + viewport.height) / TIMELINE_ITEM_HEIGHT) + TIMELINE_OVERSCAN + 1,
  );
  const visibleActivities = activities.slice(firstIndex, lastIndex);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      setViewport((current) => {
        const height = list.clientHeight;
        return current.height === height ? current : { ...current, height };
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const list = listRef.current;
    const previousId = previousFirstActivityId.current;
    if (list && previousId && list.scrollTop > 0) {
      const previousIndex = activities.findIndex((activity) => activity.id === previousId);
      if (previousIndex > 0) {
        list.scrollTop += previousIndex * TIMELINE_ITEM_HEIGHT;
        setViewport({ scrollTop: list.scrollTop, height: list.clientHeight });
      }
    }
    previousFirstActivityId.current = activities[0]?.id;
  }, [activities]);

  const selectFilter = (nextFilter: TimelineFilter) => {
    setFilter(nextFilter);
    if (listRef.current) listRef.current.scrollTop = 0;
    setViewport((current) => ({ ...current, scrollTop: 0 }));
  };
  return (
    <div className="timeline">
      <div className="filter-tabs" aria-label="Activity filters">
        {(["all", "agent", "tool", "file", "command", "error"] as const).map((option) => (
          <button key={option} data-active={filter === option || undefined} onClick={() => selectFilter(option)}>
            {option[0]?.toUpperCase()}{option.slice(1)}
          </button>
        ))}
      </div>
      <ol
        className="timeline__list"
        ref={listRef}
        aria-label={`Recent activity, ${activities.length} events`}
        onScroll={(event) => setViewport({
          scrollTop: event.currentTarget.scrollTop,
          height: event.currentTarget.clientHeight,
        })}
      >
        {activities.length > 0 && (
          <li
            className="timeline__sizer"
            style={{ height: `${activities.length * TIMELINE_ITEM_HEIGHT + 8}px` }}
            aria-hidden="true"
          />
        )}
        {visibleActivities.map((activity, windowIndex) => {
          const agent = snapshot.agents[activity.agentId];
          const activityIndex = firstIndex + windowIndex;
          return (
            <li
              key={activity.id}
              className={`timeline-item timeline-item--${activity.kind}`}
              style={{ transform: `translateY(${activityIndex * TIMELINE_ITEM_HEIGHT + 4}px)` }}
              aria-posinset={activityIndex + 1}
              aria-setsize={activities.length}
            >
              <time dateTime={new Date(activity.startedAt).toISOString()}>{formatTime(activity.startedAt)}</time>
              <span className="timeline-item__rail" aria-hidden="true" />
              <div>
                <span className="timeline-item__agent">{agent?.nickname ?? agent?.role ?? shortId(activity.agentId)}</span>
                <strong>{activity.title}</strong>
                {activity.detail && <p>{activity.detail}</p>}
              </div>
            </li>
          );
        })}
        {activities.length === 0 && <li className="timeline__empty">No matching activity.</li>}
      </ol>
    </div>
  );
}

export function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="detail-row"><dt>{label}</dt><dd>{children}</dd></div>;
}

const RECENT_ACTIVITY_ITEM_HEIGHT = 32;
const RECENT_ACTIVITY_MAX_HEIGHT = 224;
const RECENT_ACTIVITY_OVERSCAN = 4;

export function RecentActivityList({ activities }: { activities: AgentActivity[] }) {
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });
  const listRef = useRef<HTMLOListElement>(null);
  const firstIndex = Math.max(
    0,
    Math.floor(viewport.scrollTop / RECENT_ACTIVITY_ITEM_HEIGHT) - RECENT_ACTIVITY_OVERSCAN,
  );
  const lastIndex = Math.min(
    activities.length,
    Math.ceil((viewport.scrollTop + viewport.height) / RECENT_ACTIVITY_ITEM_HEIGHT)
      + RECENT_ACTIVITY_OVERSCAN
      + 1,
  );
  const visibleActivities = activities.slice(firstIndex, lastIndex);
  const listHeight = Math.min(
    RECENT_ACTIVITY_MAX_HEIGHT,
    Math.max(1, activities.length) * RECENT_ACTIVITY_ITEM_HEIGHT,
  );

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      setViewport((current) => {
        const height = list.clientHeight;
        return current.height === height ? current : { ...current, height };
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  return (
    <ol
      className="inspector__recent-list"
      ref={listRef}
      aria-label={`Recent activity, ${activities.length} events`}
      style={{ height: `${listHeight}px` }}
      onScroll={(event) => setViewport({
        scrollTop: event.currentTarget.scrollTop,
        height: event.currentTarget.clientHeight,
      })}
    >
      {activities.length > 0 && (
        <li
          className="inspector__recent-sizer"
          style={{ height: `${activities.length * RECENT_ACTIVITY_ITEM_HEIGHT}px` }}
          aria-hidden="true"
        />
      )}
      {visibleActivities.map((activity, windowIndex) => {
        const activityIndex = firstIndex + windowIndex;
        return (
          <li
            className="inspector__recent-item"
            key={activity.id}
            style={{ transform: `translateY(${activityIndex * RECENT_ACTIVITY_ITEM_HEIGHT}px)` }}
            aria-posinset={activityIndex + 1}
            aria-setsize={activities.length}
          >
            <time dateTime={new Date(activity.startedAt).toISOString()}>{formatTime(activity.startedAt)}</time>
            <span>{activity.title}</span>
          </li>
        );
      })}
      {activities.length === 0 && <li className="inspector__none">No activity recorded.</li>}
    </ol>
  );
}

function Inspector({ agent, snapshot, now }: { agent: AgentNode; snapshot: ObservatorySnapshot; now: number }) {
  const activitiesById = useMemo(
    () => new Map(snapshot.activities.map((activity) => [activity.id, activity])),
    [snapshot.activities],
  );
  const current = agent.currentActivityId
    ? activitiesById.get(agent.currentActivityId)
    : undefined;
  const recent = agent.recentActivityIds
    .map((id) => activitiesById.get(id))
    .filter((activity): activity is AgentActivity => Boolean(activity));
  return (
    <div className="inspector">
      <div className="inspector__identity">
        <span className="eyebrow">{agent.role ?? "agent"}</span>
        <h3>{agent.nickname ?? shortId(agent.id)}</h3>
        <StatusBadge agent={agent} />
      </div>
      <dl className="details">
        <DetailRow label="Runtime">{formatDuration(now - (agent.startedAt ?? snapshot.startedAt))}</DetailRow>
        <DetailRow label="Current activity">{current?.title ?? "—"}</DetailRow>
        {agent.model && <DetailRow label="Model">{agent.model}</DetailRow>}
        {agent.reasoningEffort && <DetailRow label="Effort">{agent.reasoningEffort}</DetailRow>}
        {agent.collaborationMode && <DetailRow label="Mode">{agent.collaborationMode}</DetailRow>}
        {(agent.observedSkills?.length ?? 0) > 0 && (
          <DetailRow label="Skills"><span className="context-tags">{agent.observedSkills?.map((skill) => <span key={skill}>{skill}</span>)}</span></DetailRow>
        )}
        {(agent.observedWorkflows?.length ?? 0) > 0 && (
          <DetailRow label="Workflows"><span className="context-tags">{agent.observedWorkflows?.map((workflow) => <span key={workflow}>{workflow}</span>)}</span></DetailRow>
        )}
        <DetailRow label="Thread"><code title={agent.threadId}>{shortId(agent.threadId)}</code></DetailRow>
        {agent.cwd && <DetailRow label="Working directory"><code title={agent.cwd}>{agent.cwd}</code></DetailRow>}
        {agent.tokenUsage?.totalTokens !== undefined && (
          <DetailRow label="Tokens">{agent.tokenUsage.totalTokens.toLocaleString()}</DetailRow>
        )}
      </dl>
      <div className="inspector__recent">
        <div className="inspector__recent-heading">
          <h4>Recent activity</h4>
          <span>{recent.length}</span>
        </div>
        <RecentActivityList key={agent.id} activities={recent} />
      </div>
    </div>
  );
}

export function RightRail({
  snapshot,
  selectedId,
  onClear,
  now,
}: {
  snapshot: ObservatorySnapshot;
  selectedId?: string;
  onClear(): void;
  now: number;
}) {
  const [tab, setTab] = useState<"activity" | "inspector">("activity");
  const agent = selectedId ? snapshot.agents[selectedId] : undefined;
  useEffect(() => { if (agent) setTab("inspector"); }, [agent?.id]);
  return (
    <aside className="right-rail panel" aria-label="Activity and agent inspector">
      <div className="rail-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "activity"} onClick={() => setTab("activity")}>Activity</button>
        <button role="tab" aria-selected={tab === "inspector"} disabled={!agent} onClick={() => setTab("inspector")}>Inspector</button>
        {agent && <button className="rail-tabs__close" onClick={onClear} aria-label="Close inspector">×</button>}
      </div>
      {tab === "inspector" && agent ? <Inspector agent={agent} snapshot={snapshot} now={now} /> : <ActivityTimeline snapshot={snapshot} />}
    </aside>
  );
}
