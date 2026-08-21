import { Fragment, useEffect, useRef, useState } from "react";
import { paneDialogAnchorId } from "../lib/pane-dialog-anchor.ts";
import type { PaneDialog, PaneOption, SessionNoteSummary } from "@shared/types.ts";
import { dialogIdentity } from "@shared/session.ts";
import { api } from "../lib/api.ts";
import {
  foremanNoteForDialog,
  recommendedChoiceKeys,
  type RecommendationChoice,
} from "../lib/foreman-review.ts";
import {
  ForemanPickMark,
  ForemanRecommendationButton,
  ForemanRecommendationSidecar,
} from "./ForemanRecommendation.tsx";
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
  note: sessionNote,
}: {
  sessionId: string;
  dialog: PaneDialog;
  /** Foreman's note, integrated only when its marker names this exact dialog. */
  note?: SessionNoteSummary | null;
}): React.JSX.Element {
  const [busy, setBusy] = useState<number | "form" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [foremanOpen, setForemanOpen] = useState(false);
  const foremanTriggerRef = useRef<HTMLButtonElement>(null);

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
    setTyped("");
    setForemanOpen(false);
  }

  const foremanNote = foremanNoteForDialog(dialog, sessionNote);
  const recommendationChoices = choicesForDialog(dialog);
  const recommendedKeys = recommendedChoiceKeys(
    foremanNote?.recommendation,
    recommendationChoices,
  );
  const foremanPicks = recommendationChoices.filter((choice) => recommendedKeys.has(choice.key));
  const foremanAvailable = Boolean(
    foremanNote && (foremanNote.recommendation?.trim() || foremanNote.brief?.trim()),
  );

  // A note can retire over SSE without the dialog changing identity. Close immediately so
  // optional context for a finished note never remains over the still-refreshing form.
  useEffect(() => {
    if (!foremanAvailable) setForemanOpen(false);
  }, [foremanAvailable]);

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

  async function submitDriverText(question: string): Promise<void> {
    const text = typed.trim();
    if (busy !== null || !text) return;
    setBusy("form");
    setError(null);
    setNote(null);
    const r = await api.submitAnswers(sessionId, [{ question, labels: [], text }]);
    setBusy(null);
    if (!r.ok) setError(failure(r));
  }

  const checkboxes = boxes(dialog);
  const form = dialog.multiSelect === true && checkboxes.length > 0;
  const driverQuestion =
    dialog.source === "driver" && dialog.questions?.length === 1 && !dialog.multiSelect
      ? dialog.questions[0]
      : null;

  // A DRIVER form is a third shape, and it needs its own render for the same reason it
  // needs its own wire body: its rows live on its questions, each numbering from 1, so
  // there is no single numbered list to draw. Drawn here rather than in a component of its
  // own so the two forms share this file's refusal handling, its identity-keyed reset and
  // its "nothing was sent" wording - the parts a human reads when something goes wrong.
  if (dialog.questions && dialog.questions.length > 0 && dialog.multiSelect) {
    return (
      <DriverForm
        key={identity}
        sessionId={sessionId}
        dialog={dialog}
        questions={dialog.questions}
        busy={busy}
        setBusy={setBusy}
        error={error}
        setError={setError}
        foremanNote={foremanAvailable ? foremanNote : null}
        foremanOpen={foremanOpen}
        setForemanOpen={setForemanOpen}
        foremanTriggerRef={foremanTriggerRef}
        recommendedKeys={recommendedKeys}
        foremanPicks={foremanPicks}
      />
    );
  }

  return (
    <Fragment>
      {/* Stops the click from reaching the card, which would toggle it expanded underneath. */}
      <section
        className="pane-dialog"
        id={paneDialogAnchorId(sessionId)}
        // Focusable only as a jump target - "Go to review" on a held queued message lands
        // here. Out of the tab order, so answering by keyboard still starts at the options.
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
      <header className="pd-head">
        <span className="pd-badge">Waiting on you</span>
        <span className="pd-hint dim">
          {form ? "pick any number, then submit" : "answer here or in the terminal"}
        </span>
        {foremanAvailable && (
          <ForemanRecommendationButton
            open={foremanOpen}
            onToggle={() => setForemanOpen((open) => !open)}
            buttonRef={foremanTriggerRef}
          />
        )}
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
                className={`pd-option pd-check${picked[o.number] ? " pd-checked" : ""}${
                  recommendedKeys.has(paneChoiceKey(o)) ? " pd-foreman-pick" : ""
                }`}
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
                {recommendedKeys.has(paneChoiceKey(o)) && <ForemanPickMark />}
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
                className={`pd-option${!form && o.number === dialog.highlighted ? " pd-current" : ""}${
                  recommendedKeys.has(paneChoiceKey(o)) ? " pd-foreman-pick" : ""
                }`}
                disabled={busy !== null}
                onClick={() => void choose(o)}
              >
                <span className="pd-num">{o.number}</span>
                <span className="pd-body">
                  <span className="pd-label">{o.label}</span>
                  {o.detail && <span className="pd-detail">{o.detail}</span>}
                </span>
                {recommendedKeys.has(paneChoiceKey(o)) && <ForemanPickMark />}
                {busy === o.number && <span className="pd-spin dim">sending…</span>}
              </button>
              </Tooltip>
            </li>
          ),
        )}
      </ul>

      {driverQuestion && (
        <form
          className="pd-question"
          onSubmit={(event) => {
            event.preventDefault();
            void submitDriverText(driverQuestion.question);
          }}
        >
          <input
            className="pd-text-answer"
            type="text"
            value={typed}
            disabled={busy !== null}
            aria-label={`Custom answer for ${driverQuestion.question}`}
            placeholder="Or type a custom answer"
            onChange={(event) => setTyped(event.target.value)}
          />
          <div className="pd-actions">
            <Tooltip label="Send this custom answer back to the agent">
              <button
                type="submit"
                className="pd-submit"
                disabled={busy !== null || !typed.trim()}
              >
                {busy === "form" ? "Submitting…" : "Submit custom answer"}
              </button>
            </Tooltip>
          </div>
        </form>
      )}

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
      {foremanOpen && foremanAvailable && foremanNote && (
        <ForemanRecommendationSidecar
          note={foremanNote}
          picks={foremanPicks}
          onClose={() => setForemanOpen(false)}
          returnFocusRef={foremanTriggerRef}
        />
      )}
    </Fragment>
  );
}

/**
 * A driver's multi-question form: every question at once, each with its own rows.
 *
 * The whole shape the pane could never show. Claude's `AskUserQuestion` carries up to four
 * questions in one call, and the TUI renders them as tabs - so the parser only ever saw
 * one, the human answered it, and the walk stepped `→` hoping to find either the next
 * question or a Submit tab. Here all of them are on screen, single-select questions render
 * as radios and multi-select ones as checkboxes, and one Submit sends the whole map. The
 * "you have not answered all questions" banner has no equivalent because the button is
 * simply disabled until every question has an answer.
 */
function DriverForm({
  sessionId,
  dialog,
  questions,
  busy,
  setBusy,
  error,
  setError,
  foremanNote,
  foremanOpen,
  setForemanOpen,
  foremanTriggerRef,
  recommendedKeys,
  foremanPicks,
}: {
  sessionId: string;
  dialog: PaneDialog;
  questions: NonNullable<PaneDialog["questions"]>;
  busy: number | "form" | null;
  setBusy: (b: number | "form" | null) => void;
  error: string | null;
  setError: (e: string | null) => void;
  foremanNote: SessionNoteSummary | null;
  foremanOpen: boolean;
  setForemanOpen: React.Dispatch<React.SetStateAction<boolean>>;
  foremanTriggerRef: React.RefObject<HTMLButtonElement | null>;
  recommendedKeys: ReadonlySet<string>;
  foremanPicks: RecommendationChoice[];
}): React.JSX.Element {
  // Per question, the labels chosen. A single-select question holds at most one, which is
  // enforced where the row is clicked rather than at submit - the human should never be
  // able to build a state the daemon will refuse.
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});

  /**
   * Pick (or unpick) a row, and drop whatever was typed for that question.
   *
   * The two are EITHER/OR, and the exclusion is enforced here rather than at submit for
   * the reason the comment above states: the human should never be able to build a state
   * the daemon will refuse. The harness takes one string per question, so a submission
   * carrying both could only send one of them - and whichever it chose, the other is
   * something the operator did that the agent never hears about. Clearing as they go makes
   * the screen say which one is live, instead of a refusal telling them afterwards.
   */
  function toggle(question: string, label: string, multi: boolean): void {
    setTyped((t) => (t[question] ? { ...t, [question]: "" } : t));
    setPicked((p) => {
      const cur = p[question] ?? [];
      if (!multi) return { ...p, [question]: cur[0] === label ? [] : [label] };
      return {
        ...p,
        [question]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label],
      };
    });
  }

  /** Type a custom answer, which likewise gives up any rows chosen for that question. */
  function type(question: string, value: string): void {
    setTyped((t) => ({ ...t, [question]: value }));
    if (value.trim()) setPicked((p) => (p[question]?.length ? { ...p, [question]: [] } : p));
  }

  const complete = questions.every(
    (q) => (picked[q.question] ?? []).length > 0 || Boolean(typed[q.question]?.trim()),
  );

  async function submit(): Promise<void> {
    if (busy !== null || !complete) return;
    setBusy("form");
    setError(null);
    const r = await api.submitAnswers(
      sessionId,
      questions.map((q) => ({
        question: q.question,
        labels: picked[q.question] ?? [],
        ...(typed[q.question]?.trim() ? { text: typed[q.question]!.trim() } : {}),
      })),
    );
    setBusy(null);
    // No success branch, as above: answering resolves the tool call, the request clears,
    // and this whole component unmounts on the next frame.
    if (!r.ok) setError(failure(r));
  }

  return (
    <Fragment>
      <section
        className="pane-dialog"
        id={paneDialogAnchorId(sessionId)}
        // Focusable only as a jump target - "Go to review" on a held queued message lands
        // here. Out of the tab order, so answering by keyboard still starts at the options.
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
      <header className="pd-head">
        <span className="pd-badge">Waiting on you</span>
        <span className="pd-hint dim">answer each, then submit</span>
        {foremanNote && (
          <ForemanRecommendationButton
            open={foremanOpen}
            onToggle={() => setForemanOpen((open) => !open)}
            buttonRef={foremanTriggerRef}
          />
        )}
      </header>

      {dialog.prompt && questions.length > 1 && <p className="pd-prompt">{dialog.prompt}</p>}

      {questions.map((q) => (
        <div className="pd-question" key={q.question}>
          <p className="pd-question-text">
            {q.header && <span className="pd-question-tag">{q.header}</span>}
            {q.question}
          </p>
          <ul className="pd-options">
            {q.options.map((o) => {
              const on = (picked[q.question] ?? []).includes(o.label);
              return (
                <li key={o.number}>
                  <Tooltip label={o.detail ?? `Choose ${o.label}`}>
                    <button
                      type="button"
                      role={q.multiSelect ? "checkbox" : "radio"}
                      aria-checked={on}
                      className={`pd-option pd-check${on ? " pd-checked" : ""}${
                        recommendedKeys.has(driverChoiceKey(q.question, o))
                          ? " pd-foreman-pick"
                          : ""
                      }`}
                      disabled={busy !== null}
                      onClick={() => toggle(q.question, o.label, q.multiSelect === true)}
                    >
                      <span className="pd-num">{o.number}</span>
                      <span className="pd-box" aria-hidden="true">
                        {on ? "✔" : ""}
                      </span>
                      <span className="pd-body">
                        <span className="pd-label">{o.label}</span>
                        {o.detail && <span className="pd-detail">{o.detail}</span>}
                      </span>
                      {recommendedKeys.has(driverChoiceKey(q.question, o)) && <ForemanPickMark />}
                    </button>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
          <input
            className="pd-text-answer"
            type="text"
            value={typed[q.question] ?? ""}
            disabled={busy !== null}
            aria-label={`Custom answer for ${q.question}`}
            placeholder="Or type a custom answer"
            onChange={(event) => type(q.question, event.target.value)}
          />
        </div>
      ))}

      <div className="pd-actions">
        <Tooltip
          label={
            complete
              ? "Send these answers back to the agent"
              : "Every question needs an answer before this can be sent"
          }
        >
          <button
            type="button"
            className="pd-submit"
            disabled={busy !== null || !complete}
            onClick={() => void submit()}
          >
            {busy === "form" ? "Submitting…" : "Submit answers"}
          </button>
        </Tooltip>
      </div>

      {error && <p className="pd-error">{error}</p>}
      </section>
      {foremanOpen && foremanNote && (
        <ForemanRecommendationSidecar
          note={foremanNote}
          picks={foremanPicks}
          onClose={() => setForemanOpen(false)}
          returnFocusRef={foremanTriggerRef}
        />
      )}
    </Fragment>
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

function paneChoiceKey(option: PaneOption): string {
  return `pane:${option.number}:${option.label}`;
}

function driverChoiceKey(question: string, option: PaneOption): string {
  return `driver:${question}:${option.number}:${option.label}`;
}

/** Flatten both dialog shapes for recommendation matching and sidecar rendering. */
function choicesForDialog(dialog: PaneDialog): RecommendationChoice[] {
  if (dialog.questions?.length) {
    return dialog.questions.flatMap((question) =>
      question.options.map((option) => ({
        key: driverChoiceKey(question.question, option),
        label: option.label,
        detail: option.detail,
        // Multi-question forms repeat numbers per question, so the numbered fallback is
        // deliberately disabled here. The group carries which question this row belongs to,
        // because labels repeat across questions too - two yes/no questions being the plain
        // case - and a label offered by more than one of them is not attributable from prose.
        group: question.question,
      })),
    );
  }
  return dialog.options.map((option) => ({
    key: paneChoiceKey(option),
    label: option.label,
    detail: option.detail,
    number: option.number,
  }));
}

/** Word a refusal, saying plainly that nothing was pressed. */
function failure(r: { status?: number; error?: string }): string {
  return r.status === 409
    ? `${r.error ?? "the screen changed"} - nothing was selected`
    : (r.error ?? "could not select that option");
}
