import { checkFlag, fetchHealth } from "./checks.ts";
import { resolveDeps } from "./context.ts";
import type { SetupStepOptions, SetupStepResult } from "./types.ts";

// Owner: P14. Reads the flag through the daemon's `/api/health`; setup never turns a flag on.
export const id = "flag" as const;
export const owner = "P14" as const;
export const implemented = true;

export async function run(options: SetupStepOptions): Promise<SetupStepResult> {
  const deps = resolveDeps(options.deps);
  const check = checkFlag(await fetchHealth(deps));
  return { id, status: check.status === "fail" ? "failed" : "ok", message: check.fix ? check.message + ". " + check.fix : check.message, checks: [check] };
}
