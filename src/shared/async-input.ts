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

/**
 * The preview flag that files a `request_plan_decisions` form instead of holding its call open.
 * It takes effect only while `ASYNC_INPUT_FLAG` is also on, and it is read in one place: the
 * route that decides how an ask waits. Every other reader asks the review (`isFiledGate`), so a
 * form filed while both flags were on stays filed after either is switched off.
 */
export const FILED_PLAN_DECISIONS_FLAG = "filed-plan-decisions" as const;

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
 * - `kind` and `snoozable`: `request_input`'s own asks, and, with `gateFlagOn`, a
 *   `request_plan_decisions` form. Every other gate (diff review, confirmations other tools
 *   raise) stays blocking, because its answer is the thing the agent is producing.
 * - `gateFlagOn`: the `filed-plan-decisions` flag, read for this ask. A plan form is filed only
 *   when both flags are on, and it is filed as a gate (`isFiledGate`): its agent stops on it.
 * - `asyncCapable`: the MCP child knows how to return a receipt. A child from an older build
 *   never says so and keeps long-polling.
 * - `messageable`: the session can receive the answer as a message (`canMessage`). A Pipeline
 *   engine session or a terminal session with no writable pane could never hear it.
 */
export function decideWaitMode(input: {
  flagOn: boolean;
  gateFlagOn?: boolean;
  kind: ReviewKind;
  snoozable: boolean;
  asyncCapable: boolean;
  messageable: boolean;
}): ReviewWaitMode {
  if (!input.flagOn || !input.asyncCapable || !input.messageable) return "call";
  if (input.kind === "input" && input.snoozable) return "message";
  return input.kind === "plan-decisions" && input.gateFlagOn === true ? "message" : "call";
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

/**
 * A plan form filed rather than held in a call (`filed-plan-decisions`): the tool returned a
 * receipt, but the form is still a gate, so its agent stops on it. It counts as a review the
 * session waits on (`pendingReviews`), holds completion, and is closed by a merge.
 */
export function isFiledGate(review: Pick<ReviewItem, "kind" | "waitMode">): boolean {
  return review.kind === "plan-decisions" && review.waitMode === "message";
}

/**
 * A message-mode review its agent works past: a filed `request_input` question. The one reading
 * of "the agent kept working" for every reader that used to test `waitMode === "message"` for
 * it, so a filed gate is never described as a question its agent carries on past.
 */
export function agentKeepsWorking(review: Pick<ReviewItem, "kind" | "waitMode">): boolean {
  return review.waitMode === "message" && !isFiledGate(review);
}

/**
 * What an agent can list and withdraw as its own ask: a `request_input` question, or a filed
 * plan form. The ten-question limit still reads `isRequestInputQuestion` alone.
 */
export function isAgentAsk(review: Pick<ReviewItem, "kind" | "snoozable" | "waitMode">): boolean {
  return isRequestInputQuestion(review) || isFiledGate(review);
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
 * pending or snoozed, and every outstanding filed plan form (`isFiledGate`). A message-mode ask
 * is covered always, since it exists only because the flags were on when it was asked; a
 * call-mode question only while the flag is on, so with the flag off and no message-mode ask open
 * completion is exactly what it was. A call-mode plan form is never covered: its agent is inside
 * the call, and the call ends with the form.
 */
export function questionHoldsCompletion(
  review: Pick<ReviewItem, "kind" | "snoozable" | "status" | "waitMode">,
  flagOn: boolean,
): boolean {
  if (!isOutstandingReview(review)) return false;
  if (isFiledGate(review)) return true;
  return isRequestInputQuestion(review) && (review.waitMode === "message" || flagOn);
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

/**
 * The tool result a filed `request_plan_decisions` call returns at once (`filed-plan-decisions`).
 *
 * Four points, in order: the plan is filed and not answered; it is still a gate, so nothing
 * outward happens until the answer, though read-only preparation is fine; do not file it again
 * or poll, and how to take it back; and then say what is waiting and end the turn. The gate is an
 * instruction, as `request_input`'s receipt is; nothing enforces read-only at the tool level.
 *
 * `bundleApproved`: a standing approval already approved the final bundle, so only the remaining
 * decisions were filed.
 */
export function filedPlanReceipt(review: Pick<ReviewItem, "id">, options: { bundleApproved?: boolean } = {}): string {
  return [
    ...(options.bundleApproved
      ? ["The final bundle was approved automatically by the operator's standing approval for this task. Only the remaining decisions are filed."]
      : []),
    `Filed, not answered: your plan is in the operator's Mission Control inbox (review ${review.id}), and this call does not wait for the answer.`,
    "This is still a gate. Make no edits, commits, pushes, task creation or other outward action until the answer arrives. Read-only preparation, such as reading code or checking facts the plan relies on, is fine.",
    `Do not file this plan again and do not poll for it. The answer arrives as a message in this conversation. If the operator tells you the scope changed, or the plan is no longer needed, use withdraw_question with id ${review.id} and a reason, then file the revised plan with request_plan_decisions.`,
    "When your preparation is done, say what is waiting on this plan and end your turn. Mission Control shows this session as waiting on the operator and wakes it with the answer.",
  ].join("\n\n");
}

/** About how much of a filed plan's body its answer restates, cut at a line boundary. */
export const FILED_PLAN_EXCERPT_CHARS = 2000;

/** The plan body, cut at the last line boundary within the excerpt length, with what was cut said. */
export function filedPlanExcerpt(body: string, limit = FILED_PLAN_EXCERPT_CHARS): string {
  const text = body.trim();
  if (text.length <= limit) return text;
  const lineEnd = text.lastIndexOf("\n", limit);
  const kept = (lineEnd > 0 ? text.slice(0, lineEnd) : text.slice(0, limit)).trimEnd();
  return `${kept}\n[... ${text.length - kept.length} more characters of the plan are not repeated here]`;
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 120) return `${seconds} seconds`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 120) return `${minutes} minutes`;
  return `${Math.floor(minutes / 60)} hours`;
}

/**
 * The message a filed plan form's answer reaches its agent as (`filed-plan-decisions`). Self-
 * contained, because the agent ended its turn on the form and its context may have moved since:
 * which form, how long ago, the plan it filed, every decision with what was chosen (notes and
 * "Chat about it" included, through `reviewToolResult`), and what to do next.
 */
export function filedPlanAnswer(review: ReviewItem, now = Date.now()): string {
  const dismissed = review.status === "dismissed";
  return [
    `Mission Control answer to your filed plan ${review.id} (filed ${elapsed(now - review.createdAt)} ago):`,
    `Plan: ${review.title}`,
    `The plan you filed:\n${filedPlanExcerpt(review.body)}`,
    reviewToolResult(review).text,
    dismissed
      ? "The operator dismissed the plan: nothing was selected and nothing was approved. Do not proceed as if it were. Stop the work this plan gated, and say so, unless the operator tells you otherwise."
      : "The gate is lifted for what was decided. Proceed on these decisions, and follow any instruction to discuss a decision before acting on it.",
  ].join("\n\n");
}
