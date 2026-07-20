import { useEffect, useState } from "react";
import type { ReviewItem, Session } from "@shared/types.ts";
import { api } from "../lib/api.ts";
import { DiffView } from "./DiffView.tsx";
import { PlanView } from "./PlanView.tsx";
import { DecisionForm } from "./PlanDecisions.tsx";
import { reviewDecisions, decisionLead } from "../lib/reviews.ts";
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
        `input` has no content block at all, so this is skipped rather than rendered empty -
        `.review-content` is a bordered, margined box, and an empty one is a visible artifact.
        `request_input` sends the question as the title AND as the body, so a paragraph of
        `body` beneath an `<h3>` of `title` printed the same sentence twice - true since the
        tool shipped, and newly obvious once a third copy could appear as the form's legend.
        The header is its one home, which is what every other kind already does; the form's
        `hideQuestions` keeps it from repeating, and the answer control follows directly.
      */}
      {review.kind !== "input" && (
        <div className="review-content">
          {review.kind === "diff" && <DiffView diff={review.body} />}
          {(review.kind === "plan" || review.kind === "plan-decisions") && (
            <PlanView markdown={review.body} />
          )}
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
