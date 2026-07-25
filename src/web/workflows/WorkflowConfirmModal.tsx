import { useState } from "react";
import { Overlay, OVERLAY_IDS } from "../components/Overlay.tsx";
import { Tooltip } from "../components/Tooltip.tsx";

/**
 * The workflow surfaces' destructive confirmations, hosted by the overlay registry instead
 * of `window.confirm` and `window.prompt`.
 *
 * `window.confirm` is not merely ugly here: it is a native dialog the registry never sees, so
 * while it is up `anyOpen` is false and the fleet's global key handler is still live behind
 * it. It also cannot name what is being removed in the vocabulary the rest of the surface
 * uses - a node id is all a browser prompt could carry. Callers build the sentence with
 * `nodeLabel` / `stageName` and hand it here.
 *
 * Not session-bound, so no "session disappeared" reconciliation: the request is closed over
 * the draft edit it will apply, and the owner drops it on close.
 */
export interface WorkflowConfirmRequest {
  title: string;
  /** Names what is removed, in persona and stage words. Never an id. */
  body: string;
  confirmLabel: string;
  /**
   * What confirming DOES, for the button's tooltip. Required rather than defaulted to the
   * label, because a tooltip that repeats its own button says nothing and still renders a
   * bubble over the dialog when the button takes focus.
   */
  confirmHint: string;
  /** Whether the confirm button reads as destructive. Removals do. */
  danger?: boolean;
  /**
   * An exact phrase the operator has to type before confirming, for the two actions the
   * DAEMON also demands one for (`restart-full`, `discard_and_new_round`).
   *
   * The phrase is required here rather than only server-side because the server's refusal
   * is the last line, not the first: by the time it fires the operator has already decided.
   * Gating the button on the exact string is what makes the decision deliberate, and it is
   * why these two could not simply become ordinary confirms when `window.prompt` went - a
   * prompt that any keystroke satisfies is a different guarantee.
   */
  requirePhrase?: string;
  onConfirm: () => void;
}

export function WorkflowConfirmModal({
  request,
  onClose,
}: {
  request: WorkflowConfirmRequest;
  onClose: () => void;
}): React.JSX.Element {
  const [typed, setTyped] = useState("");
  const satisfied = !request.requirePhrase || typed.trim() === request.requirePhrase;
  return (
    <Overlay
      id={OVERLAY_IDS.workflowConfirm}
      onClose={onClose}
      className="modal workflow-confirm"
      role="dialog"
      ariaLabel={request.title}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!satisfied) return;
          request.onConfirm();
          onClose();
        }}
      >
        <header className="modal-head">
          <h2>{request.title}</h2>
          <Tooltip label="Close without changing the workflow (Escape)">
            <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
              ✕
            </button>
          </Tooltip>
        </header>
        <div className="workflow-confirm-body">
          <p>{request.body}</p>
          {request.requirePhrase && (
            <label className="workflow-confirm-phrase">
              <span>Type <strong>{request.requirePhrase}</strong> to confirm</span>
              <input
                autoFocus
                type="text"
                value={typed}
                spellCheck={false}
                autoComplete="off"
                aria-label={`Type ${request.requirePhrase} to confirm`}
                onChange={(event) => setTyped(event.target.value)}
              />
            </label>
          )}
        </div>
        <footer className="modal-foot">
          <span className="actions-spacer" />
          <Tooltip label="Leave the workflow as it is">
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          </Tooltip>
          <Tooltip label={request.requirePhrase && !satisfied
            ? `Type ${request.requirePhrase} above to enable this`
            : request.confirmHint}>
            <button
              type="submit"
              className={request.danger ? "btn btn-danger" : "btn"}
              disabled={!satisfied}
              autoFocus={!request.requirePhrase}
            >
              {request.confirmLabel}
            </button>
          </Tooltip>
        </footer>
      </form>
    </Overlay>
  );
}
