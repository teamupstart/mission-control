import { SETUP_STEPS } from "../setup-steps/index.ts";
import type { DoctorCheck, SetupStepOptions } from "../setup-steps/types.ts";
import type { CommandSpec } from "./types.ts";

// Owner: P14. Runs the setup steps in order; a failed step does not stop the rest.

/** What a step prints when its owning phase has not replaced the stub in this build. */
export const STEP_UNAVAILABLE_TEXT = "step not available in this build";

export function formatCheck(check: DoctorCheck): string {
  const tag = check.status === "ok" ? "ok  " : check.status === "warn" ? "warn" : "FAIL";
  const fix = check.fix ? "\n        fix: " + check.fix : "";
  return "  " + tag + "  " + check.name + ": " + check.message + fix + "\n";
}

export const command: CommandSpec = {
  name: "setup",
  summary: "Install and check headless mode",
  usage: "mctl setup",
  owner: "P14",
  implemented: true,
  run: async (args, io) => {
    if (args.length > 0) {
      io.stderr("mctl setup: unexpected argument " + args[0] + " (the Foreman service and --off are not available in this build)\nusage: " + command.usage + "\n");
      return 2;
    }
    // The environment comes from the caller, so the steps see what `mctl` was started with.
    const options: SetupStepOptions = { live: false, deps: { env: io.env } };
    let failed = 0;
    for (const step of SETUP_STEPS) {
      if (!step.implemented) {
        io.stdout("- " + step.id + ": " + STEP_UNAVAILABLE_TEXT + "\n");
        continue;
      }
      const result = await step.run(options);
      if (result.status === "failed") failed += 1;
      io.stdout((result.status === "ok" ? "ok  " : "FAIL") + "  " + step.id + ": " + result.message + "\n");
      for (const check of result.checks ?? []) if (step.id === "doctor") io.stdout(formatCheck(check));
    }
    if (failed > 0) {
      io.stderr("mctl setup: " + failed + " step" + (failed === 1 ? "" : "s") + " failed; fix the lines marked FAIL and run it again\n");
      return 1;
    }
    return 0;
  },
};
