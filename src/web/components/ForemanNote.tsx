import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { NoteDisposition, Session, SessionNoteSummary } from "@shared/types.ts";
import { allowlistSuggestion, sessionSendBlock } from "../lib/foreman.ts";
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
  session,
  note,
  mode,
  enabled,
  allowlist,
  inputReviewId,
  pendingReviewIds,
}: {
  /** The whole session: the draft's hint has to reason about where it's running. */
  session: Session;
  note: SessionNoteSummary;
  /** The current Foreman mode, so a draft can explain why it wasn't sent. */
  mode: string;
  /** Whether Foreman is on at all - it outranks the mode when explaining a draft. */
  enabled: boolean;
  /** Repo roots cleared for live sends, so the hint can tell "live" from "will send". */
  allowlist?: string[];
  /** A pending `input` review id for this session, used only when the draft has no marker. */
  inputReviewId: string | null;
  /** Live pending review ids, so a draft for a since-resolved review reads as stale. */
  pendingReviewIds?: ReadonlySet<string>;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const sessionId = session.id;

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

      {pending && !done && note.recommendation && (
        <DraftHint session={session} mode={mode} enabled={enabled} allowlist={allowlist} />
      )}

      {done && <p className="fn-hint dim">Done.</p>}
    </section>
  );
}

/**
 * Why this draft is asking for an OK instead of having been sent.
 *
 * Every case gets a line, including - especially - live mode. This used to render
 * only when `mode !== "live"`, on the theory that a live draft was impossible; but
 * live mode is necessary and not sufficient (the repo must be allowlisted too), so
 * the ONE state where the human is most owed an explanation - "I turned live on and
 * it's still asking me" - was the exact state that silently rendered nothing. The
 * work-queue panel had said this all along; the note is where the human actually
 * clicks Approve, so it has to say it too.
 */
function DraftHint({
  session,
  mode,
  enabled,
  allowlist,
}: {
  session: Session;
  mode: string;
  enabled: boolean;
  allowlist: string[] | undefined;
}): React.JSX.Element {
  switch (sessionSendBlock(session, { enabled, mode, allowlist })) {
    case "foreman-off":
      return (
        <p className="fn-hint dim">
          Foreman is off, so it won&apos;t send this - Approve to send it yourself.
        </p>
      );
    case "not-allowlisted":
      return (
        <p className="fn-hint dim">
          Foreman is in live mode, but this session&apos;s repo isn&apos;t allowlisted for live
          sends - so it drafted this for your OK. Add <code>{allowlistSuggestion(session)}</code> to
          Foreman&apos;s allowlist to let it send here.
        </p>
      );
    case "no-cwd":
      return (
        <p className="fn-hint dim">
          Foreman can&apos;t tell which directory this session is in, so it can&apos;t match the
          allowlist - it drafted this for your OK rather than sending it.
        </p>
      );
    default:
      return (
        <p className="fn-hint dim">
          Draft only - Foreman won&apos;t send this automatically. Use Approve to send it.
        </p>
      );
  }
}
