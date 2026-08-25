export interface RuntimeValues {
  real?: boolean;
  mock?: boolean;
  scenario?: string;
  provider?: string;
  cwd?: string;
}

export interface RuntimeConfiguration {
  adapter: "real" | "mock";
  providers?: string;
  cwd?: string;
}

export interface BrowserCommand {
  file: string;
  args: string[];
}

export function resolveRuntimeConfiguration(values: RuntimeValues): RuntimeConfiguration;
export function browserCommand(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  target: string,
): BrowserCommand;
export function portIsAvailable(port: number, host?: string): Promise<boolean>;
export function selectAvailablePort(
  preferredPort: number,
  options?: { host?: string; allowFallback?: boolean },
): Promise<number>;
