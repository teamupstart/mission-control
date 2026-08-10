import type { WorkflowBindingSummary, WorkflowRunSummary } from "@shared/workflow.ts";
import { workflowRunIsOpen } from "@shared/workflow.ts";
import type { Tone } from "./format.ts";

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

/**
 * The same join, for one session standing in front of its own run.
 *
 * This is what a card-shaped surface (Board tile, Cards card) uses to draw its held mark, and
 * it is the SAME sentence `heldSessionIds` spells over the map - stated once here so the two
 * cannot drift. Scoped to the `idle` tone to match `orderSessions`: a held session that has
 * stopped to ask a question belongs to "needs you", and a held mark there would argue with
 * the column it sits in.
 */
export function sessionIsHeld(
  run: WorkflowRunSummary | null | undefined,
  tone: Tone,
): boolean {
  return run != null && workflowRunIsOpen(run.status) && tone === "idle";
}

/**
 * Whether a session surface may still offer to bind a workflow to it.
 *
 * The run half of the same join, read the other way round. A session is bindable when no run
 * OWNS it right now - which is not the same question as "has this session ever had a run", and
 * the difference was a dead end: the `＋ workflow` chip asked the second question, so a session
 * whose review had finished hid the chip forever and could never be reviewed again from the
 * card or the console detail header.
 *
 * The run it was bound to is still worth drawing after it ends - `WorkflowChip` says "Approved"
 * or "Preview cancelled" off the very same summary - so a terminal run shows BOTH: the outcome
 * chip as history, this chip as the next move. That pairing is why the fix lives here and not in
 * `workflowRunBySession`, which deliberately keeps the newest run per session, terminal ones
 * included, and which several display surfaces read for exactly that reason: the outcome chip,
 * the board tile's ladder, and the console's Workflows tab. Narrowing that map would delete the
 * history to fix the affordance. Narrowing it here fixes the affordance and keeps the history.
 *
 * `workflowRunIsOpen` rather than a terminal-status list of our own, for the reason
 * `heldSessionIds` gives: `WORKFLOW_RUN_STATUSES` is append-only.
 */
export function sessionCanBindWorkflow(run: WorkflowRunSummary | null | undefined): boolean {
  return run == null || !workflowRunIsOpen(run.status);
}

/**
 * What the bind chip's tooltip says, for the binding a session is armed with or for none.
 *
 * Here rather than in the two components that draw the chip, because it was written twice and
 * both copies said the same wrong thing: that the workflow "runs when this session's work is
 * complete" whatever the binding's trigger. That is only true of `foreman_complete`. A `manual`
 * binding - the dialog's own default, and an option every operator can pick - runs nothing at
 * completion and waits for an explicit submit, so the sentence promised an automatic review
 * that was never coming. One copy is the only way two surfaces cannot drift apart again.
 *
 * Switched on the trigger rather than defaulted, so a third member of the append-only
 * `WORKFLOW_TRIGGER_MODES` has to be given words here instead of silently inheriting a claim
 * that may not hold for it.
 */
export function workflowBindChipTitle(
  binding: Pick<WorkflowBindingSummary, "workflowName" | "workflowVersion" | "triggerMode"> | null | undefined,
): string {
  if (!binding) return "Bind a published workflow version";
  const armed = `${binding.workflowName} v${binding.workflowVersion}`;
  switch (binding.triggerMode) {
    case "foreman_complete":
      return `${armed} runs when this session's work is complete - click to change it`;
    case "manual":
      return `${armed} is armed and waits for you to submit it - click to change it`;
  }
}
