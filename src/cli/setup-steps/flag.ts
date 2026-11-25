import { readFile } from "node:fs/promises";
import { daemonBaseUrl, readDaemonToken } from "../../mod/daemon-link.ts";
import { FeatureFlagsConfigSchema, resolveFeatureFlag } from "../../shared/feature-flags.ts";
import { checkDaemon, checkFlag, fetchHealth } from "./checks.ts";
import { resolveDeps } from "./context.ts";
import type { SetupStepOptions, SetupStepResult } from "./types.ts";

export const id = "flag" as const;
export const owner = "P14" as const;
export const implemented = true;

export async function run(options: SetupStepOptions): Promise<SetupStepResult> {
  const deps = resolveDeps(options.deps);
  const health = await fetchHealth(deps);
  const daemon = checkDaemon(health, deps);
  if (daemon.status === "fail") return { id, status: "failed", message: daemon.message };
  const current = checkFlag(health.body);
  const wanted = !options.off;
  if (wanted && current.status === "ok") return { id, status: "ok", message: current.message, checks: [current] };
  try {
    const token = await readDaemonToken({ ...deps.env, MISSION_HOME: deps.stateDir }, (path) => readFile(path, "utf8"));
    const response = await deps.fetch(`${daemonBaseUrl(deps.env)}/api/feature-flags`, {
      method: "PUT", headers: { "x-harness-token": token, "content-type": "application/json" },
      body: JSON.stringify({ kind: "flag", id: "headless-mode", enabled: wanted }),
      signal: AbortSignal.timeout(5000), redirect: "error",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { config?: unknown };
    if (payload.config === undefined) throw new Error("daemon returned no flag configuration");
    const config = FeatureFlagsConfigSchema.parse(payload.config);
    if (resolveFeatureFlag("headless-mode", config) !== wanted) throw new Error("daemon did not apply the flag change");
    if (deps.runCache) delete deps.runCache.reading;
    return { id, status: "ok", message: `the headless-mode preview flag is ${wanted ? "on" : "off"}` };
  } catch (error) {
    return { id, status: "failed", message: `could not change the headless-mode flag: ${error instanceof Error ? error.message : String(error)}` };
  }
}
