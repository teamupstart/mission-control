import { useState } from "react";
import type { EnsembleActionBody } from "@shared/protocol.ts";
import { ensembleIsTerminal, ensembleReviewIsInfrastructureBlocked } from "@shared/ensemble.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import type { EnsembleRunDetailResponse } from "./types.ts";

/**
 * The generic, state-aware action surface for one run. It reads what is offerable off the run's
 * STATUS and stage state - never off a `best_of_n` check - so a new strategy inherits cancel,
 * retry, resolve-finalization and delete for free. The decision (`decide`) is not here: it is
 * strategy-specific and lives in the result renderer.
 *
 * Destructive actions confirm inline, in the detail, with no unregistered overlay. Delete
 * demands the run id echoed back, and says plainly that Tasks and any linked Workflow survive
 * while the private ensemble refs and history do not.
 */
export function EnsembleActions({
  detail,
  pending,
  error,
  onAction,
  onDelete,
}: {
  detail: EnsembleRunDetailResponse;
  /** The action currently in flight (its `kind`), or null. Disables the surface while set. */
  pending: string | null;
  error: string | null;
  onAction: (body: EnsembleActionBody) => void;
  onDelete: (confirmId: string) => void;
}): React.JSX.Element {
  const { run } = detail;
  const status = run.status;
  const terminal = status ? ensembleIsTerminal(status) : false;
  const cancellable =
    status === null
      ? run.unreadable !== null
      : !terminal && status !== "cancelling" && status !== "finalizing";
  const finalizing = status === "finalizing";
  const handoff = run.workflowHandoff;
  const handoffCanBeSkipped =
    handoff !== null && ["failed", "conflict"].includes(handoff.state);
  const latestStageAttempts = new Map<string, (typeof detail.stageAttempts)[number]>();
  for (const attempt of detail.stageAttempts) {
    const current = latestStageAttempts.get(attempt.stageId);
    if (
      !current ||
      attempt.attempt > current.attempt ||
      (attempt.attempt === current.attempt && attempt.updatedAt > current.updatedAt)
    ) {
      latestStageAttempts.set(attempt.stageId, attempt);
    }
  }
  const failedStage = [...latestStageAttempts.values()]
    .filter((attempt) => {
      // A finalize stage that failed is always the operator's to restart: nothing re-drives it
      // on its own, so a failed row IS the state that needs this door.
      if (attempt.driverKind === "finalize") return attempt.status === "failed";
      if (attempt.driverKind !== "review") return false;
      if (attempt.status !== "failed" && attempt.status !== "interrupted") return false;
      // A review offers its door exactly when the DAEMON has stopped, which is when its
      // infrastructure budget is spent - and that one question answers for both statuses.
      //
      // Neither of them means "stopped" on its own. Mid-backoff the newest row is `failed` and a
      // timer is already armed to try again; an interruption is re-driven the same way. Offering
      // the button in either case invites a person to press something that is already happening,
      // and the pipeline is drawing that same stage as *retrying* while it does - one screen
      // making two claims. It also had a consequence: an operator-granted attempt skips the
      // pending backoff, so a press during the 1s or 4s wait fired the next call immediately and
      // undid the spacing that stops one provider blip becoming three.
      return ensembleReviewIsInfrastructureBlocked(detail.stageAttempts, attempt.stageId);
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];

  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmSkipHandoff, setConfirmSkipHandoff] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteEcho, setDeleteEcho] = useState("");
  const busy = pending !== null;

  return (
    <div className="ensemble-actions" aria-label="Run actions">
      {error && (
        <p className="ensemble-error" role="alert">
          {error}
        </p>
      )}
      <div className="ensemble-action-row">
        {failedStage && !terminal && (
          <Tooltip label="Re-run the failed stage against its recorded inputs">
            <button
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => onAction({ kind: "retry_stage", stageId: failedStage.stageId })}
            >
              {pending === "retry_stage" ? "Retrying…" : "Retry stage"}
            </button>
          </Tooltip>
        )}
        {finalizing && (
          <Tooltip label="Resume finalization from where it stopped">
            <button
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => onAction({ kind: "resolve_finalization", skipWorkflowHandoff: false })}
            >
              {pending === "resolve_finalization" ? "Resuming…" : "Retry finalization"}
            </button>
          </Tooltip>
        )}
        {finalizing && handoffCanBeSkipped && !confirmSkipHandoff && (
          <Tooltip label="Abandon the blocked workflow handoff and finish with the normal continuation">
            <button
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => setConfirmSkipHandoff(true)}
            >
              Skip workflow handoff…
            </button>
          </Tooltip>
        )}
        {cancellable && !confirmCancel && (
          <Tooltip label="Cancel active members; keep submitted snapshots and history">
            <button className="btn btn-ghost danger" disabled={busy} onClick={() => setConfirmCancel(true)}>
              Cancel run…
            </button>
          </Tooltip>
        )}
        {terminal && !confirmDelete && (
          <Tooltip label="Delete this run's history and private refs (tasks and workflow survive)">
            <button className="btn btn-ghost danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
              Delete run…
            </button>
          </Tooltip>
        )}
      </div>

      {finalizing && handoffCanBeSkipped && confirmSkipHandoff && (
        <div className="ensemble-inline-confirm" role="group" aria-label="Confirm skip workflow handoff">
          <p>
            Abandon this failed Workflow handoff and finish through the normal continuation.
            The pinned Workflow run will not be retried by finalization.
          </p>
          <div className="ensemble-action-row">
            <Tooltip label="Confirm: abandon the failed workflow handoff">
              <button
                className="btn btn-primary danger"
                disabled={busy}
                onClick={() => {
                  onAction({ kind: "resolve_finalization", skipWorkflowHandoff: true });
                  setConfirmSkipHandoff(false);
                }}
              >
                {pending === "resolve_finalization" ? "Skipping…" : "Skip handoff"}
              </button>
            </Tooltip>
            <Tooltip label="Keep the workflow handoff and leave finalization unchanged">
              <button
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => setConfirmSkipHandoff(false)}
              >
                Keep handoff
              </button>
            </Tooltip>
          </div>
        </div>
      )}

      {confirmCancel && (
        <div className="ensemble-inline-confirm" role="group" aria-label="Confirm cancel">
          <p>
            Cancel every launching or active member. Submitted snapshot refs and this run's history
            are kept.
          </p>
          <div className="ensemble-action-row">
            <Tooltip label="Confirm: cancel every launching or active member">
              <button
                className="btn btn-primary danger"
                disabled={busy}
                onClick={() => {
                  onAction({ kind: "cancel", reason: null });
                  setConfirmCancel(false);
                }}
              >
                {pending === "cancel" ? "Cancelling…" : "Cancel run"}
              </button>
            </Tooltip>
            <Tooltip label="Leave the run as it is">
              <button className="btn btn-ghost" onClick={() => setConfirmCancel(false)}>
                Keep running
              </button>
            </Tooltip>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="ensemble-inline-confirm" role="group" aria-label="Confirm delete">
          <p>
            This deletes the run's history and its private snapshot refs. The member Tasks and any
            linked Workflow run are not touched. Type the run id to confirm.
          </p>
          <input
            className="ensemble-delete-echo"
            value={deleteEcho}
            placeholder={run.id}
            aria-label="Run id"
            onChange={(event) => setDeleteEcho(event.target.value)}
          />
          <div className="ensemble-action-row">
            <Tooltip label="Permanently delete this run's history and private refs">
              <button
                className="btn btn-primary danger"
                disabled={busy || deleteEcho.trim() !== run.id}
                onClick={() => onDelete(run.id)}
              >
                {pending === "delete" ? "Deleting…" : "Delete permanently"}
              </button>
            </Tooltip>
            <Tooltip label="Keep this run's history">
              <button
                className="btn btn-ghost"
                onClick={() => {
                  setConfirmDelete(false);
                  setDeleteEcho("");
                }}
              >
                Keep history
              </button>
            </Tooltip>
          </div>
        </div>
      )}
    </div>
  );
}
