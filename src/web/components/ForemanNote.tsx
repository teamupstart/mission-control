import { Markdown } from "./Markdown.tsx";
import type { Session, SessionNoteSummary } from "@shared/types.ts";
import { noteAwaitsYou } from "@shared/foreman.ts";
import { canMessage } from "@shared/pane.ts";
import { DISPOSITION_LABEL } from "../lib/foreman.ts";
import { DraftHint, useForemanDecision } from "./foreman-bits.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { relativeTime } from "../lib/format.ts";

// The Foreman panel inside an expanded card: the session's Purpose, plus - when
// Foreman drafted or escalated - the decision brief + its recommended answer, and
// one-click controls to send or dismiss a pending draft. When Foreman already
// answered live, a compact audit line. Read-mostly; it stops click propagation so
// interacting with it doesn't select/collapse the card.

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
  const { busy, done, blocked, approve, dismiss } = useForemanDecision({
    sessionId: session.id,
    note,
    inputReviewId,
    pendingReviewIds,
    canSend: canMessage(session),
  });

  const escalated = note.disposition === "escalated";
  const pending = note.disposition === "pending";
  const answered = note.disposition === "answered";
  const showProposal = noteAwaitsYou(note.disposition) && !done;
  // Same test the strip makes, from the same hook, because it is the same note. This card
  // only ever drew controls for a `pending` draft, so the escalation-with-no-channel that
  // motivated this never had a live button here - but it had no explanation either, which
  // left the grid showing a suggested answer and no account of why it was never sent.
  const sendable = Boolean(note.recommendation) && !blocked;

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
          <Markdown>{note.brief}</Markdown>
        </div>
      )}

      {showProposal && note.recommendation && (
        <div className="fn-rec">
          <span className="fn-rec-label">{escalated ? "Suggested answer" : "Proposed reply"}</span>
          <p className="fn-rec-text">{note.recommendation}</p>
        </div>
      )}

      {answered && note.lastAction && <p className="fn-audit">✓ {note.lastAction}</p>}

      {/* The hint above the control, for the reason the strip gives: it is why Approve is
          missing, and a reader who finds that out after the buttons has already decided the
          card is broken. */}
      {showProposal && blocked && (
        <>
          <p className="fn-hint dim">{blocked}</p>
          <div className="fn-actions">
            <Tooltip label="Drop this note - nothing is sent to the session">
              <button className="btn" disabled={busy} onClick={() => void dismiss()}>
                Dismiss
              </button>
            </Tooltip>
          </div>
        </>
      )}

      {pending && !done && sendable && (
        <div className="fn-actions">
          <Tooltip label="Type Foreman's drafted reply into this session's prompt">
            <button className="btn btn-primary" disabled={busy} onClick={() => void approve()}>
              Approve &amp; send
            </button>
          </Tooltip>
          <Tooltip label="Drop this note - nothing is sent to the session">
            <button className="btn" disabled={busy} onClick={() => void dismiss()}>
              Dismiss
            </button>
          </Tooltip>
        </div>
      )}

      {pending && !done && sendable && (
        <DraftHint session={session} mode={mode} enabled={enabled} allowlist={allowlist} />
      )}

      {done && <p className="fn-hint dim">Done.</p>}
    </section>
  );
}
