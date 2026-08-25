import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type * as React from "react";
import type { AgentNode, ObservatorySnapshot } from "@observatory/core";
import { GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH, layoutGraph } from "../../lib/graph-layout.ts";
import {
  agentRuntimeLabel,
  roleColor,
  roleDescription,
  shortId,
  STATUS,
  StatusBadge,
} from "../shared/presentation.tsx";

export const AgentGraph = memo(function AgentGraph({
  snapshot,
  selectedId,
  onSelect,
}: {
  snapshot: ObservatorySnapshot;
  selectedId?: string;
  onSelect(id: string): void;
}) {
  const topologyKey = snapshot.roots.join("|") + snapshot.edges.map((edge) => `${edge.source}>${edge.target}`).join("|");
  const layout = useMemo(() => layoutGraph(snapshot), [topologyKey]);
  const activitiesById = useMemo(
    () => new Map(snapshot.activities.map((activity) => [activity.id, activity])),
    [snapshot.activities],
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const view = useRef({ scale: 1, x: 0, y: 0 });
  const [scalePercent, setScalePercent] = useState(100);
  const scalePercentRef = useRef(100);
  const [roleTooltip, setRoleTooltip] = useState<{
    role: string;
    description: string;
    x: number;
    y: number;
  }>();
  const drag = useRef<{ pointerId: number; x: number; y: number; originX: number; originY: number } | undefined>(undefined);

  const applyView = useCallback((next: { scale: number; x: number; y: number }) => {
    const normalized = {
      scale: Math.min(2, Math.max(0.15, next.scale)),
      x: next.x,
      y: next.y,
    };
    view.current = normalized;
    if (canvasRef.current) {
      canvasRef.current.style.transform = `translate3d(${normalized.x}px, ${normalized.y}px, 0) scale(${normalized.scale})`;
    }
    const nextPercent = Math.round(normalized.scale * 100);
    if (scalePercentRef.current !== nextPercent) {
      scalePercentRef.current = nextPercent;
      setScalePercent(nextPercent);
    }
  }, []);

  const zoomAt = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const current = view.current;
    const nextScale = Math.min(2, Math.max(0.15, current.scale * factor));
    const anchorX = clientX === undefined ? bounds.width / 2 : clientX - bounds.left;
    const anchorY = clientY === undefined ? bounds.height / 2 : clientY - bounds.top;
    const worldX = (anchorX - current.x) / current.scale;
    const worldY = (anchorY - current.y) / current.scale;
    applyView({
      scale: nextScale,
      x: anchorX - worldX * nextScale,
      y: anchorY - worldY * nextScale,
    });
  }, [applyView]);

  const fit = useCallback(() => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const widthScale = Math.max(0, bounds.width - 48) / layout.width;
    const heightScale = Math.max(0, bounds.height - 48) / layout.height;
    const scale = Math.min(1, Math.max(0.15, Math.min(widthScale, heightScale)));
    applyView({
      scale,
      x: Math.max(20, (bounds.width - layout.width * scale) / 2),
      y: Math.max(20, (bounds.height - layout.height * scale) / 2),
    });
  }, [applyView, layout.height, layout.width]);

  useEffect(() => {
    fit();
    const observer = new ResizeObserver(fit);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [fit]);

  useEffect(() => {
    if (!selectedId) return;
    const position = layout.positions[selectedId];
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!position || !bounds) return;
    const current = view.current;
    const nodeLeft = current.x + position.x * current.scale;
    const nodeTop = current.y + position.y * current.scale;
    const nodeRight = nodeLeft + GRAPH_NODE_WIDTH * current.scale;
    const nodeBottom = nodeTop + GRAPH_NODE_HEIGHT * current.scale;
    const safeInset = 32;
    const isVisible = nodeLeft >= safeInset
      && nodeTop >= safeInset
      && nodeRight <= bounds.width - safeInset
      && nodeBottom <= bounds.height - safeInset;
    if (isVisible) return;
    applyView({
      ...current,
      x: bounds.width / 2 - (position.x + GRAPH_NODE_WIDTH / 2) * current.scale,
      y: bounds.height / 2 - (position.y + GRAPH_NODE_HEIGHT / 2) * current.scale,
    });
  }, [applyView, layout, selectedId]);

  useEffect(() => {
    const viewport = containerRef.current;
    if (!viewport) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? viewport.clientHeight
          : 1;
      if (event.ctrlKey || event.metaKey) {
        const factor = Math.exp(Math.max(-80, Math.min(80, -event.deltaY * unit)) * 0.008);
        zoomAt(factor, event.clientX, event.clientY);
        return;
      }
      const current = view.current;
      const horizontal = event.shiftKey && event.deltaX === 0 ? event.deltaY * unit : event.deltaX * unit;
      const vertical = event.shiftKey && event.deltaX === 0 ? 0 : event.deltaY * unit;
      applyView({ ...current, x: current.x - horizontal, y: current.y - vertical });
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [applyView, zoomAt]);

  const beginPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0 && event.button !== 1) return;
    if (event.button === 0 && event.target !== event.currentTarget && (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const current = view.current;
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: current.x, originY: current.y };
    event.currentTarget.dataset.panning = "true";
  };
  const pan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    applyView({
      scale: view.current.scale,
      x: current.originX + event.clientX - current.x,
      y: current.originY + event.clientY - current.y,
    });
  };
  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = undefined;
    delete event.currentTarget.dataset.panning;
  };
  const showRoleTooltip = (element: HTMLElement, agent: AgentNode) => {
    const viewportBounds = containerRef.current?.getBoundingClientRect();
    if (!viewportBounds) return;
    const roleBounds = element.getBoundingClientRect();
    const width = 260;
    const height = 68;
    const x = Math.max(12, Math.min(viewportBounds.width - width - 12, roleBounds.left - viewportBounds.left));
    const below = roleBounds.bottom - viewportBounds.top + 8;
    const y = below + height <= viewportBounds.height - 12
      ? below
      : Math.max(12, roleBounds.top - viewportBounds.top - height - 8);
    setRoleTooltip({
      role: agent.role ?? "agent",
      description: roleDescription(agent.role),
      x,
      y,
    });
  };
  const handleViewportKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const current = view.current;
    const step = event.shiftKey ? 80 : 32;
    if (event.key === "+" || event.key === "=") zoomAt(1.15);
    else if (event.key === "-") zoomAt(0.85);
    else if (event.key === "0") fit();
    else if (event.key === "ArrowLeft") applyView({ ...current, x: current.x + step });
    else if (event.key === "ArrowRight") applyView({ ...current, x: current.x - step });
    else if (event.key === "ArrowUp") applyView({ ...current, y: current.y + step });
    else if (event.key === "ArrowDown") applyView({ ...current, y: current.y - step });
    else return;
    event.preventDefault();
  };

  return (
    <section className="graph panel" aria-labelledby="graph-heading">
      <div className="panel__heading graph__heading">
        <div>
          <h2 id="graph-heading">Agent graph</h2>
          <span className="panel__subtle">Session topology · live</span>
        </div>
        <div className="graph-controls" aria-label="Graph controls">
          <button onClick={() => zoomAt(0.85)} aria-label="Zoom out">−</button>
          <span className="graph-controls__scale" aria-label={`Zoom ${scalePercent}%`}>{scalePercent}%</span>
          <button onClick={() => zoomAt(1.15)} aria-label="Zoom in">+</button>
          <button onClick={fit} title="Fit graph to viewport (0)">Fit</button>
        </div>
      </div>
      <div
        className="graph__viewport"
        ref={containerRef}
        tabIndex={0}
        aria-label="Interactive agent graph. Drag or scroll to move, and pinch or Control plus scroll to zoom."
        onPointerDown={beginPan}
        onPointerMove={pan}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onKeyDown={handleViewportKeyDown}
      >
        <div
          className="graph__canvas"
          ref={canvasRef}
          style={{
            width: `${layout.width}px`,
            height: `${layout.height}px`,
            transform: "translate3d(0, 0, 0) scale(1)",
          }}
        >
          <svg className="graph__edges" width={layout.width} height={layout.height} aria-hidden="true">
            {snapshot.edges.map((edge) => {
              const source = layout.positions[edge.source];
              const target = layout.positions[edge.target];
              if (!source || !target) return null;
              const x1 = source.x + GRAPH_NODE_WIDTH / 2;
              const y1 = source.y + GRAPH_NODE_HEIGHT;
              const x2 = target.x + GRAPH_NODE_WIDTH / 2;
              const y2 = target.y;
              const branchY = y1 + 18;
              const approachY = y2 - 18;
              const gutterX = target.x - 16;
              const active = edge.target === selectedId || edge.source === selectedId;
              return (
                <path
                  key={edge.id}
                  d={`M ${x1} ${y1} V ${branchY} H ${gutterX} V ${approachY} H ${x2} V ${y2}`}
                  data-active={active || undefined}
                  style={active ? {
                    "--edge-active-color": roleColor(snapshot.agents[selectedId ?? ""]?.role),
                  } as CSSProperties : undefined}
                />
              );
            })}
          </svg>
          {Object.values(snapshot.agents).map((agent) => {
            const position = layout.positions[agent.id];
            if (!position) return null;
            const activity = agent.currentActivityId
              ? activitiesById.get(agent.currentActivityId)
              : undefined;
            return (
              <button
                className={`agent-node agent-node--${agent.status}${agent.children.length > 0 ? " agent-node--parent" : ""}`}
                data-selected={selectedId === agent.id || undefined}
                style={{
                  transform: `translate(${position.x}px, ${position.y}px)`,
                  "--agent-role-color": roleColor(agent.role),
                } as CSSProperties}
                key={agent.id}
                onClick={() => onSelect(agent.id)}
                onBlur={() => setRoleTooltip(undefined)}
                aria-label={`${agent.nickname ?? agent.role ?? agent.id}, ${STATUS[agent.status].label}. Role ${agent.role ?? "agent"}: ${roleDescription(agent.role)}${agent.children.length > 0 ? ` Parent of ${agent.children.length} agents.` : ""}`}
                aria-pressed={selectedId === agent.id}
              >
                <span className="agent-node__topline">
                  <span
                    className="agent-node__role"
                    onMouseEnter={(event: ReactMouseEvent<HTMLSpanElement>) => showRoleTooltip(event.currentTarget, agent)}
                    onMouseLeave={() => setRoleTooltip(undefined)}
                  >
                    {agent.role ?? "agent"}
                  </span>
                  <span className="agent-node__signals">
                    {(agent.observedSkills?.length ?? 0) > 0 && <span title={`${agent.observedSkills?.length} observed skill(s)`}>S{agent.observedSkills?.length}</span>}
                    {(agent.observedWorkflows?.length ?? 0) > 0 && <span title={`${agent.observedWorkflows?.length} observed workflow(s)`}>W{agent.observedWorkflows?.length}</span>}
                    {agent.children.length > 0 && (
                      <span className="agent-node__children" title={`${agent.children.length} direct child agents`} aria-label={`${agent.children.length} child agents`}>
                        <span aria-hidden="true">↳</span>{agent.children.length}
                      </span>
                    )}
                    <span className="agent-node__depth">L{agent.depth ?? 0}</span>
                  </span>
                </span>
                <strong>{agent.nickname ?? shortId(agent.id)}</strong>
                <StatusBadge agent={agent} />
                {agentRuntimeLabel(agent) && (
                  <span className="agent-node__runtime" title={agentRuntimeLabel(agent)}>{agentRuntimeLabel(agent)}</span>
                )}
                <span className="agent-node__activity" data-current={activity ? "true" : undefined}>
                  {activity?.title ?? (agent.status === "idle" ? "Ready" : "No current activity")}
                </span>
              </button>
            );
          })}
        </div>
        {Object.keys(snapshot.agents).length === 0 && (
          <div className="graph__empty">
            <span>Waiting for thread discovery</span>
            <small>Agent nodes appear as App Server events arrive.</small>
          </div>
        )}
        {Object.keys(snapshot.agents).length > 0 && (
          <div className="graph__hint" aria-hidden="true">Drag or scroll to move · Pinch or Ctrl-scroll to zoom</div>
        )}
        {roleTooltip && (
          <div
            className="role-tooltip"
            role="tooltip"
            style={{ left: `${roleTooltip.x}px`, top: `${roleTooltip.y}px` }}
          >
            <strong>{roleTooltip.role}</strong>
            <span>{roleTooltip.description}</span>
          </div>
        )}
      </div>
    </section>
  );
});
