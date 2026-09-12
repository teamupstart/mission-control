import {
  updateDialogDismissal,
  type UpdateDialogChoice,
  type UpdateDialogRequest,
} from "@shared/update-dialog.ts";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * The auto-updater's questions, in the app's own clothes.
 *
 * Every one of these used to be a `dialog.showMessageBox` sheet: platform grey, system
 * buttons, no panel, no border, no type ramp. It was the only confirm in Mission Control
 * that did not look like Mission Control, and it was the one shown for the job where
 * recognising who is asking matters most - an app proposing to close itself, install
 * something in `/Applications`, and ask for an administrator password on the way.
 *
 * There is no per-phase branch here. The seven conversations differ only in words, tone and
 * which buttons they offer, and `shared/update-dialog.ts` owns all three - so this renders
 * whatever arrives, and a new phase costs a builder there rather than a component here.
 */
export function UpdateDialog({
  request,
  onAnswer,
}: {
  request: UpdateDialogRequest | null;
  onAnswer: (id: string, choice: UpdateDialogChoice) => void;
}): React.JSX.Element | null {
  if (!request) return null;

  // Escape and the backdrop answer with the dialog's own dismissal, read off the content
  // rather than assumed: "Later" on the two that offer it, "OK" on the five that do not.
  const dismissal = updateDialogDismissal(request);

  return (
    <Overlay
      id={OVERLAY_IDS.updateDialog}
      onClose={() => onAnswer(request.id, dismissal.choice)}
      className={`modal update-dialog update-dialog-${request.tone}`}
      role="dialog"
      ariaLabel="Mission Control update"
      ariaModal
    >
      <header className="modal-head">
        <h2>Mission Control update</h2>
        <Tooltip label={`${dismissal.label} (Escape)`}>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close"
            onClick={() => onAnswer(request.id, dismissal.choice)}
          >
            ✕
          </button>
        </Tooltip>
      </header>

      <div className="modal-body update-dialog-body">
        <strong className="update-dialog-title">{request.title}</strong>
        {/* Release notes arrive as the release's own markdown, newlines and all, so the
            detail keeps its line breaks instead of collapsing into one paragraph. */}
        {request.detail && <p className="update-dialog-detail">{request.detail}</p>}
      </div>

      <footer className="modal-foot">
        <span className="actions-spacer" />
        {request.actions.map((action) => (
          <Tooltip key={action.choice} label={action.hint}>
            <button
              type="button"
              className={action.tone === "primary" ? "btn btn-primary" : "btn btn-ghost"}
              autoFocus={action.tone === "primary"}
              onClick={() => onAnswer(request.id, action.choice)}
            >
              {action.label}
            </button>
          </Tooltip>
        ))}
      </footer>
    </Overlay>
  );
}
