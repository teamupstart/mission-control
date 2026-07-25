import { randomUUID } from "node:crypto";
import type { PlanDecision, ReviewItem, ReviewKind, ReviewStatus } from "@shared/types.ts";
import type { Registry } from "./registry.ts";
import { insertReview, updateReviewStatus } from "./db.ts";
import { unref } from "./util/timers.ts";

export type ReviewAction = "approve" | "reject" | "answer" | "dismiss";

type Waiter = (r: ReviewItem) => void;

export class ReviewResolutionError extends Error {}

/**
 * Owns the review lifecycle and the long-poll waiters that let an agent block on
 * a human decision. The agent (via MCP) creates a review and calls `wait`; the
 * human resolves it from the UI, which unblocks every waiter. This is the
 * generalized analog of no-mistakes' `axi respond` approval gate.
 */
export class ReviewManager {
  private waiters = new Map<string, Set<Waiter>>();

  constructor(private registry: Registry) {
    // A review is durable state BOUND TO A SESSION, so it needs the same two halves every
    // other such subscriber has (see `Registry.beginEviction`). Without them a pending row
    // outlived its agent for ever: `remove` clears seven session-scoped maps and never
    // touched this one, and `loadPendingReviews()` restores every pending row at boot
    // whether or not the process that asked still exists. That is a topbar counting eight
    // agents "waiting on your review" when all of them exited days ago - and counting them
    // is the lesser half of it, because the chip opens the modal keyed on the review's
    // session, which is no longer in the session list, so the click does nothing at all.
    //
    // While the daemon is UP: `session_remove`, which the Registry emits only from its
    // eviction timer. Keying on `state === "exited"` instead would settle a live agent's
    // question on one hiccuping sweep, and there is no way back from a terminal status.
    this.registry.subscribe((e) => {
      if (e.type === "session_remove") this.orphanReviewsFor(e.id);
    });
    // And one whose session went away while the daemon was DOWN is in no map at all until
    // discovery rebuilds it, so the same reconciliation waits for the first COMPLETED
    // sweep. Running it any earlier would orphan the questions of every agent that
    // outlived the restart, which are exactly the ones still worth answering.
    this.registry.onSessionsObserved(() => this.orphanReviewsWithNoLiveSession());
  }

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
    if (
      action === "dismiss" &&
      cur.kind !== "plan-decisions" &&
      (cur.kind !== "input" || !cur.decisions?.some((decision) => decision.options.length > 0))
    ) {
      throw new ReviewResolutionError("only reviews with selectable decisions can be dismissed");
    }
    if (cur.status !== "pending") return cur;

    const status: ReviewStatus =
      action === "approve"
        ? "approved"
        : action === "reject"
          ? "rejected"
          : action === "dismiss"
            ? "dismissed"
            : "answered";
    const storedResponse = action === "dismiss" ? null : response;
    return this.settle(cur, status, storedResponse);
  }

  /**
   * The session that asked has gone. Settle everything it was blocked on.
   *
   * `orphaned` rather than `dismissed`: the operator declining to choose and the agent no
   * longer being there to hear a choice are different facts, and only the first is
   * evidence of intent. The row keeps its question and its body - this is a settle, not a
   * delete, so the record of what was asked survives for anything reading history.
   */
  private orphanReviewsFor(sessionId: string): void {
    for (const r of this.registry.pendingReviews(sessionId)) this.settle(r, "orphaned", null);
  }

  /** The restart half: pending reviews bound to a session the first sweep never found. */
  private orphanReviewsWithNoLiveSession(): void {
    for (const r of this.registry.pendingReviews()) {
      if (this.registry.getSession(r.sessionId)) continue;
      this.settle(r, "orphaned", null);
    }
  }

  /**
   * The one writer of a terminal status, human-driven or not.
   *
   * Persist, publish, then release the waiters - in that order, and never one without the
   * others. The write is what survives a restart (`loadPendingReviews` is a SQL filter on
   * status, so an in-memory-only settle comes straight back at the next boot), the upsert
   * is what reaches the dashboards (the live channel is SSE only; nothing polls this), and
   * waking the waiters is what unblocks an agent long-polling on an answer instead of
   * leaving it to discover the timeout.
   */
  private settle(cur: ReviewItem, status: ReviewStatus, response: string | null): ReviewItem {
    const resolvedAt = Date.now();
    updateReviewStatus(cur.id, status, response, resolvedAt);
    const updated: ReviewItem = { ...cur, status, response, resolvedAt };
    this.registry.upsertReview(updated);

    const set = this.waiters.get(cur.id);
    if (set) {
      for (const w of [...set]) w(updated);
      this.waiters.delete(cur.id);
    }
    return updated;
  }
}
