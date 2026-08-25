import { useEffect, useState } from "react";
import type { AgentNode, AgentRuntimeStatus } from "@observatory/core";

export const STATUS: Record<AgentRuntimeStatus, { icon: string; label: string }> = {
  working: { icon: "●", label: "Working" },
  waiting: { icon: "◐", label: "Waiting" },
  idle: { icon: "○", label: "Idle" },
  completed: { icon: "✓", label: "Completed" },
  failed: { icon: "!", label: "Failed" },
  unknown: { icon: "?", label: "Unknown" },
};

const FALLBACK_ROLE_COLORS = ["#93c5fd", "#c4b5fd", "#67e8f9", "#fcd34d", "#6ee7b7", "#fda4af"];

export function roleColor(role?: string): string {
  const value = role?.trim().toLowerCase() ?? "agent";
  if (/^(root|main|agent|orchestrator)$/.test(value)) return "#a8b3ba";
  if (/(architect|planner|research|analyst)/.test(value)) return "#c4b5fd";
  if (/(implement|builder|engineer|frontend|backend|developer)/.test(value)) return "#7dd3fc";
  if (/(evaluat|test|qa|validator)/.test(value)) return "#fbbf24";
  if (/(review|audit)/.test(value)) return "#5eead4";
  if (/(fix|debug|repair)/.test(value)) return "#fb7185";
  let hash = 0;
  for (const character of value) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return FALLBACK_ROLE_COLORS[Math.abs(hash) % FALLBACK_ROLE_COLORS.length] ?? "#a8b3ba";
}

export function roleDescription(role?: string): string {
  const value = role?.trim().toLowerCase() ?? "agent";
  if (/^(root|main|orchestrator)$/.test(value)) {
    return "Coordinates the run, delegates work, and integrates agent results.";
  }
  if (value === "agent") return "General-purpose agent working on the current task.";
  if (/(architect|planner)/.test(value)) {
    return "Defines structure, constraints, and the implementation direction.";
  }
  if (/(research|analyst|explorer)/.test(value)) {
    return "Investigates context, evidence, and possible approaches.";
  }
  if (/(implement|builder|engineer|frontend|backend|developer)/.test(value)) {
    return "Builds and modifies the requested implementation.";
  }
  if (/(evaluat|test|qa|validator)/.test(value)) {
    return "Checks behavior, quality, tests, and acceptance criteria.";
  }
  if (/(review|audit)/.test(value)) {
    return "Reviews results for correctness, risk, and regressions.";
  }
  if (/(fix|debug|repair)/.test(value)) {
    return "Diagnoses issues and applies corrective changes.";
  }
  return "Custom agent role defined by the current workflow.";
}

export type TimelineFilter = "all" | "agent" | "tool" | "file" | "command" | "error";
export type AgentContextFilter = "all" | "skill" | "workflow";

type ProviderAwareAgent = AgentNode & { provider?: string };

export function normalizeProvider(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "anthropic" || normalized.includes("claude")) return "claude";
  if (normalized === "openai" || normalized.includes("codex")) return "codex";
  return normalized;
}

export function agentProvider(agent: AgentNode, fallback?: string): string {
  const declared = normalizeProvider((agent as ProviderAwareAgent).provider);
  if (declared) return declared;
  const modelProvider = normalizeProvider(agent.modelProvider);
  if (modelProvider) return modelProvider;
  const model = agent.model?.toLowerCase();
  if (model?.startsWith("claude")) return "claude";
  if (model && /^(gpt|o\d|codex)/.test(model)) return "codex";
  const namespacedId = normalizeProvider(agent.id.split(":", 1)[0]);
  if (namespacedId === "codex" || namespacedId === "claude") return namespacedId;
  return normalizeProvider(fallback) ?? "unknown";
}

export function providerLabel(provider: string): string {
  const normalized = normalizeProvider(provider) ?? "unknown";
  if (normalized === "codex") return "Codex";
  if (normalized === "claude") return "Claude";
  if (normalized === "mock") return "Mock";
  if (normalized === "unknown") return "Unknown";
  return normalized[0]?.toUpperCase() + normalized.slice(1);
}

export function ProviderBadge({ provider, compact = false }: { provider: string; compact?: boolean }) {
  const normalized = normalizeProvider(provider) ?? "unknown";
  const label = providerLabel(normalized);
  return (
    <span className={`provider-badge provider-badge--${normalized}`} data-provider={normalized} data-compact={compact || undefined} aria-label={`Provider: ${label}`}>
      {compact ? null : label}
    </span>
  );
}

export function useNow(interval = 1_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), interval);
    return () => window.clearInterval(timer);
  }, [interval]);
  return now;
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

export function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(timestamp);
}

export function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

export function agentRuntimeLabel(agent: AgentNode): string | undefined {
  const values = [agent.model, agent.reasoningEffort].filter((value): value is string => Boolean(value));
  return values.length > 0 ? values.join(" · ") : undefined;
}

export function agentContextLabel(agent: AgentNode): string | undefined {
  const skills = agent.observedSkills ?? [];
  const workflows = agent.observedWorkflows ?? [];
  const values = [
    skills.length > 0 ? `Skill: ${skills.join(", ")}` : undefined,
    workflows.length > 0 ? `Workflow: ${workflows.join(", ")}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return values.length > 0 ? values.join(" · ") : undefined;
}

export function agentContextSummary(agent: AgentNode): string | undefined {
  const skills = agent.observedSkills ?? [];
  const workflows = agent.observedWorkflows ?? [];
  const skill = skills[0] ? `${skills[0]}${skills.length > 1 ? ` +${skills.length - 1}` : ""}` : undefined;
  const workflow = workflows[0] ? `${workflows[0]}${workflows.length > 1 ? ` +${workflows.length - 1}` : ""}` : undefined;
  return [skill, workflow].filter(Boolean).join(" · ") || undefined;
}

export function StatusBadge({ agent, compact = false }: { agent: AgentNode; compact?: boolean }) {
  const status = STATUS[agent.status];
  const waiting = agent.waitingReasons
    .map((reason) => reason === "userInput" ? "user input" : reason)
    .join(" + ");
  const label = agent.status === "waiting" && waiting ? `${status.label} · ${waiting}` : status.label;
  return (
    <span className={`status status--${agent.status}`} aria-label={`Status: ${label}`}>
      <span className="status__icon" aria-hidden="true">{status.icon}</span>
      {!compact && <span>{label}</span>}
    </span>
  );
}
