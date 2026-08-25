import type { RuntimeInfo } from "@observatory/core";

export function contentCapturePolicy(
  environment: NodeJS.ProcessEnv = process.env,
): NonNullable<RuntimeInfo["contentCapture"]> {
  return environment.OBSERVATORY_CAPTURE_CONTENT === "1" ? "enabled" : "metadata-only";
}

export function contentCaptureEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return contentCapturePolicy(environment) === "enabled";
}
