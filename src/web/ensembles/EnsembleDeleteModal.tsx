import type { EnsembleRun } from "@shared/ensemble.ts";
import { Overlay, OVERLAY_IDS } from "../components/Overlay.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import { DeleteButton } from "../components/DeleteButton.tsx";

/**
 * Confirm the one ensemble action that destroys retained evidence.
 *
 * The title is the operator's identity for the run. The GUID remains a server-side safety echo,
 * supplied by the controller from its selected record rather than used as a typing challenge.
 */
export function EnsembleDeleteModal({
  run,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  run: EnsembleRun;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}): React.JSX.Element {
  return (
    <Overlay
      id={OVERLAY_IDS.ensembleDelete}
      onClose={onClose}
      className="modal ensemble-delete-modal"
      role="dialog"
      ariaLabel={`Delete ensemble run ${run.title}`}
      closable={!busy}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) onConfirm();
        }}
      >
        <header className="modal-head">
          <h2 tabIndex={-1} autoFocus>Delete ensemble run</h2>
          <Tooltip label="Keep this run and close (Escape)">
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
        <div className="ensemble-delete-body">
          <p className="ensemble-delete-subject">
            <strong>{run.title}</strong>
          </p>
          <p className="ensemble-delete-consequence">
            This permanently deletes the run's history and private snapshot refs. This cannot be
            undone.
          </p>
          <p className="ensemble-delete-kept">
            The member Tasks and any linked Workflow run are kept.
          </p>
          {error ? <p className="ensemble-error" role="alert">{error}</p> : null}
        </div>
        <footer className="modal-foot">
          <span className="actions-spacer" />
          <Tooltip label="Keep this run's history and private refs">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          </Tooltip>
          <DeleteButton
            type="submit"
            className="btn btn-danger"
            disabled={busy}
            tooltip="Permanently delete this run's history and private refs"
          >
            {busy ? "Deleting…" : "Delete run"}
          </DeleteButton>
        </footer>
      </form>
    </Overlay>
  );
}
