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
}: {
  sessionId: string;
  note: SessionNoteSummary;
  /** The current Foreman mode, so a dry-run draft can point the user at live mode. */
  mode: string;
  /** A pending `input` review id for this session, so Approve resolves it cleanly. */
  inputReviewId: string | null;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const escalated = note.disposition === "escalated";
  const pending = note.disposition === "pending";
  const answered = note.disposition === "answered";
  const showProposal = (escalated || pending) && !done;

  async function approve(): Promise<void> {
    if (!note.recommendation) return;
    setBusy(true);
    const res = inputReviewId
      ? await api.resolveReview(inputReviewId, "answer", note.recommendation)
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
        <p className="fn-hint dim">Draft only (dry-run). Switch Foreman to live for it to send.</p>
      )}

      {done && <p className="fn-hint dim">Done.</p>}
    </section>
  );
}
