// The asynchronous input inbox (`async-input` preview flag), said once for every side.
//
// Browser-safe: no `node:` import may reach this module. The daemon decides how an ask waits
// and writes the receipt with these functions, the MCP child returns that receipt verbatim, the
// session bucket and the dashboard's state badge read the same predicates, and the tests pin the
// same words, so no two readers can disagree about what an open question is or what the agent
// was told about it.

import { reviewToolResult } from "./review-item.ts";
import type { ReviewItem, ReviewKind, Session } from "./types.ts";

/** The preview flag that turns `request_input` into an ask that returns at once. */
export const ASYNC_INPUT_FLAG = "async-input" as const;

/** The longest `meanwhile` line an agent may file with a question. */
export const MEANWHILE_MAX_CHARS = 300;

/** With async-input enabled, pending and snoozed questions in either wait mode consume a slot. */
export const MAX_OPEN_QUESTIONS = 10;

/** Collapse a `meanwhile` line's whitespace, line breaks included, so it reads as one line on a card. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * How the agent waits for a review's answer. `call`: inside its tool call, long-polling the
 * daemon (every gate, and every question asked with the flag off). `message`: the tool returned
 * a receipt at once and the answer reaches the agent later as a message.
 */
export type ReviewWaitMode = "call" | "message";

/**
 * Decide how one ask waits. Every condition must hold for `message`; anything else is `call`,
 * which is exactly today's behavior:
 *
 * - `flagOn`: the `async-input` flag, read for this ask.
 * - `kind` and `snoozable`: only `request_input`'s own asks. The gates (plan decisions, diff
 *   review, confirmations other tools raise) stay blocking, because their answer is the thing
 *   the agent is producing.
 * - `asyncCapable`: the MCP child knows how to return a receipt. A child from an older build
 *   never says so and keeps long-polling.
 * - `messageable`: the session can receive the answer as a message (`canMessage`). A Pipeline
 *   engine session or a terminal session with no writable pane could never hear it.
 */
export function decideWaitMode(input: {
  flagOn: boolean;
  kind: ReviewKind;
  snoozable: boolean;
  asyncCapable: boolean;
  messageable: boolean;
}): ReviewWaitMode {
  return input.flagOn && input.kind === "input" && input.snoozable && input.asyncCapable && input.messageable
    ? "message"
    : "call";
}

/**
 * The tool result a message-mode `request_input` call returns at once.
 *
 * Four points, in order: the question is filed and not answered; keep working, but only on what
 * is easy to reverse where the answer matters; do not ask again or poll, because the answer
 * arrives as a message; and with nothing else left, say what is waiting and end the turn. This is
 * the wording "Remind me later" already uses (`snoozedToolResultText`), generalized so the agent
 * does not need the operator to release it first.
 */
export function asyncInputReceipt(review: Pick<ReviewItem, "id">): string {
  return [
    `Filed, not answered: your question is in the operator's Mission Control inbox (review ${review.id}), and this call does not wait for the answer.`,
    "Keep working. Do every part of your task that does not depend on the answer. Where your work does depend on it, proceed only on a choice that is easy to reverse (the recommended option, if you offered one) and say which assumption you made. Hold anything irreversible or outward-facing until the answer arrives.",
    `Do not ask this question again and do not poll for it. The answer arrives as a message in this conversation; reconcile your work with it then. Use list_open_questions to inspect your outstanding questions, or withdraw_question with id ${review.id} and a reason when this question is no longer needed. Do not use listing to poll for answers.`,
    "If nothing else remains, say what is waiting on this question and end your turn. Mission Control shows this session as waiting on the operator and wakes it with the answer.",
  ].join("\n\n");
}

/** A question asked through `request_input` itself, as opposed to a gate or another tool's confirmation. */
export function isRequestInputQuestion(review: Pick<ReviewItem, "kind" | "snoozable">): boolean {
  return review.kind === "input" && review.snoozable === true;
}

/** Still unanswered: pending in front of the operator, or parked by "Remind me later". */
export function isOutstandingReview(review: Pick<ReviewItem, "status">): boolean {
  return review.status === "pending" || review.status === "snoozed";
}

/**
 * Whether this review keeps prompted completion, workflow resumption and automatic evidence
 * preparation from finishing its session's task, and is closed with the reason `merged` when a
 * merge completes the task anyway.
 *
 * Both completion rules share this one scope: every outstanding `request_input` question,
 * pending or snoozed. A message-mode question is covered always, since it exists only because
 * the flag was on when it was asked; a call-mode question only while the flag is on, so with the
 * flag off and no message-mode question open completion is exactly what it was.
 */
export function questionHoldsCompletion(
  review: Pick<ReviewItem, "kind" | "snoozable" | "status" | "waitMode">,
  flagOn: boolean,
): boolean {
  return isRequestInputQuestion(review) && isOutstandingReview(review) && (review.waitMode === "message" || flagOn);
}

/** `Session.openQuestions`, read as zero from a snapshot that predates it. */
export function openQuestionCount(session: Pick<Session, "openQuestions">): number {
  return session.openQuestions ?? 0;
}

/**
 * Every pending question a person still has to answer for this session, whichever way its agent
 * waits. What the readers that refuse to rebind, reassign or reset an agent underneath an
 * unanswered question count, so a message-mode question protects it exactly as a call-mode one
 * does. A snoozed question is in neither count.
 */
export function questionsAwaitingOperator(session: Pick<Session, "pendingReviews" | "openQuestions">): number {
  return session.pendingReviews + openQuestionCount(session);
}

/** The agent is confirmed to be running a turn right now. */
export function confirmedWorking(session: Pick<Session, "state" | "stateConfirmed">): boolean {
  return session.stateConfirmed && (session.state === "starting" || session.state === "working");
}

/**
 * The idle clause: a session that is not confirmed working and has a pending message-mode
 * question is waiting on the operator's answer. One predicate for `reportBucket`,
 * `needsYouReason` and the dashboard's state badge, so the board and the server cannot disagree
 * about who is waiting.
 *
 * A resident is exempt. It wakes on its own cadence, so open questions alone never stop it, and
 * its questions accumulate in the inbox while it keeps iterating.
 */
export function waitingOnOpenQuestion(
  session: Pick<Session, "openQuestions" | "state" | "stateConfirmed" | "task">,
): boolean {
  return openQuestionCount(session) > 0 && session.task?.kind !== "resident" && !confirmedWorking(session);
}

/** The reason a stopped session with a pending message-mode question needs you. */
export const WAITING_ON_ANSWER_REASON = "waiting on your answer";

/** Self-contained news for an agent whose context may have changed since it asked. */
export function asyncInputAnswer(review: ReviewItem, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - review.createdAt) / 1000));
  return [
    `Mission Control answer to question ${review.id} (asked ${seconds} seconds ago):`,
    `Question and context:\n${review.body || review.decisions?.[0]?.question || review.title}`,
    `You said you would do meanwhile: ${review.meanwhile || "No meanwhile plan was supplied."}`,
    reviewToolResult(review).text,
    review.status === "dismissed"
      ? "The question was dismissed. Keep the choice you made while waiting."
      : "Reconcile any work or assumptions made meanwhile with this response. Follow any instruction to discuss the question before deciding.",
    "Resume anything this message interrupted.",
  ].join("\n\n");
}
