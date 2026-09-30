import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SupervisorLaunch } from "./types.ts";

// The turn supervisor relies on POSIX process groups; Windows is refused before any process starts.
export const ORCHESTRATION_PLATFORMS: readonly NodeJS.Platform[] = ["darwin", "linux"];

export type SupervisorLaunchResolution =
  | { ok: true; launch: SupervisorLaunch; helperPath: string }
  | { ok: false; reason: "unsupported_platform" | "helper_missing"; detail: string };

// Runs the helper with the application binary in Node mode
// (docs/adr/ADR-20260913-packaged-fuses-keep-run-as-node.md, orchestration amendment).
export function resolveSupervisorLaunch(input: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  execPath: string;
  exists?: (p: string) => boolean;
}): SupervisorLaunchResolution {
  if (!ORCHESTRATION_PLATFORMS.includes(input.platform)) {
    return { ok: false, reason: "unsupported_platform", detail: `Orchestration turns are not supported on ${input.platform}.` };
  }
  const helperPath = input.isPackaged
    ? join(input.resourcesPath, "orchestration", "supervisor.mjs")
    : join(input.appPath, "src", "orchestration", "supervisor.mjs");
  if (!(input.exists ?? existsSync)(helperPath)) {
    return { ok: false, reason: "helper_missing", detail: `Turn supervisor not found at ${helperPath}.` };
  }
  return {
    ok: true,
    helperPath,
    launch: { command: input.execPath, args: [helperPath], env: { ELECTRON_RUN_AS_NODE: "1" } }
  };
}
