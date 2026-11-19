import {
  DISPATCH_STANDING_LINE,
  HEADLESS_MODE_FLAG_ID,
  HOME_SESSION_START_SOURCES,
  type HomeSessionRegistration,
  type HookDispatchOutput,
} from "@shared/home-dispatch.ts";
import type { HookIngest } from "@shared/protocol.ts";
import { featureEnabled } from "../feature-flags/index.ts";
import { SERVICE_VERSION } from "../version.ts";
import { dispatchNudge } from "./intent.ts";
import { claimLauncher, launcherOfferable } from "./launcher.ts";
import { getHomeSession, isWorkerSession, registerHomeSession, type HomeSessionRow } from "./sessions.ts";
import {
  closeTurn,
  openTurn,
  recordCardsShown,
  recordSessionStartCards,
  type ShownCard,
} from "./turns.ts";

/**
 * What the hook route adds to its response for a home session (spec 7.3). The route calls this
 * only while `headless-mode` is on, once per event, never cached; the flag is checked again here
 * so a direct caller cannot write while it is off. `null` means "no `dispatch` field", which is
 * exactly today's response.
 *
 * Everything is built from the database alone: no model and no network call, so it fits inside
 * the hook's 100 ms budget. Errors never reach the hook: a throw becomes `null` (print nothing,
 * exit 0), the same as an unreachable daemon.
 */

/** A card to show on the person's next message: the line they see and the context the model gets. */
export interface HookCard {
  shown: ShownCard;
  /** The `systemMessage` line, for example `mission-control: mc-91c2 asks a question (logging cleanup)`. */
  systemLine: string;
  /** The full card, rendered through `home-dispatch-render`, for `additionalContext`. */
  context: string;
}

export interface HookCardDelta {
  /** Cards that are new or changed since this session was last shown them. */
  full: HookCard[];
  /** One-line reminders for questions already shown and still waiting. */
  reminders: Array<{ shown: ShownCard; systemLine: string }>;
}

/** The harness names the shared banner builder takes (spec 7.21). */
export type HarnessName = "claude" | "codex" | "pi";

export interface BannerInput {
  harness: HarnessName;
  counts: { running: number; waiting: number };
  menuOffered: boolean;
  versionMismatch: boolean;
  color: boolean;
}

/**
 * The parts of the dispatch output that other work packages own. Each default is inert, so the
 * hook route is correct before they land and gains their output the moment they are wired:
 *
 * - `banner`: the three-line start-up banner. WP3 owns `dispatchBanner` (spec 7.21), the only place
 *   banner text is written, so nothing here spells a banner out.
 * - `inbox`: the counts and the card delta from `buildInbox` (WP2b, spec 7.7).
 * - `receiptLine`: the receipt for an answer sent in this turn (WP2b, spec 7.8).
 */
export interface HomeDispatchHookDeps {
  now(): number;
  daemonVersion: string;
  banner(input: BannerInput): string | null;
  inbox: {
    counts(repoRoot: string | null): { running: number; waiting: number };
    cards(session: HomeSessionRow, turnOpenedAt: number): HookCardDelta;
    /** A one-off summary card for `SessionStart`, or null when nothing needs saying. */
    summary(session: HomeSessionRow): { cards: ShownCard[]; context: string } | null;
  };
  receiptLine(session: HomeSessionRow, toolName: string, sinceMs: number): string | null;
}

export const DEFAULT_HOOK_DEPS: HomeDispatchHookDeps = {
  now: () => Date.now(),
  daemonVersion: SERVICE_VERSION,
  banner: () => null,
  inbox: {
    counts: () => ({ running: 0, waiting: 0 }),
    cards: () => ({ full: [], reminders: [] }),
    summary: () => null,
  },
  receiptLine: () => null,
};

/** The two tools whose result the person sees as a receipt line (spec 7.3). */
const RECEIPT_TOOLS = new Set(["mcp__mission-control__answer_task", "mcp__mission-control__checkin"]);

/** What the model is told when the launcher is offered (spec 7.3). */
export const LAUNCHER_INSTRUCTION =
  'Before anything else, call start_dispatch with entry: "first-message" and the person\'s message as brief, ' +
  "then follow the mission-dispatch skill. Keep the message, and do not start the work until the tool returns.";

const PRINTING_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PostToolUse"]);

function sourceOf(hook: HookIngest): HomeSessionRegistration["source"] {
  if (hook.event !== "SessionStart") return null;
  return (HOME_SESSION_START_SOURCES as readonly string[]).includes(hook.source ?? "")
    ? (hook.source as HomeSessionRegistration["source"])
    : null;
}

function registrationFrom(hook: HookIngest): HomeSessionRegistration | null {
  if (!hook.sessionId || !hook.cwd) return null;
  return {
    sessionId: hook.sessionId,
    harness: hook.agent,
    cwd: hook.cwd,
    hookVersion: hook.hookVersion ?? null,
    claudePid: hook.claudePid ?? null,
    source: sourceOf(hook),
    entrypoint: hook.entrypoint ?? null,
    launcherDisabled: hook.launcherDisabled ?? false,
    terminal: hook.terminal ?? null,
  };
}

/**
 * The session an event is from, registering it first when the daemon has not met it (spec 7.2: the
 * first event that reaches the daemon registers the session, with an unknown source when it is not
 * a `SessionStart`, which keeps the launcher off). A refused registration (a worker, or a harness
 * that cannot be a home session) is null, and so is the whole event's output.
 */
function sessionFor(hook: HookIngest, now: number): HomeSessionRow | null {
  const registration = registrationFrom(hook);
  if (!registration) return null;
  if (hook.event !== "SessionStart") {
    const known = getHomeSession(registration.sessionId);
    // A session can become a worker after it registered (a task bound to it, or its folder became
    // a task's worktree), so the existing row is only used while it would still be accepted.
    if (known) return isWorkerSession(registration.sessionId, registration.cwd) ? null : known;
  }
  const outcome = registerHomeSession(registration, now);
  return outcome.ok ? outcome.row : null;
}

const join = (parts: Array<string | undefined>, glue: string): string | undefined => {
  const kept = parts.filter((p): p is string => p !== undefined && p !== "");
  return kept.length > 0 ? kept.join(glue) : undefined;
};

function compact(output: { systemMessage?: string | undefined; additionalContext?: string | undefined }): HookDispatchOutput | null {
  const result: HookDispatchOutput = {};
  if (output.systemMessage) result.systemMessage = output.systemMessage;
  if (output.additionalContext) result.additionalContext = output.additionalContext;
  return result.systemMessage || result.additionalContext ? result : null;
}

function onSessionStart(hook: HookIngest, deps: HomeDispatchHookDeps): HookDispatchOutput | null {
  const now = deps.now();
  const session = sessionFor(hook, now);
  if (!session) return null;

  // The banner is for a fresh start only (D37): never on resume, clear or compact.
  let systemMessage: string | undefined;
  if (session.startSource === "startup") {
    const harness = hook.agent as HarnessName;
    const versionMismatch = hook.hookVersion !== undefined && hook.hookVersion !== deps.daemonVersion;
    systemMessage =
      deps.banner({
        harness,
        counts: deps.inbox.counts(session.repoRoot),
        menuOffered: launcherOfferable(session),
        versionMismatch,
        color: hook.noColor !== true,
      }) ?? undefined;
  }

  const summary = deps.inbox.summary(session);
  if (summary) recordSessionStartCards(session.sessionId, summary.cards, now);
  // The standing line is always last, so the model reads the summary first and the rule after it.
  const additionalContext = join([summary?.context, DISPATCH_STANDING_LINE], "\n\n");
  return compact({ systemMessage, additionalContext });
}

function onUserPromptSubmit(hook: HookIngest, deps: HomeDispatchHookDeps): HookDispatchOutput | null {
  const now = deps.now();
  const session = sessionFor(hook, now);
  if (!session) return null;
  const prompt = hook.prompt ?? "";

  // The first turn is read from the session row's `last_turn_at`, which only a person's turn sets
  // and cleanup never clears. Counting turn rows would let the seven-day prune hand a long-lived
  // session a second "first turn".
  const firstTurn = session.lastTurnAt === null;
  const turn = openTurn({ sessionId: session.sessionId, prompt, now });
  // A failing inbox must not cost the person the menu: the turn is already written, and a later
  // prompt is no longer the first, so the launcher decision below carries on with no cards.
  let delta: HookCardDelta = { full: [], reminders: [] };
  try {
    delta = deps.inbox.cards(session, turn.openedAt);
  } catch (error) {
    console.error("[home-dispatch] card delta failed:", error);
  }
  recordCardsShown(session.sessionId, turn.promptId, [...delta.full.map((c) => c.shown), ...delta.reminders.map((r) => r.shown)]);

  const launcher = claimLauncher(session, prompt, firstTurn, now);
  // The nudge fires only when the menu is not being offered this turn: one entry point per turn.
  const nudge = launcher === "offer" ? null : dispatchNudge(prompt);

  // Waiting-question cards come first, then the launcher or the nudge.
  return compact({
    systemMessage: join([...delta.full.map((c) => c.systemLine), ...delta.reminders.map((r) => r.systemLine)], "\n"),
    additionalContext: join(
      [...delta.full.map((c) => c.context), launcher === "offer" ? LAUNCHER_INSTRUCTION : undefined, nudge ?? undefined],
      "\n\n",
    ),
  });
}

function onPostToolUse(hook: HookIngest, deps: HomeDispatchHookDeps): HookDispatchOutput | null {
  if (!hook.toolName || !RECEIPT_TOOLS.has(hook.toolName)) return null;
  const session = sessionFor(hook, deps.now());
  if (!session) return null;
  const line = deps.receiptLine(session, hook.toolName, session.lastTurnAt ?? 0);
  return compact({ systemMessage: line ? `mission-control: ${line}` : undefined });
}

export function homeDispatchHookOutput(hook: HookIngest, deps: HomeDispatchHookDeps = DEFAULT_HOOK_DEPS): HookDispatchOutput | null {
  if (!featureEnabled(HEADLESS_MODE_FLAG_ID)) return null;
  try {
    if (hook.event === "Stop") {
      const known = hook.sessionId ? getHomeSession(hook.sessionId) : null;
      // A session that became a worker mid-turn must not have its turn state touched.
      if (known && !isWorkerSession(known.sessionId, hook.cwd ?? known.cwd)) closeTurn(known.sessionId, deps.now());
      return null;
    }
    if (!PRINTING_EVENTS.has(hook.event)) return null;
    switch (hook.event) {
      case "SessionStart":
        return onSessionStart(hook, deps);
      case "UserPromptSubmit":
        return onUserPromptSubmit(hook, deps);
      default:
        return onPostToolUse(hook, deps);
    }
  } catch (error) {
    // A broken dispatch output must never cost the hook its event: print nothing, as today.
    console.error("[home-dispatch] hook output failed:", error);
    return null;
  }
}
