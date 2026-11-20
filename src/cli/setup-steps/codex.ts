import { stubResult, type SetupStepOptions, type SetupStepResult } from "./types.ts";

// Owner: P7. Replace this stub, set `implemented` to true, and keep the `run` signature.
export const id = "codex" as const;
export const implemented = false;

export async function run(_options: SetupStepOptions): Promise<SetupStepResult> {
  return stubResult(id, "codex: not built yet");
}
