import { DISPATCH_COMMAND, DISPATCH_LAUNCHER_PROMPT_SETTING } from "@shared/home-dispatch.ts";
import { openDb } from "../db.ts";
import type { HomeSessionRow } from "./sessions.ts";

/**
 * The once-per-session launcher decision (spec 7.4). The daemon decides, never the hook, and
 * records `launcher_offered_at` so a session is offered the menu at most once.
 */

/** `CLAUDE_CODE_ENTRYPOINT` for an interactive session (L6). `claude -p` reports `sdk-cli`. */
export const INTERACTIVE_ENTRYPOINT = "cli" as const;

/**
 * `dispatch.launcher.prompt`, default true. Read per decision, never cached, from the same
 * `app_config` table every other setting lives in; an unset or unreadable value is the default.
 */
export function launcherPromptEnabled(): boolean {
  const row = openDb().prepare("SELECT value FROM app_config WHERE key = ?").get(DISPATCH_LAUNCHER_PROMPT_SETTING) as
    | { value: string }
    | undefined;
  if (!row) return true;
  try {
    return JSON.parse(row.value) !== false;
  } catch {
    return true;
  }
}

/**
 * The facts of 7.4 that do not depend on the prompt: could this session still be offered the menu
 * on its first message? The startup banner uses it to pick its hint, before any prompt exists.
 */
export function launcherOfferable(session: HomeSessionRow, settingEnabled = launcherPromptEnabled()): boolean {
  return (
    session.startSource === "startup" &&
    session.entrypoint === INTERACTIVE_ENTRYPOINT &&
    session.launcherOfferedAt === null &&
    !session.launcherDisabled &&
    settingEnabled
  );
}

export type LauncherDecision =
  /** Tell the model to call `start_dispatch` first. `launcher_offered_at` is recorded. */
  | "offer"
  /** The first prompt was exactly the command, which already shows the menu. It is recorded, not offered. */
  | "command-spent"
  /** Not offered, and nothing recorded. */
  | "none";

export interface LauncherInput {
  session: HomeSessionRow;
  /** The prompt as typed. */
  prompt: string;
  /** True when this is the session's first turn from the person (the summary-card turn does not count). */
  firstTurn: boolean;
  settingEnabled?: boolean;
}

/** The pure rule of 7.4. */
export function decideLauncher(input: LauncherInput): LauncherDecision {
  const { session } = input;
  if (!input.firstTurn || !launcherOfferable(session, input.settingEnabled ?? true)) {
    // A session that was never offered and whose first turn was the command still records it
    // below, but only once the other facts hold; a turn that is not the first spends nothing.
    return "none";
  }
  const prompt = input.prompt.trim();
  if (prompt === DISPATCH_COMMAND) return "command-spent";
  // Any other slash command spends the first turn (L8): the session is never offered the menu.
  if (prompt === "" || prompt.startsWith("/")) return "none";
  return "offer";
}

/**
 * Decide for the turn that just opened, and record `launcher_offered_at` when the menu is offered
 * or the command spent it. A session that skipped its first turn (a slash command other than the
 * command) is never offered later, because `firstTurn` is false from then on.
 */
export function claimLauncher(
  session: HomeSessionRow,
  prompt: string,
  firstTurn: boolean,
  now = Date.now(),
): LauncherDecision {
  const decision = decideLauncher({ session, prompt, firstTurn, settingEnabled: launcherPromptEnabled() });
  if (decision === "none") return decision;
  // Compare-and-set, so two hooks racing for one session cannot both offer the menu.
  const won = openDb()
    .prepare("UPDATE home_dispatch_sessions SET launcher_offered_at = ? WHERE session_id = ? AND launcher_offered_at IS NULL")
    .run(now, session.sessionId);
  return Number(won.changes) === 1 ? decision : "none";
}
