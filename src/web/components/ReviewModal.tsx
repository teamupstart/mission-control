import { useCallback, useContext, useEffect, useRef, useState, type Ref } from "react";
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
import { canSnoozeReview } from "@shared/review-snooze.ts";
import { ReminderBanner, RemindLaterButton, SnoozeSheet } from "./ReviewSnooze.tsx";
import { RevisionTag } from "./ReviewRevision.tsx";
import { useWorkspacePaths, type SessionFilesController } from "../lib/sessionFiles.ts";
import { QuestionBody } from "./QuestionBody.tsx";
import { questionStatusLine, questionWait, useQuestionAgent, type QuestionAgent } from "../lib/async-questions.ts";
import { useNow } from "../useNow.ts";
import { useAgentName, useAgentNamesEnabled } from "../lib/agent-names.ts";
import { QuestionVoiceHint, VoiceAnswerFooter } from "./VoiceAnswerFooter.tsx";
import { VoiceAnswersContext } from "../lib/voice-open-cards.ts";
import { VoiceRosterContext } from "../lib/voice-roster.ts";
import { AgentName } from "./AgentName.tsx";

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
  reviews, focusQuestion, onQuestionFocused,
  dialog = null,
  onClose,
  onMovedToChat,
  files,
  onOpenPath,
}: {
  session: Session;
  reviews: ReviewItem[];
  focusQuestion?: { reviewId: string } | null;
  onQuestionFocused?: (request: { reviewId: string }) => void;
  /**
   * A menu the session is parked on (`activePaneDialog`), answered here by the Conversation's
   * own `PaneDialogPrompt`, so a resident's every requested decision opens in this one modal.
   */
  dialog?: PaneDialog | null;
  onClose: () => void;
  /** A question was moved to the conversation; the caller takes the operator there. */
  onMovedToChat?: (sessionId: string) => void;
  /**
   * The session files store, for the checkout listing that decides which paths a question's
   * text names. The question is often a choice between files the agent just wrote - mock-ups
   * above all - and this card is where the operator makes it.
   */
  files?: SessionFilesController;
  /** Open one checkout file in the session's Files tab. */
  onOpenPath?: (sessionId: string, path: string) => void;
}): React.JSX.Element {
  const selectedIsDrawn = reviews.some(r => r.id === focusQuestion?.reviewId);
  useEffect(() => {
    if (!selectedIsDrawn || !focusQuestion) return;
    const card = document.querySelector<HTMLElement>(`.review-modal [data-voice-question="${CSS.escape(focusQuestion.reviewId)}"]`);
    card?.focus();
    if (card && document.activeElement === card) onQuestionFocused?.(focusQuestion);
  }, [focusQuestion, selectedIsDrawn, onQuestionFocused]);
  const checkoutPaths = useWorkspacePaths(files, session.id, Boolean(session.cwd && onOpenPath));
  const openPath = onOpenPath
    ? (path: string) => {
        onClose();
        onOpenPath(session.id, path);
      }
    : undefined;
  const tourTargetRef = useTourTaskTargetRef<HTMLElement>("see-work:review-modal", session.task?.id);
  const pending = reviews.length + (dialog ? 1 : 0);
  const name = useAgentName(session, session.name);
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
          <AgentName view={name} />
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
          <ReviewCard
            key={r.id}
            review={r}
            session={session}
            note={session.note}
            onMovedToChat={onMovedToChat}
            checkoutPaths={checkoutPaths}
            onOpenPath={openPath}
          />
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
  titleRef,
  session = null,
  note: sessionNote,
  onMovedToChat,
  checkoutPaths = null,
  onOpenPath,
}: {
  review: ReviewItem;
  /** The inbox uses this to land the keyboard at a particular question. */
  titleRef?: Ref<HTMLHeadingElement>;
  /**
   * The session that asked, live. A message-mode question (`async-input`) reads it for its status
   * line: whether the agent is still working past the question or has stopped on it. Every other
   * review ignores it.
   */
  session?: Pick<Session, "id" | "name" | "state" | "stateConfirmed" | "task"> | null;
  note?: SessionNoteSummary | null;
  /** Paths in the session's checkout; a question naming one links it to Files. */
  checkoutPaths?: ReadonlySet<string> | null;
  onOpenPath?: (path: string) => void;
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
  // "Remind me later" opens a sheet in place of the answer form. Local to this mount on
  // purpose: closing the modal mid-choice drops the half-made snooze, never the draft answer.
  const [snoozing, setSnoozing] = useState(false);
  const snoozable = canSnoozeReview(review);
  // How the agent waits right now, so Remind me later says what is true of it (`QUESTION_ACTION_COPY`).
  // The asking session, marked when it is a resident the operator paused (`questionAgentStatus`).
  const agent = useQuestionAgent(session);
  const wait = questionWait(review, agent);
  // Who asked, by the one naming rule: a line in the head while the `inbox` flag is on, and the
  // name the question's spoken hints address. Nothing new is drawn with the flag off.
  const namesOn = useAgentNamesEnabled();
  const asker = useAgentName(session ?? { name: "" }, session?.name ?? "");
  const question = review.kind === "input";
  const foremanTriggerRef = useRef<HTMLButtonElement>(null);
  const decisions = reviewDecisions(review);
  const voiceAnswers = useContext(VoiceAnswersContext);
  const drawnQuestion = question && voiceAnswers !== null && !snoozing;
  const voiceQuestion = drawnQuestion && (decisions?.length ?? 0) <= 1;
  const pendingAnswer = voiceQuestion ? voiceAnswers.answers.get(review.id) : undefined;
  const spokenName = useContext(VoiceRosterContext).find(row => row.sessionId === review.sessionId)?.name;
  // The daemon owns the deadline. Once the operator edits this preview, the draft
  // owns the inputs immediately, including while the cancel request is in flight.
  const [editCancel, setEditCancel] = useState<{ id: string; status: "requested" | "failed" } | null>(null);
  const origin = pendingAnswer?.originId ?? pendingAnswer?.id;
  const manualEdit = !!origin && draft.voiceEditOrigin === origin;
  const cancelStatus = manualEdit ? (editCancel?.id === pendingAnswer?.id ? editCancel?.status : undefined) ?? "requested" : undefined;
  const preview = cancelStatus ? undefined : pendingAnswer;
  const voiceSelection = preview?.selections?.[0];
  const displayedAnswers = voiceSelection ? { [voiceSelection.decisionId]: {
    selected: voiceSelection.selected, other: voiceSelection.other ?? "", note: "",
  } } : draft.decisions;
  const requestedRevision = useRef<string | undefined>(undefined);
  const cancelEdited = useCallback(async (revision: string, originId: string) => {
    requestedRevision.current = revision;
    const attempt = { id: revision, status: "requested" as const };
    setEditCancel(attempt);
    const result = await api.voiceAnswerAction(originId, "cancel", undefined, review.id);
    if (!result.ok) setEditCancel(current => current === attempt ? { ...attempt, status: "failed" } : current);
  }, [review.id]);
  const revision = pendingAnswer?.id;
  useEffect(() => {
    // A correction may overtake cancellation. The draft keeps the input and the
    // corrected action gets its own retry even if the first request is stalled.
    if (manualEdit && revision && origin && requestedRevision.current !== revision) void cancelEdited(revision, origin);
  }, [manualEdit, revision, origin, cancelEdited]);
  const answerAction = async (action: "cancel" | "send-now") => {
    if (!pendingAnswer) return;
    if (manualEdit && action === "cancel") return cancelEdited(pendingAnswer.id, origin!);
    const result = await api.voiceAnswerAction(pendingAnswer.id, action, voiceAnswers?.windowId);
    if (!result.ok) setErr(result.error ?? "This answer is no longer pending.");
  };
  function cancelForManualEdit() {
    if (!preview || !origin) return;
    updateDraft(d => ({ ...d, voiceEditOrigin: origin }));
    void cancelEdited(preview.id, origin);
  }
  const footer = pendingAnswer && <VoiceAnswerFooter answer={pendingAnswer} options={decisions?.[0]?.options}
    act={answerAction} canSubmit={!!voiceAnswers?.windowId && voiceAnswers.windowId === pendingAnswer.footerWindowId} cancelStatus={cancelStatus} />;
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

  const laterButton = snoozable ? (
    <RemindLaterButton disabled={busy} onClick={() => setSnoozing(true)} wait={wait} />
  ) : null;

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
    <section className={`review review-${review.kind}`} data-dialog-action-scope data-voice-question={drawnQuestion ? review.id : undefined} tabIndex={drawnQuestion ? -1 : undefined}>
      <div className="review-head">
        <span className={`kind-tag kind-${review.kind}`}>
          {review.kind === "plan-decisions" ? "decisions" : review.kind}
        </span>
        {review.snooze?.remindedAt != null && <span className="kind-tag kind-reminder">reminder</span>}
        {namesOn && session && <AgentName view={asker} className="review-agent" />}
        <h3 ref={titleRef} tabIndex={titleRef ? -1 : undefined}>{review.title}</h3>
        <RevisionTag review={review} />
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
        should be (Markdown, with the `markdown-questions` preview on). The whole block is
        skipped when there is nothing to put in it, because `.review-content` is a bordered,
        margined box and an empty one is an artifact.
      */}
      <QuestionStatus review={review} session={agent} />
      <ReminderBanner review={review} />

      {showsBody(review) && (
        <div className="review-content">
          {review.kind === "diff" && <DiffView diff={review.body} />}
          {(review.kind === "plan" || review.kind === "plan-decisions") && (
            <PlanView markdown={review.body} />
          )}
          {review.kind === "input" && (
            <QuestionBody
              className="question"
              text={inputBody(review)}
              paths={checkoutPaths}
              onOpenPath={onOpenPath}
            />
          )}
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
      {snoozing && snoozable ? (
        <SnoozeSheet review={review} wait={wait} onBack={() => setSnoozing(false)} />
      ) : decisions ? (
        <>

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
          voiceLetters={voiceQuestion}
          voicePending={!!preview}
          footer={footer}
          answers={displayedAnswers}
          onAnswersChange={(change) => {
            updateDraft((d) => ({ ...d, decisions: change(voiceSelection ? displayedAnswers : d.decisions) }));
            cancelForManualEdit();
          }}
          besideSubmit={
            // A snoozable question is a `request_input` ask, never a plan bundle, so at
            // most one of the two ever fills this slot.
            laterButton ?? (finalBundle && (
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
            ))
          }
          onDismiss={() => void resolve("dismiss", null)}
          onSubmit={(response, selections) => void resolve("answer", response, selections)}
        />
        </>
      ) : review.kind === "plan-decisions" ? null : review.kind === "input" ? (
        <div className="review-actions">
          <textarea
            className={preview ? "answer-box av-picked" : "answer-box"}
            placeholder="Your answer…"
            value={preview?.text ?? answer}
            onChange={(e) => { setAnswer(e.target.value); cancelForManualEdit(); }}
            rows={2}
          />
          {footer ?? <>
          {dismissButton}
          <Tooltip label="Skip answering for now: the agent explains this question in the conversation and waits for you">
            <button className="btn btn-chat" disabled={busy} onClick={chatAboutQuestion}>
              <ChatGlyph />
              {CHAT_ABOUT_IT}
            </button>
          </Tooltip>
          {laterButton}
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
          </>}
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
      {voiceQuestion && !pendingAnswer && <QuestionVoiceHint name={spokenName} decision={decisions?.[0]} />}
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

/**
 * Under a message-mode question's title (`async-input`): whether its agent is still working past
 * it, with the agent's own meanwhile line, or has stopped on it, and how long ago it was asked.
 * Nothing for a question its agent waits on inside the call, which reads exactly as it always has.
 */
function QuestionStatus({
  review,
  session,
}: {
  review: ReviewItem;
  session: QuestionAgent | null;
}): React.JSX.Element | null {
  const now = useNow(review.waitMode === "message", 10_000);
  const line = questionStatusLine(review, session, now);
  if (!line) return null;
  return (
    <p className={`review-wait review-wait-${line.status}`}>
      <span className="review-wait-state">{line.label}</span>
      {line.meanwhile && (
        <span className="review-wait-meanwhile">
          <span className="review-wait-tag">Meanwhile</span> {line.meanwhile}
        </span>
      )}
      <span className="review-wait-asked">{line.asked}</span>
    </p>
  );
}
