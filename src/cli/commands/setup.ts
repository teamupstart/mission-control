import { createSetupContext, type SetupContext } from "../setup-context.ts";
import { SETUP_STEPS } from "../setup-steps/index.ts";
import type { CommandSpec } from "./types.ts";

export async function runSetup(context: SetupContext): Promise<number> {
  let failed = false;
  for (const step of SETUP_STEPS) {
    if (context.off && step.id !== "daemon" && step.id !== "flag") continue;
    if (!step.implemented) {
      context.io.stdout(`${step.id}: step not available in this build\n`);
      continue;
    }
    try {
      const result = await step.run({ live: false, context });
      failed ||= result.status === "failed";
      context.io.stdout(step.id === "doctor" ? `${result.message}\n` : `${result.status === "failed" ? "FAIL" : "ok"} ${step.id}: ${result.message}\n`);
    } catch (error) {
      failed = true;
      context.io.stderr(`FAIL ${step.id}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  return failed ? 1 : 0;
}

export const command: CommandSpec = {
  name: "setup", owner: "P14", implemented: true,
  summary: "Install and check headless mode", usage: "mctl setup [--off]",
  async run(args, io) {
    if (args.some((arg) => arg !== "--off") || args.length > 1) {
      io.stderr("usage: mctl setup [--off]\nService installation is not available in this build.\n");
      return 2;
    }
    return runSetup(createSetupContext(io, "setup", args.includes("--off")));
  },
};
