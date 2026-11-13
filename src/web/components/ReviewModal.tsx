import { useEffect, useRef, useState } from "react";
import type { PaneDialog, PlanDecisionAnswer, ReviewItem, Session, SessionNoteSummary } from "@shared/types.ts";
import { api } from "../lib/api.ts";
import { DiffView } from "./DiffView.tsx";
import { PlanView } from "./PlanView.tsx";
import { ChatGlyph, DecisionForm, decisionChoiceKey } from "./PlanDecisions.tsx";
import { CHAT_ABOUT_IT, decisionLead, formatResponse } from "@shared/review-item.ts";
import { PLAN_APPROVAL_DECISION, approvesFinalBundle } from "@shared/managed-plans.ts";
import { inputBody, reviewDecisions, showsBody } from "../lib/reviews.ts";
import { AgentDot } from "./session-bits.tsx";
import { PaneDialogPrompt } from "./PaneDialogPrompt.tsx";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import {
  ForemanRecommendationButton,
  ForemanRecommendationSidecar,
} from "./ForemanRecommendation.tsx";
import {
  foremanNoteForReview,
  recommendedChoiceKeys,
  type RecommendationChoice,
} from "../lib/foreman-review.ts";
import { Tooltip } from "./Tooltip.tsx";
import { useTourTaskTargetRef } from "../tour/target-context.tsx";
import { clearReviewDraft, useReviewDraft } from "../lib/review-drafts.ts";

/**
 * Modal for acting on a session's pending reviews. A diff or plan is approved or
 * sent back with a note; a question is answered - as free text, or by picking from the
 * options the agent supplied; any review can also be dismissed without sending an answer.
 * Each resolution unblocks only the agent wait for that review (for diff/input/plan-decisions)
 * via the MCP long-poll.
 *
 * The options case is what a dispatched session's clarifying question looks like now:
 * `ask-channel.ts` disallows Claude's built-in `AskUserQuestion`, so instead of drawing a
 * menu on a terminal nobody is watching, the agent calls `request_input` with its choices
 * and blocks here.
 */
export function ReviewModal({
  session,
  reviews,
  dialog = null,
  onClose,
  onMovedToChat,
}: {
  session: Session;
  reviews: ReviewItem[];
  /**
   * A menu the session is parked on (`activePaneDialog`), answered here by the Conversation's
   * own `PaneDialogPrompt`, so a resident's every requested decision opens in this one modal.
   */
  dialog?: PaneDialog | null;
  onClose: () => void;
  /** A question was moved to the conversation; the caller takes the operator there. */
  onMovedToChat?: (sessionId: string) => void;
}): React.JSX.Element {
  const tourTargetRef = useTourTaskTargetRef<HTMLElement>("see-work:review-modal", session.task?.id);
  const pending = reviews.length + (dialog ? 1 : 0);
  // Close automatically once the session has nothing left pending: no review and no menu.
  useEffect(() => {
    if (pending === 0) onClose();
  }, [pending, onClose]);

  return (
    <Overlay
      id={OVERLAY_IDS.reviews}
      onClose={onClose}
      className="modal review-modal"
      role="dialog"
      ariaLabel="Review request"
      surfaceRef={tourTargetRef}
    >
      <header className="modal-head">
        <div>
          <AgentDot agent={session.agent} />
          <strong>{session.name}</strong>
          <span className="dim"> · {pending} pending</span>
        </div>
        <Tooltip label="Close the review queue - nothing is resolved">
          <button className="btn btn-ghost" onClick={onClose}>
            Close (esc)
          </button>
        </Tooltip>
      </header>
      <div className="modal-body">
        {dialog && <PaneDialogPrompt sessionId={session.id} dialog={dialog} note={session.note} />}
        {reviews.map((r) => (
          <ReviewCard key={r.id} review={r} note={session.note} onMovedToChat={onMovedToChat} />
        ))}
      </div>
    </Overlay>
  );
}

/**
 * One pending review, answered in place.
 *
 * Exported because it is session-AGNOSTIC - `api.resolveReview` is its whole dependency - so
 * the attention inbox draws every session's questions with the same card rather than growing a
 * second answering surface that would have to be kept in step with this one. Its `namePrefix`
 * below is what makes that safe.
 */
export function ReviewCard({
  review,
  note: sessionNote,
  onMovedToChat,
}: {
  review: ReviewItem;
  note?: SessionNoteSummary | null;
  /**
   * Called once an answer that moved at least one question to chat has been delivered, so the
   * surface can close and focus the session's message box: the conversation is where the
   * operator goes next.
   */
  onMovedToChat?: (sessionId: string) => void;
}): React.JSX.Element {
  // Everything typed or picked lives in the review-draft map, not in this mount, so closing
  // the modal, folding the inbox or reloading the page brings it back on the next open.
  const [draft, updateDraft] = useReviewDraft(review.id);
  const { note, answer, approveFuture } = draft;
  const setNote = (next: string) => updateDraft((d) => ({ ...d, note: next }));
  const setAnswer = (next: string) => updateDraft((d) => ({ ...d, answer: next }));
  const setApproveFuture = (next: boolean) => updateDraft((d) => ({ ...d, approveFuture: next }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [foremanOpen, setForemanOpen] = useState(false);
  const foremanTriggerRef = useRef<HTMLButtonElement>(null);
  const decisions = reviewDecisions(review);
  // The daemon marks the reviews that can carry it; an unbound form with the same question cannot.
  const finalBundle = review.standingApprovalEligible === true
    && (decisions?.some((d) => d.id === PLAN_APPROVAL_DECISION) ?? false);
  const foremanNote = foremanNoteForReview(review, sessionNote);
  const recommendationChoices: RecommendationChoice[] =
    decisions?.flatMap((decision) =>
      decision.options.map((option) => ({
        key: decisionChoiceKey(decision.id, option.id),
        label: option.label,
        detail: option.detail,
        // A review can carry several decisions, and two of them may offer the same wording.
        // Naming the decision keeps a match on one from marking its twin on another.
        group: decision.id,
      })),
    ) ?? [];
  const recommendedKeys = recommendedChoiceKeys(
    foremanNote?.recommendation,
    recommendationChoices,
  );
  const foremanPicks = recommendationChoices.filter((choice) => recommendedKeys.has(choice.key));
  const foremanAvailable = Boolean(
    foremanNote && (foremanNote.recommendation?.trim() || foremanNote.brief?.trim()),
  );

  useEffect(() => {
    if (!foremanAvailable) setForemanOpen(false);
  }, [foremanAvailable]);

  async function resolve(
    action: "approve" | "reject" | "answer" | "dismiss",
    response: string | null,
    selections: PlanDecisionAnswer[] | null = null,
  ) {
    setBusy(true);
    setErr(null);
    const r = await api.resolveReview(
      review.id,
      action,
      response,
      selections,
      // Granted only alongside an approval of this bundle, never with "Needs revision".
      action === "answer" && finalBundle && approveFuture && approvesFinalBundle(selections),
    );
    setBusy(false);
    if (!r.ok) {
      setErr(r.error ?? "failed");
      return;
    }
    // Delivered: the draft has nothing left to come back for. A failed resolve keeps it.
    clearReviewDraft(review.id);
    if (selections?.some((a) => a.chat)) onMovedToChat?.(review.sessionId);
  }

  /**
   * "Chat about it" on an open-ended question. Built through `formatResponse`, like a form's
   * answer, so the agent reads the same instruction either way; anything already typed goes
   * along as the note, which is usually what is unclear.
   */
  function chatAboutQuestion(): void {
    const typed = answer.trim();
    const selections: PlanDecisionAnswer[] = [
      { decisionId: "q", selected: [], other: null, chat: true, ...(typed ? { note: typed } : {}) },
    ];
    const asked = [{ id: "q", question: review.body || review.title, options: [] }];
    void resolve("answer", formatResponse(asked, selections, decisionLead(review.kind)), selections);
  }

  const dismissButton = (
    <Tooltip label="Dismiss this review without sending an answer">
      <button
        className="btn btn-ghost"
        disabled={busy}
        onClick={() => void resolve("dismiss", null)}
      >
        Dismiss
      </button>
    </Tooltip>
  );

  return (
    <section className={`review review-${review.kind}`} data-dialog-action-scope>
      <div className="review-head">
        <span className={`kind-tag kind-${review.kind}`}>
          {review.kind === "plan-decisions" ? "decisions" : review.kind}
        </span>
        <h3>{review.title}</h3>
        {foremanAvailable && (
          <ForemanRecommendationButton
            open={foremanOpen}
            onToggle={() => setForemanOpen((open) => !open)}
            buttonRef={foremanTriggerRef}
          />
        )}
      </div>

      {/*
        An `input` shows its body only when it SAYS something the header does not.

        `request_input` sends a clipped question as the title and the whole question, then any
        `context`, as the body. When the question fit in a heading its paragraph equals the
        title, and printing it again put the same sentence on screen twice - so `inputBody`
        drops that leading paragraph and only the context is printed beneath the heading.

        But suppressing the body outright would flatten a long or multi-line free-text
        question into a bold heading with its newlines collapsed. Past the clip the body says
        something the header does not, and it is rendered in full as the readable paragraph it
        should be. The whole block is
        skipped when there is nothing to put in it, because `.review-content` is a bordered,
        margined box and an empty one is an artifact.
      */}
      {showsBody(review) && (
        <div className="review-content">
          {review.kind === "diff" && <DiffView diff={review.body} />}
          {(review.kind === "plan" || review.kind === "plan-decisions") && (
            <PlanView markdown={review.body} />
          )}
          {review.kind === "input" && <p className="question">{inputBody(review)}</p>}
        </div>
      )}

      {/*
        A question with discrete options is submitted or dismissed by the form, whichever
        kind asked it - `plan-decisions` (several choices about a plan) or an `input` that
        `request_input` raised with options, which is what a dispatched session now sends
        instead of drawing Claude's built-in `AskUserQuestion` menu on its terminal. A
        `plan-decisions` with no decisions cannot be created (the schema forbids it); an
        `input` with none is the open-ended ask, and still gets the textarea.
      */}
      {decisions ? (
        <DecisionForm
          decisions={decisions}
          busy={busy}
          lead={decisionLead(review.kind)}
          hideQuestions={review.kind === "input"}
          // Only `request_plan_decisions` returns the formatted answer to the agent for every
          // form it draws. An option-carrying `input` also serves the product-issue
          // confirmation, which acts on the selection alone and would drop a note.
          allowNote={review.kind === "plan-decisions"}
          allowChat
          // Review ids are unique, and every pending review of a session - or, in the
          // attention inbox, of the WHOLE FLEET - is drawn into one document. Without
          // `namePrefix` two option-carrying `input` reviews share a radio group and answering
          // one silently clears the other; across sessions that is two different agents.
          namePrefix={review.id}
          foremanRecommended={recommendedKeys}
          answers={draft.decisions}
          onAnswersChange={(change) =>
            updateDraft((d) => ({ ...d, decisions: change(d.decisions) }))
          }
          besideSubmit={
            finalBundle && (
              <label className="decisions-standing-approval">
                <Tooltip label="When you approve this bundle, also approve every later bundle for this task without asking; each is logged in this session">
                  <input
                    type="checkbox"
                    checked={approveFuture}
                    disabled={busy}
                    onChange={(e) => setApproveFuture(e.target.checked)}
                  />
                </Tooltip>
                <span>Approve all future bundles for this task</span>
              </label>
            )
          }
          onDismiss={() => void resolve("dismiss", null)}
          onSubmit={(response, selections) => void resolve("answer", response, selections)}
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
          {dismissButton}
          <Tooltip label="Skip answering for now: the agent explains this question in the conversation and waits for you">
            <button className="btn btn-chat" disabled={busy} onClick={chatAboutQuestion}>
              <ChatGlyph />
              {CHAT_ABOUT_IT}
            </button>
          </Tooltip>
          <Tooltip
            label={answer.trim() ? "Send this answer back to the agent" : "Write an answer first"}
          >
            <button
              className="btn btn-send"
              data-dialog-default
              disabled={busy || !answer.trim()}
              onClick={() => void resolve("answer", answer.trim())}
            >
              Send answer
            </button>
          </Tooltip>
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
          {dismissButton}
          <Tooltip label="Send this back for another pass, with your note">
            <button
              className="btn btn-reject"
              disabled={busy}
              onClick={() => void resolve("reject", note.trim() || null)}
            >
              Request changes
            </button>
          </Tooltip>
          <Tooltip label="Approve this and let the agent carry on">
            <button
              className="btn btn-approve"
              data-dialog-default
              disabled={busy}
              onClick={() => void resolve("approve", note.trim() || null)}
            >
              Approve
            </button>
          </Tooltip>
        </div>
      )}
      {err && <p className="review-err">{err}</p>}
      {foremanOpen && foremanAvailable && foremanNote && (
        <ForemanRecommendationSidecar
          note={foremanNote}
          picks={foremanPicks}
          onClose={() => setForemanOpen(false)}
          returnFocusRef={foremanTriggerRef}
        />
      )}
    </section>
  );
}
