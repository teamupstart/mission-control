import { useState } from "react";
import type { Session } from "@shared/types.ts";
import { TASK_WORKTREE_RETENTION_DAYS } from "@shared/types.ts";
import { muxHandle } from "@shared/pane.ts";
import { api } from "../lib/api.ts";
import { AgentDot } from "./session-bits.tsx";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * Terminate a session's agent.
 *
 * This replaced a two-click arm on the action bar itself. The arm was cheap and it was
 * also silent about the thing that matters most here: a session running a Mission
 * Control task settles that task as `failed` when it goes, which blocks everything
 * declared to wait on it. An operator whose work was finished wanted Complete, and had
 * no way to know that from a button that just turned red.
 *
 * A safe, published checkout can return after the session leaves. Local work or uncertain
 * safety preserves it under the existing retention policy.
 */
export function KillModal({
  session,
  onKilled,
  onComplete,
  onClose,
}: {
  session: Session;
  /** Fired once shutdown is accepted, so App can drop the detail it was ordered from. */
  onKilled?: () => void;
  /** Switch to Complete instead - offered only when there is a task to complete. */
  onComplete?: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only a verified sole-pane home can be closed along with the agent.
  const killsMux = muxHandle(session);
  const task = session.task;

  async function confirm(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await api.kill(session.id);
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? "kill failed");
      return;
    }
    onKilled?.();
    onClose();
  }

  return (
    <Overlay
      id={OVERLAY_IDS.kill}
      onClose={onClose}
      className="modal kill-modal"
      role="dialog"
      ariaLabel="Kill session"
      closable={!busy}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        <header className="modal-head">
          <h2>Kill session</h2>
          <Tooltip label="Close without killing (Escape)">
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

        <div className="modal-bleed kill-body">
          <p className="kill-lead">
            <AgentDot agent={session.agent} />
            <span className="kill-name">{session.name || "(unnamed)"}</span>
          </p>

          <p className="kill-what">
            Terminates the agent process
            {killsMux ? (
              <>
                {" "}
                and closes its terminal session only if this is its sole pane and that can
                be verified. Other panes and windows are preserved
              </>
            ) : null}
            . Task-owned worktrees return automatically once the session stops, if all are clean,
            published to origin, and unused. Otherwise they are kept for Clean up or Worktree
            Settings and removed automatically after {TASK_WORKTREE_RETENTION_DAYS} days
            without a Git-visible change.
          </p>

          {task && (
            <p className="kill-task-warn">
              <strong>{task.title}</strong> will settle as failed, which blocks any task
              waiting on it. If the work is finished, use Complete instead.
            </p>
          )}

          {error && <p className="kill-error">{error}</p>}
        </div>

        <footer className="modal-foot">
          <span className="actions-spacer" />
          <Tooltip label="Leave the agent running">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          </Tooltip>
          {task && onComplete && (
            <Tooltip label="Mark the task done and close the session instead">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  onClose();
                  onComplete();
                }}
                disabled={busy}
              >
                Complete instead
              </button>
            </Tooltip>
          )}
          <Tooltip label="Terminate this agent now">
            <button type="submit" className="btn btn-danger" autoFocus disabled={busy}>
              {busy ? "Killing…" : "Kill"}
            </button>
          </Tooltip>
        </footer>
      </form>
    </Overlay>
  );
}
