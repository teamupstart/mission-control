import { useEffect, useState } from "react";
import type { ReviewItem, Session } from "@shared/types.ts";
import { api } from "../lib/api.ts";
import { DiffView } from "./DiffView.tsx";
import { PlanView } from "./PlanView.tsx";
import { DecisionForm } from "./PlanDecisions.tsx";
import { reviewDecisions, decisionLead, showsBody } from "../lib/reviews.ts";
import { AgentDot } from "./session-bits.tsx";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";

/**
 * Modal for acting on a session's pending reviews. A diff or plan is approved or
 * sent back with a note; a question is answered - as free text, or by picking from the
 * options the agent supplied; a `plan-decisions` plan is answered by submitting its
 * selections. Each resolution unblocks the agent that is waiting on it (for
 * diff/input/plan-decisions) via the MCP long-poll.
 *
 * The options case is what a dispatched session's clarifying question looks like now:
 * `ask-channel.ts` disallows Claude's built-in `AskUserQuestion`, so instead of drawing a
 * menu on a terminal nobody is watching, the agent calls `request_input` with its choices
 * and blocks here.
 */
export function ReviewModal({
  session,
  reviews,
  onClose,
}: {
  session: Session;
  reviews: ReviewItem[];
  onClose: () => void;
}): React.JSX.Element {
  // Close automatically once the session has no more pending reviews.
  useEffect(() => {
    if (reviews.length === 0) onClose();
  }, [reviews.length, onClose]);

  return (
    <Overlay id={OVERLAY_IDS.reviews} onClose={onClose} className="modal">
      <header className="modal-head">
        <div>
          <AgentDot agent={session.agent} />
          <strong>{session.name}</strong>
          <span className="dim"> · {reviews.length} pending</span>
        </div>
        <button className="btn btn-ghost" onClick={onClose}>
          Close (esc)
        </button>
      </header>
      <div className="modal-body">
        {reviews.map((r) => (
          <ReviewCard key={r.id} review={r} />
        ))}
      </div>
    </Overlay>
  );
}

function ReviewCard({ review }: { review: ReviewItem }): React.JSX.Element {
  const [note, setNote] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const decisions = reviewDecisions(review);

  async function resolve(action: "approve" | "reject" | "answer", response: string | null) {
    setBusy(true);
    setErr(null);
    const r = await api.resolveReview(review.id, action, response);
    setBusy(false);
    if (!r.ok) setErr(r.error ?? "failed");
  }

  return (
    <section className={`review review-${review.kind}`}>
      <div className="review-head">
        <span className={`kind-tag kind-${review.kind}`}>
          {review.kind === "plan-decisions" ? "decisions" : review.kind}
        </span>
        <h3>{review.title}</h3>
      </div>

      {/*
        An `input` shows its body only when it SAYS something the header does not.

        `request_input` sends a clipped question as the title and the whole question as the
        body, so the two are equal whenever the question fit in a heading - and printing both
        then put the same sentence on screen twice, once as the `<h3>` and again as a paragraph
        directly beneath, with a third copy possible as the form's legend.

        But suppressing it unconditionally would flatten a long or multi-line free-text
        question into a bold heading with its newlines collapsed. So the test is
        `body !== title` rather than the kind: past the clip the body says something the header
        does not, and it is rendered as the readable paragraph it should be. The whole block is
        skipped when there is nothing to put in it, because `.review-content` is a bordered,
        margined box and an empty one is an artifact.
      */}
      {showsBody(review) && (
        <div className="review-content">
          {review.kind === "diff" && <DiffView diff={review.body} />}
          {(review.kind === "plan" || review.kind === "plan-decisions") && (
            <PlanView markdown={review.body} />
          )}
          {review.kind === "input" && <p className="question">{review.body}</p>}
        </div>
      )}

      {/*
        A question with discrete options is answered by the form, whichever kind asked it -
        `plan-decisions` (several choices about a plan) or an `input` that `request_input`
        raised with options, which is what a dispatched session now sends instead of drawing
        Claude's built-in `AskUserQuestion` menu on its terminal. A `plan-decisions` with no
        decisions cannot be resolved at all (the schema forbids creating one); an `input`
        with none is the open-ended ask, and still gets the textarea.
      */}
      {decisions ? (
        <DecisionForm
          decisions={decisions}
          busy={busy}
          lead={decisionLead(review.kind)}
          hideQuestions={review.kind === "input"}
          // Review ids are unique, and every pending review of a session is drawn into this
          // one document - see `namePrefix`, without which two option-carrying `input` reviews
          // share a radio group and answering one silently clears the other.
          namePrefix={review.id}
          onSubmit={(response) => void resolve("answer", response)}
        />
      ) : review.kind === "plan-decisions" ? null : review.kind === "input" ? (
        <div className="review-actions">
          <textarea
            className="answer-box"
            placeholder="Your answer…"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            rows={2}
          />
          <button
            className="btn btn-send"
            disabled={busy || !answer.trim()}
            onClick={() => void resolve("answer", answer.trim())}
          >
            Send answer
          </button>
        </div>
      ) : (
        <div className="review-actions">
          <input
            className="note-input"
            placeholder="Optional note to the agent…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <span className="actions-spacer" />
          <button
            className="btn btn-reject"
            disabled={busy}
            onClick={() => void resolve("reject", note.trim() || null)}
          >
            Request changes
          </button>
          <button
            className="btn btn-approve"
            disabled={busy}
            onClick={() => void resolve("approve", note.trim() || null)}
          >
            Approve
          </button>
        </div>
      )}
      {err && <p className="review-err">{err}</p>}
    </section>
  );
}
