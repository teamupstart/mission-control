import { useState } from "react";
import type { PaneDialog } from "@shared/types.ts";
import { dialogIdentity } from "@shared/session.ts";
import { api } from "../lib/api.ts";

/**
 * The option menu a session's terminal is parked on, rendered as buttons the human can
 * answer from the dashboard.
 *
 * This is the human half of a fix Foreman already got. Prose is not an answer to a menu:
 * text sent at a dialog is SWALLOWED (nothing is focused to receive it) and the trailing
 * Enter confirms whatever row was already highlighted - the incident `pane-dialog.ts`
 * opens with, where a reviewer's option 2 was recorded as option 1 and shipped. Foreman
 * was taught to answer by walking the cursor; the human's only affordance was the reply
 * box, which is that same bug with a person behind it. So: rows, not a text field.
 *
 * Every dialog is offered, not just the ones Foreman declined. Foreman ships off by
 * default and takes tens of seconds when on, so "wait and see if it handles this" is the
 * wrong default for a session that is blocked right now. Racing it is safe by
 * construction rather than by coordination: both paths take the same pane lock, and
 * `selectPaneOption` re-reads the screen and refuses unless the row still reads as the
 * label rendered here. Whoever loses gets a 409 and presses nothing.
 */
export function PaneDialogPrompt({
  sessionId,
  dialog,
}: {
  sessionId: string;
  dialog: PaneDialog;
}): React.JSX.Element {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A 409 says "the screen changed" - and the screen changing is precisely what replaces
  // the question above it. Without this the failure message outlives the menu it was
  // about and renders under a different question with different rows, reporting a
  // failure on an attempt nobody made. Done here rather than by keying at the two call
  // sites so neither can forget it, and on `dialogIdentity` because the dialog is
  // re-parsed from the pane every poll, so object equality would fire on every tick.
  const identity = dialogIdentity(dialog);
  const [shownFor, setShownFor] = useState(identity);
  if (shownFor !== identity) {
    setShownFor(identity);
    setError(null);
  }

  async function choose(option: { number: number; label: string }): Promise<void> {
    if (busy !== null) return;
    setBusy(option.number);
    setError(null);
    // The label goes back exactly as rendered - it is what the daemon re-checks the pane
    // against, so passing anything reconstructed would be checking our own guess.
    const r = await api.selectOption(sessionId, option.number, option.label);
    setBusy(null);
    // No success branch: the menu closes, the next poll clears `paneDialog`, and this
    // whole component unmounts. Nothing to congratulate the human with.
    if (!r.ok) {
      setError(
        r.status === 409
          ? `${r.error ?? "the screen changed"} - nothing was selected`
          : (r.error ?? "could not select that option"),
      );
    }
  }

  return (
    // Stops the click from reaching the card, which would toggle it expanded underneath.
    <section className="pane-dialog" onClick={(e) => e.stopPropagation()}>
      <header className="pd-head">
        <span className="pd-badge">Waiting on you</span>
        <span className="pd-hint dim">answer here or in the terminal</span>
      </header>

      {dialog.prompt && <p className="pd-prompt">{dialog.prompt}</p>}

      <ul className="pd-options">
        {dialog.options.map((o) => (
          <li key={o.number}>
            <button
              type="button"
              // The cursor's row is marked because it is where an Enter in the terminal
              // would land - the human may well have a tab open on this session, and the
              // two views disagreeing about the default is its own small betrayal.
              className={`pd-option${o.number === dialog.highlighted ? " pd-current" : ""}`}
              disabled={busy !== null}
              onClick={() => void choose(o)}
            >
              <span className="pd-num">{o.number}</span>
              <span className="pd-body">
                <span className="pd-label">{o.label}</span>
                {o.detail && <span className="pd-detail">{o.detail}</span>}
              </span>
              {busy === o.number && <span className="pd-spin dim">sending…</span>}
            </button>
          </li>
        ))}
      </ul>

      {error && <p className="pd-error">{error}</p>}
    </section>
  );
}
