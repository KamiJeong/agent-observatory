import { useEffect, useState, useSyncExternalStore } from "react";
import type { ObservatorySnapshot } from "@observatory/core";
import { uiStore } from "../../ui-store.ts";
import { DetailRow, RightRail } from "../activity/ActivityPanel.tsx";
import { AgentGraph } from "../agents/AgentGraph.tsx";
import { AgentList } from "../agents/AgentList.tsx";
import { formatDuration, formatTime, useNow } from "../shared/presentation.tsx";
import { WorkflowBoard } from "../workflows/WorkflowBoard.tsx";

function Connection({ snapshot }: { snapshot: ObservatorySnapshot }) {
  const phase = snapshot.connection.phase;
  const symbol = phase === "connected" ? "●" : phase === "disconnected" ? "!" : "○";
  const label = phase[0]?.toUpperCase() + phase.slice(1);
  return (
    <div className={`connection connection--${phase}`} role="status" aria-live="polite">
      <span aria-hidden="true">{symbol}</span>
      <strong>{label}</strong>
      {phase === "disconnected" && <button onClick={() => uiStore.retry()}>Retry</button>}
    </div>
  );
}

function DebugPanel({ snapshot, onClose }: { snapshot: ObservatorySnapshot; onClose(): void }) {
  return (
    <div className="debug-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="debug-panel" role="dialog" aria-modal="true" aria-labelledby="debug-heading">
        <div className="debug-panel__heading">
          <div>
            <span className="eyebrow">Diagnostics</span>
            <h2 id="debug-heading">Protocol debug</h2>
          </div>
          <button onClick={onClose} aria-label="Close debug panel">×</button>
        </div>
        <dl className="debug-meta">
          <DetailRow label="Adapter">{snapshot.runtime.adapter}</DetailRow>
          <DetailRow label="Codex">{snapshot.runtime.codexCliVersion ?? "mock"}</DetailRow>
          <DetailRow label="Protocol">{snapshot.runtime.protocolGenerationVersion ?? "unknown"}</DetailRow>
          <DetailRow label="Discovery">{snapshot.runtime.discoveryStrategy}</DetailRow>
          <DetailRow label="Experimental">{snapshot.runtime.experimentalApi ? "enabled" : "disabled"}</DetailRow>
        </dl>
        <ol className="debug-log">
          {snapshot.debug.map((entry) => (
            <li key={entry.id}>
              <time>{formatTime(entry.at)}</time>
              <span className={`debug-log__direction debug-log__direction--${entry.direction}`}>{entry.direction}</span>
              <span>{entry.method ?? entry.category}</span>
              <strong>{entry.summary}</strong>
            </li>
          ))}
          {snapshot.debug.length === 0 && <li className="debug-log__empty">No protocol events in mock mode.</li>}
        </ol>
      </section>
    </div>
  );
}

export function App() {
  const snapshot = useSyncExternalStore(uiStore.subscribe, uiStore.getSnapshot);
  const now = useNow();
  const [selectedId, setSelectedId] = useState<string>();
  const [debugOpen, setDebugOpen] = useState(false);
  const [visualization, setVisualization] = useState<"graph" | "workflow">("graph");
  useEffect(() => uiStore.start(), []);
  useEffect(() => {
    if (selectedId && !snapshot.agents[selectedId]) setSelectedId(undefined);
  }, [selectedId, snapshot.agents]);

  const agents = Object.values(snapshot.agents);
  const counts = {
    working: agents.filter((agent) => agent.status === "working").length,
    waiting: agents.filter((agent) => agent.status === "waiting").length,
    completed: agents.filter((agent) => agent.status === "completed").length,
    failed: agents.filter((agent) => agent.status === "failed").length,
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">⌁</span>
          <div>
            <h1>Codex Observatory</h1>
            <span>{snapshot.runtime.adapter === "mock" ? `Mock · ${snapshot.runtime.scenario?.toUpperCase() ?? "A"}` : "Local App Server"}</span>
          </div>
        </div>
        <div className="metrics" aria-label="Run summary">
          <div className="metric metric--agents"><span>Agents</span><strong>{agents.length}</strong></div>
          <div className="metric metric--working"><span>Working</span><strong>{counts.working}</strong></div>
          <div className="metric metric--waiting"><span>Waiting</span><strong>{counts.waiting}</strong></div>
          <div className="metric metric--completed"><span>Completed</span><strong>{counts.completed}</strong></div>
          <div className="metric metric--runtime"><span>Runtime</span><strong>{formatDuration(now - snapshot.startedAt)}</strong></div>
        </div>
        <div className="topbar__actions">
          <button className="debug-button" onClick={() => setDebugOpen(true)}>Debug</button>
          <Connection snapshot={snapshot} />
        </div>
      </header>

      {snapshot.connection.phase !== "connected" && (
        <div className={`connection-banner connection-banner--${snapshot.connection.phase}`}>
          <span>{snapshot.connection.message ?? "Connection unavailable"}</span>
          {snapshot.connection.phase === "reconnecting" && <small>Attempt {snapshot.connection.attempt}</small>}
          {snapshot.connection.phase === "disconnected" && <button onClick={() => uiStore.retry()}>Retry connection</button>}
        </div>
      )}

      <main className="workspace">
        <AgentList snapshot={snapshot} selectedId={selectedId} onSelect={setSelectedId} />
        <div className="visualization">
          <div className="visualization-tabs" role="group" aria-label="Agent visualization">
            <button aria-pressed={visualization === "graph"} onClick={() => setVisualization("graph")}>Graph</button>
            <button aria-pressed={visualization === "workflow"} onClick={() => setVisualization("workflow")}>Workflows</button>
          </div>
          {visualization === "graph"
            ? <AgentGraph snapshot={snapshot} selectedId={selectedId} onSelect={setSelectedId} />
            : <WorkflowBoard snapshot={snapshot} selectedId={selectedId} onSelect={setSelectedId} />}
        </div>
        <RightRail snapshot={snapshot} selectedId={selectedId} onClear={() => setSelectedId(undefined)} now={now} />
      </main>

      <footer className="runbar">
        <span className="runbar__label">Run summary</span>
        <span><i className="dot dot--working" /> Active {counts.working}</span>
        <span><i className="dot dot--waiting" /> Waiting {counts.waiting}</span>
        <span><i className="dot dot--completed" /> Done {counts.completed}</span>
        {counts.failed > 0 && <span><i className="dot dot--failed" /> Failed {counts.failed}</span>}
        <span className="runbar__version">Codex {snapshot.runtime.codexCliVersion ?? snapshot.runtime.protocolGenerationVersion ?? "mock"} · Observatory {snapshot.runtime.observatoryVersion}</span>
      </footer>
      {debugOpen && <DebugPanel snapshot={snapshot} onClose={() => setDebugOpen(false)} />}
    </div>
  );
}
