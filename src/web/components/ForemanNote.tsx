import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { NoteDisposition, SessionNoteSummary } from "@shared/types.ts";
import { api } from "../lib/api.ts";
import { relativeTime } from "../lib/format.ts";

// The Foreman panel inside an expanded card: the session's Purpose, plus - when
// Foreman drafted or escalated - the decision brief + its recommended answer, and
// one-click controls to send or dismiss a pending draft. When Foreman already
// answered live, a compact audit line. Read-mostly; it stops click propagation so
// interacting with it doesn't select/collapse the card.

const DISPOSITION_LABEL: Record<NoteDisposition, string> = {
  answered: "answered for you",
  pending: "drafted a reply",
  escalated: "needs your decision",
  skipped: "left for you",
};

export function ForemanNote({
  sessionId,
  note,
  mode,
  inputReviewId,
  pendingReviewIds,
}: {
  sessionId: string;
  note: SessionNoteSummary;
  /** The current Foreman mode, so a dry-run draft can point the user at live mode. */
  mode: string;
  /** A pending `input` review id for this session, used only when the draft has no marker. */
  inputReviewId: string | null;
  /** Live pending review ids, so a draft for a since-resolved review reads as stale. */
  pendingReviewIds?: ReadonlySet<string>;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const escalated = note.disposition === "escalated";
  const pending = note.disposition === "pending";
  const answered = note.disposition === "answered";
  const showProposal = (escalated || pending) && !done;

  /**
   * Deliver to the channel the draft was actually made for, read from the note's
   * `handledMarker`, not from the live review map (which can drift while a draft
   * sits pending). A `review:<id>` draft resolves *that* review; if it's no longer
   * pending the draft is stale and must be dismissed, never redirected elsewhere.
   * A terminal marker types into the session; a marker-less draft falls back to
   * the live input review, else the terminal.
   */
  function deliveryTarget():
    | { kind: "review"; reviewId: string }
    | { kind: "send" }
    | { kind: "stale" } {
    const marker = note.handledMarker;
    if (marker?.startsWith("review:")) {
      const reviewId = marker.slice("review:".length);
      if (pendingReviewIds?.has(reviewId) ?? false) return { kind: "review", reviewId };
      return { kind: "stale" };
    }
    if (marker) return { kind: "send" };
    return inputReviewId ? { kind: "review", reviewId: inputReviewId } : { kind: "send" };
  }

  async function approve(): Promise<void> {
    if (!note.recommendation) return;
    const target = deliveryTarget();
    if (target.kind === "stale") {
      await dismiss();
      return;
    }
    setBusy(true);
    const res =
      target.kind === "review"
        ? await api.resolveReview(target.reviewId, "answer", note.recommendation)
        : await api.sendText(sessionId, note.recommendation);
    if (res.ok) {
      await api.setNote(sessionId, {
        disposition: "answered",
        lastAction: "approved by you",
        recommendation: null,
        brief: null,
      });
      setDone(true);
    }
    setBusy(false);
  }

  async function dismiss(): Promise<void> {
    setBusy(true);
    await api.setNote(sessionId, {
      disposition: "skipped",
      lastAction: "dismissed by you",
      recommendation: null,
      brief: null,
    });
    setDone(true);
    setBusy(false);
  }

  return (
    <section
      className={`foreman-note fn-${note.disposition}`}
      onClick={(e) => e.stopPropagation()}
    >
      <header className="fn-head">
        <span className="fn-badge">Foreman</span>
        <span className="fn-disp">{DISPOSITION_LABEL[note.disposition]}</span>
        {note.updatedAt > 0 && <span className="fn-time dim">{relativeTime(note.updatedAt)}</span>}
      </header>

      {note.purpose && <p className="fn-purpose">{note.purpose}</p>}

      {showProposal && note.brief && (
        <div className="fn-brief markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{note.brief}</ReactMarkdown>
        </div>
      )}

      {showProposal && note.recommendation && (
        <div className="fn-rec">
          <span className="fn-rec-label">{escalated ? "Suggested answer" : "Proposed reply"}</span>
          <p className="fn-rec-text">{note.recommendation}</p>
        </div>
      )}

      {answered && note.lastAction && <p className="fn-audit">✓ {note.lastAction}</p>}

      {pending && !done && note.recommendation && (
        <div className="fn-actions">
          <button className="btn btn-primary" disabled={busy} onClick={() => void approve()}>
            Approve &amp; send
          </button>
          <button className="btn" disabled={busy} onClick={() => void dismiss()}>
            Dismiss
          </button>
        </div>
      )}

      {pending && !done && note.recommendation && mode !== "live" && (
        <p className="fn-hint dim">Draft only - Foreman won&apos;t send this automatically. Use Approve to send it.</p>
      )}

      {done && <p className="fn-hint dim">Done.</p>}
    </section>
  );
}
