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
