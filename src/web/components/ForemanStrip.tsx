import { useState } from "react";
import type { Session, SessionNoteSummary } from "@shared/types.ts";
import { DISPOSITION_LABEL } from "../lib/foreman.ts";
import { DraftHint, useForemanDecision } from "./foreman-bits.tsx";

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
  const { busy, done, approve, dismiss } = useForemanDecision({
    sessionId: session.id,
    note,
    inputReviewId,
    pendingReviewIds,
  });

  const escalated = note.disposition === "escalated";
  const pending = note.disposition === "pending";

  // The whole lifecycle rule, in one line: the strip is for what you OWE. An answered
  // or skipped note owes nothing, and its record is already in the transcript, so
  // there is nothing left to pin - it unmounts rather than lingering as a status line
  // the reader has to learn to ignore. `done` covers the same state for the moment
  // between the write landing and SSE saying so, and unlatches on the next marker.
  if ((!escalated && !pending) || done) return null;

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
