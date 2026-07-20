import { HEADLESS_CWD, killLiveClaudeRuns, resultText, runClaudeText } from "../claude-cli.ts";
import { headlessTranscriptDir } from "../goal/prune.ts";
import { grantRefusal } from "@shared/llm.ts";
import type { LlmRunOptions, LlmRunner, LlmToolGrant } from "@shared/llm.ts";

// The `claude -p` implementation of `LlmRunner`, with today's exact behaviour.
//
// A THIN ADAPTER over `claude-cli.ts` rather than a copy of it, deliberately. Every
// argument this file could have re-derived - why `--tools` defaults to empty, why the
// child is detached, why the pane env is stripped, why the stream is decoded once, which
// flags are load-bearing by their ABSENCE - is written out at length over there, next to
// the code it constrains. Duplicating the spawn here would fork those arguments the first
// time one of the two was edited. The migration that moves the bodies across is a later
// item; this one only has to make the seam exist.
//
// The direction of the remaining import is the same story: `HEADLESS_CWD` and
// `headlessTranscriptDir()` stay where they are and are surfaced here, so the cwd a run
// spawns in and the directory its transcript lands in continue to come from ONE
// derivation. They disagree silently if they are ever computed twice - the sweep cleans an
// empty directory while the real one grows forever.

/**
 * The tools a caller may be granted, and nothing else.
 *
 * Read-only by construction. Today exactly one caller holds any tools at all - the
 * Inspector, which needs to read source to review a diff honestly and carries four other
 * defence layers because of it - and this is the same three it holds. A caller wanting
 * `Bash` or `Write` has to edit this line, which is where that argument should have to be
 * made rather than in a call site's options object.
 */
export const CLAUDE_GRANTABLE_TOOLS = ["Read", "Grep", "Glob"] as const;

/**
 * Render a grant's deny globs into a `--settings` payload.
 *
 * Every path is denied for EVERY tool the run holds, not just `Read`. That is not padding:
 * `Grep` takes an absolute path and prints the matching lines, so a `Read(...)`-only list
 * protects nothing it names, and `Glob` confirms the files exist. The grant is what pays
 * for the tool access, so the denial has to cover the whole grant.
 *
 * Path-major, tool-minor, to reproduce byte-for-byte what the Inspector builds today.
 * `llm-runner-contract.test.ts` asserts that equality against the Inspector's own
 * constants, so the item that migrates it is provably a no-op rather than hopefully one.
 */
export function claudeGrantSettings(grant: LlmToolGrant): string {
  return JSON.stringify({
    permissions: {
      deny: grant.denyPaths.flatMap((p) => grant.tools.map((t) => `${t}(${p})`)),
    },
  });
}

/**
 * The cwd a run without a grant spawns in.
 *
 * Exported from the runner because it is a CLAUDE property rather than a general one, and
 * the interface is right not to carry it: with no tools a working directory is meaningless
 * to the run itself, but Claude derives the directory it writes the run's transcript to
 * from the spawner's cwd, so this constant alone decides where they all pile up.
 */
export { HEADLESS_CWD };

export const claudeRunner: LlmRunner = {
  id: "claude",
  label: "Claude Code",

  async run(prompt: string, opts: LlmRunOptions = {}): Promise<string> {
    const grant = opts.grant ?? null;
    if (grant) {
      const refusal = grantRefusal(claudeRunner.sandbox, grant);
      // Refused BEFORE the spawn, and loudly. A grant this runner would only partly honour
      // must not run at all: a caller that asked for a deny list and silently did not get
      // one cannot tell the difference until something it named leaks into a prompt.
      if (refusal) throw new Error(`claude runner refused the tool grant: ${refusal}`);
    }
    // No grant means no `tools`, no `cwd` and no `settings` - so `runClaudeText` applies
    // its own defaults: every tool disabled, and the temp dir above. That is the safe
    // shape for every caller that embeds untrusted text, which is all of them but one.
    const raw = await runClaudeText(prompt, {
      model: opts.model,
      timeoutMs: opts.timeoutMs,
      ...(grant
        ? { tools: grant.tools.join(","), cwd: grant.cwd, settings: claudeGrantSettings(grant) }
        : {}),
    });
    // Unwrapped here, so no caller ever sees the `{ result: "…" }` envelope. It exists
    // because THIS runner passes `--output-format json`; a caller that parsed it would be
    // undoing its own runner's flag, and a different provider's envelope would break it.
    return resultText(raw);
  },

  /**
   * Not implemented, and `null` rather than a throwing stub so the absence is a value the
   * caller can branch on.
   *
   * `claude -p` could do it - `--session-id <uuid>` then `--resume` - and the day it is
   * wanted the key must be one supervised session. Nothing here needs it: every caller
   * today summarises one window of one session and is better off with a clean context.
   */
  runInThread: null,

  sandbox: { tools: CLAUDE_GRANTABLE_TOOLS, enforcesDenyPaths: true },

  /**
   * Every run mints a session id and writes a real transcript, exactly as an interactive
   * session does - the litter `goal/prune.ts` sweeps by age. `.jsonl` only, because the
   * directory is not exclusively ours: a human running `claude` from `$TMPDIR` lands in
   * the same encoded project dir.
   */
  litter: { dir: headlessTranscriptDir, ext: ".jsonl" },

  killLiveRuns: killLiveClaudeRuns,
};
