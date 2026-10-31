import { useState } from "react";
import type { PlanDecision, PlanDecisionAnswer } from "@shared/types.ts";
import { formatResponse } from "@shared/review-item.ts";
import { isAnswered } from "../lib/reviews.ts";
import { ForemanPickMark } from "./ForemanRecommendation.tsx";
import { Tooltip } from "./Tooltip.tsx";

/** Per-decision answer state: chosen option ids, any free-text "Other", and any note. */
type Answer = { selected: string[]; other: string; note: string };
type Answers = Record<string, Answer>;

const EMPTY: Answer = { selected: [], other: "", note: "" };

/** Stable inside one review form, shared with its Foreman recommendation matcher. */
export function decisionChoiceKey(decisionId: string, optionId: string): string {
  return `${decisionId}:${optionId}`;
}

/**
 * The form's state as the wire shape, in the order the questions were asked.
 *
 * One conversion at the edge rather than holding `PlanDecisionAnswer[]` throughout: the
 * form indexes by decision id on every keystroke, which a map does well and an array does
 * not. Every decision is emitted, answered or not - an unanswered one is a real fact about
 * a submission, and dropping it would make a form that could not have been submitted look
 * like one that never asked. Blank "Other" text normalizes to null and a blank note is
 * omitted, so "typed nothing" and "typed and cleared it" are the same record.
 */
function toDecisionAnswers(decisions: PlanDecision[], answers: Answers): PlanDecisionAnswer[] {
  return decisions.map((d) => {
    const a = answers[d.id];
    return {
      decisionId: d.id,
      selected: a?.selected ?? [],
      other: a?.other.trim() ? a.other.trim() : null,
      // Present only when typed, so an answer without one keeps the shape it always had.
      ...(a?.note.trim() ? { note: a.note.trim() } : {}),
    };
  });
}

/**
 * Renders each decision as a radio group (choose one) or checkbox group (choose many),
 * with an optional free-text "Other". Its Submit hands up both the formatted response the
 * agent will read and the structured selections behind it, so the caller can resolve the
 * review with `action: "answer"` and the conversation can later replay the form. When
 * `onDismiss` is supplied, Dismiss resolves the whole request without submitting any
 * selections.
 */
export function DecisionForm({
  decisions,
  busy,
  onSubmit,
  onDismiss,
  /** Opening line of the response the agent receives - see `formatResponse`. */
  lead = "Plan decisions submitted:",
  /**
   * Drop the visible `<legend>`, because the caller already displays the question.
   *
   * For an `input` review the question is already above the form - as the review's title,
   * and in full as the body paragraph when the title had to be clipped - so a legend beneath
   * it says the same sentence a third time. The text still reaches assistive tech as the
   * fieldset's `aria-label` - the group needs a name whether or not one is drawn. A
   * `plan-decisions` form has several questions under one plan title and always shows them.
   */
  hideQuestions = false,
  /**
   * Namespace for the radio/checkbox `name` attributes this form emits.
   *
   * A group `name` is DOCUMENT-scoped, not component-scoped, and `ReviewModal` renders every
   * pending review of a session into one document. `request_input` hardcodes its decision id
   * as `q`, so two option-carrying `input` reviews - an abandoned ask still pending while the
   * agent asks again - would put two radio groups on screen under the same name. The browser
   * then treats them as ONE group: clicking in the second unchecks the first in the DOM,
   * while React re-renders only the card whose state changed, so the first card shows nothing
   * selected even though its state still holds a selection and its Submit stays enabled.
   *
   * Defaulted rather than required because a form rendered on its own cannot collide, and
   * because the decision id itself must stay untouched - it is echoed in the response payload.
   */
  namePrefix = "d",
  /**
   * Draw an optional note box under every decision, so the human can pick an option AND send
   * instructions with it. Off by default: a form whose resolution never reaches an agent as
   * prose - the product-issue confirmation, which acts on the selection alone - must not
   * offer a box whose text would go nowhere.
   */
  allowNote = false,
  foremanRecommended,
  besideSubmit,
}: {
  decisions: PlanDecision[];
  busy: boolean;
  /**
   * `response` is the agent's tool result, `selections` the record kept beside it. Handed
   * up together, from one derivation, so the two can never describe different answers.
   */
  onSubmit: (response: string, selections: PlanDecisionAnswer[]) => void;
  /** Resolve this decision request without sending any of its options as an answer. */
  onDismiss?: () => void;
  lead?: string;
  hideQuestions?: boolean;
  namePrefix?: string;
  allowNote?: boolean;
  /**
   * Exact decision-option keys Foreman's prose names.
   *
   * The mark is deliberately NOT gated on the sidecar being open: the pick is legible at a
   * glance, and the sidecar is opened only for the reasoning behind it. Empty unless a live
   * Foreman note names this exact form, so an unmatched recommendation marks nothing.
   */
  foremanRecommended?: ReadonlySet<string>;
  /** A control drawn next to Submit, such as the final-bundle form's standing approval. */
  besideSubmit?: React.ReactNode;
}): React.JSX.Element {
  const [answers, setAnswers] = useState<Answers>({});

  function get(id: string): Answer {
    return answers[id] ?? EMPTY;
  }

  function choose(d: PlanDecision, optionId: string, checked: boolean): void {
    setAnswers((prev) => {
      const cur = prev[d.id] ?? EMPTY;
      let selected: string[];
      if (d.multiSelect) {
        selected = checked
          ? [...cur.selected, optionId]
          : cur.selected.filter((x) => x !== optionId);
      } else {
        selected = [optionId]; // radio: single choice replaces
      }
      return { ...prev, [d.id]: { ...cur, selected } };
    });
  }

  function setText(id: string, field: "other" | "note", text: string): void {
    setAnswers((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? EMPTY), [field]: text },
    }));
  }

  // Built once per render and used for both the completeness test and the submit, so the
  // button's enabled state is decided over exactly the payload it would send.
  const payload = toDecisionAnswers(decisions, answers);
  const complete = decisions.length > 0 && decisions.every((d, i) => isAnswered(d, payload[i]));

  return (
    <div className="decisions">
      {decisions.map((d) => (
        <fieldset
          key={d.id}
          className="decision"
          aria-label={hideQuestions ? d.question : undefined}
        >
          {!hideQuestions && <legend className="decision-q">{d.question}</legend>}
          {d.options.map((o) => {
            const foremanPick = foremanRecommended?.has(decisionChoiceKey(d.id, o.id));
            return (
            <label
              key={o.id}
              className={`decision-option${foremanPick ? " decision-foreman-pick" : ""}`}
            >
              <Tooltip label={o.detail ?? o.label}>
                <input
                  type={d.multiSelect ? "checkbox" : "radio"}
                  name={`${namePrefix}-${d.id}`}
                  checked={get(d.id).selected.includes(o.id)}
                  onChange={(e) => choose(d, o.id, e.target.checked)}
                  disabled={busy}
                />
              </Tooltip>
              <span className="decision-option-body">
                <span className="decision-option-label">
                  {o.label}
                  {o.recommended && <span className="decision-rec"> · recommended</span>}
                </span>
                {o.detail && <span className="decision-option-detail">{o.detail}</span>}
              </span>
              {foremanPick && <ForemanPickMark />}
            </label>
            );
          })}
          {d.allowOther && (
            <input
              className="decision-other"
              placeholder="Other…"
              value={get(d.id).other}
              onChange={(e) => setText(d.id, "other", e.target.value)}
              disabled={busy}
            />
          )}
          {allowNote && (
            <textarea
              className="decision-note"
              aria-label={`Note to the agent: ${d.question}`}
              placeholder="Optional note to the agent…"
              rows={3}
              value={get(d.id).note}
              onChange={(e) => setText(d.id, "note", e.target.value)}
              disabled={busy}
            />
          )}
        </fieldset>
      ))}
      <div className="decisions-actions">
        {onDismiss && (
          <Tooltip label="Dismiss this decision request without sending an answer">
            <button className="btn btn-ghost" disabled={busy} onClick={onDismiss}>
              Dismiss
            </button>
          </Tooltip>
        )}
        {besideSubmit}
        <Tooltip
          label={complete ? "Send these decisions back to the agent" : "Answer every decision above first"}
        >
          <button
            className="btn btn-approve"
            disabled={busy || !complete}
            onClick={() => onSubmit(formatResponse(decisions, payload, lead), payload)}
          >
            Submit
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
