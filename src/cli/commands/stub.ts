import { EXIT, type CommandRun } from "../types.ts";

/**
 * The seam a later work package replaces: each command file exports `run`, and until its owner
 * lands, `run` is this. Replace the body of the command's own file; the registry never changes.
 */
export function stubCommand(name: string, owner: string): CommandRun {
  return async (ctx) => {
    ctx.stderr.write(`mctl ${name} is not implemented yet (${owner}).\n`);
    return EXIT.failed;
  };
}
