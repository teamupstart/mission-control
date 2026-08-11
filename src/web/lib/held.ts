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
 * Takes the map App already folds for the tile (`workflowRunsBySession`) rather than the raw
 * summaries, so a session's runs are resolved once per fleet change instead of once per consumer.
 *
 * ANY open run holds the session, which is what makes this read the list rather than one run.
 * A multi-repo task's session carries one run per repository it changed; reading only the
 * newest would report a session as free to take work while another repository's review was
 * still mid-repair on the very same pane.
 */
export function heldSessionIds(
  runsBySession: ReadonlyMap<string, readonly WorkflowRunSummary[]> | null | undefined,
): ReadonlySet<string> {
  const held = new Set<string>();
  if (!runsBySession) return held;
  for (const [sessionId, runs] of runsBySession) {
    if (runs.some((run) => workflowRunIsOpen(run.status))) held.add(sessionId);
  }
  return held;
}

/** Shared empty set, so the default argument allocates nothing per call. */
export const NO_HELD_SESSIONS: ReadonlySet<string> = new Set<string>();

/**
 * The one of a session's runs that a one-run surface should speak about.
 *
 * Three surfaces genuinely want one: the board tile's ladder, the console's Workflows tab and
 * the retro offer each render or reason about a single review, and for a multi-repo task's
 * session the most recently updated one is the review something is happening in.
 *
 * Derived here rather than folded into a second App-level map, so the list and the single run
 * cannot disagree about a session - the failure mode a parallel map invites is a card drawing
 * two chips while the tag beside them reads off a third run nobody can see.
 */
export function newestSessionRun(
  runs: readonly WorkflowRunSummary[] | null | undefined,
): WorkflowRunSummary | null {
  if (!runs || runs.length === 0) return null;
  return runs.reduce((best, run) => (run.updatedAt > best.updatedAt ? run : best));
}

/**
 * The run actually holding this session's next turn, or null when nothing is.
 *
 * This is what a card-shaped surface (Board tile, Cards card, rail row) uses to draw its held
 * mark AND to name it, and it is the SAME sentence `heldSessionIds` spells over the map -
 * stated once here so the two cannot drift, which is also why both read every run rather than
 * one. Scoped to the `idle` tone to match `orderSessions`: a held session that has stopped to
 * ask a question belongs to "needs you", and a held mark there would argue with the column it
 * sits in.
 *
 * An OPEN run, and never merely the newest. On a multi-repo session those come apart: a run
 * queued behind a sibling's turn stops advancing its `updatedAt` by design, so a sibling that
 * COMPLETED afterwards is the newer row - and a tooltip reading the newest would name a
 * finished review as the thing holding the session, while the review that really holds it went
 * unnamed. The mark and its sentence have to come from the same run or the card is arguing
 * with itself.
 *
 * List order decides between several open runs, which is repository order with the session's
 * own first. Stable, so the sentence does not flip between renders as sibling runs update.
 */
export function heldByRun(
  runs: readonly WorkflowRunSummary[] | null | undefined,
  tone: Tone,
): WorkflowRunSummary | null {
  if (runs == null || tone !== "idle") return null;
  return runs.find((run) => workflowRunIsOpen(run.status)) ?? null;
}

/** Whether an open run owns this session's next turn. The predicate half of `heldByRun`. */
export function sessionIsHeld(
  runs: readonly WorkflowRunSummary[] | null | undefined,
  tone: Tone,
): boolean {
  return heldByRun(runs, tone) !== null;
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
 *
 * Every run, not the newest: a multi-repo task's session is not bindable while ANY of its
 * repositories is still under review, and the newest run finishing first is the ordinary case
 * rather than an unusual one.
 */
export function sessionCanBindWorkflow(
  runs: readonly WorkflowRunSummary[] | null | undefined,
): boolean {
  return runs == null || !runs.some((run) => workflowRunIsOpen(run.status));
}

/**
 * The active binding each session is ARMED with: its own repository's, never a sibling's.
 *
 * A multi-repo task's session owns one active binding per repository it is reviewing, and
 * only one of them answers the question this chip asks. The chip names what the conversation
 * is armed with and its click opens the dialog ON that binding, so handing it an attached
 * repository's would name a repository the session is not standing in, and would open a
 * binding the dialog then refuses to reattach - it compares the session's own cwd and root.
 *
 * "Own" is `repoRoot` matching the session's, or absent - the shape every binding written
 * before per-repo runs has, and every single-repo binding still. Newest-wins stays the
 * tiebreak within the session's own repository, which is the whole of the old rule.
 */
export function ownBindingBySession(
  bindings: readonly WorkflowBindingSummary[],
  sessionRepoRoots: ReadonlyMap<string, string | null>,
): ReadonlyMap<string, WorkflowBindingSummary> {
  const own = (binding: WorkflowBindingSummary): boolean =>
    !binding.repoRoot || binding.repoRoot === sessionRepoRoots.get(binding.sessionId ?? "");
  const bySession = new Map<string, WorkflowBindingSummary>();
  for (const binding of bindings) {
    if (!binding.sessionId || binding.state !== "active") continue;
    const current = bySession.get(binding.sessionId);
    if (current && own(current) && !own(binding)) continue;
    if (!current || (own(binding) && !own(current)) || binding.updatedAt > current.updatedAt) {
      bySession.set(binding.sessionId, binding);
    }
  }
  return bySession;
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
