import type { PlanDecision, PlanDecisionAnswer } from "@shared/types.ts";
import { CHAT_ABOUT_IT } from "@shared/review-item.ts";
import { quickSelections } from "../lib/reviews.ts";
import { ChatGlyph, decisionChoiceKey } from "./PlanDecisions.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * A one-question ask answered by one press: each option is a button that sends it, beside
 * **Chat about it** and **Dismiss**.
 *
 * Drawn by `ReviewCard` in place of `DecisionForm` when its surface asks for quick answers and
 * `quickDecision` says the question is simple enough. It decides nothing about delivery:
 * `onAnswer` hands the selections back to `ReviewCard`, which resolves them through the same
 * `api.resolveReview` call its form submits through.
 */
export function QuickDecisionButtons({
  decision,
  busy,
  recommended,
  onAnswer,
  onDismiss,
}: {
  decision: PlanDecision;
  busy: boolean;
  /** Foreman's picks, keyed by `decisionChoiceKey`. */
  recommended?: ReadonlySet<string>;
  onAnswer: (selections: PlanDecisionAnswer[]) => void;
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <div className="review-quick" role="group" aria-label={`Answer: ${decision.question}`}>
      <div className="review-quick-options">
        {decision.options.map((option) => {
          const picked = recommended?.has(decisionChoiceKey(decision.id, option.id)) ?? false;
          return (
            <Tooltip key={option.id} label={option.detail ? `Answer "${option.label}": ${option.detail}` : `Answer "${option.label}"`}>
              <button
                type="button"
                className={`btn review-quick-option${picked ? " is-foreman-pick" : ""}${option.recommended ? " is-recommended" : ""}`}
                disabled={busy}
                onClick={() => onAnswer(quickSelections(decision, { optionId: option.id }))}
              >
                {option.label}
              </button>
            </Tooltip>
          );
        })}
      </div>
      <div className="review-quick-actions">
        <Tooltip label="Dismiss this question without sending an answer">
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onDismiss}>
            Dismiss
          </button>
        </Tooltip>
        <Tooltip label="Skip choosing for now: the agent explains this question in the conversation and waits for you">
          <button
            type="button"
            className="btn btn-chat"
            disabled={busy}
            onClick={() => onAnswer(quickSelections(decision, "chat"))}
          >
            <ChatGlyph />
            {CHAT_ABOUT_IT}
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
