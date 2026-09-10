import type { HookIngest } from "@shared/protocol.ts";
import type { HookReading, HookSpec, WorkCycleSignal } from "../types.ts";
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
//   - `hooks/install.mjs` and `src/main/integrations.ts` - `events` / `matcherEvents`,
//     and `isMissionHookCommand` to find their own entries again
//   - `src/server/environment/claude-hooks.ts` - `missionHookScriptPath`, to check that the
//     path an installer baked still resolves

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
 * A bare prose question stays invisible: nothing in the hook stream distinguishes it from
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

/** Claude hook vocabulary to the generic work-cycle lifecycle. */
function workCycleSignal(evt: HookIngest): WorkCycleSignal | null {
  switch (evt.event) {
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
    case "SubagentStop":
    case "PreCompact":
      return "work_started";
    case "Stop":
      return "turn_completed";
    default:
      return null;
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

/**
 * The submitted text, unreshaped. Same event as `promptText`, deliberately none of its
 * grammar: `substantivePrompt` collapses every whitespace run to a single space, so a
 * delivered packet reaches the goal path as one line and hashes to nothing the daemon
 * recorded typing.
 */
function submittedPromptText(evt: HookIngest): string | null {
  if (evt.event !== "UserPromptSubmit") return null;
  return evt.prompt?.trim() || null;
}

export const claudeHooks: HookSpec = {
  scope: "machine",
  events: EVENTS,
  matcherEvents: MATCHER_EVENTS,
  toState,
  workCycleSignal,
  promptText,
  submittedPromptText,
};

// --- what one of OUR hook commands looks like in somebody else's settings file ---------
//
// Both installers bake an ABSOLUTE path to a script this repository ships, into
// `~/.claude/settings.json`, and then have to find their own entries again later - to
// replace them on a re-run, to remove them on `--uninstall`, and (since the outage below)
// to notice when the path they baked has stopped resolving. That is three readers of one
// fact, which is the same reason `EVENTS` lives here rather than in each installer.
//
// It was previously two facts that did not agree. `hooks/install.mjs` matched the literal
// `harness-hook.mjs`, which is its own script's name; `src/main/integrations.ts` matched
// `harness-hook`, but the script IT installs is `dist/satellites/hook.mjs` - a path with no
// `harness-hook` anywhere in it. So the packaged app's "Install Claude integrations"
// stripped nothing before appending, duplicating every hook group on each press, and its
// uninstall removed nothing at all. Naming both scripts here is what makes each installer
// recognise the other's work, so an operator who has used both ends up with one bridge
// rather than two.
//
// The outage this exists for: these paths must outlive the install, and sometimes do not.
// A checkout gets renamed or deleted, and every Claude session on the machine then fails
// every hook event with MODULE_NOT_FOUND and prints the stack into the transcript, with
// nothing pointing back at the settings file that caused it. `hooks/install-checks.mjs`
// refuses the one cause it can see beforehand (a transient pooled checkout);
// `src/server/environment/claude-hooks.ts` reports the rest afterwards.

/**
 * Every script an installer of ours can write, by the tail of its path.
 *
 * ONE list. Both predicates below are DERIVED from it rather than restating it, because a
 * regex here and a substring array there is the same drift this whole section exists to
 * end: a future installer, or a renamed satellite, would have to be added to both in
 * lockstep, and missing one puts stripping and reporting back into disagreement. They
 * already had disagreed - the array carried only the forward-slash spelling while the
 * regex accepted either separator, so a backslash-separated command was reportable and not
 * strippable.
 */
export const MISSION_HOOK_SCRIPTS = ["harness-hook.mjs", "satellites/hook.mjs"] as const;

/** Either path separator, so a hand-copied Windows-style path is still recognised. */
const SEP = "[\\\\/]";

const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One of `MISSION_HOOK_SCRIPTS` as the tail of a path.
 *
 * Anchored at both ends - a path separator (or the start of the value) before, the end of
 * the string after - so this matches the last segment of a path and never a coincidence
 * inside a directory name. Each `/` inside a script name becomes a separator class, so
 * `satellites/hook.mjs` matches either spelling exactly as the substring test does.
 */
const HOOK_SCRIPT = new RegExp(
  `(?:^|${SEP})(?:${MISSION_HOOK_SCRIPTS.map((name) => name.split("/").map(escapeRe).join(SEP)).join("|")})$`,
);

/**
 * Whether a settings.json hook command is one an installer of ours wrote.
 *
 * Deliberately looser than `missionHookScriptPath` below, and the asymmetry is the point:
 * stripping wants to be generous, because anything of ours left behind fires a second time
 * for every event, while reporting wants to be exact, because a warning about a path we
 * merely guessed at is a note the operator cannot act on.
 *
 * Separators are normalised before the test so this stays at least as generous as the regex
 * for every spelling of a path, which is the direction the asymmetry has to run.
 */
export function isMissionHookCommand(command: string): boolean {
  const normalized = command.replace(/\\/g, "/");
  return MISSION_HOOK_SCRIPTS.some((name) => normalized.includes(name));
}

/**
 * The script path inside one of our hook commands, or null when it cannot be read exactly.
 *
 * The commands we write are `"<node>" "<script>" <Event>`, optionally preceded by
 * `ELECTRON_RUN_AS_NODE=1`, so the script is a quoted argument - quoted precisely because
 * the packaged app's path contains a space (`Mission Control.app`). Quoted arguments are
 * therefore tried first and taken whole; the unquoted fallback exists only for a
 * hand-edited command, where a whitespace-delimited token is the best a reader can do.
 *
 * Absolute paths only. That is what separates a real argument from a fragment of a wrapped
 * command such as `sh -c "node ./harness-hook.mjs"`, where the quoted value ends with our
 * script's name and is not a path at all. A caller is going to `stat` whatever comes back
 * and tell the operator it is missing, so "not sure" has to be null rather than a guess.
 */
export function missionHookScriptPath(command: string): string | null {
  for (const match of command.matchAll(/"([^"]*)"/g)) {
    const value = match[1] ?? "";
    if (value.startsWith("/") && HOOK_SCRIPT.test(value)) return value;
  }
  for (const token of command.split(/\s+/)) {
    if (token.startsWith("/") && HOOK_SCRIPT.test(token)) return token;
  }
  return null;
}
