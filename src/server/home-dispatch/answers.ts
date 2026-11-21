import { createHash } from "node:crypto";
import type { Handler } from "hono";
import {
  HomeDispatchAnswerRequestSchema,
  HomeDispatchReceiptSchema,
  type HomeDispatchAnswerRequest,
  type HomeDispatchReceipt,
} from "@shared/home-dispatch.ts";
import {
  approvalSent,
  HOME_DISPATCH_CHAT_FIRST_SENT,
  HOME_DISPATCH_CHAT_FIRST_TEXT,
} from "@shared/home-dispatch-inbox.ts";
import { decisionLead, formatResponse } from "@shared/review-item.ts";
import type { PlanDecision, PlanDecisionAnswer, ReviewActor, ReviewItem, Task } from "@shared/types.ts";
import { openDb } from "../db.ts";
import { parseBody } from "../http-body.ts";
import { ReviewResolutionError } from "../reviews.ts";
import {
  ANSWER_IN_DASHBOARD,
  APPROVE_BUNDLE_SELECTION,
  NEEDS_REVISION_OPTION,
  reviewShapeOf,
  revisionHashFor,
  taskOwningSession,
  type ReviewShape,
} from "./approval.ts";
import { resolveCaller, taskOriginOf, type ResolvedCaller } from "./caller.ts";
import { UNATTRIBUTED_ITEM_PREFIX, visibleResidents } from "./inbox.ts";
import { canAnswerTask, canReadTask } from "./sessions.ts";
import type { HomeDispatchDeps, HomeDispatchHandler } from "./stub.ts";

// Owner: P4. `POST /dispatch/answers` (spec 7.8, 7.9): `answer`, `approve_plan`, `request_changes`,
// `approve_review`, `reject_review` and `chat_first`, each settled through the review manager the
// dashboard's `POST /api/reviews/:id/resolve` uses, with the actor set here by the server and never
// read from the request. A receipt is kept per review, so a retry returns what was sent.

interface Refusal {
  status: 400 | 403 | 404 | 409 | 500;
  error: string;
}

const refuse = (status: Refusal["status"], error: string): { refusal: Refusal } => ({ refusal: { status, error } });

interface ReceiptRow {
  review_id: string;
  task_id: string;
  session_id: string | null;
  surface: string;
  sent: string;
  created_at: number;
}

function receiptRow(reviewId: string): ReceiptRow | undefined {
  return openDb().prepare(`SELECT * FROM home_dispatch_receipts WHERE review_id = ?`).get(reviewId) as ReceiptRow | undefined;
}

function toReceipt(row: ReceiptRow): HomeDispatchReceipt {
  return HomeDispatchReceiptSchema.parse({ reviewId: row.review_id, taskId: row.task_id, sent: row.sent, at: row.created_at });
}

/**
 * The task a review belongs to. A settled review's receipt names the task it was answered for;
 * otherwise it is the task that owns the session that asked (`taskOwningSession`), and a session
 * with two active tasks is ambiguous rather than guessed.
 */
function taskOfReview(
  deps: Pick<HomeDispatchDeps, "registry">,
  review: ReviewItem | undefined,
  receipt: ReceiptRow | undefined,
): ReturnType<typeof taskOwningSession> {
  if (receipt) {
    const task = deps.registry.getTask(receipt.task_id);
    return task ? { task } : undefined;
  }
  return review ? taskOwningSession(deps, review.sessionId, review.createdAt) : undefined;
}

function actorFor(resolved: ResolvedCaller, approving: boolean): ReviewActor {
  if (resolved.sessionId === null) return "mctl";
  return approving ? `home-approval:${resolved.sessionId}` : `home:${resolved.sessionId}`;
}

/** What settling a review takes: the resolve action, the flattened response and the structured selections. */
interface Settlement {
  action: "approve" | "reject" | "answer";
  response: string | null;
  selections: PlanDecisionAnswer[] | null;
  approving: boolean;
  sent: string;
}

function questionSettlement(
  review: ReviewItem,
  decision: PlanDecision | null,
  body: Extract<HomeDispatchAnswerRequest, { action: "answer" }>,
): Settlement | Refusal {
  const text = body.text?.trim() ? body.text : undefined;
  if (decision === null) {
    // A question with no options refuses an option and takes the text as the answer.
    if (body.option !== undefined) return { status: 400, error: "this question takes text, not an option" };
    if (text === undefined) return { status: 400, error: "an answer needs text" };
    return { action: "answer", response: text, selections: null, approving: false, sent: text };
  }
  const labels = decision.options.map((o) => o.label);
  const option = body.option === undefined ? undefined : decision.options.find((o) => o.label === body.option);
  if (body.option !== undefined && !option) {
    return { status: 400, error: `"${body.option}" is not one of the options: ${labels.join(", ")}` };
  }
  if (!option && text === undefined) return { status: 400, error: "an answer needs one of the options or text" };
  // A question with options and no free-text field refuses text alone, and text beside an option.
  if (text !== undefined && decision.allowOther !== true) {
    return { status: 400, error: option ? "this question takes an option, not text" : `this question takes one of its options: ${labels.join(", ")}` };
  }
  const selection: PlanDecisionAnswer = { decisionId: decision.id, selected: option ? [option.id] : [], other: text ?? null };
  const sent = option ? (text !== undefined ? `${option.label}: ${text}` : option.label) : text!;
  return {
    action: "answer",
    response: formatResponse(review.decisions ?? [decision], [selection], decisionLead(review.kind)),
    selections: [selection],
    approving: false,
    sent,
  };
}

/** Builds the settlement for an action, or the refusal for one that does not fit the review. */
function settlementFor(review: ReviewItem, shape: ReviewShape, body: HomeDispatchAnswerRequest): Settlement | Refusal {
  const doesNotFit: Refusal = { status: 400, error: `${body.action} does not fit this review` };
  switch (body.action) {
    case "answer":
      return shape.type === "question" ? questionSettlement(review, shape.decision, body) : doesNotFit;
    case "chat_first":
      return shape.type === "question"
        ? { action: "answer", response: HOME_DISPATCH_CHAT_FIRST_TEXT, selections: null, approving: false, sent: HOME_DISPATCH_CHAT_FIRST_SENT }
        : doesNotFit;
    case "approve_plan": {
      if (shape.type !== "plan") return doesNotFit;
      const current = revisionHashFor(review, shape)!;
      if (body.revisionHash !== current) {
        return { status: 409, error: "the plan changed; show the new revision before approving" };
      }
      const selections: PlanDecisionAnswer[] = [{ ...APPROVE_BUNDLE_SELECTION, selected: [...APPROVE_BUNDLE_SELECTION.selected] }];
      return {
        action: "answer",
        response: formatResponse(review.decisions ?? [], selections, decisionLead(review.kind)),
        selections,
        approving: true,
        sent: approvalSent("plan", current),
      };
    }
    case "request_changes": {
      if (shape.type !== "plan") return doesNotFit;
      const selections: PlanDecisionAnswer[] = [{
        decisionId: APPROVE_BUNDLE_SELECTION.decisionId, selected: [NEEDS_REVISION_OPTION], other: null, note: body.text,
      }];
      return {
        action: "answer",
        response: formatResponse(review.decisions ?? [], selections, decisionLead(review.kind)),
        selections,
        approving: false,
        sent: body.text,
      };
    }
    case "approve_review": {
      if (shape.type !== "diff" && shape.type !== "plan-review") return doesNotFit;
      const current = revisionHashFor(review, shape)!;
      if (body.revisionHash !== current) {
        return { status: 409, error: "the review changed; show the new revision before approving" };
      }
      const text = body.text?.trim() ? body.text : undefined;
      return { action: "approve", response: text ?? null, selections: null, approving: true, sent: approvalSent("review", current, text) };
    }
    case "reject_review": {
      if (shape.type !== "diff" && shape.type !== "plan-review") return doesNotFit;
      const text = body.text?.trim() ? body.text : undefined;
      return { action: "reject", response: text ?? null, selections: null, approving: false, sent: approvalSent("reject", null, text) };
    }
  }
}

const isRefusal = (v: Settlement | Refusal): v is Refusal => "status" in v;

/**
 * Who a receipt belongs to, for telling a retry from a different answer. A home session is its
 * session id. Every `mctl` call has no session, so one is identified by what it asked: a hash of its
 * action, task, review, option, text and revision. It is stored with the receipt, so it survives a
 * daemon restart, and an option `Keep` and a text `Keep` are different requests.
 */
function callerIdentity(resolved: ResolvedCaller, body: HomeDispatchAnswerRequest): string {
  if (resolved.sessionId !== null) return resolved.sessionId;
  const asked = body as Record<string, unknown>;
  const text = typeof asked.text === "string" ? asked.text.trim() : null;
  const canonical = JSON.stringify([body.action, body.taskId, body.reviewId, asked.option ?? null, text, asked.revisionHash ?? null]);
  return "mctl:" + createHash("sha256").update(canonical).digest("hex");
}

/**
 * Everything between the request and the settled review, with no await: the status check, the
 * settle and the receipt write run in one turn of the event loop, so two calls at once from one
 * session settle once and the second reads the first's receipt.
 */
function answer(
  deps: HomeDispatchDeps,
  resolved: ResolvedCaller,
  body: HomeDispatchAnswerRequest,
): { receipt: HomeDispatchReceipt } | { refusal: Refusal } {
  const { caller } = resolved;
  const surface = caller.surface;

  // `mctl` never approves, and never sends the mod-only chat_first (7.8, 7.9).
  if (surface === "cli") {
    if (body.action === "approve_plan") {
      return refuse(403, "mctl does not approve plans; approve it in the home session or the dashboard");
    }
    if (body.action === "approve_review") {
      return refuse(403, "mctl does not approve reviews; approve it in the home session or the dashboard");
    }
    if (body.action === "chat_first") return refuse(403, "mctl never starts a chat; chat_first is for the home session only");
  }

  const review = deps.registry.getReview(body.reviewId);
  const prior = receiptRow(body.reviewId);
  const identity = callerIdentity(resolved, body);
  const owner = taskOfReview(deps, review, prior);
  if (!owner) return refuse(404, "no such review");
  if ("ambiguous" in owner) return refuse(409, "more than one active task shares this review's session, so it cannot be answered from here; answer it in the dashboard");
  if ("unestablished" in owner) return refuse(409, "another task took over this review's session after it was asked, so which task asked it cannot be established; answer it in the dashboard");
  const { task } = owner;

  const origin = taskOriginOf(task.id);
  const residentVisible = caller.surface === "home-session" && visibleResidents(deps, caller.repoRoot).has(task.id);
  const read = canReadTask(caller, origin, { residentVisible });
  if (read) return refuse(403, read.reason);
  if (caller.surface === "cli" && origin.originSurface !== "mctl") {
    return refuse(403, "answer this in the home session that started it");
  }
  const denied = canAnswerTask(caller, origin, { residentVisible });
  if (denied) return refuse(403, denied.reason);

  // The request names the item it answers, so a question replaced since the person read it is
  // refused rather than answered by mistake.
  // A task's second and later pending requests are listed as `review:{id}` items, so that id names
  // the same review and is answered for the task that owns it.
  const named = body.taskId === `${UNATTRIBUTED_ITEM_PREFIX}${body.reviewId}` ? task.id : body.taskId;
  if (task.id !== named) return refuse(409, "the review belongs to a different task than the one shown");

  const settled = !review || (review.status !== "pending" && review.status !== "snoozed");
  if (settled) {
    // A retry by the same caller returns the receipt, so a lost response never hides what was sent.
    if (prior && prior.surface === surface) {
      if (prior.session_id === identity) return { receipt: toReceipt(prior) };
      // A later `mctl` command has the same identity only if it asks the same thing, so a different
      // answer to a settled review is refused instead of being handed the first one's receipt.
      if (surface === "cli") {
        return refuse(409, "this review was already answered by an earlier mctl command, with a different answer; nothing was sent");
      }
    }
    return refuse(409, "this review was already settled");
  }

  const shape = reviewShapeOf(review);
  if (shape.type === "dashboard-only") return refuse(400, ANSWER_IN_DASHBOARD);

  const settlement = settlementFor(review, shape, body);
  if (isRefusal(settlement)) return { refusal: settlement };

  // The receipt is written in the SAME transaction as the settle (`persistWith`), so the two commit
  // together or not at all: a failed receipt write leaves the review pending and the caller can
  // simply answer again, and a settled review always has the receipt a retry needs.
  const at = Date.now();
  let updated: ReviewItem | null;
  try {
    updated = deps.reviews.resolve(
      review.id, settlement.action, settlement.response, actorFor(resolved, settlement.approving), settlement.selections,
      () => {
        openDb()
          .prepare(
            `INSERT INTO home_dispatch_receipts (review_id, task_id, session_id, surface, sent, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(review.id, task.id, identity, surface, settlement.sent, at);
      },
    );
  } catch (error) {
    if (error instanceof ReviewResolutionError) return refuse(400, error.message);
    console.warn(`[home-dispatch] could not settle review ${review.id}: ${error instanceof Error ? error.message : String(error)}`);
    return refuse(500, "the answer could not be recorded, so nothing was sent; answer again");
  }
  if (!updated) return refuse(404, "no such review");
  if (updated.status === "pending" || updated.status === "snoozed") return refuse(409, "the review could not be settled");
  return { receipt: { reviewId: review.id, taskId: task.id, sent: settlement.sent, at } };
}

/** `POST /dispatch/answers` (7.8). The actor is `home:{sessionId}`, `home-approval:{sessionId}` or `mctl`. */
export const answersHandler: HomeDispatchHandler = (deps): Handler => async (c) => {
  const parsed = await parseBody(c, HomeDispatchAnswerRequestSchema);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  const outcome = await resolveCaller(deps, c, { sessionId: body.sessionId, cwd: body.cwd });
  if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
  const result = answer(deps, outcome.resolved, body);
  if ("refusal" in result) return c.json({ error: result.refusal.error }, result.refusal.status);
  return c.json(result.receipt);
};
