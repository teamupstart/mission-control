import { useState } from "react";
import type { Session, Task } from "@shared/types.ts";
import { api } from "../lib/api.ts";
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
  onCompleted,
  onClose,
}: {
  session: Session;
  /** Every task, to count what this completion would release. */
  tasks: Task[];
  /** Fired once the task is closed and the session killed, so App can drop the detail. */
  onCompleted?: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const task = session.task;
  const [outcome, setOutcome] = useState("");
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

  const canComplete = Boolean(task) && outcome.trim().length > 0 && !busy;

  async function confirm(): Promise<void> {
    if (!canComplete || !task) return;
    setBusy(true);
    setError(null);
    const completed = await api.completeTask(task.id, outcome.trim(), undefined, satisfy);
    if (!completed.ok) {
      setBusy(false);
      setError(completed.error ?? "could not complete the task");
      return;
    }
    // The task is recorded before the agent is stopped, and the order matters: a kill
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

  return (
    <Overlay
      id={OVERLAY_IDS.complete}
      onClose={onClose}
      className="modal complete-modal"
      role="dialog"
      ariaLabel="Complete task and close session"
      closable={!busy}
    >
      <header className="modal-head">
        <h2>Complete {task ? "task" : "session"}</h2>
        <Tooltip label="Close without completing (Escape)">
          <button className="icon-btn" aria-label="Close" onClick={onClose} disabled={busy}>
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
              <span>Outcome</span>
              <input
                className="complete-outcome"
                autoFocus
                value={outcome}
                disabled={busy}
                placeholder="What happened? e.g. shipped in PR #193"
                onChange={(e) => setOutcome(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canComplete) void confirm();
                }}
              />
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
      </div>

      <footer className="modal-foot">
        <span className="actions-spacer" />
        <Tooltip label="Leave the task and the agent alone">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </Tooltip>
        <Tooltip
          label={
            task
              ? "Record the outcome, then terminate this agent"
              : "This session has no task to complete"
          }
        >
          <button className="btn btn-primary" onClick={() => void confirm()} disabled={!canComplete}>
            {busy ? "Completing…" : "Complete & close"}
          </button>
        </Tooltip>
      </footer>
    </Overlay>
  );
}
