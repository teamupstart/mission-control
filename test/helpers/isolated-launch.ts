import { readFileSync } from "node:fs";

/**
 * What a terminal backend was actually asked to run, read back through `isolatedAgentArgv`.
 *
 * The argv a backend receives is `/bin/sh <wrapper>` and nothing else. The environment and
 * the agent's own command line live inside that wrapper script, because Herdr has no way to
 * launch a command except by TYPING it into a login shell, and a 3.5 KB paste loses its Enter
 * to the shell's bracketed-paste handling - the launch then sits at the prompt, unexecuted.
 * See `launchAndCleanupScript` in `src/server/agent-subprocess-env.ts`.
 *
 * So a test that means "the launch carried `--resume`" has to look where the launch is, which
 * is the wrapper's last line. An argv that is not a wrapper is returned as it was given, so
 * this reads correctly for backends and fixtures that never went through the wrapping.
 */
export function launchedCommand(argv: readonly string[]): string {
  const wrapper = argv.length === 2 && argv[1]?.endsWith("launch-and-cleanup.sh") ? argv[1] : null;
  if (!wrapper) return argv.join(" ");
  return readFileSync(wrapper, "utf8").trimEnd().split("\n").at(-1) ?? "";
}

/** The launch's own argv, unquoted - what `execFile` would have been given. */
export function launchedArgv(argv: readonly string[]): string[] {
  const command = launchedCommand(argv);
  return [...command.matchAll(/'((?:[^']|'"'"')*)'|(\S+)/g)].map(
    (match) => (match[1] ?? match[2] ?? "").replaceAll(`'"'"'`, "'"),
  );
}
