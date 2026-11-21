import type { CommandOwner, CommandSpec } from "./types.ts";

/** The text every stub prints, so a test can tell a stub from a real command. */
export const NOT_IMPLEMENTED_TEXT = "not implemented";

/** A command that reports `mctl {name}: not implemented` and exits 1. The owner replaces the call. */
export function stubCommand(name: string, owner: CommandOwner, summary: string, usage: string): CommandSpec {
  return {
    name,
    summary,
    usage,
    owner,
    implemented: false,
    run: async (_args, io) => {
      io.stderr(`mctl ${name}: ${NOT_IMPLEMENTED_TEXT}\n`);
      return 1;
    },
  };
}
