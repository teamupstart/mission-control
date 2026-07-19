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
 * WHEN a wrap-up fires, as opposed to WHAT it sends (`WrapupMode`).
 *
 * The two axes are independent by design: the human picks one or more moments that
 * count as "this session is finished", and one action to take at whichever fires.
 *
 *  - `drain`  - every item in the session's work queue reached a terminal state. The
 *               original behaviour, and the only one with a per-ITEM verdict behind
 *               it: each item was already judged complete on its way to `verified`.
 *  - `prompted` - the human typed straight into the pane (no queue involved), the
 *               agent worked, and it has parked. There is no item and therefore no
 *               existing verdict, so this trigger has to EARN the same confidence -
 *               see `decidePromptedWrapup`, which verifies the session diff against
 *               the captured goal before anything is typed.
 *
 * An empty list is a legitimate, fully-off state: it means "never wrap up
 * automatically", which is what someone who wants the queue but not the shipping
 * would choose. Nothing may treat empty as "fall back to the default".
 */
export type WrapupTrigger = "drain" | "prompted";

/** The enum's values, for the config schema. Spelled once so zod can't drift from the type. */
export const WRAPUP_TRIGGERS = ["drain", "prompted"] as const satisfies readonly WrapupTrigger[];

/** Whether a trigger is armed. The one reader of the config list, so it can't be spelled two ways. */
export function wrapupTriggerOn(
  triggers: readonly WrapupTrigger[],
  which: WrapupTrigger,
): boolean {
  return triggers.includes(which);
}

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
 * What the Ship it? question says, worded for the trigger that actually raised it.
 *
 * Both triggers share one card and one alert - deliberately, so there is a single ask
 * to answer - but they are not the same event, and the drain wording states something
 * that never happened on the other one: the `prompted` trigger fires only on a checkout
 * with NO work queue (see `decidePromptedWrapup` step 3), so "the queue is drained"
 * describes a batch that never existed.
 *
 * Both strings come out of ONE call so the card and the alert cannot drift into
 * describing the same ask two different ways, which is the failure mode that put a
 * queue-drain sentence on a queueless session in the first place.
 *
 * `hasQueuedWork` is read off the row's items - `items.length` for a caller holding the
 * full queue, `totalCount` for one holding the card summary. They are the same number
 * (see `summarizeQueue`), which is what lets the two callers agree without sharing state.
 */
export function wrapupAskCopy(hasQueuedWork: boolean): { card: string; alert: string } {
  return hasQueuedWork
    ? { card: "The queue is drained. Ship it?", alert: "the work queue drained" }
    : { card: "The work you asked for looks done. Ship it?", alert: "the work you asked for looks done" };
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

/**
 * Whether some text IS one of the wrap-up instructions - i.e. whether a session's
 * captured goal is really just Foreman hearing its own voice come back.
 *
 * This is what stops the `prompted` trigger looping forever, and the loop it closes
 * is not hypothetical. The goal is captured from `UserPromptSubmit`, which fires for
 * an INJECTED prompt exactly as it does for a typed one, and `substantivePrompt`
 * filters only `/clear` and `/compact` - so `/no-mistakes` lands as the session's new
 * goal. The prompted trigger re-arms on a new goal, so without this check the cycle
 * is: fire -> type `/no-mistakes` -> goal becomes `/no-mistakes` -> the run finishes
 * and the session parks -> re-armed -> fire again. Forever, on a live repo, each pass
 * opening another PR.
 *
 * Deliberately a comparison against the two payloads rather than a general
 * "did Foreman type this" lookup: turn authorship (see `injections.ts`) is in-memory,
 * unpersisted, and annotated only on the browser's SSE stream, so the worker cannot
 * read it. These two strings are the only things this trigger can ever have sent, and
 * a constant it emitted itself is something it can always recognise.
 */
export function isWrapupPayload(text: string | null | undefined): boolean {
  const t = text?.trim();
  return t === WRAPUP_NO_MISTAKES || t === WRAPUP_PR;
}
