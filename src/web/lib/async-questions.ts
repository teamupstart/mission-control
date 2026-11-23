// How the dashboard tells a working agent's open questions from a stopped one's (`async-input`).
//
// Rendering only: every value here is read from `ReviewItem` and `Session` through the predicates
// `@shared/async-input.ts` already owns, so no surface grows a second opinion on who is waiting.
// The card's status line, the inbox's order, the state badge, the review chord and the Residents
// drawer all ask these functions, which is how one question reads the same everywhere it appears.

import { createContext, useContext } from "react";
import { agentKeepsWorking, confirmedWorking, isFiledGate, openQuestionCount } from "@shared/async-input.ts";
import type { ResidentRunSummary } from "@shared/residents.ts";
import type { ReviewItem, Session } from "@shared/types.ts";
import { relativeTime, type StateDisplay } from "./format.ts";

/**
 * What these functions read about the agent behind a question: the session's own reading, plus
 * whether it is a resident the operator paused. The session alone cannot say the second. A
 * resident's Pause lives on its resident run (`loopState: "paused"`), which the dashboard joins in
 * (`pausedResidentSessionIds`), so a caller that knows marks the session with `residentPaused`.
 */
export type QuestionAgent = Pick<Session, "state" | "stateConfirmed" | "task"> & { residentPaused?: boolean };

/**
 * Whether the agent behind a message-mode question is still working past it or has stopped on it.
 *
 * For any session that is not a resident this is exactly the bucket's idle clause
 * (`waitingOnOpenQuestion`): a session that is not confirmed working has stopped, unconfirmed
 * included, as the bucket paints it amber. A resident reads as working because it wakes on its own
 * cadence, except when its operator paused it: a paused resident does not wake, so unless it is
 * still finishing a turn, nothing will act on its question and it reads as stopped.
 *
 * The paused case is decided here and not in the shared clause on purpose. The daemon refuses a
 * resident's Resume while its bucket is `needs-you` (`ResidentLoop.resume`), so teaching the
 * bucket that a paused resident's open question needs you would refuse the very Resume that lets
 * it act on the question, and break the rule that filed questions never hold a resident.
 *
 * Stated for any session rather than only one whose `openQuestions` is already raised, so a card
 * drawn in the one frame between a `review_upsert` and the `session_upsert` that counts it still
 * reads correctly.
 */
export type QuestionAgentStatus = "working" | "stopped";

export function questionAgentStatus(agent: QuestionAgent): QuestionAgentStatus {
  if (confirmedWorking(agent)) return "working";
  return agent.task?.kind === "resident" && agent.residentPaused !== true ? "working" : "stopped";
}

/**
 * The sessions of residents whose loop the operator paused, joined from the resident runs by task.
 * Every surface that reads `questionAgentStatus` is handed this one set: components through
 * `PausedResidentsContext`, the attention fold and the review chord as an argument.
 */
export function pausedResidentSessionIds(
  runs: readonly Pick<ResidentRunSummary, "taskId" | "loopState">[] | undefined,
  sessions: readonly Pick<Session, "id" | "task">[],
): ReadonlySet<string> {
  const pausedTasks = new Set((runs ?? []).filter((run) => run.loopState === "paused").map((run) => run.taskId));
  if (pausedTasks.size === 0) return NO_PAUSED_RESIDENTS;
  return new Set(sessions.filter((s) => s.task && pausedTasks.has(s.task.id)).map((s) => s.id));
}

const NO_PAUSED_RESIDENTS: ReadonlySet<string> = new Set();

/** The paused residents' session ids, provided once by App for every component below it. */
export const PausedResidentsContext = createContext<ReadonlySet<string>>(NO_PAUSED_RESIDENTS);

/** The session, marked as a paused resident when it is one. */
export function asQuestionAgent<T extends Pick<Session, "id">>(
  session: T,
  paused: ReadonlySet<string>,
): T & { residentPaused?: boolean } {
  return paused.has(session.id) ? { ...session, residentPaused: true } : session;
}

/** `asQuestionAgent` for a component, from `PausedResidentsContext`. */
export function useQuestionAgent<T extends Pick<Session, "id">>(session: T): T & { residentPaused?: boolean };
export function useQuestionAgent<T extends Pick<Session, "id">>(session: T | null): (T & { residentPaused?: boolean }) | null;
export function useQuestionAgent<T extends Pick<Session, "id">>(session: T | null): (T & { residentPaused?: boolean }) | null {
  const paused = useContext(PausedResidentsContext);
  return session ? asQuestionAgent(session, paused) : null;
}

/** The card's status line for a message-mode review, as the operator reads it. */
export interface QuestionStatusLine {
  status: QuestionAgentStatus;
  /** "Still working", "Stopped, waiting on this answer", or for a filed plan form "Waiting on your decisions". */
  label: string;
  /** The agent's own meanwhile line, shown only while it is still working past the question. */
  meanwhile: string | null;
  /** "asked 4m ago", or "filed 4m ago" for a plan form. */
  asked: string;
}

/** The label a filed plan form's status line carries: its agent has stopped on it, whatever its state. */
export const FILED_GATE_LABEL = "Waiting on your decisions";

/**
 * The status line a question card carries, or null for a review the agent waits on inside its
 * call: those render exactly as they always have.
 *
 * A filed plan form (`isFiledGate`) is a gate whose call returned: its agent has stopped on it,
 * so it always reads as stopped and never carries a meanwhile line, even in the moments before
 * the agent's turn ends.
 */
export function questionStatusLine(
  review: Pick<ReviewItem, "kind" | "waitMode" | "meanwhile" | "createdAt">,
  session: QuestionAgent | null | undefined,
  now = Date.now(),
): QuestionStatusLine | null {
  if (review.waitMode !== "message" || !session) return null;
  if (isFiledGate(review)) {
    return { status: "stopped", label: FILED_GATE_LABEL, meanwhile: null, asked: `filed ${relativeTime(review.createdAt, now)}` };
  }
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
 * review it waits on inside a call (a gate, or a question asked with the flag off) or a filed plan
 * form always has, and a row of message-mode questions has when its agent is no longer working.
 * The inbox lists these rows first. With the flags off every review is call-mode, so every row is
 * stopped and the order is exactly what it was.
 */
export function stoppedOnQuestions(
  session: QuestionAgent,
  reviews: readonly Pick<ReviewItem, "kind" | "waitMode">[],
): boolean {
  return reviews.some((review) => !agentKeepsWorking(review)) || questionAgentStatus(session) === "stopped";
}

/**
 * Every review in the row is a question its agent works past (`agentKeepsWorking`), so its agent
 * is not waiting on any of them. A filed plan form is a gate, so a row holding one is not.
 */
export function allMessageMode(reviews: readonly Pick<ReviewItem, "kind" | "waitMode">[]): boolean {
  return reviews.length > 0 && reviews.every(agentKeepsWorking);
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
 * - Pending message-mode questions: a button that opens them. Whether its words say the agent
 *   keeps working or has stopped comes from `questionAgentStatus`, the same reading the card, the
 *   Asked entry and every action use, so the badge can never contradict the card beside it.
 *   `display` decides the colour only, together with the label when it is amber: `stateDisplay`'s
 *   amber reason ("waiting on your answer", "needs an answer") says more than a count. Any other
 *   tone - working, idle, or a transient reading such as an interrupt in flight - shows the count,
 *   "N questions open", in that tone, never amber.
 */
export function questionBadge(
  session: Pick<Session, "pendingReviews" | "openQuestions"> & QuestionAgent,
  display: StateDisplay,
): { label: string; tone: StateDisplay["tone"]; tooltip: string } | null {
  if (session.pendingReviews > 0) {
    const n = session.pendingReviews;
    return { label: display.label, tone: display.tone, tooltip: `${n} review${n === 1 ? "" : "s"} waiting on you - open the queue` };
  }
  const open = openQuestionCount(session);
  if (open === 0) return null;
  const them = open === 1 ? "it" : "them";
  const tooltip = questionAgentStatus(session) === "working"
    ? `The agent keeps working while ${open === 1 ? "this question is" : "these questions are"} open - open ${them} to answer`
    : `The agent has stopped on ${open === 1 ? "this question" : "these questions"}, waiting on your answer - open ${them}`;
  return {
    label: display.tone === "attention" ? display.label : openQuestionsLabel(open),
    tone: display.tone,
    tooltip,
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
  session: Pick<Session, "pendingReviews" | "openQuestions"> & QuestionAgent,
): boolean {
  return session.pendingReviews > 0 || (openQuestionCount(session) > 0 && questionAgentStatus(session) === "stopped");
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
  review: Pick<ReviewItem, "kind" | "waitMode">,
  session: QuestionAgent | null | undefined,
): QuestionWait {
  // A filed plan form reads as `call`: its agent keeps waiting on it, as that copy says.
  if (!agentKeepsWorking(review)) return "call";
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
