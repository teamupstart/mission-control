import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@shared/types.ts";
import { api } from "../lib/api.ts";
import { AgentDot } from "./session-bits.tsx";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { containTourTab } from "../tour/focus-containment.ts";

/**
 * Send a session's task back to the backlog.
 *
 * Kill's sibling, and the answer Kill could not give: an operator who wants this work run
 * LATER had only Kill, which settles the task as failed and leaves it nowhere they could
 * requeue it from. This stops the task and re-files it at the rank it had before dispatch.
 *
 * The dialog exists for the one irreversible part. Re-filing gives the next attempt a fresh
 * checkout, so the current one is reclaimed on the way, uncommitted and unpushed work
 * included - unlike Kill, which keeps it. That is what has to be read before the click.
 */
export function RequeueModal({
  session,
  onRequeued,
  onClose,
}: {
  session: Session;
  /** Fired once the task is back in the backlog, so App can drop the detail it came from. */
  onRequeued?: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const task = session.task;
  const formRef = useRef<HTMLFormElement>(null);

  // A modal confirm keeps Tab inside itself, and hands focus back to what opened it when it
  // closes - unless that is gone, which it is after a landed requeue closes the detail.
  useEffect(() => {
    const previous = document.activeElement;
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  const containTab = useCallback((event: KeyboardEvent) => {
    if (formRef.current) containTourTab(event, formRef.current);
  }, []);

  async function confirm(): Promise<void> {
    if (busy || !task) return;
    setBusy(true);
    setError(null);
    const r = await api.requeueTask(task.id);
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? "could not return the task to the backlog");
      return;
    }
    onRequeued?.();
    onClose();
  }

  return (
    <Overlay
      id={OVERLAY_IDS.requeue}
      onClose={onClose}
      className="modal requeue-modal"
      role="dialog"
      ariaLabel="Return to backlog"
      ariaModal
      onKeyDown={containTab}
      closable={!busy}
    >
      <form
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        <header className="modal-head">
          <h2>Return to backlog</h2>
          <Tooltip label="Close without changing the task (Escape)">
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

        <div className="modal-bleed requeue-body">
          <p className="requeue-lead">
            <AgentDot agent={session.agent} />
            <span className="requeue-name">{session.name || "(unnamed)"}</span>
          </p>

          {task ? (
            <>
              <p className="requeue-what">
                <strong>{task.title}</strong> goes back to the Backlog at the position it had,
                re-enabled and with no outcome, so it can be dispatched again later. The agent
                Mission Control launched for it is stopped; an agent you assigned it to keeps
                running.
              </p>
              <p className="requeue-warn">
                Its checkout is removed. Uncommitted and unpushed work in it is deleted, and
                the next dispatch starts from a fresh checkout.
              </p>
            </>
          ) : (
            <p className="requeue-what">This session has no Mission Control task to return.</p>
          )}

          {error && <p className="requeue-error">{error}</p>}
        </div>

        <footer className="modal-foot">
          <span className="actions-spacer" />
          <Tooltip label="Leave the task where it is">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          </Tooltip>
          <Tooltip label="Stop this task and put it back in the backlog">
            <button
              type="submit"
              className="btn btn-danger"
              autoFocus
              disabled={busy || !task}
            >
              {busy ? "Returning…" : "Return to backlog"}
            </button>
          </Tooltip>
        </footer>
      </form>
    </Overlay>
  );
}
