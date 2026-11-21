import { COMMANDS, findCommand, type CliIo } from "./commands/index.ts";

/** The help text: one line per registered command. */
export function usageText(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  const rows = COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`);
  return `usage: mctl <command> [args]\n\ncommands:\n${rows.join("\n")}\n`;
}

/**
 * Runs `mctl` with the arguments after the program name and returns its exit code. It touches
 * no process global, so tests pass their own `CliIo`. An unknown or missing command is a
 * usage error (exit 2).
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const [name, ...rest] = argv;
  if (name === "help" || name === "--help" || name === "-h") {
    io.stdout(usageText());
    return 0;
  }
  if (name === undefined) {
    io.stderr(usageText());
    return 2;
  }
  const command = findCommand(name);
  if (!command) {
    io.stderr(`mctl: unknown command ${name}\n${usageText()}`);
    return 2;
  }
  return command.run(rest, io);
}
