import { run as runDoctor } from "../setup-steps/doctor.ts";
import { formatCheck } from "./setup.ts";
import type { CommandSpec } from "./types.ts";

// Owner: P14. Reports every kept check and the fix for each failure, and changes nothing.
export const command: CommandSpec = {
  name: "doctor",
  summary: "Check headless mode, changing nothing",
  usage: "mctl doctor [--live]",
  owner: "P14",
  implemented: true,
  run: async (args, io) => {
    const unknown = args.filter((a) => a !== "--live");
    if (unknown.length > 0) {
      io.stderr("mctl doctor: unexpected argument " + unknown[0] + "\nusage: " + command.usage + "\n");
      return 2;
    }
    // `--live` is the run that may spend tokens; no kept check does, so it adds nothing yet.
    const result = await runDoctor({ live: args.includes("--live"), deps: { env: io.env } });
    for (const check of result.checks ?? []) io.stdout(formatCheck(check));
    if (result.status === "failed") {
      io.stderr("mctl doctor: " + result.message + "\n");
      return 1;
    }
    io.stdout(result.message + "\n");
    return 0;
  },
};
