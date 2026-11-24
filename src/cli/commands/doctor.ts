import { createSetupContext } from "../setup-context.ts";
import { doctorChecks, formatChecks } from "../setup-checks.ts";
import type { CommandSpec } from "./types.ts";

export const command: CommandSpec = {
  name: "doctor", owner: "P14", implemented: true,
  summary: "Check headless mode, changing nothing", usage: "mctl doctor",
  async run(args, io) {
    if (args.length) {
      io.stderr("usage: mctl doctor\nLive model checks are not available in this build.\n");
      return 2;
    }
    const checks = await doctorChecks(createSetupContext(io, "doctor"));
    io.stdout(formatChecks(checks));
    return checks.every((check) => check.ok) ? 0 : 1;
  },
};
