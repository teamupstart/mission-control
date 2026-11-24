import { doctorChecks, formatChecks } from "../setup-checks.ts";
import type { SetupStepOptions, SetupStepResult } from "./types.ts";
export const id = "doctor" as const;
export const owner = "P14" as const;
export const implemented = true;
export async function run({ context }: SetupStepOptions): Promise<SetupStepResult> {
  if (!context) throw new Error("Setup context required");
  const checks = await doctorChecks(context);
  return { id, status: checks.every((check) => check.ok) ? "ok" : "failed", message: formatChecks(checks).trimEnd() };
}
