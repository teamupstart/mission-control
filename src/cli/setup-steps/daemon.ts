import { checkDaemon } from "../setup-checks.ts";
import type { SetupStepOptions, SetupStepResult } from "./types.ts";
export const id = "daemon" as const;
export const owner = "P14" as const;
export const implemented = true;
export async function run({ context }: SetupStepOptions): Promise<SetupStepResult> {
  if (!context) throw new Error("Setup context required");
  const check = await checkDaemon(context);
  return { id, status: check.ok ? "ok" : "failed", message: check.message };
}
