import { run, type RunResult } from "../util/exec.ts";
import type { TerminalResult } from "./types.ts";

/**
 * The subprocess seam the two shipped adapters share, and the reduction from a finished
 * command to a `TerminalResult`.
 *
 * Threaded rather than defaulted at the module level so an adapter can be built against a
 * fake: the interesting property of an adapter is the ARGV it emits - `BTab` versus
 * `\x1b[Z` for one named key - and asserting that on a machine that happens to have tmux
 * installed is not a test of anything. It is also why this is a parameter of the adapter
 * factory rather than of every method: a caller that fakes half the commands drives none
 * of the read-write-read sequences the policy layer is made of.
 *
 * The seam covers everything an adapter runs ITSELF, which since enumeration moved in is
 * most of both: tmux's `list`, `clients`, `write`, `capture`, `select`, `sessions` and
 * `paneMode` (threaded on into `readTmuxPaneMode`), and wezterm's `list`, `write` and
 * `capture`.
 *
 * What is left delegating to `discovery/wezterm.ts` - `focus`, `spawn` and `retitle` - calls
 * `run` directly and ignores this parameter entirely, so `weztermEmulator(fake).spawn.tab(…)`
 * opens a real tab on the developer's desktop. Drive those through a fake BINARY instead
 * (`terminal-emulator-spawn.test.ts` does). The delegation is deliberate while `actions.ts`
 * still calls those functions too; they get a seam when the focus/spawn item moves that file
 * behind this layer, and this note exists so nobody reads the injection as broader than it is.
 *
 * Nothing in `types.ts` mentions this type. An adapter is not obliged to be a subprocess -
 * iTerm2 scripts through AppleScript - and the interface must not assume otherwise.
 */
export type TerminalExec = (
  bin: string,
  args: string[],
  opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Promise<RunResult>;

export const defaultExec: TerminalExec = run;

/**
 * Reduce a finished command to a `TerminalResult`, preserving the distinction between "it
 * was refused" and "we never found out" - see `TerminalResult.outcomeUnknown`.
 *
 * `fallback` is used only when the command failed silently, which is common: tmux and
 * wezterm both exit non-zero with nothing on stderr for an unresolvable target.
 */
export function toResult(r: RunResult, fallback: string): TerminalResult {
  if (r.code === 0) return { ok: true, outcomeUnknown: false };
  return { ok: false, error: r.stderr.trim() || fallback, outcomeUnknown: r.outcomeUnknown };
}
