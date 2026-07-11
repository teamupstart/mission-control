import { useEffect, useState } from "react";
import type { ReviewItem, Session } from "@shared/types.ts";
import { api } from "../lib/api.ts";
import { DiffView } from "./DiffView.tsx";
import { PlanView } from "./PlanView.tsx";

/**
 * Modal for acting on a session's pending reviews. A diff or plan is approved or
 * sent back with a note; a question is answered. Each resolution unblocks the
 * agent that is waiting on it (for diff/input) via the MCP long-poll.
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Close automatically once the session has no more pending reviews.
  useEffect(() => {
    if (reviews.length === 0) onClose();
  }, [reviews.length, onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <span className={`agent-dot agent-${session.agent}`} aria-hidden />
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
      </div>
    </div>
  );
}

function ReviewCard({ review }: { review: ReviewItem }): React.JSX.Element {
  const [note, setNote] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
        <span className={`kind-tag kind-${review.kind}`}>{review.kind}</span>
        <h3>{review.title}</h3>
      </div>

      <div className="review-content">
        {review.kind === "diff" && <DiffView diff={review.body} />}
        {review.kind === "plan" && <PlanView markdown={review.body} />}
        {review.kind === "input" && <p className="question">{review.body}</p>}
      </div>

      {review.kind === "input" ? (
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
