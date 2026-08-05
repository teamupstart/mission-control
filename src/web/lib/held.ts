import type { WorkflowRunSummary } from "@shared/workflow.ts";
import { workflowRunIsOpen } from "@shared/workflow.ts";

/**
 * The sessions a still-open workflow run owns the next turn of.
 *
 * A session bound to a live run sits at `idle` for most of that run's life: it finished its
 * turn, and the workflow is off running checks, judges and reviewers before it sends the next
 * repair round. `stateDisplay` says `idle` and is RIGHT - the agent really is doing nothing.
 * What that reading cannot say is that nobody may give it anything to do, because held-ness is
 * not a property of the session at all. It is a JOIN: a `WorkflowRunSummary` whose `sessionId`
 * is this session and whose status has not reached a terminal one.
 *
 * So this is the one place the join is spelled, and every surface that cares reads it here
 * rather than re-deriving it. `workflowRunIsOpen` rather than a status list of our own, because
 * `WORKFLOW_RUN_STATUSES` is append-only: a fourth terminal status added there has to reach
 * this predicate at the same moment it reaches every other reader.
 *
 * Takes the map App already folds for the tile (`workflowRunBySession`) rather than the raw
 * summaries, so a session's run is resolved once per fleet change instead of once per consumer.
 */
export function heldSessionIds(
  runBySession: ReadonlyMap<string, WorkflowRunSummary> | null | undefined,
): ReadonlySet<string> {
  const held = new Set<string>();
  if (!runBySession) return held;
  for (const [sessionId, run] of runBySession) {
    if (workflowRunIsOpen(run.status)) held.add(sessionId);
  }
  return held;
}

/** Shared empty set, so the default argument allocates nothing per call. */
export const NO_HELD_SESSIONS: ReadonlySet<string> = new Set<string>();
