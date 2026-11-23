import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ReviewItem } from "@shared/types.ts";
import { api } from "../lib/api.ts";
import { questionOutcome } from "../lib/async-questions.ts";
import { formatConversationTimestampLong } from "../lib/format.ts";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { PlanView } from "./PlanView.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * A revised plan form's "Revision N" tag and, beside it, the control that shows the form it
 * replaced (`ReviewItem.revision`). Drawn on the review card, which the review modal and the
 * attention inbox share, and on the form's conversation entry. Nothing for a form that revises
 * nothing.
 */
export function RevisionTag({ review }: { review: Pick<ReviewItem, "revision"> }): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const revision = review.revision;
  if (!revision) return null;
  return (
    <span className="review-revision">
      <span className="kind-tag kind-revision">Revision {revision.number}</span>
      <Tooltip label="Read the form this revision replaced. It is a record: nothing on it can be answered">
        <button type="button" className="btn btn-ghost review-revision-earlier" onClick={() => setOpen(true)}>
          Earlier version
        </button>
      </Tooltip>
      {open && <EarlierVersionModal id={revision.previousId} onClose={() => setOpen(false)} />}
    </span>
  );
}

type Loaded = { state: "loading" } | { state: "failed" } | { state: "loaded"; review: ReviewItem };

/**
 * The earlier form, read-only: its title, when it was filed, how it ended and why, its plan and
 * its decisions. Read from the daemon by id (`GET /api/reviews/:id`), because a withdrawn form
 * leaves the live snapshot at the next restart. Portaled to the body like the Foreman guide,
 * since it opens from inside the inbox or the review modal.
 */
function EarlierVersionModal({ id, onClose }: { id: string; onClose: () => void }): React.JSX.Element {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  useEffect(() => {
    let live = true;
    void api.review(id).then((read) => {
      if (live) setLoaded(read.ok ? { state: "loaded", review: read.value } : { state: "failed" });
    });
    return () => {
      live = false;
    };
  }, [id]);

  return createPortal(
    <Overlay
      id={OVERLAY_IDS.reviewEarlierVersion}
      onClose={onClose}
      className="modal review-earlier-modal"
      role="dialog"
      ariaLabel="Earlier version"
      ariaModal
    >
      <header className="modal-head">
        <h2>Earlier version</h2>
        <Tooltip label="Close the earlier version (Escape)">
          <button type="button" className="icon-btn" aria-label="Close" autoFocus onClick={onClose}>
            ✕
          </button>
        </Tooltip>
      </header>
      <div className="modal-body review-earlier-body">
        {loaded.state === "loading" && <p className="dim">Loading the earlier version…</p>}
        {loaded.state === "failed" && <p className="dim">The earlier version could not be read.</p>}
        {loaded.state === "loaded" && <EarlierVersion review={loaded.review} />}
      </div>
    </Overlay>,
    document.body,
  );
}

/** The earlier form's content, with no control that could answer it. */
export function EarlierVersion({ review }: { review: ReviewItem }): React.JSX.Element {
  const outcome = questionOutcome(review);
  const reason = outcome.state === "open" ? null : outcome.detail;
  return (
    <article className="review-earlier" aria-label={`Earlier version: ${review.title}`}>
      <div className="review-head">
        <span className={`kind-tag kind-${review.kind}`}>{review.kind === "plan-decisions" ? "decisions" : review.kind}</span>
        {review.revision && <span className="kind-tag kind-revision">Revision {review.revision.number}</span>}
        <h3>{review.title}</h3>
      </div>
      <p className="review-earlier-meta">
        Filed {formatConversationTimestampLong(review.createdAt)} · {outcome.text}
      </p>
      {reason && (
        <p className="review-earlier-reason">
          <span className="review-wait-tag">Reason</span> {reason}
        </p>
      )}
      {review.body.trim() && (
        <div className="review-content">
          <PlanView markdown={review.body} />
        </div>
      )}
      {(review.decisions?.length ?? 0) > 0 && (
        <ol className="review-earlier-decisions" aria-label="Decisions in the earlier version">
          {review.decisions!.map((decision) => (
            <li key={decision.id}>
              <span className="review-earlier-question">{decision.question}</span>
              <ul>
                {decision.options.map((option) => (
                  <li key={option.id}>
                    {option.label}
                    {option.recommended ? " (recommended)" : ""}
                    {option.detail ? <span className="dim"> - {option.detail}</span> : null}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}
