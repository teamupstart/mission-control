import { useEffect, useState } from "react";
import type { ResetPreview, Session } from "@shared/types.ts";
import { api, fetchResetPreview } from "../lib/api.ts";
import { AgentDot } from "./session-bits.tsx";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";

/**
 * Confirm-and-execute a hard reset of a session's checkout to origin's default
 * branch (then `/clear` its context). On open it fetches a loss preview so the
 * dialog can name exactly what work the reset would throw away - uncommitted
 * edits, untracked files, and local commits - before the user commits. The
 * preview fetch hits the network (it fetches origin), so the body shows a
 * checking state first and disables the confirm button until it resolves.
 */
export function ResetModal({
  session,
  onReset,
  onClose,
  unsavedFiles = 0,
}: {
  session: Session;
  /** Fired once the reset succeeds (before the modal closes) so the app can retire
   *  the session's client-side state - its parked send / reply drafts. */
  onReset?: () => void;
  onClose: () => void;
  /** Local editor buffers that are not safely represented on disk yet. */
  unsavedFiles?: number;
}): React.JSX.Element {
  const [preview, setPreview] = useState<ResetPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch the loss preview when the target session changes. `alive` guards a
  // late response from writing state after the modal closed / retargeted.
  useEffect(() => {
    let alive = true;
    setPreview(null);
    setError(null);
    void fetchResetPreview(session.id).then((p) => {
      if (alive) setPreview(p);
    });
    return () => {
      alive = false;
    };
  }, [session.id]);

  const target = preview?.target ?? "origin/main";
  const canReset = Boolean(preview?.ok) && !busy;

  async function confirm(): Promise<void> {
    if (!canReset) return;
    setBusy(true);
    setError(null);
    const r = await api.reset(session.id, true);
    setBusy(false);
    if (r.ok) {
      onReset?.();
      onClose();
    } else setError(r.error ?? "reset failed");
  }

  return (
    // `closable` gates the backdrop click and Escape together: a reset that is already
    // running must not be abandoned by either route, and one flag rather than two guards
    // is what stops them drifting apart.
    <Overlay
      id={OVERLAY_IDS.reset}
      onClose={onClose}
      className="modal reset-modal"
      role="dialog"
      ariaLabel="Reset session to origin"
      closable={!busy}
    >
      <header className="modal-head">
        <h2>Reset to {target}</h2>
        <button className="icon-btn" aria-label="Close" onClick={onClose} disabled={busy}>
          ✕
        </button>
      </header>

      <div className="reset-body">
        <p className="reset-lead">
          <AgentDot agent={session.agent} />
          <span className="reset-name">{session.name || "(unnamed)"}</span>
        </p>

        {!preview && !error && <p className="reset-checking">Checking working tree against origin…</p>}
        {preview && !preview.ok && <p className="reset-error">{preview.error}</p>}
        {preview?.ok && <ResetPreviewBody preview={preview} unsavedFiles={unsavedFiles} />}
        {error && <p className="reset-error">{error}</p>}
      </div>

      <footer className="modal-foot">
        <span className="actions-spacer" />
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn btn-danger" onClick={() => void confirm()} disabled={!canReset}>
          {busy ? "Resetting…" : "Reset & clear"}
        </button>
      </footer>
    </Overlay>
  );
}

/** The warning body once the preview is in: what's lost, then what will happen. */
function ResetPreviewBody({ preview, unsavedFiles }: { preview: ResetPreview; unsavedFiles: number }): React.JSX.Element {
  const { dirtyFiles, untrackedFiles, aheadCommits, aheadSubjects, clean, target, branch, canClear } = preview;
  const branchLabel = branch ?? "this branch";
  return (
    <>
      {clean && unsavedFiles === 0 ? (
        <p className="reset-clean">
          ✓ Working tree is clean and already at <code>{target}</code>. Nothing will be lost.
        </p>
      ) : (
        <>
          <p className="reset-warn-title">
            This permanently discards - it <strong>cannot be undone</strong>:
          </p>
          <ul className="reset-loss">
            {unsavedFiles > 0 && (
              <li>
                <strong>{unsavedFiles}</strong> unsaved Mission Control editor buffer{unsavedFiles === 1 ? "" : "s"}
              </li>
            )}
            {aheadCommits > 0 && (
              <li>
                <strong>{aheadCommits}</strong> local commit{aheadCommits === 1 ? "" : "s"} on{" "}
                <code>{branchLabel}</code> not on <code>{target}</code>
                {aheadSubjects.length > 0 && (
                  <ul className="reset-commits">
                    {aheadSubjects.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                    {aheadCommits > aheadSubjects.length && (
                      <li className="reset-more">…and {aheadCommits - aheadSubjects.length} more</li>
                    )}
                  </ul>
                )}
              </li>
            )}
            {dirtyFiles > 0 && (
              <li>
                <strong>{dirtyFiles}</strong> uncommitted file change{dirtyFiles === 1 ? "" : "s"}
              </li>
            )}
            {untrackedFiles > 0 && (
              <li>
                <strong>{untrackedFiles}</strong> untracked file{untrackedFiles === 1 ? "" : "s"}
              </li>
            )}
          </ul>
        </>
      )}
      <p className="reset-then">
        Then hard-reset <code>{branchLabel}</code> to the latest <code>{target}</code>
        {canClear ? (
          <>
            {" "}
            and clear the agent's context (<code>/clear</code>).
          </>
        ) : (
          <>. The agent's context can't be cleared automatically (no pane).</>
        )}
      </p>
    </>
  );
}
