import { useState } from "react";
import type { Session } from "@shared/types.ts";
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
 * So the dialog's job is to name the consequence and offer the other door. What it must
 * NOT do is take the checkout: `agentWentAway` keeps the worktree, branch and home for a
 * confirmed Clean up precisely so a mis-aimed kill costs nothing that git cannot give
 * back.
 */
export function KillModal({
  session,
  onKilled,
  onComplete,
  onClose,
}: {
  session: Session;
  /** Fired once the kill lands, so App can drop the detail it was ordered from. */
  onKilled?: () => void;
  /** Switch to Complete instead - offered only when there is a task to complete. */
  onComplete?: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What Kill tears down beyond the process: a multiplexer's named session, which an
  // emulator has no equivalent of. The backend names itself, so the sentence is true for
  // whichever one is holding this pane rather than borrowing tmux's wording.
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
      <header className="modal-head">
        <h2>Kill session</h2>
        <Tooltip label="Close without killing (Escape)">
          <button className="icon-btn" aria-label="Close" onClick={onClose} disabled={busy}>
            ✕
          </button>
        </Tooltip>
      </header>

      <div className="kill-body">
        <p className="kill-lead">
          <AgentDot agent={session.agent} />
          <span className="kill-name">{session.name || "(unnamed)"}</span>
        </p>

        <p className="kill-what">
          Terminates the agent process
          {killsMux ? (
            <>
              {" "}
              and kills its {killsMux.backend} session <code>{killsMux.session}</code>
            </>
          ) : null}
          . Its checkout is kept - free it later with Clean up.
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
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </Tooltip>
        {task && onComplete && (
          <Tooltip label="Record an outcome and close the session instead">
            <button
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
          <button className="btn btn-danger" onClick={() => void confirm()} disabled={busy}>
            {busy ? "Killing…" : "Kill"}
          </button>
        </Tooltip>
      </footer>
    </Overlay>
  );
}
