import { checkFlag } from "../setup-checks.ts";
import type { SetupStepOptions, SetupStepResult } from "./types.ts";
export const id = "flag" as const;
export const owner = "P14" as const;
export const implemented = true;
export async function run({ context }: SetupStepOptions): Promise<SetupStepResult> {
  if (!context) throw new Error("Setup context required");
  const check = await checkFlag(context, context.mode === "setup");
  return { id, status: check.ok ? "ok" : "failed", message: check.message };
}
