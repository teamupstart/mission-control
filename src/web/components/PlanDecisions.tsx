import { useState } from "react";
import type { PlanDecision } from "@shared/types.ts";

/** Per-decision answer state: chosen option ids plus any free-text "Other". */
type Answers = Record<string, { selected: string[]; other: string }>;

/**
 * A decision is answered once it has a selected option, or free text when the
 * decision allows it. Submit stays disabled until every decision clears this bar,
 * and an empty decision set is "nothing to submit" rather than vacuously complete,
 * so the agent never unblocks on a half-filled or content-free form.
 */
function isAnswered(d: PlanDecision, a: { selected: string[]; other: string } | undefined): boolean {
  if (!a) return false;
  if (a.selected.length > 0) return true;
  return Boolean(d.allowOther && a.other.trim());
}

/**
 * Format the selections into the response string the agent receives verbatim as its
 * tool result. Deterministic and human-legible (it also shows in the transcript), one
 * block per question with the chosen labels and any free-text note.
 *
 * `lead` names what was answered, because this form now serves two askers: a
 * `plan-decisions` review resolving several choices about a plan, and an `input` review
 * where `request_input` asked one question with options - the replacement for Claude's
 * built-in `AskUserQuestion`. Telling the second one "Plan decisions submitted" would hand
 * the agent a plan it never wrote.
 */
function formatResponse(decisions: PlanDecision[], answers: Answers, lead: string): string {
  const blocks = decisions.map((d) => {
    const a = answers[d.id] ?? { selected: [], other: "" };
    const labels = d.options.filter((o) => a.selected.includes(o.id)).map((o) => o.label);
    const lines = [`• ${d.question}`];
    if (labels.length) lines.push(`  → ${labels.join(", ")}`);
    if (d.allowOther && a.other.trim()) lines.push(`  Other: ${a.other.trim()}`);
    if (!labels.length && !(d.allowOther && a.other.trim())) lines.push("  → (no selection)");
    return lines.join("\n");
  });
  return `${lead}\n\n${blocks.join("\n\n")}`;
}

/**
 * Renders each decision as a radio group (choose one) or checkbox group (choose many),
 * with an optional free-text "Other". Its Submit hands the formatted selections up so
 * the caller can resolve the review with `action: "answer"`. When `onDismiss` is
 * supplied, Dismiss resolves the whole request without submitting any selections.
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
}: {
  decisions: PlanDecision[];
  busy: boolean;
  onSubmit: (response: string) => void;
  /** Resolve this decision request without sending any of its options as an answer. */
  onDismiss?: () => void;
  lead?: string;
  hideQuestions?: boolean;
  namePrefix?: string;
}): React.JSX.Element {
  const [answers, setAnswers] = useState<Answers>({});

  function get(id: string): { selected: string[]; other: string } {
    return answers[id] ?? { selected: [], other: "" };
  }

  function choose(d: PlanDecision, optionId: string, checked: boolean): void {
    setAnswers((prev) => {
      const cur = prev[d.id] ?? { selected: [], other: "" };
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

  function setOther(id: string, other: string): void {
    setAnswers((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? { selected: [], other: "" }), other },
    }));
  }

  const complete = decisions.length > 0 && decisions.every((d) => isAnswered(d, answers[d.id]));

  return (
    <div className="decisions">
      {decisions.map((d) => (
        <fieldset
          key={d.id}
          className="decision"
          aria-label={hideQuestions ? d.question : undefined}
        >
          {!hideQuestions && <legend className="decision-q">{d.question}</legend>}
          {d.options.map((o) => (
            <label key={o.id} className="decision-option">
              <input
                type={d.multiSelect ? "checkbox" : "radio"}
                name={`${namePrefix}-${d.id}`}
                checked={get(d.id).selected.includes(o.id)}
                onChange={(e) => choose(d, o.id, e.target.checked)}
                disabled={busy}
              />
              <span className="decision-option-body">
                <span className="decision-option-label">
                  {o.label}
                  {o.recommended && <span className="decision-rec"> · recommended</span>}
                </span>
                {o.detail && <span className="decision-option-detail">{o.detail}</span>}
              </span>
            </label>
          ))}
          {d.allowOther && (
            <input
              className="decision-other"
              placeholder="Other…"
              value={get(d.id).other}
              onChange={(e) => setOther(d.id, e.target.value)}
              disabled={busy}
            />
          )}
        </fieldset>
      ))}
      <div className="decisions-actions">
        {onDismiss && (
          <button className="btn btn-ghost" disabled={busy} onClick={onDismiss}>
            Dismiss
          </button>
        )}
        <button
          className="btn btn-approve"
          disabled={busy || !complete}
          onClick={() => onSubmit(formatResponse(decisions, answers, lead))}
        >
          Submit
        </button>
      </div>
    </div>
  );
}
