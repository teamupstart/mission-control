import { useState } from "react";
import type { AssignResetConfirm, Session } from "@shared/types.ts";
import { api } from "../lib/api.ts";
import { AgentDot } from "./session-bits.tsx";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * Confirm handing a backlog task to an agent that is holding something the handover
 * would take.
 *
 * Dropping a card onto an idle agent resets that agent's checkout, and the reset drops
 * its work queue, wipes its context and releases the branch it stands on. None of that
 * is recoverable from origin, and none of it was ever announced - the card's own reset
 * control has a dialog and a loss preview in front of it, and this gesture had neither.
 *
 * The loss is NOT re-derived here. It arrives on the daemon's refusal, so what is listed
 * is what the daemon saw when it decided, and confirming re-POSTs the same assign with
 * the flag set rather than opening a second window in which the queue could move. An
 * agent with nothing to lose is never refused, so it never reaches this dialog.
 *
 * Wears the reset dialog's own classes on purpose: this is the same promise about the
 * same checkout, and two dialogs that mean the same thing should not look different.
 */
export function AssignResetModal({
  session,
  taskId,
  taskTitle,
  confirm,
  onClose,
}: {
  session: Session;
  taskId: string;
  /** The card's title, so the dialog names the task rather than "this task". */
  taskTitle: string | null;
  confirm: AssignResetConfirm;
  onClose: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await api.assignTask(taskId, session.id, true, true);
    setBusy(false);
    // Nothing to retire on the way out: the task moves to running over SSE, which is the
    // same route every other board update arrives by.
    if (r.ok) onClose();
    else setError(r.error ?? "could not hand that to the agent");
  }

  return (
    // `closable` gates the backdrop click and Escape together, as the reset dialog does:
    // an assign already in flight must not be abandoned by either route.
    <Overlay
      id={OVERLAY_IDS.assignReset}
      onClose={onClose}
      className="modal reset-modal"
      role="dialog"
      ariaLabel="Confirm handing this task to a running agent"
      closable={!busy}
    >
      <header className="modal-head">
        <h2>Hand this task over?</h2>
        <Tooltip label="Close without handing the task over (Escape)">
          <button className="icon-btn" aria-label="Close" onClick={onClose} disabled={busy}>
            ✕
          </button>
        </Tooltip>
      </header>

      <div className="modal-bleed reset-body">
        <p className="reset-lead">
          <AgentDot agent={session.agent} />
          <span className="reset-name">{session.name || "(unnamed)"}</span>
        </p>

        <p className="reset-warn-title">
          Starting <strong>{taskTitle || "this task"}</strong> here resets the checkout
          first, which <strong>cannot be undone</strong>:
        </p>
        <ul className="reset-loss">
          {confirm.queuedItems > 0 && (
            <li>
              <strong>{confirm.queuedItems}</strong> queued work item
              {confirm.queuedItems === 1 ? "" : "s"} on this agent
            </li>
          )}
          {confirm.branch && (
            <li>
              the branch <code>{confirm.branch}</code> is released (the checkout ends up
              detached)
            </li>
          )}
          {confirm.clearsContext && (
            <li>
              the agent's conversation (<code>/clear</code>)
            </li>
          )}
        </ul>
        <p className="reset-then">
          Committed work origin already has is safe - the assign is refused outright when
          the checkout holds anything else.
        </p>
        {error && <p className="reset-error">{error}</p>}
      </div>

      <footer className="modal-foot">
        <span className="actions-spacer" />
        <Tooltip label="Leave this agent on what it is doing">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </Tooltip>
        <Tooltip label="Reset this agent's checkout and give it this task instead">
          <button className="btn btn-danger" onClick={() => void go()} disabled={busy}>
            {busy ? "Handing over…" : "Reset & hand over"}
          </button>
        </Tooltip>
      </footer>
    </Overlay>
  );
}
