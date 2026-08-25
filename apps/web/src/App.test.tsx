// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ObservatorySnapshot } from "@observatory/core";
import { ActivityTimeline, AgentGraph, AgentList, RecentActivityList, RightRail, RunHistory, WorkflowBoard } from "./App.tsx";

beforeAll(() => {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

afterEach(() => cleanup());

const snapshot: ObservatorySnapshot = {
  agents: {
    root: {
      id: "root", threadId: "root", nickname: "Main", role: "root", status: "working",
      waitingReasons: [], recentActivityIds: [], children: ["tester"], depth: 0,
    },
    tester: {
      id: "tester", threadId: "tester", parentId: "root", nickname: "Tester", role: "testing",
      status: "waiting", waitingReasons: ["approval"], recentActivityIds: ["test"], children: [], depth: 1,
      currentActivityId: "test", cwd: "/repo", model: "gpt-5.6-terra", reasoningEffort: "medium",
      observedSkills: ["sdd-verify"], observedWorkflows: ["SDD"], collaborationMode: "default",
    },
  },
  activities: [{
    id: "test", agentId: "tester", kind: "test", title: "Running vitest", detail: "bun run test", startedAt: 100,
  }],
  history: [],
  pendingRequests: {},
  connection: { phase: "connected", attempt: 0 },
  runtime: { adapter: "mock", observatoryVersion: "test", experimentalApi: false, discoveryStrategy: "mock" },
  debug: [],
  startedAt: 0,
  revision: 1,
  roots: ["root"],
  edges: [{ id: "root->tester", source: "root", target: "tester" }],
};

describe("dashboard interactions", () => {
  it("selects a keyboard-accessible graph node", () => {
    const onSelect = vi.fn();
    render(<AgentGraph snapshot={snapshot} onSelect={onSelect} />);
    const tester = screen.getByRole("button", { name: /Tester, Waiting/i });
    const root = screen.getByRole("button", { name: /Main, Working/i });
    expect(tester.style.getPropertyValue("--agent-role-color")).not.toBe(root.style.getPropertyValue("--agent-role-color"));
    expect(root).toHaveClass("agent-node--parent");
    expect(root.querySelector(".agent-node__children")).toHaveTextContent("1");
    fireEvent.click(tester);
    expect(onSelect).toHaveBeenCalledWith("tester");
  });

  it("explains an agent role on hover", () => {
    render(<AgentGraph snapshot={snapshot} onSelect={() => undefined} />);
    fireEvent.mouseEnter(screen.getByText("testing", { selector: ".agent-node__role" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Checks behavior, quality, tests, and acceptance criteria.");
    fireEvent.mouseLeave(screen.getByText("testing", { selector: ".agent-node__role" }));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("fits a wide graph using the limiting viewport dimension", () => {
    const childIds = Array.from({ length: 12 }, (_, index) => `agent-${index + 1}`);
    const wideSnapshot: ObservatorySnapshot = {
      ...snapshot,
      agents: {
        ...snapshot.agents,
        root: { ...snapshot.agents.root!, children: childIds },
        ...Object.fromEntries(childIds.map((id) => [id, {
          id,
          threadId: id,
          parentId: "root",
          nickname: id,
          role: "worker",
          status: "working" as const,
          waitingReasons: [],
          recentActivityIds: [],
          children: [],
          depth: 1,
        }])),
      },
      edges: childIds.map((id) => ({ id: `root->${id}`, source: "root", target: id })),
    };
    render(<AgentGraph snapshot={wideSnapshot} onSelect={() => undefined} />);
    const viewport = screen.getByLabelText(/Interactive agent graph/i);
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      width: 700, height: 800, left: 0, top: 0, right: 700, bottom: 800, x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.click(screen.getByRole("button", { name: "Fit" }));

    const transform = (viewport.querySelector(".graph__canvas") as HTMLElement).style.transform;
    const scale = Number(transform.match(/scale\(([^)]+)\)/)?.[1]);
    expect(scale).toBeGreaterThan(0.65);
    expect(scale).toBeLessThan(0.8);
  });

  it("pans with the wheel and zooms around the pointer with Control-wheel", () => {
    render(<AgentGraph snapshot={snapshot} onSelect={() => undefined} />);
    const viewport = screen.getByLabelText(/Interactive agent graph/i);
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      width: 900, height: 600, left: 100, top: 50, right: 1_000, bottom: 650, x: 100, y: 50, toJSON: () => ({}),
    });
    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    const canvas = viewport.querySelector(".graph__canvas") as HTMLElement;
    const fittedTransform = canvas.style.transform;

    fireEvent.wheel(viewport, { deltaX: 48, deltaY: 24 });
    expect(canvas.style.transform).not.toBe(fittedTransform);

    const scaleBefore = screen.getByLabelText(/Zoom \d+%/i).textContent;
    fireEvent.wheel(viewport, { deltaY: -20, ctrlKey: true, clientX: 500, clientY: 300 });
    expect(screen.getByLabelText(/Zoom \d+%/i).textContent).not.toBe(scaleBefore);
  });

  it("brings an off-screen selected node back into view", () => {
    const { rerender } = render(<AgentGraph snapshot={snapshot} onSelect={() => undefined} />);
    const viewport = screen.getByLabelText(/Interactive agent graph/i);
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      width: 600, height: 400, left: 0, top: 0, right: 600, bottom: 400, x: 0, y: 0, toJSON: () => ({}),
    });
    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    const canvas = viewport.querySelector(".graph__canvas") as HTMLElement;
    fireEvent.wheel(viewport, { deltaX: -2_000 });
    const offscreenTransform = canvas.style.transform;

    rerender(<AgentGraph snapshot={snapshot} selectedId="tester" onSelect={() => undefined} />);

    expect(canvas.style.transform).not.toBe(offscreenTransform);
  });

  it("selects an agent from the list", () => {
    const onSelect = vi.fn();
    render(<AgentList snapshot={snapshot} onSelect={onSelect} />);
    const tester = screen.getByText("Tester").closest("button")!;
    const root = screen.getByText("Main").closest("button")!;
    expect(tester.closest(".agent-tree-item")?.getAttribute("style"))
      .not.toBe(root.closest(".agent-tree-item")?.getAttribute("style"));
    expect(root.closest(".agent-tree-item")).toHaveAttribute("data-parent", "true");
    expect(tester.closest(".agent-tree-item")).not.toHaveAttribute("data-parent");
    expect(screen.getByText("Parent")).toBeInTheDocument();
    fireEvent.click(tester);
    expect(onSelect).toHaveBeenCalledWith("tester");
  });

  it("collapses and expands child agents from the list", () => {
    render(<AgentList snapshot={snapshot} onSelect={() => undefined} />);
    const collapse = screen.getByRole("button", { name: "Collapse Main" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(collapse);
    expect(screen.queryByText("Tester")).not.toBeInTheDocument();
    const expand = screen.getByRole("button", { name: "Expand Main" });
    expect(expand).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(expand);
    expect(screen.getByText("Tester")).toBeInTheDocument();
  });

  it("filters agents by observed execution context", () => {
    render(<AgentList snapshot={snapshot} onSelect={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    expect(screen.getByText("Tester")).toBeInTheDocument();
    expect(screen.getByText("Main")).toBeInTheDocument();
  });

  it("virtualizes a large activity timeline while scrolling", () => {
    const activities = Array.from({ length: 300 }, (_, index) => ({
      id: `activity-${index}`,
      agentId: "tester",
      kind: "command" as const,
      title: `Event ${index}`,
      startedAt: 1_000 + index,
    }));
    render(<ActivityTimeline snapshot={{ ...snapshot, activities }} />);
    const list = screen.getByRole("list", { name: "Recent activity, 300 events" });

    expect(list.querySelectorAll(".timeline-item").length).toBeLessThan(20);
    expect(screen.getByText("Event 0")).toBeInTheDocument();
    expect(screen.queryByText("Event 100")).not.toBeInTheDocument();

    Object.defineProperty(list, "clientHeight", { configurable: true, value: 256 });
    fireEvent.scroll(list, { target: { scrollTop: 7_600 } });

    expect(screen.queryByText("Event 0")).not.toBeInTheDocument();
    expect(screen.getByText("Event 100")).toBeInTheDocument();
    expect(list.querySelectorAll(".timeline-item").length).toBeLessThan(20);
  });

  it("renders a chronological human and agent narrative with message routes", () => {
    render(<RunHistory snapshot={{
      ...snapshot,
      history: [
        {
          id: "decision",
          kind: "decision",
          actor: { type: "agent", id: "root" },
          summary: "Plan updated",
          content: "Inspect, implement, verify",
          status: "completed",
          occurredAt: 200,
          source: "protocol",
        },
        {
          id: "handoff",
          kind: "handoff",
          actor: { type: "agent", id: "root" },
          recipients: [{ type: "agent", id: "tester" }],
          summary: "Sent message",
          content: "Verify the browser flow",
          status: "sent",
          occurredAt: 300,
          source: "protocol",
        },
        {
          id: "request",
          kind: "request",
          actor: { type: "human" },
          recipients: [{ type: "agent", id: "root" }],
          summary: "Request received",
          content: "Review authentication",
          status: "completed",
          occurredAt: 100,
          source: "protocol",
        },
      ],
    }} />);

    const events = screen.getByRole("list", { name: "Run history, 3 events" });
    expect([...events.querySelectorAll(".history-event__summary")].map((node) => node.textContent))
      .toEqual(["Request received", "Plan updated", "Sent message"]);
    expect(screen.getByText("Verify the browser flow")).toBeInTheDocument();
    expect(events.querySelector(".history-event__route")?.textContent).toContain("Human→Main");
    expect(events.querySelectorAll(".history-event__route")[2]?.textContent).toContain("Main→Tester");
  });

  it("switches the right rail between narrative messages and low-level trace", () => {
    render(<RightRail snapshot={{
      ...snapshot,
      history: [{
        id: "message",
        kind: "handoff",
        actor: { type: "agent", id: "root" },
        recipients: [{ type: "agent", id: "tester" }],
        summary: "Sent message",
        status: "sent",
        occurredAt: 100,
        source: "protocol",
      }],
    }} onClear={() => undefined} now={5_000} />);

    fireEvent.click(screen.getByRole("button", { name: "Messages" }));
    expect(screen.getByRole("list", { name: "Messages, 1 events" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Trace" }));
    expect(screen.getByRole("list", { name: "Recent activity, 1 events" })).toBeInTheDocument();
  });

  it("groups agents into evidence-based workflow lanes", () => {
    const onSelect = vi.fn();
    render(<WorkflowBoard snapshot={snapshot} onSelect={onSelect} />);

    expect(screen.getByRole("heading", { name: "SDD" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No workflow evidence" })).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/not orchestration ownership/i);

    fireEvent.click(screen.getByRole("button", { name: /Tester, Waiting, SDD workflow lane/i }));
    expect(onSelect).toHaveBeenCalledWith("tester");
  });

  it("orders workflow agents by observed start, update, or status", () => {
    const workflowSnapshot: ObservatorySnapshot = {
      ...snapshot,
      agents: {
        ...snapshot.agents,
        root: { ...snapshot.agents.root!, observedWorkflows: ["SDD"], startedAt: 100, updatedAt: 300 },
        tester: { ...snapshot.agents.tester!, startedAt: 200, updatedAt: 400 },
      },
    };
    render(<WorkflowBoard snapshot={workflowSnapshot} onSelect={() => undefined} />);
    const lane = screen.getByRole("heading", { name: "SDD" }).closest("section")!;
    const names = () => [...lane.querySelectorAll(".workflow-card > strong")].map((node) => node.textContent);

    expect(names()).toEqual(["Main", "Tester"]);
    expect(screen.getByText("Started ↑")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Updated" }));
    expect(names()).toEqual(["Tester", "Main"]);
    expect(screen.getByText("Updated ↓")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Status" }));
    expect(names()).toEqual(["Main", "Tester"]);
    expect(screen.getByText("Status priority")).toBeInTheDocument();
  });

  it("virtualizes recent inspector activity while scrolling", () => {
    const activities = Array.from({ length: 30 }, (_, index) => ({
      id: `recent-${index}`,
      agentId: "tester",
      kind: "command" as const,
      title: `Recent ${index}`,
      startedAt: 1_000 + index,
    }));
    render(<RecentActivityList activities={activities} />);
    const list = screen.getByRole("list", { name: "Recent activity, 30 events" });

    expect(list.querySelectorAll(".inspector__recent-item").length).toBeLessThan(20);
    expect(screen.getByText("Recent 0")).toBeInTheDocument();
    expect(screen.queryByText("Recent 20")).not.toBeInTheDocument();

    Object.defineProperty(list, "clientHeight", { configurable: true, value: 96 });
    fireEvent.scroll(list, { target: { scrollTop: 800 } });

    expect(screen.queryByText("Recent 0")).not.toBeInTheDocument();
    expect(screen.getByText("Recent 20")).toBeInTheDocument();
    expect(list.querySelectorAll(".inspector__recent-item").length).toBeLessThan(20);
  });

  it("shows waiting reason and recent activity in the inspector", () => {
    render(<RightRail snapshot={snapshot} selectedId="tester" onClear={() => undefined} now={5_000} />);
    expect(screen.getAllByText(/Waiting · approval/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Running vitest").length).toBeGreaterThan(0);
    expect(screen.getByText("gpt-5.6-terra")).toBeInTheDocument();
    expect(screen.getByText("medium")).toBeInTheDocument();
    expect(screen.getByText("sdd-verify")).toBeInTheDocument();
    expect(screen.getByText("SDD")).toBeInTheDocument();
    expect(screen.getByText("/repo")).toBeInTheDocument();
  });
});
