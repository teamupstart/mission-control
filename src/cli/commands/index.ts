import { command as claude } from "./claude.ts";
import { command as config } from "./config.ts";
import { command as daemon } from "./daemon.ts";
import { command as describe } from "./describe.ts";
import { command as doctor } from "./doctor.ts";
import { command as get } from "./get.ts";
import { command as logs } from "./logs.ts";
import { command as run } from "./run.ts";
import { command as setup } from "./setup.ts";
import { command as status } from "./status.ts";
import type { CommandSpec } from "./types.ts";

export type { CliIo, CommandOwner, CommandSpec } from "./types.ts";

/**
 * Every `mctl` command, in help order (spec 7.13). A phase replaces a command's file and leaves
 * this list alone, so there is nothing to merge here after P2.
 */
export const COMMANDS: readonly CommandSpec[] = [get, describe, logs, status, config, run, claude, setup, doctor, daemon];

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name);
}
