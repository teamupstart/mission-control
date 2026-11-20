import { stubResult, type SetupStepOptions, type SetupStepResult } from "./types.ts";

// Owner: P14. Replace this stub, set `implemented` to true, and keep the `run` signature.
export const id = "flag" as const;
export const owner = "P14" as const;
export const implemented = false;

export async function run(_options: SetupStepOptions): Promise<SetupStepResult> {
  return stubResult(id, "flag: not implemented");
}
