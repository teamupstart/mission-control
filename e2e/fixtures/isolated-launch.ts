import { readFileSync } from "node:fs";

import { shellWords } from "../../src/server/terminal/shell.ts";

/**
 * The agent command a terminal backend was really given, read back through the launch wrapper.
 *
 * What a backend receives is `'/bin/sh' '<state home>/launch-and-cleanup.sh'` and nothing
 * else. The environment and the agent's own command line live inside that script, because
 * Herdr has no way to launch a command except by TYPING it into a login shell, and a 3.5 KB
 * paste loses its Enter to the shell's bracketed-paste handling - the launch then sits at the
 * prompt, unexecuted. See `launchAndCleanupScript` in `src/server/agent-subprocess-env.ts`.
 *
 * So a spec that means "the reopened CLI carried its mode" has to look where the launch is,
 * which is the wrapper's last line. Everything else about those assertions is unchanged: the
 * line is the same `shellCommand` output the backend used to receive directly, so the same
 * single-quoted literals still pin that flags arrived as separate words.
 *
 * The path is decoded with `shellWords` rather than matched with a pattern, because
 * `shellCommand` renders an apostrophe as `'"'"'` - a wrapper under `/tmp/O'Brien` would be
 * read as the fragment after the apostrophe, and `readFileSync` would throw on a truncated
 * path before a single assertion ran.
 *
 * A command that is not a wrapper comes back as it was given, so a backend or fixture that
 * never went through the wrapping reads correctly too.
 */
export function launchedCommand(command: string): string {
  const wrapper = shellWords(command).find((word) => word.endsWith("launch-and-cleanup.sh"));
  if (!wrapper) return command;
  return readFileSync(wrapper, "utf8").trimEnd().split("\n").at(-1) ?? "";
}
