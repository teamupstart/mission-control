// How the dashboard tells a working agent's open questions from a stopped one's (`async-input`).
//
// Rendering only: every value here is read from `ReviewItem` and `Session` through the predicates
// `@shared/async-input.ts` already owns, so no surface grows a second opinion on who is waiting.
// The card's status line, the inbox's order, the state badge, the review chord and the Residents
// drawer all ask these functions, which is how one question reads the same everywhere it appears.

import { confirmedWorking, openQuestionCount, waitingOnOpenQuestion } from "@shared/async-input.ts";
import type { ReviewItem, Session } from "@shared/types.ts";
import { relativeTime, type StateDisplay } from "./format.ts";

/**
 * Whether the agent behind a message-mode question is still working past it or has stopped on it.
 *
 * The same reading as `waitingOnOpenQuestion`, the bucket's idle clause: a session that is not
 * confirmed working has stopped, and a resident never has, because it wakes on its own cadence.
 * Unconfirmed is stopped, as the bucket paints it amber. Stated for any session rather than only
 * one whose `openQuestions` is already raised, so a card drawn in the one frame between a
 * `review_upsert` and the `session_upsert` that counts it still reads correctly.
 */
export type QuestionAgentStatus = "working" | "stopped";

export function questionAgentStatus(
  session: Pick<Session, "state" | "stateConfirmed" | "task">,
): QuestionAgentStatus {
  return session.task?.kind === "resident" || confirmedWorking(session) ? "working" : "stopped";
}

/** The card's status line for a message-mode question, as the operator reads it. */
export interface QuestionStatusLine {
  status: QuestionAgentStatus;
  /** "Still working" or "Stopped, waiting on this answer". */
  label: string;
  /** The agent's own meanwhile line, shown only while it is still working past the question. */
  meanwhile: string | null;
  /** "asked 4m ago". */
  asked: string;
}

/**
 * The status line a question card carries, or null for a question the agent waits on inside its
 * call: those render exactly as they always have.
 */
export function questionStatusLine(
  review: Pick<ReviewItem, "waitMode" | "meanwhile" | "createdAt">,
  session: Pick<Session, "state" | "stateConfirmed" | "task"> | null | undefined,
  now = Date.now(),
): QuestionStatusLine | null {
  if (review.waitMode !== "message" || !session) return null;
  const status = questionAgentStatus(session);
  const meanwhile = review.meanwhile?.trim() || null;
  return {
    status,
    label: status === "working" ? "Still working" : "Stopped, waiting on this answer",
    meanwhile: status === "working" ? meanwhile : null,
    asked: `asked ${relativeTime(review.createdAt, now)}`,
  };
}

/**
 * Whether the agent behind a row of the inbox's "Questions from agents" has stopped on it: any
 * review it waits on inside a call (a gate, or a question asked with the flag off) always has, and
 * a row of message-mode questions has when its agent is no longer working. The inbox lists these
 * rows first. With the flag off every review is call-mode, so every row is stopped and the order
 * is exactly what it was.
 */
export function stoppedOnQuestions(
  session: Pick<Session, "state" | "stateConfirmed" | "task">,
  reviews: readonly Pick<ReviewItem, "waitMode">[],
): boolean {
  return reviews.some((review) => review.waitMode !== "message") || questionAgentStatus(session) === "stopped";
}

/** Every review in the row is a message-mode question, so its agent is not waiting inside a call. */
export function allMessageMode(reviews: readonly Pick<ReviewItem, "waitMode">[]): boolean {
  return reviews.length > 0 && reviews.every((review) => review.waitMode === "message");
}

/** "1 question open", "3 questions open". */
export function openQuestionsLabel(count: number): string {
  return `${count} question${count === 1 ? "" : "s"} open`;
}

/**
 * What the state badge draws once a session has something for the operator to answer, or null
 * when it has nothing and the badge is the plain state.
 *
 * - A review its agent waits on inside a call: today's button, in today's tone and words.
 * - Pending message-mode questions on a stopped agent: the same amber button, labelled with the
 *   amber reason `stateDisplay` already gives it ("waiting on your answer").
 * - Pending message-mode questions on an agent still working, or on a resident between
 *   iterations: "N questions open" in the tone the session already wears, never amber. It is still
 *   a button that opens the questions.
 */
export function questionBadge(
  session: Pick<Session, "pendingReviews" | "openQuestions">,
  display: StateDisplay,
): { label: string; tone: StateDisplay["tone"]; tooltip: string } | null {
  if (session.pendingReviews > 0) {
    const n = session.pendingReviews;
    return { label: display.label, tone: display.tone, tooltip: `${n} review${n === 1 ? "" : "s"} waiting on you - open the queue` };
  }
  const open = openQuestionCount(session);
  if (open === 0) return null;
  if (display.tone === "attention") {
    return { label: display.label, tone: display.tone, tooltip: `${open} question${open === 1 ? "" : "s"} waiting on your answer - open ${open === 1 ? "it" : "them"}` };
  }
  return {
    label: openQuestionsLabel(open),
    tone: display.tone,
    tooltip: `The agent keeps working while ${open === 1 ? "this question is" : "these questions are"} open - open ${open === 1 ? "it" : "them"} to answer`,
  };
}

/**
 * Whether a session has something the review chord and the review modal can open: a review its
 * agent waits on, or a pending message-mode question.
 */
export function hasOpenAsks(session: Pick<Session, "pendingReviews" | "openQuestions">): boolean {
  return session.pendingReviews > 0 || openQuestionCount(session) > 0;
}

/** A session that has stopped on something only the operator can answer through a review. */
export function stoppedAsking(
  session: Pick<Session, "pendingReviews" | "openQuestions" | "state" | "stateConfirmed" | "task">,
): boolean {
  return session.pendingReviews > 0 || waitingOnOpenQuestion(session);
}

/**
 * How a question the conversation records for itself ended, as its Asked entry or its closure
 * entry says it (`isConversationQuestionRecord`). `open` is the one state with an Answer button;
 * every other state is a record and nothing on it can be acted on.
 *
 * Renders `withdrawn` without depending on it being written yet: the agent's reason is whatever
 * it wrote into `response` when it took the question back.
 */
export type QuestionOutcome =
  | { state: "open"; text: string }
  | { state: "snoozed" | "answered" | "dismissed" | "closed" | "withdrawn"; text: string; detail: string | null };

export function questionOutcome(review: Pick<ReviewItem, "status" | "closedReason" | "resolvedBy" | "response">): QuestionOutcome {
  switch (review.status) {
    case "pending":
      return { state: "open", text: "Open, not answered yet" };
    case "snoozed":
      return { state: "snoozed", text: "Snoozed: it comes back to you later", detail: null };
    case "dismissed":
      return { state: "dismissed", text: "Dismissed without an answer", detail: null };
    case "approved":
    case "rejected":
    case "answered":
      return { state: "answered", text: review.resolvedBy === "foreman" ? "Answered by Foreman" : "Answered", detail: null };
    case "orphaned":
      return {
        state: "closed",
        text: review.closedReason === "merged" ? "Closed unanswered: pull request merged" : "Closed unanswered",
        detail: null,
      };
    case "withdrawn":
      return { state: "withdrawn", text: "Withdrawn by the agent", detail: review.response?.trim() || null };
    case "superseded":
      return { state: "closed", text: "Closed unanswered: the agent asked a newer question", detail: null };
  }
}

/**
 * The words on a question's actions, chosen from how its agent waits right now, so no action
 * contradicts the card's status line. `call`: the agent waits inside its tool call (today's
 * words). `working` and `stopped`: a message-mode question, read through `questionAgentStatus`.
 * A stopped agent hears nothing from a snooze unless it is given a provisional option or told to
 * hold, both of which reach it as a message.
 */
export type QuestionWait = "call" | QuestionAgentStatus;

export function questionWait(
  review: Pick<ReviewItem, "waitMode">,
  session: Pick<Session, "state" | "stateConfirmed" | "task"> | null | undefined,
): QuestionWait {
  if (review.waitMode !== "message") return "call";
  // Every caller passes the asking session; without one, the words fall back to what the agent
  // was told when it filed the question: keep working.
  return session ? questionAgentStatus(session) : "working";
}

export const QUESTION_ACTION_COPY: Record<QuestionWait, { dismissRow: string; remindLater: string; snooze: string }> = {
  call: {
    dismissRow: "Remove these questions from the inbox without answering them. The agent keeps waiting; a new question from it still shows here",
    remindLater: "Not ready to decide? The agent stops waiting and carries on, and this question comes back to you later",
    snooze: "Park this question; the agent stops waiting now",
  },
  working: {
    dismissRow: "Remove these questions from the inbox without answering them. The agent keeps working and the questions stay open; a new question from it still shows here",
    remindLater: "Not ready to decide? The agent keeps working, and this question comes back to you later",
    snooze: "Park this question; the agent keeps working",
  },
  stopped: {
    dismissRow: "Remove these questions from the inbox without answering them. The agent has stopped on them and the questions stay open; a new question from it still shows here",
    remindLater: "Not ready to decide? This question comes back to you later. The agent has stopped on it and hears nothing unless you choose a provisional option or Hold",
    snooze: "Park this question; the agent stays stopped unless you choose a provisional option or Hold",
  },
};
