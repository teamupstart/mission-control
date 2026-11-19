/** What a command receives. Injectable so tests drive commands without a terminal or a daemon. */
export interface CommandContext {
  args: readonly string[];
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  env: NodeJS.ProcessEnv;
}

export type CommandRun = (ctx: CommandContext) => Promise<number>;

export interface CommandModule {
  run: CommandRun;
}

export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;
