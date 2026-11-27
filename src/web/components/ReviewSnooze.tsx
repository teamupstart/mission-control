import { useId, useState } from "react";
import { agentKeepsWorking } from "@shared/async-input.ts";
import type { ReviewItem, Session } from "@shared/types.ts";
import {
  DEFAULT_REVIEW_SNOOZE_DELAY,
  KEEP_DOING_WHAT_IT_SAID,
  REVIEW_SNOOZE_DELAYS,
  provisionalOptions,
  reviewSnoozeDelay,
  snoozeMeanwhileLabel,
  snoozeMeanwhileSince,
  snoozeToldNothing,
  type ReviewSnoozeDelayId,
  type ReviewSnoozeMeanwhile,
} from "@shared/review-snooze.ts";
import { api } from "../lib/api.ts";
import { untilTime } from "../lib/format.ts";
import { reminderClock } from "../lib/review-snooze.ts";
import { useNow } from "../useNow.ts";
import { QUESTION_ACTION_COPY, type QuestionWait } from "../lib/async-questions.ts";
import { AgentDot } from "./session-bits.tsx";
import { ConversationTimestamp } from "./ConversationTimestamp.tsx";
import { ReviewDeliveryNote, type ReviewCardDelivery } from "./ReviewAnswer.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { useAgentName } from "../lib/agent-names.ts";
import { AgentName } from "./AgentName.tsx";

/** An alarm clock: the mark every "Remind me later" surface wears. */
export function ClockGlyph(): React.JSX.Element {
  return (
    <svg className="clock-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="9" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 6.2V9l2 1.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M3 3.2 4.8 1.8M13 3.2l-1.8-1.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The footer button that opens the sheet, beside Dismiss on the question's card. `wait`: how the
 * agent waits right now. A message-mode question (`async-input`) never held a call, so a snooze
 * releases no one: its words say whether the agent is still working or has stopped on it.
 */
export function RemindLaterButton({
  disabled,
  onClick,
  wait = "call",
}: {
  disabled: boolean;
  onClick: () => void;
  wait?: QuestionWait;
}): React.JSX.Element {
  return (
    <Tooltip label={QUESTION_ACTION_COPY[wait].remindLater}>
      <button type="button" className="btn btn-later" disabled={disabled} onClick={onClick}>
        <ClockGlyph />
        Remind me later…
      </button>
    </Tooltip>
  );
}

type MeanwhileChoice = "judgment" | "hold" | `option:${string}`;

/** A label read mid-sentence. Only the first letter: an option's own label keeps its case. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function meanwhileFromChoice(choice: MeanwhileChoice): ReviewSnoozeMeanwhile {
  if (choice === "judgment" || choice === "hold") return { mode: choice };
  return { mode: "option", optionId: choice.slice("option:".length) };
}

/**
 * "Remind me later", opened in place of the answer form: when to ask again, and - the first
 * time only - what the agent does until then.
 *
 * The second question is asked once because the agent is told once. A question that already
 * came back has an agent already following an instruction, so the sheet says which instead of
 * offering a choice it could not deliver.
 */
export function SnoozeSheet({
  review,
  wait = agentKeepsWorking(review) ? "working" : "call",
  onBack,
}: {
  review: ReviewItem;
  /** How the agent waits right now (`questionWait`); the card that opens the sheet passes it. */
  wait?: QuestionWait;
  /** Close the sheet without snoozing; the form comes back as it was. */
  onBack: () => void;
}): React.JSX.Element {
  const now = useNow(true);
  const [delay, setDelay] = useState<ReviewSnoozeDelayId>(DEFAULT_REVIEW_SNOOZE_DELAY);
  const [choice, setChoice] = useState<MeanwhileChoice>("judgment");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const options = provisionalOptions(review);
  // The agent is told what to do meanwhile only once, so a question that came back keeps that
  // choice - unless nothing was ever told: a filed question snoozed on "Keep doing what it said"
  // sent nothing, so the choice is offered again and a Hold or option now still reaches it. Read
  // from what the daemon recorded (`instructed`), never inferred from the mode.
  const earlier = review.snooze && !snoozeToldNothing(review, review.snooze) ? review.snooze : null;
  // A message-mode question's agent already carried on when it asked (`async-input`): the default
  // lets it keep doing what it said, and sends it nothing. Still the `judgment` mode on the wire.
  const carryingOn = wait !== "call";
  const name = `snooze-${review.id}`;
  const back = reminderClock(now + reviewSnoozeDelay(delay).ms, now);

  async function submit(): Promise<void> {
    setBusy(true);
    setErr(null);
    const r = await api.snoozeReview(review.id, delay, meanwhileFromChoice(choice));
    setBusy(false);
    if (!r.ok) setErr(r.error ?? "failed");
  }

  return (
    <div className="snooze-sheet" role="group" aria-label="Remind me later">
      <p className="snooze-sheet-title">
        <ClockGlyph />
        Remind me later
      </p>
      <fieldset className="snooze-sheet-field">
        <legend className="snooze-sheet-label">Ask me again in</legend>
        <div className="snooze-delays">
          {REVIEW_SNOOZE_DELAYS.map((d) => (
            <label key={d.id} className={`snooze-delay${delay === d.id ? " is-picked" : ""}`}>
              <Tooltip label={`Ask again in ${d.label}, at ${reminderClock(now + d.ms, now)}`}>
                <input
                  type="radio"
                  name={`${name}-delay`}
                  aria-label={d.label}
                  checked={delay === d.id}
                  disabled={busy}
                  onChange={() => setDelay(d.id)}
                />
              </Tooltip>
              <span aria-hidden="true">{d.short}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {earlier ? (
        <p className="snooze-sheet-note">
          The agent keeps doing what you chose last time: {lowerFirst(snoozeMeanwhileLabel(review, earlier))}.
        </p>
      ) : (
        <fieldset className="snooze-sheet-field">
          <legend className="snooze-sheet-label">Meanwhile, the agent should</legend>
          <div className="snooze-meanwhile">
            <MeanwhileRow
              name={`${name}-meanwhile`}
              label={carryingOn ? KEEP_DOING_WHAT_IT_SAID : "Use your best judgment"}
              detail={carryingOn
                ? `${review.meanwhile
                  ? `It said "${review.meanwhile.replace(/[.\s]+$/, "")}".`
                  : "It already carried on when it asked."}${wait === "stopped" ? " It has since stopped." : ""} Nothing is sent to it`
                : "It picks, says which, and keeps that choice easy to change"}
              checked={choice === "judgment"}
              disabled={busy}
              onPick={() => setChoice("judgment")}
            />
            {options.map((o) => (
              <MeanwhileRow
                key={o.id}
                name={`${name}-meanwhile`}
                label={`Go with "${o.label}" for now`}
                detail={o.recommended ? "The recommended option, as a provisional answer" : "As a provisional answer you confirm or change later"}
                checked={choice === `option:${o.id}`}
                disabled={busy}
                onPick={() => setChoice(`option:${o.id}`)}
              />
            ))}
            <MeanwhileRow
              name={`${name}-meanwhile`}
              label="Hold work that depends on this"
              detail="It does everything else first and leaves this part untouched"
              checked={choice === "hold"}
              disabled={busy}
              onPick={() => setChoice("hold")}
            />
          </div>
        </fieldset>
      )}
      <div className="snooze-sheet-actions">
        <Tooltip label="Back to the answer form, without snoozing">
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onBack}>
            Back
          </button>
        </Tooltip>
        <Tooltip label={QUESTION_ACTION_COPY[wait].snooze}>
          <button type="button" className="btn btn-snooze" data-dialog-default disabled={busy} onClick={() => void submit()}>
            <ClockGlyph />
            {/* "at 3:30 PM" for today; "tomorrow 2:30 PM" or "Mon 12:30 AM" stand on their own. */}
            Remind me {/^\d/.test(back) ? `at ${back}` : back}
          </button>
        </Tooltip>
      </div>
      {err && <p className="review-err">{err}</p>}
    </div>
  );
}

function MeanwhileRow({
  name,
  label,
  detail,
  checked,
  disabled,
  onPick,
}: {
  name: string;
  label: string;
  detail: string;
  checked: boolean;
  disabled: boolean;
  onPick: () => void;
}): React.JSX.Element {
  const detailId = useId();
  return (
    <label className={`decision-option snooze-meanwhile-option${checked ? " is-picked" : ""}`}>
      <input
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        aria-label={label}
        aria-describedby={detailId}
        onChange={onPick}
      />
      <span className="decision-option-body">
        <span className="decision-option-label">{label}</span>
        <span className="decision-option-detail" id={detailId}>{detail}</span>
      </span>
    </label>
  );
}

/**
 * The line a question that came back carries: when it was snoozed and what the agent has been
 * doing since, so the operator answers knowing there is work to reconcile.
 */
export function ReminderBanner({ review }: { review: ReviewItem }): React.JSX.Element | null {
  const snooze = review.snooze;
  if (!snooze || snooze.remindedAt === null) return null;
  return (
    <p className="reminder-banner" role="note">
      <ClockGlyph />
      <span>
        <strong>You snoozed this at {reminderClock(snooze.at, snooze.remindedAt)}.</strong>{" "}
        {snoozeMeanwhileSince(review, snooze)} Your answer reaches it as a message.
      </span>
    </p>
  );
}

/** When it comes back, as "3:30 PM · in 58m" - one clock per row, ticking on its own. */
function SnoozeWhen({ until }: { until: number }): React.JSX.Element {
  const now = useNow(true);
  return (
    <span className="snooze-when">
      back {reminderClock(until, now)} · {untilTime(until, now)}
    </span>
  );
}

function useWake(reviewId: string): { busy: boolean; err: string | null; wake: () => void } {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return {
    busy,
    err,
    wake: () => {
      setBusy(true);
      setErr(null);
      void api.wakeReview(reviewId).then((r) => {
        setBusy(false);
        if (!r.ok) setErr(r.error ?? "failed");
      });
    },
  };
}

function AnswerNowButton({ busy, onClick }: { busy: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <Tooltip label="Bring this question back now, ahead of its reminder">
      <button type="button" className="btn" disabled={busy} onClick={onClick}>
        Answer now
      </button>
    </Tooltip>
  );
}

/** One snoozed question in the attention inbox's Snoozed section. */
export function SnoozedInboxRow({ review, session }: { review: ReviewItem; session: Session }): React.JSX.Element {
  const { busy, err, wake } = useWake(review.id);
  const name = useAgentName(session, session.name || "(unnamed)");
  return (
    <section className="inbox-item inbox-snoozed" aria-label={`Snoozed: ${review.title}`}>
      <div className="inbox-head">
        <AgentDot agent={session.agent} />
        <AgentName view={name} />
        <span className="inbox-spacer" />
        {review.snooze && <SnoozeWhen until={review.snooze.until} />}
        <AnswerNowButton busy={busy} onClick={wake} />
      </div>
      <p className="inbox-line inbox-snoozed-question">{review.title}</p>
      {review.snooze && (
        <p className="inbox-line">Meanwhile: {lowerFirst(snoozeMeanwhileLabel(review, review.snooze))}</p>
      )}
      {err && <p className="inbox-line inbox-error" role="alert">{err}</p>}
    </section>
  );
}

/**
 * A snoozed question in the session's conversation, where its answer will later appear: what
 * was asked, when it comes back, and Answer now.
 */
export function SnoozedReviewCard({
  review,
  delivery,
}: {
  review: ReviewItem;
  /**
   * The "Remind me later" instruction's delivery turn (`async-input`), when the line is drawn
   * there rather than as the raw instruction text. The question may have been answered since:
   * then the line records the snooze and offers nothing to act on.
   */
  delivery?: ReviewCardDelivery;
}): React.JSX.Element {
  const { busy, err, wake } = useWake(review.id);
  const snooze = review.snooze;
  const parked = review.status === "snoozed";
  return (
    <div
      className="review-snoozed"
      role="note"
      aria-label={`Snoozed: ${review.title}`}
      data-turn-id={delivery?.state === "delivered" ? delivery.turnId : undefined}
    >
      <div className="review-answer-head">
        <span className="review-answer-who review-snoozed-who">Snoozed</span>
        <span className="review-answer-title">{review.title}</span>
        <ConversationTimestamp at={snooze?.at ?? review.createdAt} className="turn-time" />
      </div>
      <div className="review-snoozed-foot">
        <ClockGlyph />
        <span>
          {snooze && parked ? <SnoozeWhen until={snooze.until} /> : "Snoozed"}
          {snooze && <> · meanwhile: {lowerFirst(snoozeMeanwhileLabel(review, snooze))}</>}
        </span>
        <span className="inbox-spacer" />
        {parked && <AnswerNowButton busy={busy} onClick={wake} />}
      </div>
      {delivery && <ReviewDeliveryNote delivery={delivery} />}
      {err && <p className="review-err">{err}</p>}
    </div>
  );
}
