import { useRef, useState } from "react";
import { ProviderBadge, providerLabel } from "../shared/presentation.tsx";

export type ProviderPhase =
  | "ready"
  | "discovering"
  | "setup-required"
  | "unsupported"
  | "permission-blocked"
  | "error"
  | "offline"
  | "unknown";

export interface ProviderHealth {
  provider: string;
  phase: ProviderPhase;
  message?: string;
  lastUpdatedAt?: number;
  agentCount: number;
}

export type ProviderGuidanceState =
  | "active"
  | "no-session"
  | Exclude<ProviderPhase, "ready">;

export interface ProviderGuidance {
  provider: string;
  state: ProviderGuidanceState;
  title: string;
  description: string;
  command?: string;
  commandLabel?: string;
}

const REPOSITORY_URL = "https://github.com/KamiJeong/agent-observatory";

function providerLaunchCommand(provider: string): string | undefined {
  if (provider === "codex" || provider === "claude") return provider;
  return undefined;
}

function observatoryCommand(provider: string): string {
  const selected = provider === "codex" || provider === "claude" ? provider : "all";
  return `bunx agent-observatory --real --provider ${selected} --no-open`;
}

export function buildProviderGuidance(health: ProviderHealth): ProviderGuidance {
  const label = providerLabel(health.provider);
  if (health.phase === "ready" && health.agentCount > 0) {
    return {
      provider: health.provider,
      state: "active",
      title: `${label} observation is active`,
      description: `${health.agentCount} agent${health.agentCount === 1 ? " is" : "s are"} available in the dashboard.`,
    };
  }
  if (health.phase === "ready") {
    const command = providerLaunchCommand(health.provider);
    return {
      provider: health.provider,
      state: "no-session",
      title: `No active ${label} session`,
      description: `${label} is installed and observation is ready. Start a session and this view will update automatically.`,
      command,
      commandLabel: command ? `Launch ${label}` : undefined,
    };
  }
  if (health.phase === "setup-required") {
    return {
      provider: health.provider,
      state: health.phase,
      title: `${label} setup required`,
      description: `Restart Observatory with ${label} observation enabled. The command contains no credentials.`,
      command: observatoryCommand(health.provider),
      commandLabel: `Enable ${label} observation`,
    };
  }
  if (health.phase === "unsupported") {
    const command = health.provider === "codex"
      ? "npm install -g @openai/codex@latest"
      : health.provider === "claude"
        ? "claude update"
        : undefined;
    return {
      provider: health.provider,
      state: health.phase,
      title: `Unsupported ${label} version`,
      description: `Update ${label}, then restart Observatory. Existing provider data remains unchanged.`,
      command,
      commandLabel: command ? `Update ${label}` : undefined,
    };
  }
  if (health.phase === "permission-blocked") {
    return {
      provider: health.provider,
      state: health.phase,
      title: `${label} permission blocked`,
      description: `Observatory cannot read the local runtime metadata it needs. Review file access and restart after granting only the required permission.`,
    };
  }
  if (health.phase === "offline") {
    return {
      provider: health.provider,
      state: health.phase,
      title: `${label} observation disconnected`,
      description: `The provider collector stopped responding. Healthy providers and previously observed data remain available.`,
      command: observatoryCommand(health.provider),
      commandLabel: `Restart ${label} observation`,
    };
  }
  if (health.phase === "discovering") {
    return {
      provider: health.provider,
      state: health.phase,
      title: `Looking for ${label} sessions`,
      description: `Discovery is still running. Start a ${label} session if none is currently active.`,
      command: providerLaunchCommand(health.provider),
      commandLabel: `Launch ${label}`,
    };
  }
  if (health.phase === "error") {
    return {
      provider: health.provider,
      state: health.phase,
      title: `${label} discovery failed`,
      description: `Observatory could not complete provider discovery. Open Debug for technical detail, then restart the collector.`,
      command: observatoryCommand(health.provider),
      commandLabel: `Restart ${label} observation`,
    };
  }
  return {
    provider: health.provider,
    state: health.phase,
    title: `${label} status unavailable`,
    description: `No reliable provider status is available yet. Open Debug for discovery detail.`,
  };
}

function providerPrivacyUrl(provider: string): string {
  return provider === "claude"
    ? `${REPOSITORY_URL}/blob/main/docs/claude-compatibility.md#privacy-boundary`
    : `${REPOSITORY_URL}/blob/main/docs/architecture.md#runtime-boundary`;
}

function providerTroubleshootingUrl(provider: string): string {
  if (provider === "claude") return `${REPOSITORY_URL}/blob/main/README.md#real-claude-code-mode`;
  if (provider === "codex") return `${REPOSITORY_URL}/blob/main/README.md#real-codex-mode`;
  return `${REPOSITORY_URL}#troubleshooting`;
}

function CopyCommand({ command, label }: { command: string; label: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const commandRef = useRef<HTMLInputElement>(null);
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(command);
      setCopyState("copied");
    } catch {
      commandRef.current?.focus();
      commandRef.current?.select();
      setCopyState("failed");
    }
  };
  return (
    <div className="provider-guidance__command">
      <input ref={commandRef} value={command} readOnly aria-label={`${label} command`} />
      <button type="button" onClick={() => void copy()} aria-label={`Copy command for ${label}`}>
        {copyState === "copied" ? "Copied" : copyState === "failed" ? "Select command" : "Copy"}
      </button>
    </div>
  );
}

export function ProviderOnboarding({
  providers,
  hasAgentContent,
  onOpenDebug,
}: {
  providers: ProviderHealth[];
  hasAgentContent: boolean;
  onOpenDebug(): void;
}) {
  const guidance = providers.map(buildProviderGuidance);
  const degraded = guidance.filter((item) => !["active", "no-session"].includes(item.state));
  const active = guidance.filter((item) => item.state === "active");
  const visible = hasAgentContent ? degraded : guidance;
  if (visible.length === 0) return null;
  const partial = hasAgentContent && active.length > 0 && degraded.length > 0;
  const interrupted = hasAgentContent && active.length === 0 && degraded.length > 0;
  const heading = partial
    ? "Partial observation"
    : interrupted
      ? "Provider observation interrupted"
      : "No active agent sessions";
  const summary = partial
    ? `${active.map((item) => providerLabel(item.provider)).join(", ")} remains active while another provider needs attention.`
    : interrupted
      ? "Previously observed agents remain visible while provider recovery is required."
      : "Provider diagnostics below distinguish a ready runtime from setup or discovery problems.";

  return (
    <section className={`provider-guidance provider-guidance--${hasAgentContent ? "compact" : "empty"}`} aria-labelledby="provider-guidance-heading">
      <header className="provider-guidance__heading">
        <div>
          <span className="eyebrow">Runtime guidance</span>
          <h2 id="provider-guidance-heading">{heading}</h2>
          <p>{summary}</p>
        </div>
        <button type="button" className="provider-guidance__debug" onClick={onOpenDebug}>Open Debug</button>
      </header>
      <div className="provider-guidance__cards">
        {visible.map((item) => (
          <article className={`provider-guidance__card provider-guidance__card--${item.state}`} key={item.provider}>
            <div className="provider-guidance__card-heading">
              <ProviderBadge provider={item.provider} />
              <span>{item.state.replaceAll("-", " ")}</span>
            </div>
            <h3>{item.title}</h3>
            <p>{item.description}</p>
            {item.command && item.commandLabel && <CopyCommand command={item.command} label={item.commandLabel} />}
            <div className="provider-guidance__links">
              <a href={providerTroubleshootingUrl(item.provider)} target="_blank" rel="noreferrer">{providerLabel(item.provider)} troubleshooting</a>
              <a href={providerPrivacyUrl(item.provider)} target="_blank" rel="noreferrer">Observation &amp; privacy</a>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export function NoFilterMatches({ onClear }: { onClear(): void }) {
  return (
    <section className="filter-empty" aria-labelledby="filter-empty-heading">
      <span className="empty-state__mark" aria-hidden="true">⌁</span>
      <h2 id="filter-empty-heading">No agents match these filters</h2>
      <p>Provider sessions may still be active. Clear the dashboard filters to restore all agent, graph, workflow, and history results.</p>
      <button type="button" onClick={onClear}>Clear dashboard filters</button>
    </section>
  );
}
