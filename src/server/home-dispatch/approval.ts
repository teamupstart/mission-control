import { createHash } from "node:crypto";
import { managedPlanPreview, PLAN_APPROVAL_DECISION, PLAN_APPROVAL_OPTION } from "@shared/managed-plans.ts";
import type { HomeDispatchInboxItem } from "@shared/home-dispatch.ts";
import { isActiveTask } from "@shared/task-status.ts";
import type { PlanDecision, ReviewItem, Task } from "@shared/types.ts";
import { openDb } from "../db.ts";
import type { HomeDispatchDeps } from "./stub.ts";

// Owner: P4. What a pending review looks like to a home session (spec 7.7), and the revision hash
// every approval must name (7.8, 7.9). Pure reads: nothing here changes a review.

/** The pending request an inbox item carries (`HomeDispatchInboxItem["pending"]`). */
export type InboxPending = NonNullable<HomeDispatchInboxItem["pending"]>;

/** The id of the one decision a managed plan's final-bundle review asks; "Needs revision" is its other option. */
export const NEEDS_REVISION_OPTION = "revise";

interface ManagedPlanReviewRow {
  plan_id: string;
  revision: number;
  manifest_hash: string;
}

/** The managed plan a review is the final-bundle approval of, or null for every other review. */
export function managedPlanFor(reviewId: string): { planId: string; revision: number; manifestHash: string } | null {
  const row = openDb()
    .prepare(`SELECT plan_id, revision, manifest_hash FROM managed_plan_reviews WHERE review_id = ?`)
    .get(reviewId) as ManagedPlanReviewRow | undefined;
  return row ? { planId: row.plan_id, revision: row.revision, manifestHash: row.manifest_hash } : null;
}

/** A resident's proposed instruction changes can only be applied by the operator (the dashboard). */
function isInstructionProposal(reviewId: string): boolean {
  return Boolean(
    openDb()
      .prepare(`SELECT 1 FROM resident_instruction_proposals WHERE review_id = ? AND outcome IS NULL`)
      .get(reviewId),
  );
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** How a home session answers a review: which actions fit it, and what it is called in the inbox. */
export type ReviewShape =
  | { type: "question"; decision: PlanDecision | null }
  | { type: "plan"; planId: string; revision: number; manifestHash: string }
  | { type: "plan-review" }
  | { type: "diff" }
  | { type: "dashboard-only"; decisions: number };

/**
 * Sorts a review into the one shape the answers route and the inbox both read, so the two cannot
 * disagree about what a review accepts. A form that asks more than a home session can show, an
 * unmanaged plan-decisions form, a managed plan that asks more than its final bundle, and a
 * resident's instruction proposal are `dashboard-only` (`{n} decisions; answer this in the
 * dashboard`).
 */
export function reviewShapeOf(review: ReviewItem): ReviewShape {
  const decisions = review.decisions ?? [];
  if (review.kind === "diff") return { type: "diff" };
  if (review.kind === "plan") return { type: "plan-review" };
  if (review.kind === "plan-decisions") {
    const managed = managedPlanFor(review.id);
    const onlyBundle = decisions.length === 1 && decisions[0]!.id === PLAN_APPROVAL_DECISION;
    return managed && onlyBundle
      ? { type: "plan", ...managed }
      : { type: "dashboard-only", decisions: decisions.length };
  }
  // An `input` review: a free-text question, or one with a single set of discrete options.
  if (isInstructionProposal(review.id)) return { type: "dashboard-only", decisions: Math.max(decisions.length, 1) };
  if (decisions.length > 1 || decisions[0]?.multiSelect) {
    return { type: "dashboard-only", decisions: decisions.length };
  }
  return { type: "question", decision: decisions[0] ?? null };
}

/**
 * The revision a review is approved at (7.8). A managed plan's is its manifest hash. A diff review's
 * and a plain plan review's are computed from exactly what the person is shown: the title and the
 * body, which for a diff is the diff itself with its head commit. Any change to either changes the
 * hash, so an approval always names what was on screen. Undefined for a question, which is never
 * approved.
 */
export function revisionHashFor(review: ReviewItem, shape: ReviewShape = reviewShapeOf(review)): string | undefined {
  switch (shape.type) {
    case "plan":
      return shape.manifestHash;
    case "diff":
    case "plan-review":
      return sha256([shape.type, review.title, review.body].join("\u0000"));
    default:
      return undefined;
  }
}

/** The first characters of a plan or diff, cut at a line end, for the pane's summary line. */
function summaryOf(body: string): string | undefined {
  const text = body.trim();
  if (!text) return undefined;
  if (text.length <= 280) return text;
  const cut = text.slice(0, 280);
  const lineEnd = cut.lastIndexOf("\n");
  return `${(lineEnd > 120 ? cut.slice(0, lineEnd) : cut).trimEnd()}...`;
}

/**
 * The `pending` block of an inbox item (7.7). `resident` marks a request raised by a resident run,
 * which is answered like a question but shown as its own kind. Worker text is passed through as
 * written; the mod renders it in person mode (7.18).
 */
export function pendingFor(review: ReviewItem, resident: boolean): InboxPending {
  const shape = reviewShapeOf(review);
  const base = { reviewId: review.id };
  switch (shape.type) {
    case "question": {
      const decision = shape.decision;
      const question = decision?.question ?? (review.body.trim() || review.title);
      return {
        ...base,
        kind: resident ? "resident-request" : "question",
        question,
        ...(decision ? { options: decision.options.map((o) => o.label) } : {}),
        // A question with options and no free-text field refuses text alone; one with no options is text.
        allowsText: decision ? decision.allowOther === true : true,
        dashboardOnly: false,
      };
    }
    case "plan":
      return {
        ...base,
        kind: "plan",
        allowsText: true,
        revisionHash: shape.manifestHash,
        ...(summaryOf(review.body) ? { summary: summaryOf(review.body) } : {}),
        link: managedPlanPreview(shape.planId, shape.revision),
        dashboardOnly: false,
      };
    case "plan-review":
    case "diff":
      return {
        ...base,
        kind: shape.type === "diff" ? "diff" : "plan-review",
        allowsText: true,
        revisionHash: revisionHashFor(review, shape),
        ...(summaryOf(review.body) ? { summary: summaryOf(review.body) } : {}),
        dashboardOnly: false,
      };
    case "dashboard-only":
      return {
        ...base,
        kind: review.kind === "plan-decisions" ? "plan-decisions" : resident ? "resident-request" : "question",
        question: review.title,
        allowsText: false,
        dashboardOnly: true,
        decisions: shape.decisions,
      };
  }
}

/**
 * The one task a session's review belongs to. A review names only its session, so the association
 * is the registry's own rule for a card (`taskForSession`): the session's active task, else its
 * newest bound one. A session with two ACTIVE tasks has no single owner for its question, so it is
 * reported as ambiguous instead of guessed, and nothing is answered or listed against either task.
 * Every reader of "which task is this review for" (the inbox, the answers route) calls this.
 */
export function taskOwningSession(
  deps: Pick<HomeDispatchDeps, "registry">,
  sessionId: string,
  /** When the review was created. A task that started after it cannot be the one that asked. */
  reviewCreatedAt?: number,
): { task: Task } | { ambiguous: true } | { unestablished: true; task: Task } | undefined {
  const active = deps.registry.listTasks().filter((t) => t.sessionId === sessionId && isActiveTask(t.status));
  if (active.length > 1) return { ambiguous: true };
  // The registry's card rule skips a cancelled task, but a cancelled task can still hold a pending
  // question, so the newest task ever bound to the session is the last resort.
  const task = active[0]
    ?? deps.registry.taskForSession(sessionId, null)
    ?? deps.registry.listTasks()
      .filter((t) => t.sessionId === sessionId && t.status !== "backlog")
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!task) return undefined;
  // A review records only its session, not its task. When another task took the session over after
  // the review was created, the review was asked by the task that held the session then, which is
  // no longer knowable, so it is refused rather than attributed to the new holder.
  if (reviewCreatedAt !== undefined && !reviewBelongsTo(task, reviewCreatedAt)) return { unestablished: true, task };
  return { task };
}

/** Whether a review created at `createdAt` could have been asked by `task`: it was running by then. */
export function reviewBelongsTo(task: Pick<Task, "dispatchedAt" | "createdAt">, createdAt: number): boolean {
  return createdAt >= (task.dispatchedAt ?? task.createdAt);
}

/** The text a refused action on a `dashboard-only` item carries (7.8). */
export const ANSWER_IN_DASHBOARD = "answer this in the dashboard";

/** The selection a managed plan's final-bundle review takes for "Approve final bundle". */
export const APPROVE_BUNDLE_SELECTION = {
  decisionId: PLAN_APPROVAL_DECISION,
  selected: [PLAN_APPROVAL_OPTION],
  other: null,
} as const;
