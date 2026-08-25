export interface RuntimeValues {
  real?: boolean;
  mock?: boolean;
  scenario?: string;
  provider?: string;
}

export interface RuntimeConfiguration {
  adapter: "real" | "mock";
  providers?: string;
}

export function resolveRuntimeConfiguration(values: RuntimeValues): RuntimeConfiguration;
export function portIsAvailable(port: number, host?: string): Promise<boolean>;
export function selectAvailablePort(
  preferredPort: number,
  options?: { host?: string; allowFallback?: boolean },
): Promise<number>;
