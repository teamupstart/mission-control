import type { PlanDecision, PlanDecisionAnswer, ReviewItem } from "@shared/types.ts";
import { ConversationTimestamp } from "./ConversationTimestamp.tsx";
import { selectedOptions } from "@shared/review-item.ts";
import { ChatGlyph } from "./PlanDecisions.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { answeredDecisions, reviewAnswerVerb } from "../lib/reviews.ts";

/**
 * What the human answered, replayed in the conversation where they answered it.
 *
 * The gap this closes: a review reaches the agent as an MCP tool result, and every harness
 * parser drops a user turn that is purely a tool result as machine noise. So the log used to
 * show the agent's `request_input` call as a grey tool chip, then a silence, then the agent
 * carrying on as though something had been decided - with the decision itself readable only
 * on a card that disappeared the moment it was submitted.
 *
 * Drawn as the form rather than as the response string, because the two answer different
 * questions. `response` is what the agent read ("→ OAuth via Clerk"), which names the option
 * taken and is silent about the three passed over; the reader of a transcript wants to know
 * what the choice WAS. So the questions and their options are laid out as they were on
 * screen, with the taken ones marked - and the whole thing in `--attention` gold, the colour
 * it wore as a form, so it reads as the same object answered rather than as a new kind of
 * message.
 *
 * Deliberately inert: no inputs, no buttons, nothing that answers. A resolved review cannot
 * be re-answered, and a control that looks live but does nothing is worse than prose. The one
 * focusable thing is the "What the agent received" disclosure on a delivered answer, which
 * opens a record rather than acting on one.
 *
 * `delivery` says how the answer reached its agent when that was a message (`async-input`):
 * on its way while still in the outbox, or delivered at the turn this card is drawn at.
 */
export function ReviewAnswerCard({
  review,
  delivery,
}: {
  review: ReviewItem;
  delivery?: ReviewCardDelivery;
}): React.JSX.Element {
  const answered = answeredDecisions(review);
  // Namespaced by review id (a UUID) because a conversation draws many of these into one
  // document, and by POSITION rather than decision id - a decision id is agent-supplied and
  // may contain spaces, which would silently break the space-separated `aria-labelledby`.
  const titleId = `ra-${review.id}-title`;
  return (
    <div
      className="review-answer"
      data-turn-id={delivery?.state === "delivered" ? delivery.turnId : undefined}
    >
      <div className="review-answer-head">
        <span className="review-answer-who">{reviewAnswerVerb(review)}</span>
        <span className="review-answer-title" id={titleId}>
          {review.title}
        </span>
        <ConversationTimestamp at={review.resolvedAt ?? review.createdAt} className="turn-time" />
      </div>
      {answered.length > 0 ? (
        <div className="review-answer-decisions">
          {answered.map(({ decision, answer }, i) => (
            <AnsweredDecision
              key={decision.id}
              decision={decision}
              answer={answer}
              questionId={`ra-${review.id}-${i}-q`}
              /*
                Don't print the question a second time when the header already IS it.

                `request_input` sends the question as the review's title and again as its
                single decision, so an `input` card would otherwise say the same sentence
                twice, once as the byline's title and once as the heading below it - the
                same duplication `showsBody` exists to prevent on the form.

                Compared rather than keyed on the kind, so the two cases the comparison
                distinguishes both come out right: a question short enough to survive
                `titleLine`'s clip is dropped as redundant, while a longer one differs from
                the clipped title and is shown in full - which is the case that most needs
                it, since the title truncates to one line. A `plan-decisions` review's title
                is the plan's, never a question, so all of its questions show.
              */
              labelledBy={decision.question === review.title ? titleId : null}
            />
          ))}
        </div>
      ) : (
        <ReviewAnswerProse review={review} />
      )}
      {delivery && <ReviewDeliveryNote delivery={delivery} />}
    </div>
  );
}

/**
 * A delivered answer (or Remind me later instruction) whose question this conversation does not
 * have, drawn in the card's place: still loading while the review history is in flight, unreadable
 * once its retries ran out without an answer, or no longer available once it has come back without
 * it. Each says what it is and when the agent got it, and discloses exactly what the agent
 * received, so it never reads as raw text.
 */
export function UnavailableReviewCard({
  envelope,
  delivery,
  loading = false,
  unreadable = false,
}: {
  envelope: "answer" | "remind-later";
  delivery: Extract<ReviewCardDelivery, { state: "delivered" }>;
  /** The review history has not come back yet, so the question may still be found. */
  loading?: boolean;
  /** The review history could not be read, so the question may exist all the same. */
  unreadable?: boolean;
}): React.JSX.Element {
  const snoozed = envelope === "remind-later";
  const subject = snoozed ? "Snoozed question" : "Answer";
  const [label, title] = loading
    ? [`${subject} loading`, "Loading the question…"]
    : unreadable
      ? [snoozed ? "Snoozed question that could not be loaded" : "Answer whose question could not be loaded", "Couldn't load the question"]
      : [snoozed ? "Snoozed question no longer available" : "Answer to a question no longer available", "This question is no longer available"];
  return (
    <div
      className={snoozed ? "review-snoozed" : "review-answer"}
      role="note"
      aria-label={label}
      aria-busy={loading || undefined}
      data-turn-id={delivery.turnId}
    >
      <div className="review-answer-head">
        <span className={`review-answer-who${snoozed ? " review-snoozed-who" : ""}`}>{snoozed ? "Snoozed" : "Answered"}</span>
        <span className="review-answer-title">{title}</span>
      </div>
      <ReviewDeliveryNote delivery={delivery} />
    </div>
  );
}

/** How a review message reached its agent, for the card that draws it. */
export type ReviewCardDelivery =
  | { state: "queued" }
  | {
      state: "delivered";
      /** The delivery turn's native id, so a jump to that turn lands on its card. */
      turnId: string;
      at: number;
      /**
       * What the agent received, on the one card per delivery that discloses it. `received`
       * draws it (with find highlights); `open` keeps the disclosure open while it holds the
       * current find match.
       */
      received?: { text: React.ReactNode; open: boolean };
    };

/**
 * The quiet line under a card answered by message: "On its way to the agent" until the
 * outbox delivers it, then "Delivered to the agent" with the turn's time and, on the last card
 * of that delivery, a native disclosure of exactly what the agent read. Nothing is hidden for
 * good: the raw text the card replaces is one click away, and find reaches it.
 */
export function ReviewDeliveryNote({ delivery }: { delivery: ReviewCardDelivery }): React.JSX.Element {
  if (delivery.state === "queued") return <p className="review-delivery">On its way to the agent</p>;
  return (
    <>
      <p className="review-delivery">
        Delivered to the agent
        <ConversationTimestamp at={delivery.at} className="turn-time" />
      </p>
      {delivery.received && (
        <details
          className="review-received"
          aria-label="What the agent received"
          open={delivery.received.open || undefined}
        >
          <Tooltip label="Show the exact message Mission Control sent the agent">
            <summary>What the agent received</summary>
          </Tooltip>
          <div className="review-received-text">{delivery.received.text}</div>
        </details>
      )}
    </>
  );
}

/**
 * One question with its options, the chosen ones marked.
 *
 * The marker is a `<span>` and not a disabled radio. A disabled input is announced to
 * assistive tech as a control you may not use, which is a lie about a record - nothing here
 * was ever going to be usable. The chosen rows instead carry `aria-label` prefixes so the
 * selection is read out as the fact it is, and the whole group is a list.
 */
function AnsweredDecision({
  decision,
  answer,
  questionId,
  labelledBy,
}: {
  decision: PlanDecision;
  answer: PlanDecisionAnswer | undefined;
  /** Id given to this question when it is drawn, so its option list can name itself by it. */
  questionId: string;
  /**
   * The element already showing this question, or null to draw it here.
   *
   * A reference and not a copy of the string: the option list has to be NAMED either way - a
   * list of options with no accessible name is a list of loose strings - and repeating the
   * question in an `aria-label` would have a screen reader read the same sentence twice in a
   * row, which is the audible form of the duplication being removed from the page.
   */
  labelledBy: string | null;
}): React.JSX.Element {
  const chosen = new Set(selectedOptions(decision, answer).map((o) => o.id));
  const other = answer?.other?.trim() ?? "";
  const note = answer?.note?.trim() ?? "";
  // A decision can be answered entirely in free text when `allowOther` is set, and a
  // dismissed review has no answer at all. Both are stated rather than left as an empty
  // block, so the reader is never shown a question with no visible outcome.
  const movedToChat = answer?.chat === true;
  const nothingPicked = chosen.size === 0 && !other && !movedToChat;
  return (
    <div className="review-answer-decision">
      {!labelledBy && (
        <p className="review-answer-q" id={questionId}>
          {decision.question}
        </p>
      )}
      <ul className="review-answer-options" aria-labelledby={labelledBy ?? questionId}>
        {decision.options.map((o) => {
          const picked = chosen.has(o.id);
          return (
            <li
              key={o.id}
              className={`review-answer-option${picked ? " is-picked" : ""}`}
              aria-label={`${picked ? "Chosen" : "Not chosen"}: ${o.label}`}
            >
              <span className="review-answer-mark" aria-hidden="true">
                {picked ? "●" : "○"}
              </span>
              <span className="review-answer-option-body">
                <span className="review-answer-option-label">
                  {o.label}
                  {o.recommended && <span className="decision-rec"> · recommended</span>}
                </span>
                {o.detail && <span className="decision-option-detail">{o.detail}</span>}
              </span>
            </li>
          );
        })}
      </ul>
      {movedToChat && <MovedToChat />}
      {other && (
        <p className="review-answer-other">
          {/* Named as the agent read it (`formatResponse`): beside a pick or a move to chat
              the text was context for it, and only on its own was it an Other answer. */}
          <span className="review-answer-other-tag">
            {chosen.size > 0 || movedToChat ? "Context" : "Other"}
          </span>
          {other}
        </p>
      )}
      {nothingPicked && <p className="review-answer-none">No option chosen.</p>}
      {note && (
        <p className="review-answer-other review-answer-note">
          <span className="review-answer-other-tag">Note</span>
          {note}
        </p>
      )}
    </div>
  );
}

/**
 * The fallback for every resolution with no form behind it: a free-text `input`, an
 * approve/reject note, a dismissal, and any answer stored before selections were recorded.
 *
 * Shows `response` verbatim, which is exactly what the agent received. An empty one is not
 * an error and not a blank box - approving without a note, or dismissing, genuinely says
 * nothing more than the byline above already does, so the card simply ends there.
 */
function ReviewAnswerProse({ review }: { review: ReviewItem }): React.JSX.Element | null {
  // An open-ended question moved to chat: its response is the instruction the agent read,
  // which is not something the human said. Show the fact, and any note they typed.
  const chat = review.selections?.find((a) => a.chat);
  if (chat) {
    const note = chat.note?.trim();
    return (
      <>
        <MovedToChat />
        {note && (
          <p className="review-answer-other review-answer-note">
            <span className="review-answer-other-tag">Note</span>
            {note}
          </p>
        )}
      </>
    );
  }
  const text = review.response?.trim();
  if (!text) return null;
  return <p className="review-answer-text">{text}</p>;
}

function MovedToChat(): React.JSX.Element {
  return (
    <p className="review-answer-chat">
      <ChatGlyph />
      Moved to chat
    </p>
  );
}
