import type { HintName } from "@shared/inbox.ts";
import { PlanVoiceHint } from "./VoiceAnswerFooter.tsx";
import { VoiceIcon } from "./VoiceCardView.tsx";
import { ordinal, spokenOrdinal, optionLetter } from "@shared/voice-answers.ts";
import { useRef, useLayoutEffect, useState } from "react";
import type { PlanDecision, PlanDecisionAnswer } from "@shared/types.ts";
import { CHAT_ABOUT_IT, formatResponse } from "@shared/review-item.ts";
import { isAnswered } from "../lib/reviews.ts";
import { ForemanPickMark } from "./ForemanRecommendation.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { readReviewDraft, type DecisionAnswer as Answer, type DecisionAnswers as Answers } from "../lib/review-drafts.ts";

const EMPTY: Answer = { selected: [], other: "", note: "" };

/** Stable inside one review form, shared with its Foreman recommendation matcher. */
export function decisionChoiceKey(decisionId: string, optionId: string): string {
  return `${decisionId}:${optionId}`;
}

/**
 * The form's state as the wire shape, in the order the questions were asked.
 *
 * One conversion at the edge rather than holding `PlanDecisionAnswer[]` throughout: the
 * form indexes by decision id on every keystroke, which a map does well and an array does
 * not. Every decision is emitted, answered or not - an unanswered one is a real fact about
 * a submission, and dropping it would make a form that could not have been submitted look
 * like one that never asked. Blank "Other" text normalizes to null and a blank note is
 * omitted, so "typed nothing" and "typed and cleared it" are the same record.
 */
function toDecisionAnswers(decisions: PlanDecision[], answers: Answers): PlanDecisionAnswer[] {
  return decisions.map((d) => {
    const a = answers[d.id];
    // Moved to chat: nothing picked before the move is an answer. The note and anything typed
    // in the text box travel, because beside a moved question they say what is unclear.
    if (a?.chat) {
      return {
        decisionId: d.id,
        selected: [],
        other: a.other.trim() ? a.other.trim() : null,
        chat: true,
        ...(a.note.trim() ? { note: a.note.trim() } : {}),
      };
    }
    return {
      decisionId: d.id,
      selected: a?.selected ?? [],
      other: a?.other.trim() ? a.other.trim() : null,
      // Present only when typed, so an answer without one keeps the shape it always had.
      ...(a?.note.trim() ? { note: a.note.trim() } : {}),
    };
  });
}

/**
 * Renders each decision as a radio group (choose one) or checkbox group (choose many),
 * with an optional free-text "Other". Its Submit hands up both the formatted response the
 * agent will read and the structured selections behind it, so the caller can resolve the
 * review with `action: "answer"` and the conversation can later replay the form. When
 * `onDismiss` is supplied, Dismiss resolves the whole request without submitting any
 * selections.
 */
export function DecisionForm({
  decisions,
  busy,
  onSubmit,
  onDismiss,
  /** Opening line of the response the agent receives - see `formatResponse`. */
  lead = "Plan decisions submitted:",
  /**
   * Drop the visible `<legend>`, because the caller already displays the question.
   *
   * For an `input` review the question is already above the form - as the review's title,
   * and in full as the body paragraph when the title had to be clipped - so a legend beneath
   * it says the same sentence a third time. The text still reaches assistive tech as the
   * fieldset's `aria-label` - the group needs a name whether or not one is drawn. A
   * `plan-decisions` form has several questions under one plan title and always shows them.
   */
  hideQuestions = false,
  /**
   * Namespace for the radio/checkbox `name` attributes this form emits.
   *
   * A group `name` is DOCUMENT-scoped, not component-scoped, and `ReviewModal` renders every
   * pending review of a session into one document. `request_input` hardcodes its decision id
   * as `q`, so two option-carrying `input` reviews - an abandoned ask still pending while the
   * agent asks again - would put two radio groups on screen under the same name. The browser
   * then treats them as ONE group: clicking in the second unchecks the first in the DOM,
   * while React re-renders only the card whose state changed, so the first card shows nothing
   * selected even though its state still holds a selection and its Submit stays enabled.
   *
   * Defaulted rather than required because a form rendered on its own cannot collide, and
   * because the decision id itself must stay untouched - it is echoed in the response payload.
   */
  namePrefix = "d",
  /**
   * Draw an optional note box under every decision, so the human can pick an option AND send
   * instructions with it. Off by default: a form whose resolution never reaches an agent as
   * prose - the product-issue confirmation, which acts on the selection alone - must not
   * offer a box whose text would go nowhere.
   */
  allowNote = false,
  /**
   * Offer "Chat about it" on every question, plus "Chat about all" when there are several.
   *
   * A moved question counts as answered, so the human can submit what they know and take the
   * rest to the conversation in one go; `formatResponse` tells the agent to explain those and
   * wait rather than decide them. Off by default, like the note: a form rendered on its own
   * has no conversation to move anything into.
   */
  allowChat = false,
  foremanRecommended,
  besideSubmit, footer, voiceLetters, voicePending, planAddress,
  answers: heldAnswers,
  onAnswersChange,
}: {
  decisions: PlanDecision[];
  busy: boolean;
  /**
   * `response` is the agent's tool result, `selections` the record kept beside it. Handed
   * up together, from one derivation, so the two can never describe different answers.
   */
  onSubmit: (response: string, selections: PlanDecisionAnswer[], submitId?: string) => void;
  /** Resolve this decision request without sending any of its options as an answer. */
  onDismiss?: () => void;
  lead?: string;
  hideQuestions?: boolean;
  namePrefix?: string;
  allowNote?: boolean;
  allowChat?: boolean;
  /**
   * Exact decision-option keys Foreman's prose names.
   *
   * The mark is deliberately NOT gated on the sidecar being open: the pick is legible at a
   * glance, and the sidecar is opened only for the reasoning behind it. Empty unless a live
   * Foreman note names this exact form, so an unmatched recommendation marks nothing.
   */
  foremanRecommended?: ReadonlySet<string>;
  /** A control drawn next to Submit, such as the final-bundle form's standing approval. */
  besideSubmit?: React.ReactNode;
  footer?: React.ReactNode;
  planAddress?: HintName;
  voiceLetters?: boolean;
  voicePending?: boolean;
  /**
   * The answers, held by the caller instead of by this mount.
   *
   * A review card passes its parked draft here so picks and typed text survive the form
   * unmounting - the modal closing, the inbox folding, the page reloading. Left out, the form
   * keeps its own state, as a standalone form with nothing to outlive has always done.
   */
  answers?: Answers;
  onAnswersChange?: (change: (prev: Answers) => Answers) => void;
}): React.JSX.Element {
  const [ownAnswers, setOwnAnswers] = useState<Answers>({});
  const answers = heldAnswers ?? ownAnswers;
  const setAnswers = onAnswersChange ?? setOwnAnswers;

  function get(id: string): Answer {
    return answers[id] ?? EMPTY;
  }

  function editDecision(id: string, changesChoice: boolean, change: (answer: Answer) => Answer): void {
    const manualChoiceAt = planAddress && changesChoice ? performance.timeOrigin + performance.now() : undefined;
    setAnswers(prev => {
      const answer = change(prev[id] ?? EMPTY);
      return { ...prev, [id]: manualChoiceAt === undefined ? answer : { ...answer, manualChoiceAt } };
    });
  }

  function choose(d: PlanDecision, optionId: string, checked: boolean): void {
    editDecision(d.id, true, (cur) => {
      let selected: string[];
      if (!checked) {
        selected = cur.selected.filter((x) => x !== optionId);
      } else if (d.multiSelect) {
        selected = [...cur.selected, optionId];
      } else {
        selected = [optionId]; // radio: single choice replaces
      }
      return { ...cur, selected, chat: false, voice: false };
    });
  }

  /**
   * A click on a radio that was ALREADY checked clears it.
   *
   * A browser never fires `change` for that click, so a radio group on its own can only move a
   * pick, never take it back - the human who picked by mistake had to pick something else or
   * dismiss the whole ask. `wasChecked` is this render's state, read before the click lands.
   * Checkboxes toggle natively and need nothing here.
   */
  function clearOnReclick(d: PlanDecision, wasChecked: boolean, clear: () => void): void {
    if (!d.multiSelect && wasChecked) clear();
  }

  function moveToChat(id: string, chat: boolean): void {
    // Moving replaces the picks but keeps the typed context for the conversation.
    editDecision(id, true, cur => chat ? { ...cur, selected: [], chat: true, voice: false } : { ...cur, chat: false });
  }

  function setText(id: string, field: "other" | "note", text: string): void {
    // Typing never changes the pick. The box is an answer of its own only when nothing is
    // picked; beside a pick, or beside "Chat about it", it is context for that choice.
    editDecision(id, field === "other", cur => ({ ...cur, [field]: text }));
  }

  // Built once per render and used for both the completeness test and the submit, so the
  // button's enabled state is decided over exactly the payload it would send.
  const payload = toDecisionAnswers(decisions, answers);
  const complete = decisions.length > 0 && decisions.every((d, i) => isAnswered(d, payload[i]));
  const formRef = useRef<HTMLDivElement>(null);
  const [refused, setRefused] = useState<string>();
  const missing = decisions.findIndex((d, i) => !isAnswered(d, payload[i]));
  const marked = missing >= 0 && decisions[missing]?.id === refused;
  useLayoutEffect(() => {
    const card = formRef.current?.closest<HTMLElement>("[data-voice-kind=plan]");
    const reviewId = card?.dataset.voiceId;
    if (!planAddress || !card || !reviewId) return;
    const submit = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (busy) return;
      // A fill event can update the parked draft just before this event, between renders.
      const current = toDecisionAnswers(decisions, readReviewDraft(reviewId).decisions);
      const firstMissing = decisions.findIndex((d, i) => !isAnswered(d, current[i]));
      if (firstMissing < 0 && decisions.length) onSubmit(formatResponse(decisions, current, lead), current, id);
      else if (firstMissing >= 0) {
        setRefused(decisions[firstMissing]!.id);
        void fetch("/api/voice/form-submit/" + id + "/refuse", { method: "POST",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ missing: firstMissing + 1 }) }).catch(() => {});
      }
    };
    card.addEventListener("voice-form-submit", submit);
    return () => card.removeEventListener("voice-form-submit", submit);
  });
  const chatCount = allowChat ? payload.filter((a) => a.chat).length : 0;

  function chatAboutAll(): void {
    const all = toDecisionAnswers(
      decisions,
      Object.fromEntries(decisions.map((d) => [d.id, { ...get(d.id), chat: true }])),
    );
    onSubmit(formatResponse(decisions, all, lead), all);
  }

  return (
    <div className="decisions" ref={formRef}>
      {decisions.map((d, position) => (
        <fieldset
          key={d.id}
          className={planAddress && marked && position === missing ? "decision pd-missing" : "decision"}
          aria-label={hideQuestions ? d.question : undefined}
        >
          {!hideQuestions && (
            <legend className="decision-q">
              {planAddress && <span className={`pd-ord${marked && position === missing ? " is-missing" : get(d.id).voice ? " is-voice" : ""}`}>
                {get(d.id).voice && <VoiceIcon name="mic" />}{ordinal(position + 1)}
              </span>}
              {d.question}
            </legend>
          )}
          {d.options.map((o, index) => {
            const foremanPick = foremanRecommended?.has(decisionChoiceKey(d.id, o.id));
            return (
            <label
              key={o.id}
              className={`decision-option${planAddress && get(d.id).voice && get(d.id).selected.includes(o.id) ? " pd-picked" : ""}${voicePending ? (get(d.id).selected.includes(o.id) ? " av-picked" : " av-dim") : ""}${foremanPick ? " decision-foreman-pick" : ""}`}
            >
              {/*
                No `Tooltip`: it repeated the detail printed below, and picking an option
                focuses the radio, so the bubble stayed up over the question until blur. The
                enclosing label already names the radio. "Chat about it" keeps its bubble.
              */}
              <input
                type={d.multiSelect ? "checkbox" : "radio"}
                name={`${namePrefix}-${d.id}`}
                checked={get(d.id).selected.includes(o.id)}
                onChange={(e) => choose(d, o.id, e.target.checked)}
                onClick={() =>
                  clearOnReclick(d, get(d.id).selected.includes(o.id), () => choose(d, o.id, false))
                }
                disabled={busy}
              />
              {planAddress && <span className="pd-key">{optionLetter(index)}</span>}
              {voiceLetters && <span className="av-key">{optionLetter(index)}</span>}
              <span className="decision-option-body">
                <span className="decision-option-label">
                  {o.label}
                  {o.recommended && <span className="decision-rec"> · recommended</span>}
                </span>
                {o.detail && <span className="decision-option-detail">{o.detail}</span>}
              </span>
              {foremanPick && <ForemanPickMark />}
            </label>
            );
          })}
          {allowChat && (
            <label className={`decision-option decision-chat${get(d.id).chat ? " is-chat" : ""}`}>
              <Tooltip label="Skip choosing for now: the agent explains this question in the conversation and waits for you">
                <input
                  type={d.multiSelect ? "checkbox" : "radio"}
                  name={`${namePrefix}-${d.id}`}
                  checked={get(d.id).chat === true}
                  aria-label={CHAT_ABOUT_IT}
                  onChange={(e) => moveToChat(d.id, e.target.checked)}
                  onClick={() => clearOnReclick(d, get(d.id).chat === true, () => moveToChat(d.id, false))}
                  disabled={busy}
                />
              </Tooltip>
              <span className="decision-option-body">
                <span className="decision-option-label">
                  <ChatGlyph />
                  {CHAT_ABOUT_IT}
                </span>
              </span>
            </label>
          )}
          {/*
            After "Chat about it", not before it: that row is one of the group's choices and
            belongs with the others, and the text box below qualifies whichever is picked.
          */}
          {d.allowOther && (
            <input
              className={`decision-other${voicePending ? (get(d.id).other ? " av-picked" : " av-dim") : ""}`}
              aria-label={`Other answer or context: ${d.question}`}
              placeholder="Other answer, or add context…"
              value={get(d.id).other}
              onChange={(e) => setText(d.id, "other", e.target.value)}
              disabled={busy}
            />
          )}
          {allowNote && (
            <textarea
              className="decision-note"
              aria-label={`Note to the agent: ${d.question}`}
              placeholder="Optional note to the agent…"
              rows={3}
              value={get(d.id).note}
              onChange={(e) => setText(d.id, "note", e.target.value)}
              disabled={busy}
            />
          )}
          {planAddress && marked && position === missing && <p className="pd-miss" role="alert"><VoiceIcon name="warn" />Not sent. The {spokenOrdinal(position + 1)} one has no answer yet.</p>}
        </fieldset>
      ))}
      {footer || <div className="decisions-actions">
        {onDismiss && (
          <Tooltip label="Dismiss this decision request without sending an answer">
            <button className="btn btn-ghost" disabled={busy} onClick={onDismiss}>
              Dismiss
            </button>
          </Tooltip>
        )}
        {besideSubmit}
        {allowChat && decisions.length > 1 && (
          <Tooltip label="Move every question to the conversation: the agent explains them and waits for you">
            <button
              className={`btn btn-chat${besideSubmit ? "" : " decisions-chat-all"}`}
              disabled={busy}
              onClick={chatAboutAll}
            >
              Chat about all
            </button>
          </Tooltip>
        )}
        <Tooltip
          label={
            !complete
              ? `Answer every decision above${allowChat ? ", or move it to chat," : ""} first`
              : chatCount
                ? "Send these answers, and ask the agent to discuss the rest in the conversation"
                : "Send these decisions back to the agent"
          }
        >
          <button
            className="btn btn-approve"
            data-dialog-default
            disabled={busy || !complete}
            onClick={() => onSubmit(formatResponse(decisions, payload, lead), payload)}
          >
            {chatCount ? `Submit & chat (${chatCount})` : "Submit"}
          </button>
        </Tooltip>
      </div>}
      {planAddress && <PlanVoiceHint address={planAddress} decisions={decisions} missing={missing}
        answered={payload.filter((answer, i) => isAnswered(decisions[i]!, answer)).length} refused={marked} />}
    </div>
  );
}

export function ChatGlyph(): React.JSX.Element {
  return (
    <svg className="chat-glyph" viewBox="0 0 16 14" aria-hidden="true" focusable="false">
      <path
        d="M2 1.5h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H7l-3.5 2.7V10.5H2a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}
