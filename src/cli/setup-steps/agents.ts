import { stubResult, type SetupStepOptions, type SetupStepResult } from "./types.ts";

// Owner: P15. Replace this stub, set `implemented` to true, and keep the `run` signature.
export const id = "agents" as const;
export const implemented = false;

export async function run(_options: SetupStepOptions): Promise<SetupStepResult> {
  return stubResult(id, "agents: not built yet");
}
