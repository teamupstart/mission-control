import { useState } from "react";
import type { Session, Task } from "@shared/types.ts";
import { api } from "../lib/api.ts";
import { retroBackstopOffer, retroOutcome } from "../lib/retro-offer.ts";
import { useTourTaskTargetRef } from "../tour/target-context.tsx";
import { AgentDot } from "./session-bits.tsx";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * Finish a session's task and close the session.
 *
 * The counterpart to Kill, and it exists because Kill was for a long time the only way
 * to end a session that had finished its work. That left the task settled as `failed`
 * or `cancelled` - both of which mean "this did not happen" to every task declared to
 * wait on it - so an operator who did the work and reached for the nearest button
 * silently deadlocked everything behind it.
 *
 * The checkbox is the interesting part, and it is a real decision rather than a
 * formality. A declared dependency is otherwise satisfied ONLY by a merged PR, because
 * a dependent task cuts a fresh worktree from the default branch and therefore does not
 * contain unmerged prerequisite work. So the box is pre-ticked exactly when there is no
 * unmerged PR to worry about - a scout, a session whose change landed by another route -
 * and left CLEAR when this session has an open one, where ticking it means consciously
 * starting the next task on a base that is missing this one's commits.
 */
export function CompleteModal({
  session,
  tasks,
  tourOutcome,
  onCompleted,
  onClose,
}: {
  session: Session;
  /** Every task, to count what this completion would release. */
  tasks: Task[];
  /**
   * Read-only outcome shown by the See the work spike. Its presence keeps both terminal
   * actions inert; the tour controller owns the one fixed completion path.
   */
  tourOutcome?: string;
  /** Fired once the task is closed and session shutdown is accepted, so App drops detail. */
  onCompleted?: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const task = session.task;
  const tourPreview = tourOutcome !== undefined;
  const [outcome, setOutcome] = useState(tourOutcome ?? "");
  const tourTargetRef = useTourTaskTargetRef<HTMLElement>("complete-modal", task?.id);
  // Never pre-ticked. Releasing dependents without a merge is a claim only a human can
  // make, so it is always an explicit act.
  //
  // A `prState === "merged"` preselect was tried and removed: that value is not reachable
  // here after the ordinary merge path, because `reconcileWorkEpisodeMerge` clears the
  // session's PR match as it retires the episode. It would have preselected nothing while
  // reading as though it sometimes did - and the other states are worse to trust. `null`
  // is "the poller has not answered yet", which is at its most likely in exactly the
  // window after an agent opens a pull request, when releasing dependents onto a base
  // without its commits does the most damage.
  const [satisfy, setSatisfy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A success worth saying out loud - today, only the retro that became a backlog task. */
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * The last place a retro can be offered, for the session that never opened a pull request.
   *
   * The card-level offer waits for the Inspector to have finished with a PR; a scout, a
   * spike, or anything whose change landed by another route never reaches that moment, and
   * this dialog is the last time anybody looks at it. So the timing condition is dropped
   * here and the worthiness condition is not - see `retroBackstopOffer`.
   *
   * It does NOT complete the task, and that is the whole point of the placement: the retro is
   * a turn this session has to take, so completing and killing it first would deliver the
   * instruction into a conversation that is being torn down. Complete is still one click away
   * once the retro has been through its approvals.
   */
  const retro = retroBackstopOffer(session);
  const retroLabel = retro?.label ?? (tourPreview ? "Run a retro first" : null);

  // Tasks held up by an operator-declared edge onto this one that no merge has closed.
  // Counted here rather than asked of the server: the dashboard already holds every
  // task, and a number that lagged the snapshot would be a promise about work the
  // confirm is not actually going to release.
  const dependents = task
    ? tasks.filter((candidate) =>
        candidate.dependencies.some(
          (dependency) =>
            dependency.type === "task" &&
            dependency.taskId === task.id &&
            dependency.satisfiedAt === null,
        ),
      )
    : [];

  const canComplete = Boolean(task) && !busy && !tourPreview;

  async function confirm(): Promise<void> {
    if (!canComplete || !task) return;
    setBusy(true);
    setError(null);
    // An outcome is useful context, not permission to finish. Keep the wire contract's
    // non-empty outcome by supplying the plain status when the operator has nothing to
    // add; callers that do have a result still preserve it verbatim.
    const completed = await api.completeTask(
      task.id,
      outcome.trim() || "completed",
      undefined,
      satisfy,
    );
    if (!completed.ok) {
      setBusy(false);
      setError(completed.error ?? "could not complete the task");
      return;
    }
    // The task is recorded before the agent stop is requested, and the order matters: a stop
    // that fails must not leave the outcome unwritten, because the row would then settle
    // as `failed` through the session-went-away path and lose what was just typed.
    const killed = await api.kill(session.id);
    setBusy(false);
    if (!killed.ok) {
      setError(`task marked done, but the session could not be closed: ${killed.error ?? "failed"}`);
      return;
    }
    onCompleted?.();
    onClose();
  }

  /**
   * Send the retro and step out of the way.
   *
   * Closes on success rather than reporting into a dialog nobody has a reason to keep
   * looking at - the answer is now in the session's own conversation, which is where the
   * operator has to go next anyway. A refusal keeps the dialog up with the daemon's own
   * sentence in the same place every other failure here is reported.
   */
  async function runRetro(): Promise<void> {
    if (busy || tourPreview) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await api.runRetro(session.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? "could not start a retro for this session");
      return;
    }
    // Named rather than silent, and NOT through `error`: "filed as a backlog task because
    // this session cannot be typed into" is a different next move, not a failure, and it is
    // the one case where closing would leave the operator believing a turn is coming.
    if (result.kind === "dispatched" || result.kind === "queued") {
      setNotice(retroOutcome(result));
      return;
    }
    onClose();
  }

  return (
    <Overlay
      id={OVERLAY_IDS.complete}
      onClose={onClose}
      className="modal complete-modal"
      role="dialog"
      ariaLabel="Complete task and close session"
      surfaceRef={tourTargetRef}
      closable={!busy}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        <header className="modal-head">
          <h2>Complete {task ? "task" : "session"}</h2>
          <Tooltip label="Close without completing (Escape)">
            <button
              type="button"
              className="icon-btn"
              aria-label="Close"
              onClick={onClose}
              disabled={busy}
            >
              ✕
            </button>
          </Tooltip>
        </header>

        <div className="complete-body">
          <p className="complete-lead">
            <AgentDot agent={session.agent} />
            <span className="complete-name">{session.name || "(unnamed)"}</span>
          </p>

          {task ? (
            <>
              <p className="complete-task">
                Marks <strong>{task.title}</strong> done, then closes this session.
              </p>

              <label className="complete-field">
                <span>Outcome (optional)</span>
                <input
                  className="complete-outcome"
                  autoFocus
                  value={outcome}
                  disabled={busy}
                  readOnly={tourPreview}
                  placeholder="Add a note, e.g. shipped in PR #193"
                  onChange={(e) => setOutcome(e.target.value)}
                />
                {tourPreview && (
                  <span className="complete-tour-note">
                    Prefilled for the tour. The guide owns completion and will not run a retro.
                  </span>
                )}
              </label>

              {dependents.length > 0 && (
                <label className="complete-satisfy">
                  <Tooltip
                    label={
                      session.prState === "merged"
                        ? "Satisfies their dependency on this task, which its merged pull request already evidences"
                        : "Satisfies their dependency on this task without a merged pull request - they will be cut from the default branch, which may not hold its commits"
                    }
                  >
                    <input
                      type="checkbox"
                      checked={satisfy}
                      disabled={busy}
                      onChange={(e) => setSatisfy(e.target.checked)}
                    />
                  </Tooltip>
                  <span>
                    Unblock the <strong>{dependents.length}</strong> task
                    {dependents.length === 1 ? "" : "s"} waiting on this
                  </span>
                </label>
              )}
              {dependents.length > 0 && (
                <p className="complete-satisfy-why">
                  {!satisfy
                    ? "They stay blocked until a pull request from this work is merged."
                    : session.prState === "open"
                      ? "This session has an open pull request. Those tasks will be cut from the default branch, which does not contain its unmerged commits."
                      : "Mission Control has not seen a merge for this work, so those tasks may be cut from a branch without its commits."}
                </p>
              )}
              {dependents.length > 0 && (
                <ul className="complete-dependents">
                  {dependents.slice(0, 5).map((d) => (
                    <li key={d.id}>{d.title}</li>
                  ))}
                  {dependents.length > 5 && (
                    <li className="complete-more">…and {dependents.length - 5} more</li>
                  )}
                </ul>
              )}
            </>
          ) : (
            <p className="complete-none">
              This session has no Mission Control task, so there is nothing to mark done.
              Use Kill to close it.
            </p>
          )}

          {error && <p className="complete-error">{error}</p>}
          {notice && <p className="complete-notice" role="status">{notice}</p>}
        </div>

        <footer className="modal-foot">
          {/* Before the spacer, so it sits on the dialog's own side of the row rather than
              lining up with Cancel and Complete. This is not a third way to answer the
              dialog's question - it is the one thing worth doing BEFORE answering it. */}
          {retroLabel && (
            <Tooltip
              label={
                tourPreview
                  ? "Shown for comparison. This tour will not start a retro."
                  : retro!.tooltip
              }
            >
              <button
                type="button"
                className="btn btn-ghost complete-retro"
                onClick={() => void runRetro()}
                disabled={busy || tourPreview}
              >
                {retroLabel}
              </button>
            </Tooltip>
          )}
          <span className="actions-spacer" />
          <Tooltip label="Leave the task and the agent alone">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          </Tooltip>
          <Tooltip
            label={
              tourPreview
                ? "Use Complete tour in the guide to record this fixed outcome"
                : task
                ? "Mark the task done, then terminate this agent"
                : "This session has no task to complete"
            }
          >
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!canComplete}
            >
              {busy ? "Completing…" : "Complete & close"}
            </button>
          </Tooltip>
        </footer>
      </form>
    </Overlay>
  );
}
