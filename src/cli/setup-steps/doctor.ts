import { runChecks } from "./checks.ts";
import { resolveDeps } from "./context.ts";
import type { SetupStepOptions, SetupStepResult } from "./types.ts";

// Owner: P14. The last step of setup and the whole of `mctl doctor`: every kept check, read only.
export const id = "doctor" as const;
export const owner = "P14" as const;
export const implemented = true;

export async function run(options: SetupStepOptions): Promise<SetupStepResult> {
  const checks = await runChecks(resolveDeps(options.deps));
  const failed = checks.filter((c) => c.status === "fail");
  return {
    id,
    status: failed.length > 0 ? "failed" : "ok",
    message: failed.length > 0 ? failed.length + " of " + checks.length + " checks failed" : "all " + checks.length + " checks passed",
    checks,
  };
}
