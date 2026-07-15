import type { WorkItem, WorkItemState } from "./types.ts";

// The work item lifecycle's two load-bearing state sets, defined ONCE.
//
// These were previously spelled out in three places - the machine, the registry's
// denormalizer, and the DB's partial unique index - and the index being one of the
// copies is what made the duplication dangerous rather than merely untidy: adding a
// lifecycle state and missing the SQL puts two items in flight in one queue, which
// is a duplicated WORK INSTRUCTION typed into a live agent. That's the exact harm
// the index exists to prevent, so the index's predicate is DERIVED from
// IN_FLIGHT_ITEM_STATES (see db.ts) rather than restated beside it.

/**
 * An item is mid-cycle: Foreman is delivering it, waiting for the agent to pick it
 * up, watching it, or judging it. At most one per queue - see db.ts's
 * `one_inflight_per_queue`, whose WHERE clause is built from this array.
 *
 * `proposed` is deliberately NOT here: a draft has been written but nothing has
 * been typed, so it holds no single-flight slot and the human can still edit it.
 */
export const IN_FLIGHT_ITEM_STATES = [
  "sending",
  "awaiting_pickup",
  "in_progress",
  "verifying",
] as const satisfies readonly WorkItemState[];

/** An item has no further lifecycle - nothing will advance it again. */
export const TERMINAL_ITEM_STATES = ["verified", "escalated", "cancelled"] as const satisfies
  readonly WorkItemState[];

const IN_FLIGHT = new Set<WorkItemState>(IN_FLIGHT_ITEM_STATES);
const TERMINAL = new Set<WorkItemState>(TERMINAL_ITEM_STATES);

export function isInFlightState(state: WorkItemState): boolean {
  return IN_FLIGHT.has(state);
}

export function isTerminalState(state: WorkItemState): boolean {
  return TERMINAL.has(state);
}

/** The one item mid-cycle, or null. The DB's partial unique index guarantees ≤1. */
export function inFlightItem(items: WorkItem[]): WorkItem | null {
  return items.find((i) => isInFlightState(i.state)) ?? null;
}

// ---- the drain-time wrap-up ----

/**
 * What Foreman does when a queue drains.
 *
 * `ask` is the original behaviour and the default: mark the drain and let the human
 * pick from the Wrapup card. The other two type the instruction themselves, and are
 * the whole reason this text lives in `@shared` rather than in the card - the worker
 * and the card MUST send the same bytes. A copy that drifts is a copy that ships a
 * different thing depending on who pressed the button.
 */
export type WrapupMode = "ask" | "no-mistakes" | "pr";

/** The enum's values, for the config schema. Spelled once so zod can't drift from the type. */
export const WRAPUP_MODES = ["ask", "no-mistakes", "pr"] as const satisfies readonly WrapupMode[];

/**
 * The two instructions a wrap-up can send.
 *
 * `/no-mistakes` is a slash command and MUST stay a single line: `sendText` submits on
 * every embedded newline, and even on the bracketed-paste path a stray newline here
 * would split the command. It also pushes and opens the PR itself, which is why the
 * card's "both ticked" case prefills it alone rather than asking for both.
 */
export const WRAPUP_NO_MISTAKES = "/no-mistakes";
export const WRAPUP_PR = "Please commit this work, push the branch, and open a PR.";

/**
 * The composed wrap-up instruction for the card's two checkboxes. A guess, which is
 * exactly why the card's textarea is editable.
 */
export function composeWrapup(pr: boolean, nm: boolean): string {
  if (nm) return WRAPUP_NO_MISTAKES;
  if (pr) return WRAPUP_PR;
  return "";
}

/**
 * The instruction Foreman types itself on drain, or null when it must ask instead.
 *
 * Null is not "do nothing" - it's "fall back to the human", so the caller must still
 * mark the drain. See `decideQueueTick` step 5.
 */
export function autoWrapupPayload(mode: WrapupMode): string | null {
  if (mode === "no-mistakes") return WRAPUP_NO_MISTAKES;
  if (mode === "pr") return WRAPUP_PR;
  return null;
}
