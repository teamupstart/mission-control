import { checkDaemon, fetchHealth } from "./checks.ts";
import { resolveDeps } from "./context.ts";
import type { SetupStepOptions, SetupStepResult } from "./types.ts";

// Owner: P14. Reads only: setup does not start the daemon (the Foreman LaunchAgent is deferred).
export const id = "daemon" as const;
export const owner = "P14" as const;
export const implemented = true;

export async function run(options: SetupStepOptions): Promise<SetupStepResult> {
  const deps = resolveDeps(options.deps);
  const check = checkDaemon(await fetchHealth(deps), deps);
  return { id, status: check.status === "fail" ? "failed" : "ok", message: check.fix ? check.message + ". " + check.fix : check.message, checks: [check] };
}
