import { useEffect, useId, useRef } from "react";
import {
  GUIDED_STEPS,
  type GuidedPass,
  type GuidedStep,
  type GuidedStepId,
} from "../lib/guided-dispatch-steps.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * What the guided dispatch pass DRAWS: the strip of answers under the modal header, the
 * floating list over the field being asked about, and the header toggle that turns the
 * whole thing on and off.
 *
 * Presentation only. `DispatchModal` owns the pass state, builds the options out of the
 * app's registries, and handles the keys - which is what keeps the pass a phase of the
 * dispatch form rather than a second form: every option here commits through the same
 * `update(...)` the field's own `<select>` calls.
 *
 * These are not a portal. `RepoCombobox` portals because it has to escape a scrollable
 * ancestor; nothing between a picker and the modal's edge scrolls (`.dispatch-body` carries
 * no `overflow` of its own, unlike the generic `.modal-body`), so `overflow: visible` scoped
 * to `.dispatch-modal` is the whole fix and a portal would only buy positioning maths and a
 * lifecycle. See the note beside that override in `styles.css`.
 */

export interface GuidedOption {
  /** The value this option writes - the same string the field's own control carries. */
  value: string;
  /** The option's text. */
  label: string;
  /** What the answered rung shows, when the option's own text is a whole sentence. */
  short?: string;
  /** One line under the label saying what choosing it means. */
  sub?: string | null;
  /**
   * The harness accent, painted as the dot the rest of the app paints it as.
   *
   * There is deliberately no right-aligned `note` column beside these, though the mockup had
   * one. The two things it would have carried are already where they belong: a harness's
   * defaults read better as the second line (`sub`) than as a cramped mono column, and a
   * workflow's version stays inside `label` because that is what makes this list's copy
   * byte-identical to the `<select>`'s - which is a property worth more than the column.
   */
  accent?: string | null;
  /**
   * The letter that takes this option, or null when every letter in its text was already
   * spoken for. A null still prints - as the option's position digit, which always works.
   */
  hotkey: string | null;
  /**
   * Take it. Runs the same `update(...)` the field's own control runs, so the pass has no
   * opinion about what a choice MEANS that the form does not already have.
   */
  commit: () => void;
  /** Optional kind-owned move when later questions do not apply to this launch owner. */
  advance?: (pass: GuidedPass) => GuidedPass;
}

/** What an answered rung reads. */
export interface GuidedAnswer {
  text: string;
  accent?: string | null;
}

/**
 * The strip: one rung per question, under the header, for as long as the pass is running.
 *
 * A breadcrumb, and marked up as one - an ordered list inside a landmark - because that is
 * what it is: a sequence you are part-way through and can step back into. Answered rungs are
 * buttons that reopen their question; the one being asked and the ones still to come are not,
 * which is what stops the strip being a way to skip ahead past a question.
 *
 * It is removed entirely when the pass ends, so the form the operator finishes in has its
 * ordinary shape rather than a spent wizard's chrome above it.
 */
export function GuidedRail({
  pass,
  answers,
  onJump,
}: {
  pass: GuidedPass;
  answers: Partial<Record<GuidedStepId, GuidedAnswer>>;
  onJump: (id: GuidedStepId) => void;
}): React.JSX.Element {
  const done = pass.answered.length;
  return (
    <nav className="dispatch-guided-rail" aria-label="Guided dispatch">
      <ol className="dispatch-guided-rungs">
        {GUIDED_STEPS.map((step, index) => {
          const answered = pass.answered.includes(step.id);
          const answer = answers[step.id];
          const active = pass.active === step.id;
          return (
            <li className="dispatch-guided-slot" key={step.id}>
              {index > 0 && (
                <span className="dispatch-guided-tick" aria-hidden>
                  ›
                </span>
              )}
              {answered && answer ? (
                <Tooltip label={`Go back and change ${step.name.toLowerCase()}`}>
                  <button
                    type="button"
                    className="dispatch-guided-rung is-done"
                    // The step is NAMED here even though the rung shows only its value,
                    // because "ship" on its own says nothing about which question it
                    // answered - and this label is what a screen reader reads and what the
                    // browser tests select by.
                    aria-label={`${step.name}: ${answer.text}`}
                    onClick={() => onJump(step.id)}
                  >
                    <span className="dispatch-guided-num" aria-hidden>
                      ✓
                    </span>
                    <span className="dispatch-guided-value">
                      {answer.accent && (
                        // The app's one accent dot, off the inline custom property every
                        // other surface sets - never a rule of its own, per `agent-accent`.
                        <span
                          className="agent-dot"
                          style={{ ["--agent-accent" as string]: answer.accent }}
                          aria-hidden
                        />
                      )}
                      {/* The text in an element of its own so it can ellipsize. Its parent is
                          a flex box (it has to be, for the dot), and `text-overflow` does
                          nothing to a flex container's own children - the string would be cut
                          mid-letter with no ellipsis and no cap. This is the only text on the
                          strip the OPERATOR chose, and so the only one that can be any length:
                          a repo's name, a workflow's. See the width cap beside it in the CSS. */}
                      <span className="dispatch-guided-answer">{answer.text}</span>
                    </span>
                  </button>
                </Tooltip>
              ) : (
                <span
                  className={`dispatch-guided-rung${active ? " is-active" : ""}`}
                  aria-current={active ? "step" : undefined}
                >
                  <span className="dispatch-guided-num" aria-hidden>
                    {index + 1}
                  </span>
                  <span>{step.name}</span>
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {/* The exits, printed rather than remembered. They are why a pass costs nothing to be
          wrong about: one key and you are in the form you would have had anyway. */}
      <span className="dispatch-guided-out">
        <kbd>⇥</kbd> / <kbd>esc</kbd> use the form
      </span>
      {/* How far through, as a hairline rather than a row of its own - it leaves with the
          strip, so the finished modal is the ordinary one. */}
      <span className="dispatch-guided-progress" aria-hidden>
        <i style={{ width: `${(done / GUIDED_STEPS.length) * 100}%` }} />
      </span>
    </nav>
  );
}

/**
 * The question, floating under the control it is about.
 *
 * Drawn to the geometry the app's own `::picker(select)` already paints an open dropdown
 * with - 4px below the field, 8px radius, `--bg-2`, the shared shadow - so it reads as that
 * select having been opened rather than as a new kind of surface.
 *
 * `role="listbox"` with the STEP'S QUESTION as its accessible name, fixed even when the
 * visible line says something more specific ("A scout has no diff, so None is preselected"):
 * a name that changed with the state would make every spec assert which branch it caught.
 * The list takes focus so `aria-activedescendant` has somewhere to live and so no text field
 * is holding the caret while the pass owns the keyboard.
 */
export function GuidedPicker({
  step,
  options,
  highlight,
  hint,
  optionTip,
  canGoBack,
  place = "below",
  onPick,
}: {
  step: GuidedStep;
  options: readonly GuidedOption[];
  highlight: number;
  /** Replaces the question on screen when this step has something more specific to say. */
  hint?: string | null;
  /** What hovering any option describes: the field's own tooltip, so the two cannot drift. */
  optionTip: string;
  /** Whether ⌫ has a step to go back to, which is what the footer hint prints. */
  canGoBack: boolean;
  /**
   * Which way the list opens. Stated by the caller rather than measured, because there is
   * nothing to measure: the fields sit at fixed heights in a fixed-width dialog, and the one
   * question whose control is near the foot - After work - has the whole dimmed brief above
   * it and the footer below. A measured flip would be a scroll-position reader for a panel
   * that does not scroll.
   */
  place?: "below" | "above";
  onPick: (index: number) => void;
}): React.JSX.Element {
  const base = useId();
  const listRef = useRef<HTMLDivElement>(null);
  // Focus follows the question. `preventScroll`, because the modal is already fully on
  // screen and the browser's own scroll-into-view would nudge a dialog that is not moving.
  useEffect(() => {
    listRef.current?.focus({ preventScroll: true });
  }, [step.id]);

  return (
    <div className={`dispatch-guided-picker${place === "above" ? " is-above" : ""}`}>
      <span className="dispatch-guided-question">
        {hint ?? step.question}
        <span className="dispatch-guided-keys">
          <kbd>↑↓</kbd>
          <kbd>↵</kbd>
          {canGoBack ? <kbd>⌫</kbd> : <kbd>⇥</kbd>}
        </span>
      </span>
      <div
        className="dispatch-guided-list"
        role="listbox"
        aria-label={step.question}
        tabIndex={-1}
        aria-activedescendant={options[highlight] ? `${base}-${highlight}` : undefined}
        ref={listRef}
      >
        {options.map((option, index) => (
          <Tooltip key={option.value} label={optionTip}>
            <button
              type="button"
              role="option"
              id={`${base}-${index}`}
              aria-selected={index === highlight}
              className={`dispatch-guided-option${index === highlight ? " is-on" : ""}`}
              onClick={() => onPick(index)}
            >
              <span className="dispatch-guided-cap" aria-hidden>
                {option.hotkey ?? index + 1}
              </span>
              <span className="dispatch-guided-label">
                {option.accent && (
                  <span
                    className="agent-dot"
                    style={{ ["--agent-accent" as string]: option.accent }}
                    aria-hidden
                  />
                )}
                {option.label}
              </span>
              {option.sub && <span className="dispatch-guided-sub">{option.sub}</span>}
            </button>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}

/**
 * The preference, on the modal's own header.
 *
 * Present whether or not a pass is running, and in both directions: it is how the pass is
 * discovered and turned on in the first place, and it is how an operator who wants today's
 * form back gets it mid-dispatch without going looking for Settings. Turning it on starts a
 * pass right there rather than arming one for the next opening, because a switch that
 * appears to do nothing is a switch nobody flips twice.
 */
export function GuidedToggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
}): React.JSX.Element {
  return (
    <Tooltip
      label={
        on
          ? "Stop asking, and open the dispatch form directly"
          : "Ask for kind, harness and after work first, then hand over the form"
      }
    >
      <button
        type="button"
        role="switch"
        aria-checked={on}
        className={`dispatch-guided-toggle${on ? " is-on" : ""}`}
        onClick={() => onChange(!on)}
      >
        <span className="dispatch-guided-switch" aria-hidden />
        Guided
      </button>
    </Tooltip>
  );
}
