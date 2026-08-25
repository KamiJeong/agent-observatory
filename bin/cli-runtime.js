import { createServer } from "node:net";

export function resolveRuntimeConfiguration(values) {
  if (values.real && values.mock) {
    throw new Error("Use either --real or --mock, not both.");
  }
  if (values.real && values.scenario) {
    throw new Error("Use --scenario without --real; scenarios run in Mock Mode.");
  }

  const mock = Boolean(values.mock || values.scenario);
  if (mock && values.provider) {
    throw new Error("--provider is available only in Real Mode.");
  }
  return {
    adapter: mock ? "mock" : "real",
    providers: mock
      ? undefined
      : values.provider === "all" || values.provider === undefined
        ? "codex,claude"
        : values.provider,
    cwd: mock ? undefined : values.cwd ?? "all",
  };
}

export function browserCommand(platform, environment, target) {
  if (platform === "darwin") return { file: "open", args: [target] };
  if (platform === "win32") return { file: "cmd", args: ["/c", "start", "", target] };
  if (environment.WSL_INTEROP || environment.WSL_DISTRO_NAME) {
    return { file: "cmd.exe", args: ["/c", "start", "", target] };
  }
  return { file: "xdg-open", args: [target] };
}

export function portIsAvailable(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.close((error) => resolve(!error));
    });
  });
}

export async function selectAvailablePort(preferredPort, options = {}) {
  const host = options.host ?? "127.0.0.1";
  const allowFallback = options.allowFallback ?? true;
  if (await portIsAvailable(preferredPort, host)) return preferredPort;
  if (!allowFallback) throw new Error(`Port ${preferredPort} is already in use.`);

  for (let candidate = preferredPort + 1; candidate <= 65_535; candidate += 1) {
    if (await portIsAvailable(candidate, host)) return candidate;
  }
  throw new Error(`No available port found after ${preferredPort}.`);
}
