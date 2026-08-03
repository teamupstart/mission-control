import type { SessionQueueSummary, WorkItem, WorkItemState } from "./types.ts";

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
 * pick from the Wrapup card. Direct PR types the instruction itself, and is
 * the reason this text lives in `@shared` rather than in the card - the worker
 * and the card MUST send the same bytes. A copy that drifts is a copy that ships a
 * different thing depending on who pressed the button.
 */
export type WrapupMode = "ask" | "pr";

/** The enum's values, for the config schema. Spelled once so zod can't drift from the type. */
export const WRAPUP_MODES = ["ask", "pr"] as const satisfies readonly WrapupMode[];

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
 * The PR instruction, and it does not stop at `gh pr create`: an unattended wrap-up
 * that opens a red or unmergeable PR has handed the human the work back, which is the
 * one thing this mode exists not to do. So it names the finish line - green CI, no
 * conflicts - rather than the act, and says to merge the default branch in
 * unconditionally rather than "if there are conflicts", because an agent that has to
 * first decide whether a conflict exists is an agent that decides wrong and stops.
 *
 * One line because `sendText` submits on every embedded newline, so a wrapped string
 * would otherwise become several half-instructions typed in sequence.
 */
export const WRAPUP_PR =
  "Use git and gh directly: commit this work, push the branch, and open a PR. Then merge the" +
  " default branch into yours and resolve" +
  " any conflicts, and follow the PR's CI to completion - fix whatever fails and push again" +
  " until every check passes and the PR has no merge conflicts.";

/**
 * Wrap-up payloads we have sent in the past and no longer send. APPEND-ONLY.
 *
 * `isWrapupPayload` is the prompted trigger's loop-breaker: it recognises Foreman's own
 * instruction coming back as the latest captured prompt. That comparison is against text
 * living on a machine we do not control - a session may capture the prompt before an
 * upgrade and the daemon may read it after. Drop an old spelling and Foreman no longer
 * recognises that instruction as its own, which can re-arm the trigger and open a second
 * PR for work it already shipped. Retiring a payload therefore means moving it here,
 * never deleting it.
 *
 */
const RETIRED_WRAPUP_PAYLOADS: readonly string[] = [
  "Please commit this work, push the branch, and open a PR.",
  "Please commit this work, push the branch, and open a PR. Then merge the default branch into" +
    " yours and resolve any conflicts, and follow the PR's CI to completion - fix whatever fails" +
    " and push again until every check passes and the PR has no merge conflicts.",
];

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
 * An outstanding wrap-up question: raised, and not yet sent or dismissed.
 *
 * Both halves are required. `wrapupAskedAt` is never cleared - on the drain path it
 * doubles as the once-only guard - so on its own it means "a question was asked here
 * once", which stays true forever after it is answered.
 */
export function wrapupAskPending(q: SessionQueueSummary): boolean {
  return q.wrapupAskedAt !== null && !q.wrapupAnswered;
}

/**
 * A GENUINELY NEW open question - the edge the wrap-up notification fires on.
 *
 * Keyed on the ask's timestamp MOVING rather than on it appearing from null, because
 * "appearing" is a property of the drain path's lifecycle alone: `addItem` clears
 * `wrapupAskedAt` back to null whenever new work is queued, so consecutive drains
 * really do pass through null. The prompted path never does - it re-stamps `now` over
 * an already-set timestamp - so a null-transition test is silent for every episode
 * after the first, which on a trigger re-armed by a NEW HUMAN PROMPT is the mainline
 * case rather than an edge: the human works, Foreman decides it is shippable, and says
 * nothing.
 *
 * Still gated on the ask being OPEN, so a frame that carries a new ask and its answer
 * together (the human answering between two SSE pushes) does not announce a question
 * that is already settled. That also keeps this in step with `wrapupAskPending`, which
 * is what the card chip reads - the two surfaces must never disagree about whether
 * there is a question outstanding.
 *
 * Drain keeps firing exactly once per drain: null -> T alerts, T -> T does not, and
 * the clear back to null on the next `addItem` is not an ask.
 *
 * Lives here rather than beside the card's presentation helpers because away mode made
 * the DAEMON an alert consumer too (see alerts.ts), and shared/ must not reach into web/.
 */
export function newWrapupAsk(
  now: SessionQueueSummary | null | undefined,
  before: SessionQueueSummary | null | undefined,
): boolean {
  if (!now || !wrapupAskPending(now)) return false;
  return now.wrapupAskedAt !== (before?.wrapupAskedAt ?? null);
}

/**
 * The instruction Foreman types itself on drain, or null when it must ask instead.
 *
 * Null is not "do nothing" - it's "fall back to the human", so the caller must still
 * mark the drain. See `decideQueueTick` step 5.
 *
 * A bound workflow is claimed through the workflow API before this projection is
 * consulted, so only an unbound direct-PR completion reaches the payload.
 */
export function autoWrapupPayload(mode: WrapupMode): string | null {
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
 * filters only `/clear` and `/compact`. A prompt emitted by an older build can therefore
 * remain the captured goal after an upgrade and must stay recognised as Foreman's own.
 *
 * Deliberately a comparison against the payloads rather than a general "did Foreman
 * type this" lookup: turn authorship (see `injections.ts`) is in-memory, unpersisted,
 * and annotated only on the browser's SSE stream, so the worker cannot read it. These
 * strings are the only things this trigger can ever have sent, and a constant it
 * emitted itself is something it can always recognise - including the ones it emitted
 * before the last upgrade, which is what `RETIRED_WRAPUP_PAYLOADS` is for.
 *
 * The retired list is append-only because captured goals outlive the process and can be
 * re-attached to another harness after an upgrade.
 */
export function isWrapupPayload(text: string | null | undefined): boolean {
  const t = text?.trim();
  if (t === undefined) return false;
  return t === WRAPUP_PR || RETIRED_WRAPUP_PAYLOADS.includes(t);
}
