import { randomUUID } from "node:crypto";
import type {
  PlanDecision,
  PlanDecisionAnswer,
  ReviewActor,
  ReviewItem,
  ReviewKind,
  ReviewStatus,
} from "@shared/types.ts";
import type { Registry } from "./registry.ts";
import { inTransaction, insertReview, updateReviewStatus } from "./db.ts";
import { unref } from "./util/timers.ts";

export type ReviewAction = "approve" | "reject" | "answer" | "dismiss";

type Waiter = (r: ReviewItem) => void;

export class ReviewResolutionError extends Error {}

/**
 * Owns the review lifecycle and the long-poll waiters that let an agent block on
 * a human decision. The agent (via MCP) creates a review and calls `wait`; the
 * human resolves it from the UI, which unblocks every waiter. This is the
 * generalized approval and input channel for agents.
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
      selections: null,
      resolvedBy: null,
      createdAt: Date.now(),
      resolvedAt: null,
    };
    insertReview(review);
    this.registry.upsertReview(review);
    return review;
  }

  /**
   * Write a question that was ALREADY answered elsewhere - born settled, never pending.
   *
   * The second writer of this table, and the reason it is a separate method rather than a
   * `create` followed by a `resolve`. A session on the SDK runtime keeps Claude's native
   * `AskUserQuestion` and is answered by resolving the callback it is blocked on
   * (`/submit-options`), so by the time there is anything to record the decision is made
   * and the agent has moved on. Routing that through the pending path would publish a
   * `review_upsert` with `status: "pending"` for an instant - long enough for the dashboard
   * to bump its badge, pop the review modal over whatever the operator was reading, and
   * offer them a form for a question that is already gone.
   *
   * So this is the whole of it: one durable write, one upsert to publish it. No waiters are
   * woken because nothing is waiting - a driver request has no MCP long poll behind it - and
   * `refreshPendingCount` is a no-op on a row that was never pending.
   *
   * "Born settled" has to hold of the DATABASE and not only of the event, which is what
   * `inTransaction` is for. Two writers land this row - `insertReview` lays down every
   * column it shares with a `create`, `updateReviewStatus` stamps the settle columns - and
   * a failure between them commits the first without the second.
   *
   * Be precise about what that leaves, because it is NOT a pending review: `insertReview`
   * writes the status off the item, and the item is already `answered`, so the half-written
   * row reads `answered` with a null `resolved_by` and null `selections`. Nothing restores
   * it as a question (`loadPendingReviews` filters on `pending`) and nothing shows it as an
   * answer (`loadHumanResolvedReviews` requires `resolved_by = 'human'`), so it is inert -
   * today. It is still worth not writing. It is indistinguishable from a row that predates
   * the actor column, it accumulates where nothing will ever collect it, and its harmlessness
   * is a property of two queries in another module rather than of this write: the first
   * reader that asks for `status = 'answered'` without also asking who answered surfaces a
   * review with no author and no selections. The transaction makes the pair all-or-nothing,
   * so the failure mode is "no record of an answer" - which the conversation shows as the
   * silence this feature replaced - and never a row that half exists.
   *
   * Two writers inside a transaction rather than one wide INSERT, deliberately. The settle
   * columns then have exactly one place they are written from, so a column added to
   * `updateReviewStatus` reaches this path for free; a terminal-state INSERT here would be a
   * second column list to keep in step, and the one that silently drifts is the one no
   * pending-review path exercises.
   *
   * The upsert RETAINS as well as publishes, and that is not incidental. The dashboard
   * re-seeds its live review map wholesale from the reconnect snapshot
   * (`useEventStream`), so a record that was only emitted would vanish from an open
   * conversation the first time the SSE stream dropped - and the fetched half beside it was
   * taken at mount, before this row existed, so nothing would put it back until the panel
   * remounted. Publishing without keeping is the cheaper-looking version of this that does
   * not work.
   *
   * `resolvedBy` is required, not defaulted. It is the field the conversation reads to
   * decide whose voice an answer speaks in (`isHumanResolvedReview`), and Foreman answers
   * driver questions through the very same route the dashboard does.
   */
  record(o: {
    sessionId: string;
    kind: ReviewKind;
    title: string;
    body: string;
    decisions: PlanDecision[];
    selections: PlanDecisionAnswer[];
    response: string;
    resolvedBy: ReviewActor;
    /**
     * When the human spoke - NOT when this ran.
     *
     * The conversation places an answer by `resolvedAt`, and the caller only reaches this
     * after the answer has been handed to the driver, which is after the agent has been
     * unblocked and may already have written its next turn. Stamping here would file a
     * decision below the reply it caused. The route takes the reading before it delivers.
     */
    at: number;
  }): ReviewItem {
    const now = o.at;
    const review: ReviewItem = {
      id: randomUUID(),
      sessionId: o.sessionId,
      kind: o.kind,
      title: o.title,
      body: o.body,
      status: "answered",
      response: o.response,
      decisions: o.decisions,
      selections: o.selections,
      resolvedBy: o.resolvedBy,
      createdAt: now,
      resolvedAt: now,
    };
    inTransaction(() => {
      insertReview(review);
      updateReviewStatus(review.id, "answered", o.response, now, o.selections, o.resolvedBy);
    });
    // Published only after the commit, so nothing can put a review on screen that a rollback
    // then took off disk. The throw from a failed transaction reaches the caller, which
    // logs it and still reports the delivery that did happen.
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

  /**
   * A decision arriving from outside: the dashboard's, or the Foreman worker's.
   *
   * `by` is carried rather than assumed because both arrive on the same route, and only the
   * human's answers belong in the session's conversation (`isHumanResolvedReview`).
   * `selections` is the structured form behind an `answer`, kept so that conversation can
   * replay the question - the `response` string beside it names only what was chosen.
   */
  resolve(
    id: string,
    action: ReviewAction,
    response: string | null,
    by: ReviewActor = "human",
    selections: PlanDecisionAnswer[] | null = null,
  ): ReviewItem | null {
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
    // Selections describe a form that was filled in, so only an `answer` can carry them.
    // The schema already clears them on a dismiss; this covers the approve/reject actions
    // it does not, and holds whether or not the request came through that schema.
    const storedSelections = action === "answer" ? selections : null;
    return this.settle(cur, status, storedResponse, by, storedSelections);
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
  private settle(
    cur: ReviewItem,
    status: ReviewStatus,
    response: string | null,
    /**
     * Null for the two orphan paths below, which are the daemon tidying up after a session
     * that went away - not a decision anyone made, and so not a voice in the conversation.
     */
    resolvedBy: ReviewActor | null = null,
    selections: PlanDecisionAnswer[] | null = null,
  ): ReviewItem {
    const resolvedAt = Date.now();
    updateReviewStatus(cur.id, status, response, resolvedAt, selections, resolvedBy);
    const updated: ReviewItem = { ...cur, status, response, resolvedAt, resolvedBy, selections };
    this.registry.upsertReview(updated);

    const set = this.waiters.get(cur.id);
    if (set) {
      for (const w of [...set]) w(updated);
      this.waiters.delete(cur.id);
    }
    return updated;
  }
}
