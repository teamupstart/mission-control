import { useState } from "react";
import type { ReviewItem, Session } from "@shared/types.ts";
import {
  DEFAULT_REVIEW_SNOOZE_DELAY,
  REVIEW_SNOOZE_DELAYS,
  provisionalOptions,
  reviewSnoozeDelay,
  snoozeMeanwhileLabel,
  snoozeMeanwhileSince,
  type ReviewSnoozeDelayId,
  type ReviewSnoozeMeanwhile,
} from "@shared/review-snooze.ts";
import { api } from "../lib/api.ts";
import { untilTime } from "../lib/format.ts";
import { reminderClock } from "../lib/review-snooze.ts";
import { useNow } from "../useNow.ts";
import { AgentDot } from "./session-bits.tsx";
import { ConversationTimestamp } from "./ConversationTimestamp.tsx";
import { Tooltip } from "./Tooltip.tsx";

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

/** The footer button that opens the sheet, beside Dismiss on the question's card. */
export function RemindLaterButton({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <Tooltip label="Not ready to decide? The agent stops waiting and carries on, and this question comes back to you later">
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
  onBack,
}: {
  review: ReviewItem;
  /** Close the sheet without snoozing; the form comes back as it was. */
  onBack: () => void;
}): React.JSX.Element {
  const now = useNow(true);
  const [delay, setDelay] = useState<ReviewSnoozeDelayId>(DEFAULT_REVIEW_SNOOZE_DELAY);
  const [choice, setChoice] = useState<MeanwhileChoice>("judgment");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const options = provisionalOptions(review);
  const earlier = review.snooze ?? null;
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
              label="Use your best judgment"
              detail="It picks, says which, and keeps that choice easy to change"
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
        <Tooltip label="Park this question; the agent stops waiting now">
          <button type="button" className="btn btn-snooze" data-dialog-default disabled={busy} onClick={() => void submit()}>
            <ClockGlyph />
            Remind me {back.startsWith("tomorrow") ? back : `at ${back}`}
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
  return (
    <label className={`decision-option snooze-meanwhile-option${checked ? " is-picked" : ""}`}>
      <input type="radio" name={name} checked={checked} disabled={disabled} onChange={onPick} />
      <span className="decision-option-body">
        <span className="decision-option-label">{label}</span>
        <span className="decision-option-detail">{detail}</span>
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
  return (
    <section className="inbox-item inbox-snoozed" aria-label={`Snoozed: ${review.title}`}>
      <div className="inbox-head">
        <AgentDot agent={session.agent} />
        <strong>{session.name || "(unnamed)"}</strong>
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
export function SnoozedReviewCard({ review }: { review: ReviewItem }): React.JSX.Element {
  const { busy, err, wake } = useWake(review.id);
  const snooze = review.snooze;
  return (
    <div className="review-snoozed" role="note" aria-label={`Snoozed: ${review.title}`}>
      <div className="review-answer-head">
        <span className="review-answer-who review-snoozed-who">Snoozed</span>
        <span className="review-answer-title">{review.title}</span>
        <ConversationTimestamp at={snooze?.at ?? review.createdAt} className="turn-time" />
      </div>
      <div className="review-snoozed-foot">
        <ClockGlyph />
        <span>
          {snooze ? <SnoozeWhen until={snooze.until} /> : "Snoozed"}
          {snooze && <> · meanwhile: {lowerFirst(snoozeMeanwhileLabel(review, snooze))}</>}
        </span>
        <span className="inbox-spacer" />
        <AnswerNowButton busy={busy} onClick={wake} />
      </div>
      {err && <p className="review-err">{err}</p>}
    </div>
  );
}
