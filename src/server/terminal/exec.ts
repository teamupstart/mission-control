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

/** The result of a command that never ran, e.g. one whose prerequisite step failed. */
export function refuse(error: string): TerminalResult {
  return { ok: false, error, outcomeUnknown: false };
}
