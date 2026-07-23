import { randomUUID } from "node:crypto";
import type { PlanDecision, ReviewItem, ReviewKind, ReviewStatus } from "@shared/types.ts";
import type { Registry } from "./registry.ts";
import { insertReview, updateReviewStatus } from "./db.ts";
import { unref } from "./util/timers.ts";

export type ReviewAction = "approve" | "reject" | "answer" | "dismiss";

type Waiter = (r: ReviewItem) => void;

/**
 * Owns the review lifecycle and the long-poll waiters that let an agent block on
 * a human decision. The agent (via MCP) creates a review and calls `wait`; the
 * human resolves it from the UI, which unblocks every waiter. This is the
 * generalized analog of no-mistakes' `axi respond` approval gate.
 */
export class ReviewManager {
  private waiters = new Map<string, Set<Waiter>>();

  constructor(private registry: Registry) {}

  create(
    sessionId: string,
    kind: ReviewKind,
    title: string,
    body: string,
    decisions: PlanDecision[] | null = null,
  ): ReviewItem {
    const review: ReviewItem = {
      id: randomUUID(),
      sessionId,
      kind,
      title,
      body,
      status: "pending",
      response: null,
      decisions,
      createdAt: Date.now(),
      resolvedAt: null,
    };
    insertReview(review);
    this.registry.upsertReview(review);
    return review;
  }

  /**
   * Resolve immediately if already decided; otherwise wait up to `timeoutMs`.
   * On timeout returns the still-pending item so the caller can long-poll again.
   * Returns null if the id is unknown.
   */
  wait(id: string, timeoutMs: number): Promise<ReviewItem | null> {
    const current = this.registry.getReview(id);
    if (!current) return Promise.resolve(null);
    if (current.status !== "pending") return Promise.resolve(current);

    return new Promise<ReviewItem | null>((resolve) => {
      let set = this.waiters.get(id);
      if (!set) this.waiters.set(id, (set = new Set()));

      const waiter: Waiter = (r) => {
        clearTimeout(timer);
        set!.delete(waiter);
        resolve(r);
      };
      const timer = unref(
        setTimeout(() => {
          set!.delete(waiter);
          resolve(this.registry.getReview(id) ?? null);
        }, timeoutMs),
      );

      set.add(waiter);
    });
  }

  resolve(id: string, action: ReviewAction, response: string | null): ReviewItem | null {
    const cur = this.registry.getReview(id);
    if (!cur) return null;
    if (cur.status !== "pending") return cur;

    const status: ReviewStatus =
      action === "approve"
        ? "approved"
        : action === "reject"
          ? "rejected"
          : action === "dismiss"
            ? "dismissed"
            : "answered";
    const resolvedAt = Date.now();
    updateReviewStatus(id, status, response, resolvedAt);
    const updated: ReviewItem = { ...cur, status, response, resolvedAt };
    this.registry.upsertReview(updated);

    const set = this.waiters.get(id);
    if (set) {
      for (const w of [...set]) w(updated);
      this.waiters.delete(id);
    }
    return updated;
  }
}
