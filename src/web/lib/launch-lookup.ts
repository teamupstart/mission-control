import type { TranscriptMessage } from "@shared/types.ts";
import { turnForToolUse } from "./tools.ts";

/**
 * Finding the turn that launched a background sub-agent, one step at a time.
 *
 * The launch may be older than the transcript window the browser holds: a resident that has
 * run all day launched its agents hours of turns ago. So "Jump to launch" is a short search,
 * not a lookup - look in what is loaded, page older turns in while the transcript has them,
 * and stop at its start. This is the decision for one step of it, pure so it can be checked
 * without a panel; `TranscriptPanel` runs it each time the loaded turns or the paging state
 * change.
 */

/** Why a search ended without a turn to jump to. */
export type LaunchMiss =
  /**
   * The transcript records no call as launching this agent, or every older page was read
   * without reaching the call it names.
   */
  | "missing"
  /** A page failed to load, or paging stopped advancing; trying again may work. */
  | "error";

export type LaunchStep =
  | { kind: "found"; turnId: string }
  /** A page is already on its way; its arrival runs the next step. */
  | { kind: "wait" }
  /** Not loaded, and the transcript has older turns: fetch the next page. */
  | { kind: "load" }
  | { kind: "miss"; reason: LaunchMiss };

export interface LaunchHistory {
  canLoadOlder: boolean;
  loadingOlder: boolean;
  /** A page request has failed since this search started. */
  failed: boolean;
  /**
   * The last page this search asked for came back without moving the paging cursor, so
   * asking again would ask for the same page (`pagingStalled`). The search stops on that,
   * and only that: a long-running session's launch may sit any number of pages back, so no
   * page count is a limit.
   */
  stalled: boolean;
}

/**
 * Whether paging stopped advancing: a page was asked for from `askedFrom`, nothing is in
 * flight, and the back anchor is still `askedFrom`.
 *
 * Read from the CURSOR, never from how many turns arrived. A page can legitimately add no
 * turn - a stretch of pure tool output renders nothing - while still moving the anchor
 * back, and the call being searched for may sit on the page after it. Only an anchor that
 * did not move (a page refused because the file moved under the request) means the next
 * request would repeat this one.
 */
export function pagingStalled(askedFrom: number | null, anchorNow: number | null, loadingOlder: boolean): boolean {
  return askedFrom !== null && !loadingOlder && anchorNow === askedFrom;
}

/**
 * The search is always for a call id: an identity, never a description - agents can share a
 * description, and a finished agent folded out of the tray leaves its call behind.
 *
 * The id is the agent's `launchTurnId` when its source named the launching call (the Agent
 * SDK's `task_started`). Otherwise the panel first asks the daemon which call the transcript
 * FILE records as launching the agent (`fetchSubagentLaunch`), because the call and the result
 * naming its agent arrive apart and only the file is sure to hold both; then searches for that
 * id here. Call ids ride every turn the browser receives (`ToolCall.id`), streamed or paged,
 * so this half needs nothing joined across reads.
 */
export function launchStep(
  messages: readonly TranscriptMessage[],
  toolUseId: string,
  history: LaunchHistory,
): LaunchStep {
  const turnId = turnForToolUse(messages, toolUseId);
  if (turnId) return { kind: "found", turnId };
  if (history.loadingOlder) return { kind: "wait" };
  if (history.failed) return { kind: "miss", reason: "error" };
  if (!history.canLoadOlder) return { kind: "miss", reason: "missing" };
  if (history.stalled) return { kind: "miss", reason: "error" };
  return { kind: "load" };
}
