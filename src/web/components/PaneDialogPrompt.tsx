import { useState } from "react";
import type { PaneDialog, PaneOption } from "@shared/types.ts";
import { dialogIdentity } from "@shared/session.ts";
import { api } from "../lib/api.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * The option dialog a session's terminal is parked on, rendered for the human to answer
 * from the dashboard.
 *
 * This is the human half of a fix Foreman already got. Prose is not an answer to a menu:
 * text sent at a dialog is SWALLOWED (nothing is focused to receive it) and the trailing
 * Enter confirms whatever row was already highlighted - the incident `pane-dialog.ts`
 * opens with, where a reviewer's option 2 was recorded as option 1 and shipped. Foreman
 * was taught to answer by walking the cursor; the human's only affordance was the reply
 * box, which is that same bug with a person behind it. So: rows, not a text field.
 *
 * Two shapes, because Claude has two. A MENU (a permission prompt, a single-select
 * question, the folder-trust check) is answered by pressing one row, so it renders as
 * buttons that each do exactly that. A FORM - a multi-select `AskUserQuestion` - is not:
 * pressing a row there only ticks its box, and the answers reach Claude only when its
 * Submit tab is confirmed. Rendering a form as buttons is what produced the bug this
 * split fixes - clicking an option looked like answering, sent nothing, and left the
 * same question sitting there - so a form renders as checkboxes with one Submit.
 *
 * Every dialog is offered, not just the ones Foreman declined. Foreman ships off by
 * default and takes tens of seconds when on, so "wait and see if it handles this" is the
 * wrong default for a session that is blocked right now. Racing it is safe by
 * construction rather than by coordination: both paths take the same pane lock, and the
 * daemon re-reads the screen and refuses unless the rows still read as what was rendered
 * here. Whoever loses gets a 409 and presses nothing.
 */
export function PaneDialogPrompt({
  sessionId,
  dialog,
}: {
  sessionId: string;
  dialog: PaneDialog;
}): React.JSX.Element {
  const [busy, setBusy] = useState<number | "form" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // A 409 says "the screen changed" - and the screen changing is precisely what replaces
  // the question above it. Without this the failure message outlives the menu it was
  // about and renders under a different question with different rows, reporting a
  // failure on an attempt nobody made. Done here rather than by keying at the two call
  // sites so neither can forget it, and on `dialogIdentity` because the dialog is
  // re-parsed from the pane every poll, so object equality would fire on every tick.
  const identity = dialogIdentity(dialog);
  const [shownFor, setShownFor] = useState(identity);
  // The human's in-progress ticks, seeded from the boxes the pane is showing. Local until
  // they submit, because a form is answered by its whole state: round-tripping each tick
  // would put a keystroke on the wire for every click and leave a half-filled form on
  // screen between them. Re-seeded only when the QUESTION changes - `dialogIdentity`
  // excludes `checked`, so a box ticked in the terminal meanwhile cannot wipe their edits.
  const [picked, setPicked] = useState<Record<number, boolean>>(() => initialPicks(dialog));
  if (shownFor !== identity) {
    setShownFor(identity);
    setPicked(initialPicks(dialog));
    setError(null);
    setNote(null);
  }

  async function choose(option: PaneOption): Promise<void> {
    if (busy !== null) return;
    setBusy(option.number);
    setError(null);
    setNote(null);
    // The label goes back exactly as rendered - it is what the daemon re-checks the pane
    // against, so passing anything reconstructed would be checking our own guess.
    const r = await api.selectOption(sessionId, option.number, option.label);
    setBusy(null);
    // No success branch: the menu closes, the next poll clears `paneDialog`, and this
    // whole component unmounts. Nothing to congratulate the human with.
    if (!r.ok) setError(failure(r));
  }

  async function submit(): Promise<void> {
    if (busy !== null) return;
    setBusy("form");
    setError(null);
    setNote(null);
    const r = await api.submitOptions(
      sessionId,
      boxes(dialog).map((o) => ({ number: o.number, label: o.label, checked: picked[o.number] ?? false })),
    );
    setBusy(null);
    if (!r.ok) {
      setError(failure(r));
      return;
    }
    // `submitted` needs no message - the form closes and this unmounts. The other two are
    // successes that did NOT send, and saying nothing about them is how a human concludes
    // their answer went through when Claude is still waiting on the rest of it.
    //
    // The daemon's own `note` wins where it has one: it walked the pane and knows where the
    // form was actually left, which the outcome by itself cannot say.
    if (r.outcome === "next-question") setNote(r.note ?? "Saved - Claude has another question below.");
    if (r.outcome === "unanswered") {
      setNote(
        r.note ??
          "Saved, but Claude says a question is still unanswered. The form is back on the question you just answered - if the gap is an earlier one, finish it in the terminal.",
      );
    }
  }

  const checkboxes = boxes(dialog);
  const form = dialog.multiSelect === true && checkboxes.length > 0;

  return (
    // Stops the click from reaching the card, which would toggle it expanded underneath.
    <section className="pane-dialog" onClick={(e) => e.stopPropagation()}>
      <header className="pd-head">
        <span className="pd-badge">Waiting on you</span>
        <span className="pd-hint dim">
          {form ? "pick any number, then submit" : "answer here or in the terminal"}
        </span>
      </header>

      {dialog.prompt && <p className="pd-prompt">{dialog.prompt}</p>}

      <ul className="pd-options">
        {dialog.options.map((o) =>
          form && o.checked !== undefined ? (
            <li key={o.number}>
              <Tooltip label={o.detail ?? `Tick option ${o.number}: ${o.label}`}>
              <button
                type="button"
                role="checkbox"
                aria-checked={picked[o.number] ?? false}
                className={`pd-option pd-check${picked[o.number] ? " pd-checked" : ""}`}
                disabled={busy !== null}
                onClick={() => setPicked((p) => ({ ...p, [o.number]: !p[o.number] }))}
              >
                {/* Numbered like every other row, and like the pane itself. Dropping it
                    here left the form's one unboxed row ("Chat about this") wearing a
                    lone number, which reads as a stray glyph rather than as the position
                    it shares with the terminal. */}
                <span className="pd-num">{o.number}</span>
                <span className="pd-box" aria-hidden="true">
                  {picked[o.number] ? "✔" : ""}
                </span>
                <span className="pd-body">
                  <span className="pd-label">{o.label}</span>
                  {o.detail && <span className="pd-detail">{o.detail}</span>}
                </span>
              </button>
              </Tooltip>
            </li>
          ) : (
            <li key={o.number}>
              <Tooltip label={o.detail ?? `Answer this prompt with option ${o.number}: ${o.label}`}>
              <button
                type="button"
                // The cursor's row is marked because it is where an Enter in the terminal
                // would land - the human may well have a tab open on this session, and the
                // two views disagreeing about the default is its own small betrayal. Not
                // marked on a form, where the cursor is just where the last box was ticked
                // and an Enter there would toggle rather than answer.
                className={`pd-option${!form && o.number === dialog.highlighted ? " pd-current" : ""}`}
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
              </Tooltip>
            </li>
          ),
        )}
      </ul>

      {form && (
        <div className="pd-actions">
          <Tooltip label="Send the ticked options to this session's prompt">
            <button type="button" className="pd-submit" disabled={busy !== null} onClick={() => void submit()}>
              {busy === "form" ? "Submitting…" : "Submit answers"}
            </button>
          </Tooltip>
        </div>
      )}

      {note && <p className="pd-note dim">{note}</p>}
      {error && <p className="pd-error">{error}</p>}
    </section>
  );
}

/** The rows that carry a checkbox - a form's answerable rows, and only those. */
function boxes(dialog: PaneDialog): PaneOption[] {
  return dialog.options.filter((o) => o.checked !== undefined);
}

/** The form's starting ticks: whatever the pane is already showing ticked. */
function initialPicks(dialog: PaneDialog): Record<number, boolean> {
  const picks: Record<number, boolean> = {};
  for (const o of boxes(dialog)) picks[o.number] = o.checked === true;
  return picks;
}

/** Word a refusal, saying plainly that nothing was pressed. */
function failure(r: { status?: number; error?: string }): string {
  return r.status === 409
    ? `${r.error ?? "the screen changed"} - nothing was selected`
    : (r.error ?? "could not select that option");
}
