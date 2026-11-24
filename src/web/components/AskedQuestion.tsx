import { isFiledGate } from "@shared/async-input.ts";
import type { ReviewItem, Session } from "@shared/types.ts";
import { questionOutcome, questionStatusLine, useQuestionAgent } from "../lib/async-questions.ts";
import { inputBody } from "../lib/reviews.ts";
import { ConversationTimestamp } from "./ConversationTimestamp.tsx";
import { QuestionBody } from "./QuestionBody.tsx";
import { RevisionTag } from "./ReviewRevision.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * A message-mode question (`async-input`) in the conversation, where its agent filed it.
 *
 * The agent's turn does not stop at the question, so without this entry the log would show the
 * agent carrying on past a question it never appears to have asked, and the answer, when it
 * comes, replying to nothing. It names the question and the agent's own meanwhile line, then says
 * how the question stands: open, with whether its agent is still working past it or has stopped on
 * it (the card's own status line, `questionStatusLine`) and an Answer button that opens the card;
 * or how it ended. The operator's answer is still its own gold entry, at the moment they gave it.
 *
 * A filed plan form (`isFiledGate`) gets the same entry, read as a plan: "Plan filed", the gate's
 * status line, and an Open button. The plan's body is not repeated here; the form shows it.
 */
export function AskedQuestionCard({
  review,
  session = null,
  onAnswer,
}: {
  review: ReviewItem;
  /** The asking session, live: while the question is open, the entry says whether its agent works. */
  session?: Pick<Session, "id" | "state" | "stateConfirmed" | "task"> | null;
  /** Open the card that answers it. Without it the open state has no button. */
  onAnswer?: () => void;
}): React.JSX.Element {
  const outcome = questionOutcome(review);
  const agent = useQuestionAgent(session);
  const status = outcome.state === "open" ? questionStatusLine(review, agent) : null;
  const plan = isFiledGate(review);
  const who = plan ? "Plan filed" : "Asked";
  return (
    <div className={`review-asked is-${outcome.state}`} role="note" aria-label={`${who}: ${review.title}`}>
      <div className="review-answer-head">
        <span className="review-answer-who review-asked-who">{who}</span>
        <span className="review-answer-title">{review.title}</span>
        <RevisionTag review={review} />
        <ConversationTimestamp at={review.createdAt} className="turn-time" />
      </div>
      <QuestionText review={review} />
      {review.meanwhile && (
        <p className="review-asked-meanwhile">
          <span className="review-wait-tag">Meanwhile</span> {review.meanwhile}
        </p>
      )}
      <div className="review-asked-foot">
        <span className="review-asked-outcome">{outcome.text}</span>
        {status && (
          <span className={`review-asked-status review-wait-${status.status}`}>
            <span className="review-wait-state">{status.label}</span>
          </span>
        )}
        {outcome.state !== "open" && outcome.detail && (
          <span className="review-asked-detail">{outcome.detail}</span>
        )}
        {outcome.state === "open" && onAnswer && (
          <>
            <span className="inbox-spacer" />
            <Tooltip label={plan ? "Open this plan to make its decisions" : "Open this question to answer it"}>
              <button type="button" className="btn" onClick={onAnswer}>
                {plan ? "Open" : "Answer"}
              </button>
            </Tooltip>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A question its agent waited on inside the call, closed by a merge while it was snoozed or still
 * pending: drawn where its Snoozed entry would be, so the closure the operator's merge caused is
 * said in the conversation whichever way the question waited.
 */
export function ClosedQuestionCard({ review }: { review: ReviewItem }): React.JSX.Element {
  const outcome = questionOutcome(review);
  return (
    <div className="review-asked is-closed" role="note" aria-label={`Closed: ${review.title}`}>
      <div className="review-answer-head">
        <span className="review-answer-who review-asked-who">Closed</span>
        <span className="review-answer-title">{review.title}</span>
        <ConversationTimestamp at={review.snooze?.at ?? review.resolvedAt ?? review.createdAt} className="turn-time" />
      </div>
      <QuestionText review={review} />
      <div className="review-asked-foot">
        <span className="review-asked-outcome">{outcome.text}</span>
      </div>
    </div>
  );
}

/**
 * The rest of the question beneath the entry's heading. `request_input` files a clipped heading as
 * the title and the whole question and its context as the body, so the heading alone would drop
 * text from a long or multi-line question, and nothing else in the conversation shows it once the
 * question has ended. The card's own rule decides what to add (`inputBody`): a question that fit
 * in the heading shows only its context, and nothing at all when there is none. It renders the way
 * the question card does (`QuestionBody`), so a bulleted context reads as a list in both places.
 */
function QuestionText({ review }: { review: ReviewItem }): React.JSX.Element | null {
  const text = review.kind === "input" ? inputBody(review) : "";
  return text ? <QuestionBody className="review-asked-question" text={text} /> : null;
}
