/**
 * The shape every `mctl` command takes (spec 7.13). The registry in `index.ts` lists one
 * `CommandSpec` per command, and the phase that owns a command replaces its file's `command`
 * export without changing this shape.
 */

/** Where a command writes and what it was started with, so tests drive it without a process. */
export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  /** True when stdin is a terminal (`mctl run` refuses without one). */
  stdinIsTty: boolean;
}

/** The phase that fills a stub; the registry test pins it so no command is left unowned. */
export type CommandOwner = "P10" | "P13" | "P14";

export interface CommandSpec {
  name: string;
  summary: string;
  usage: string;
  owner: CommandOwner;
  /** True once the owning phase replaced the stub. */
  implemented: boolean;
  /** Runs the command with the arguments after its name and returns the exit code. */
  run: (args: readonly string[], io: CliIo) => Promise<number>;
}
