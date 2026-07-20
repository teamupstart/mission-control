import type { HookIngest } from "@shared/protocol.ts";
import type { HookReading, HookSpec } from "../types.ts";
import { substantivePrompt } from "./scaffolding.ts";

// Claude Code's hook vocabulary: which events it fires, and what each one means.
//
// This is the most agent-specific thing the daemon does with a hook, and it used to sit
// in `registry.ts` as a bare switch - so a second harness's bridge would have had to
// either speak Claude's event names or add a parallel switch beside it. Neither is a
// thing an interface should permit, hence `HookSpec`.
//
// Kept IMPORT-LIGHT on purpose, and reached directly rather than through
// `harness/index.ts`: the two installers below both need `events`, and one of them is
// bundled into the Electron main process, which must not pull the daemon in behind a
// list of nine strings. Everything imported here is either a type (erased) or pure.
//
// Readers:
//   - `registry.applyHook` - `toState` and `promptText`
//   - `hooks/install.mjs` and `src/main/integrations.ts` - `events` / `matcherEvents`

/**
 * The events we install a bridge for, in install order.
 *
 * One definition, three readers. It was previously written out in both installers with a
 * comment in CLAUDE.md admitting nothing caught the drift; the failure that invites is
 * silent and asymmetric - an event added to the repo installer and not to the packaged
 * app's is a state the dashboard reports for developers and not for anyone else.
 */
const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "SessionEnd",
] as const;

/** Claude's per-tool events, whose settings.json group carries `matcher: "*"`. */
const MATCHER_EVENTS = ["PreToolUse", "PostToolUse"] as const;

/**
 * True when a `Notification` is Claude's idle nudge rather than a real ask.
 *
 * Claude Code fires the same hook for two unrelated things: it needs something from
 * you, and the prompt has simply sat idle for ~60s. Only the first needs you.
 * Treating both as `awaiting_input` made *every* settled session claim it needed
 * you a minute after it went quiet, which is noise in exactly the bucket that is
 * supposed to be signal - and it never recovered, because nothing moves a session
 * out of `awaiting_input` on its own.
 *
 * The message is the only discriminator the payload carries. These are the only
 * three we have ever actually observed, across 61 Notification events in this
 * daemon's own `session_events` log (the counts are real sessions on one machine,
 * so treat them as "what Claude sends", not "all Claude can send"):
 *
 *   41x  "Claude is waiting for your input"              <- the idle nudge
 *   19x  "Claude needs your permission"                  <- a real ask
 *    1x  "Claude Code needs your approval for the plan"  <- a real ask
 *
 * Hence the match is on the nudge, narrowly, and everything else - including any
 * wording a future Claude introduces - keeps its `awaiting_input` meaning. The
 * failure mode is therefore safe by construction: if this string ever changes we
 * regress to the old over-reporting (an idle session says "needs you"), never to
 * swallowing a genuine ask. That asymmetry is the reason to match the nudge rather
 * than to match the asks.
 *
 * Known tradeoff: a session that ends its turn with a question in *prose* (no
 * permission prompt) is indistinguishable from an idle one in the hook stream -
 * both are a `Stop` followed by this same nudge - so it now reads `idle` and won't
 * nag at 60s.
 *
 * Foreman recovers the case it can identify structurally: a parked no-mistakes gate
 * classifies as `gate-parked` (see foreman/pending.ts) off the run summary, and its
 * reviewer reads the relayed finding out of the transcript. A bare prose question with
 * no gate behind it stays invisible - nothing in the hook stream distinguishes it from
 * an idle prompt, and `no-question` disposes it without a model call. Recovering that
 * one needs a signal this stream doesn't carry, not a smarter reader.
 */
export function isIdleNudge(message: string | undefined | null): boolean {
  return /waiting for your input/i.test(message ?? "");
}

/** One line for the ticker: collapsed whitespace, capped, ellipsized. */
function trim(s: string | undefined, n = 120): string | null {
  return s ? (s.length > n ? s.slice(0, n - 1) + "…" : s).replace(/\s+/g, " ").trim() : null;
}

function toState(evt: HookIngest): HookReading {
  switch (evt.event) {
    case "SessionStart":
      return { state: "idle", activity: evt.source ? `started (${evt.source})` : "started" };
    case "UserPromptSubmit":
      return { state: "working", activity: trim(evt.prompt) };
    case "PreToolUse":
      return { state: "working", activity: evt.toolName ? `running ${evt.toolName}` : "working" };
    case "PostToolUse":
      return { state: "working", activity: evt.toolName ? `${evt.toolName} done` : "working" };
    case "Notification":
      // The idle nudge means "still parked at the prompt", which is the same thing
      // Stop reports - so report it identically rather than inventing a state.
      return isIdleNudge(evt.message)
        ? { state: "idle", activity: "idle" }
        : { state: "awaiting_input", activity: trim(evt.message) ?? "waiting for you" };
    case "Stop":
      return { state: "idle", activity: "idle" };
    case "SubagentStop":
      return { state: "working", activity: "subagent finished" };
    case "PreCompact":
      return { state: "working", activity: "compacting context" };
    case "SessionEnd":
      return { state: "exited", activity: evt.reason ? `ended (${evt.reason})` : "ended" };
    default:
      // An event we don't model - a newer Claude's, or one someone wired by hand.
      // `working` because a hook fired at all means the process is alive and running
      // something; a null activity leaves the ticker showing the last thing we knew.
      return { state: "working", activity: null };
  }
}

/**
 * The human's ask, when the event is the one that carries one.
 *
 * Both halves are Claude's: `UserPromptSubmit` is its event name, and
 * `substantivePrompt` is its scaffolding grammar (`<local-command-caveat>`,
 * `<command-name>`, the caveat XML). Folding them into one call is what keeps the
 * registry from testing an event name for an agent that may not have it - and keeps the
 * two from drifting apart, since the filter is only ever correct for the event it was
 * measured against.
 */
function promptText(evt: HookIngest): string | null {
  if (evt.event !== "UserPromptSubmit") return null;
  return substantivePrompt(evt.prompt);
}

export const claudeHooks: HookSpec = {
  events: EVENTS,
  matcherEvents: MATCHER_EVENTS,
  toState,
  promptText,
};
