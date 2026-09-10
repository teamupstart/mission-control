import { readFileSync } from "node:fs";

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
 * which is the wrapper's last line. Everything else about these assertions is unchanged: the
 * line is the same `shellCommand` output the backend used to receive directly, so the same
 * single-quoted literals still pin that flags arrived as separate words.
 *
 * A command that is not a wrapper comes back as it was given, so a backend or fixture that
 * never went through the wrapping reads correctly too.
 */
export function launchedCommand(command: string): string {
  const wrapper = /'([^']*launch-and-cleanup\.sh)'/.exec(command)?.[1];
  if (!wrapper) return command;
  return readFileSync(wrapper, "utf8").trimEnd().split("\n").at(-1) ?? "";
}
