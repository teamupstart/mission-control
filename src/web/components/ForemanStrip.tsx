import { useState } from "react";
import type { NoteDisposition, Session, SessionNoteSummary } from "@shared/types.ts";
import { allowlistSuggestion, closeForemanNote, sessionSendBlock } from "../lib/foreman.ts";
import { api } from "../lib/api.ts";

// The pinned half of a Foreman note: the decision you owe, and nothing else.
//
// The card this replaces carried the record and the action in one block and pinned
// both. Those want opposite things - a record should be as long as it needs to be and
// scroll away, an action should be tiny and never move - so pinning them together
// inflicted the record's length on the action's position, which is how a long
// escalation came to cover the whole conversation.
//
// The prose now lives in the transcript, at the point Foreman spoke. What is left
// here is one line, and it CANNOT grow: the brief isn't in it, so no amount of
// Foreman writing can push the chat off screen.

const DISPOSITION_LABEL: Record<NoteDisposition, string> = {
  answered: "answered for you",
  pending: "drafted a reply",
  escalated: "needs your decision",
  skipped: "left for you",
};

export function ForemanStrip({
  session,
  note,
  mode,
  enabled,
  allowlist,
  inputReviewId,
  pendingReviewIds,
  onJump,
}: {
  session: Session;
  note: SessionNoteSummary;
  mode: string;
  enabled: boolean;
  allowlist?: string[];
  inputReviewId: string | null;
  pendingReviewIds?: ReadonlySet<string>;
  /** Scroll the transcript to this note's inline entry. */
  onJump?: () => void;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const sessionId = session.id;

  const escalated = note.disposition === "escalated";
  const pending = note.disposition === "pending";

  // The whole lifecycle rule, in one line: the strip is for what you OWE. An answered
  // or skipped note owes nothing, and its record is already in the transcript, so
  // there is nothing left to pin - it unmounts rather than lingering as a status line
  // the reader has to learn to ignore.
  if ((!escalated && !pending) || done) return null;

  /** Deliver to the channel this draft was made for - see `ForemanNote.deliveryTarget`. */
  function deliveryTarget(): { kind: "review"; reviewId: string } | { kind: "send" } | { kind: "stale" } {
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
      await closeForemanNote(api, sessionId, {
        marker: note.handledMarker,
        disposition: "answered",
        lastAction: "approved by you",
        sentText: note.recommendation,
      });
      setDone(true);
    }
    setBusy(false);
  }

  async function dismiss(): Promise<void> {
    setBusy(true);
    await closeForemanNote(api, sessionId, {
      marker: note.handledMarker,
      disposition: "skipped",
      lastAction: "dismissed by you",
      sentText: null,
    });
    setDone(true);
    setBusy(false);
  }

  const summary = note.purpose ?? note.recommendation ?? "Foreman is waiting on you.";

  return (
    <section
      className={`foreman-strip fs-${note.disposition}`}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="fs-row">
        <button
          type="button"
          className="fs-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="fn-badge">Foreman</span>
          <span className="fs-disp">{DISPOSITION_LABEL[note.disposition]}</span>
          {/* One line, ellipsised. The full text is in the transcript entry; this is
              a pointer to a decision, not the decision itself. */}
          <span className="fs-summary">{summary}</span>
          <span className="fs-caret" aria-hidden="true">
            ▾
          </span>
        </button>
        {note.recommendation && (
          <button className="btn btn-primary fs-go" disabled={busy} onClick={() => void approve()}>
            Approve &amp; send
          </button>
        )}
      </div>

      {open && (
        <div className="fs-body">
          {note.recommendation && (
            <div className="fn-rec">
              <span className="fn-rec-label">
                {escalated ? "Suggested answer" : "Proposed reply"}
              </span>
              <p className="fn-rec-text">{note.recommendation}</p>
            </div>
          )}
          <div className="fs-actions">
            {note.recommendation && (
              <button className="btn btn-primary" disabled={busy} onClick={() => void approve()}>
                Approve &amp; send
              </button>
            )}
            <button className="btn" disabled={busy} onClick={() => void dismiss()}>
              Dismiss
            </button>
            {onJump && (
              <button className="fs-jump" onClick={onJump}>
                Jump to note in chat ↑
              </button>
            )}
          </div>
          {pending && note.recommendation && (
            <DraftHint session={session} mode={mode} enabled={enabled} allowlist={allowlist} />
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Why this draft is asking for an OK instead of having been sent. Every case gets a
 * line, live mode included - see the same note on `ForemanNote.DraftHint`, which this
 * mirrors: live is necessary and not sufficient (the repo must be allowlisted too),
 * so "I turned live on and it's still asking me" is the state most owed an answer.
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
