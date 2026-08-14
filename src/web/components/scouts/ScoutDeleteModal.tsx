import { useEffect, useRef, useState } from "react";
import { Overlay, OVERLAY_IDS } from "../Overlay.tsx";
import { Tooltip } from "../Tooltip.tsx";
import { api } from "../../lib/api.ts";
import { formatBytes } from "../../lib/format.ts";

/** The literal an operator types to arm the destructive button. */
const CONFIRM_WORD = "DELETE";

/** What the caller captured about the scout at the moment the control was pressed. */
export interface ScoutDeleteTarget {
  /**
   * The archive key AS IT WAS when the control was invoked.
   *
   * Captured rather than read at submit time, and echoed to the daemon as
   * `confirmArchiveKey`. Background reconciliation can reorder the rail underneath an open
   * modal, so a key resolved late would let a confirmed delete land on whichever archive had
   * since moved into that position.
   */
  key: string;
  title: string;
  producerLabel: string | null;
  bytes: number;
}

export function ScoutDeleteModal({
  target,
  onClose,
  onDeleted,
}: {
  target: ScoutDeleteTarget;
  onClose: () => void;
  /** Fired only after the daemon confirms, so no row disappears on optimism. */
  onDeleted: (key: string) => void;
}): React.JSX.Element {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const armed = typed.trim() === CONFIRM_WORD && !busy;

  async function confirm(): Promise<void> {
    if (!armed) return;
    setBusy(true);
    setError(null);
    const result = await api.deleteArchive(target.key);
    if (!result.ok) {
      // The modal and the archive both stay put, showing the daemon's own reason. An
      // unreadable bundle is still deletable by its server-verified path, so a refusal here
      // is a real problem worth reading rather than a state to dismiss.
      setBusy(false);
      setError(result.error ?? "The archive could not be deleted.");
      inputRef.current?.focus();
      return;
    }
    onDeleted(target.key);
  }

  return (
    <Overlay
      id={OVERLAY_IDS.scoutDelete}
      onClose={onClose}
      className="modal scout-delete-modal"
      role="dialog"
      ariaLabel={`Delete the scout archive ${target.title}`}
      closable={!busy}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        <header className="modal-head">
          <h2>Delete scout</h2>
        </header>
        <div className="modal-body">
          <p className="scout-delete-lede">
            <strong>{target.title}</strong>
            {target.producerLabel ? <> from {target.producerLabel}</> : null}
            {" · "}
            <span className="mono">{formatBytes(target.bytes)}</span>
          </p>
          {/*
            The exact local consequence, and the exact limit of it. An operator deleting
            evidence deserves to know precisely how far this reaches: it is one directory on
            one machine, it is not a retraction, and Mission Control cannot promise what a
            sync tool does next in either direction.
          */}
          <p className="scout-delete-consequence">
            Mission Control removes this bundle and its search entry from the library on this
            machine. The task, its session, the repository and every remote service are
            untouched.
          </p>
          <p className="scout-delete-consequence">
            If you sync this directory, that tool may propagate the deletion to your other
            machines - or restore the same bundle here later. Mission Control cannot promise
            either.
          </p>
          <label className="field scout-delete-field">
            <span className="field-label">
              Type <span className="mono">{CONFIRM_WORD}</span> to confirm
            </span>
            <input
              ref={inputRef}
              className="field-input"
              value={typed}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTyped(event.target.value)}
            />
          </label>
          {error ? (
            // Above the actions, so it is read before the button is reached for again.
            <p className="scout-delete-error" role="alert">{error}</p>
          ) : null}
        </div>
        <footer className="modal-foot">
          <span className="spacer" />
          <Tooltip label="Close without deleting anything (Escape)">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          </Tooltip>
          <Tooltip label={
            armed
              ? "Remove this bundle and its search entry from the library on this machine"
              : `Type ${CONFIRM_WORD} above to enable this`
          }>
            <button type="submit" className="btn btn-danger" disabled={!armed}>
              {busy ? "Deleting…" : "Delete scout"}
            </button>
          </Tooltip>
        </footer>
      </form>
    </Overlay>
  );
}
