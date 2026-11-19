import type { CommandModule } from "../types.ts";

/**
 * The `mctl` command registry (spec 7.13). One entry per command; `src/cli/index.ts` is the only
 * reader. Each command's body lives in its own file, owned by the work package in `owner`, so a
 * later package replaces a stub without touching this list.
 *
 * `needsFlag` is false only for `setup` and `doctor`: with `headless-mode` off, every other
 * command exits 2 with `headless-mode is off: run mctl setup` (spec 7.1).
 */
export interface CommandSpec {
  name: string;
  aliases: readonly string[];
  summary: string;
  usage: string;
  needsFlag: boolean;
  owner: string;
  load: () => Promise<CommandModule>;
}

export const COMMANDS: readonly CommandSpec[] = [
  { name: "get", aliases: ["ls"], summary: "List tasks, kinds or workflows", usage: "mctl get (tasks|kinds|workflows) [--all] [--repo path] [--state s] [--json]", needsFlag: true, owner: "WP6a", load: () => import("./get.ts") },
  { name: "describe", aliases: [], summary: "Show one home-dispatched task", usage: "mctl describe {id} [--json]", needsFlag: true, owner: "WP6a", load: () => import("./describe.ts") },
  { name: "logs", aliases: [], summary: "Show a worker's conversation", usage: "mctl logs {id} [-f]", needsFlag: true, owner: "WP6a", load: () => import("./logs.ts") },
  { name: "status", aliases: [], summary: "Counts by state, slots and the Foreman leader", usage: "mctl status [--watch] [--repo path] [--json]", needsFlag: true, owner: "WP6a", load: () => import("./status.ts") },
  { name: "config", aliases: [], summary: "View dispatch settings", usage: "mctl config view [--json]", needsFlag: true, owner: "WP6a", load: () => import("./config.ts") },
  { name: "run", aliases: [], summary: "Create and start a task", usage: "mctl run ({prompt} | -f {file}) [--kind k] [--after-work w] [--agent a] [--model m] [--effort e] [--repo path] [--depends-on id]... [--priority p] [--label l]... [--shelve] [--dry-run] [--watch] [--json]", needsFlag: true, owner: "WP6b", load: () => import("./run.ts") },
  { name: "pick", aliases: [], summary: "Choose a worker to follow or jump into", usage: "mctl pick [--all] [--open] [--return-to {backend}:{pane}] [--json]", needsFlag: true, owner: "WP10", load: () => import("./pick.ts") },
  { name: "claude", aliases: [], summary: "Run claude with the dispatch menu", usage: "mctl claude [args]", needsFlag: true, owner: "WP6b", load: () => import("./claude.ts") },
  { name: "setup", aliases: [], summary: "Turn headless mode on and register it", usage: "mctl setup [--off] [--service]", needsFlag: false, owner: "WP7", load: () => import("./setup.ts") },
  { name: "doctor", aliases: [], summary: "Check this machine is ready", usage: "mctl doctor", needsFlag: false, owner: "WP7", load: () => import("./doctor.ts") },
  { name: "daemon", aliases: [], summary: "Service status and restart", usage: "mctl daemon (status|restart)", needsFlag: true, owner: "WP6b", load: () => import("./daemon.ts") },
];

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name || c.aliases.includes(name));
}

export function usageText(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  return ["usage: mctl {command} [args]", "", ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`), ""].join("\n");
}
