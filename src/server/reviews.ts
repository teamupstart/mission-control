import { randomUUID } from "node:crypto";
import type {
  PlanDecision,
  PlanDecisionAnswer,
  ReviewActor,
  ReviewItem,
  ReviewKind,
  ReviewStatus,
} from "@shared/types.ts";
import { isHumanResolvedReview } from "@shared/review-item.ts";
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
/**
 * Do two asks offer the human the same choice?
 *
 * Compared through a canonical serialization rather than `deepEqual` on the parsed value,
 * because the two sides are the same JSON payload sent twice and re-parsed - identical in
 * content, and with no guarantee of identical key order or of which optional keys survived
 * as `undefined`. Sorting keys and dropping `undefined` makes the comparison about what the
 * human would read, which is the only thing that decides whether these are one question.
 */
function sameDecisions(a: PlanDecision[] | null | undefined, b: PlanDecision[] | null): boolean {
  return canonical(a ?? null) === canonical(b);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    entries.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return Object.fromEntries(entries);
  });
}

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

  /**
   * Open a question and publish it - or hand back the identical one already open.
   *
   * The re-attach is the whole point, and it is not a nicety. Every tool that lands here
   * (`request_input`, `request_plan_decisions`, `request_review`) BLOCKS until a human
   * decides, for as long as that takes. The MCP client in front of it does not wait that
   * long: it abandons the tool call on its own timeout and hands the model an error, and
   * the model's natural recovery is to ask the identical question again. Nothing here
   * could tell that retry from a fresh ask - a new UUID per call, no dedup key on the
   * table - so the abandoned row stayed pending BESIDE its own retry and the operator was
   * shown the same prompt twice, with no way to tell which of the two still had an agent
   * listening behind it. The live database records the pattern plainly: the duplicate
   * pairs cluster 293-325 seconds apart with a byte-identical body, which is a client
   * timeout and not a human-meaningful interval.
   *
   * So an identical ask from the same session, while the first is still unanswered, is
   * treated as what it is - the same question - and returns the existing row untouched.
   * The retry then long-polls the ORIGINAL review, and `wait` keeps a SET of waiters per
   * id, so answering the one card the operator sees unblocks every call still holding on.
   *
   * Scoped to PENDING deliberately, which is what makes this safe rather than sticky. A
   * question the human already settled is not a match, so an agent that legitimately asks
   * the same thing again later gets a fresh card; the collapse only ever covers the window
   * where a second card would have been unanswerable noise anyway. And the two asks it
   * refuses to collapse are the two it must: a different session's, and one whose offered
   * options differ, since the options are what the human is actually choosing between.
   *
   * This is a floor, not the fix for the timeout itself - it makes a retry HARMLESS rather
   * than preventing one. The MCP side keeps the call alive so the retry mostly does not
   * happen (`src/mcp/server.ts`), but that depends on a client honouring progress
   * notifications, and this does not depend on anything.
   */
  create(
    sessionId: string,
    kind: ReviewKind,
    title: string,
    body: string,
    decisions: PlanDecision[] | null = null,
  ): ReviewItem {
    const existing = this.registry
      .pendingReviews(sessionId)
      .find((r) => r.kind === kind && r.title === title && r.body === body && sameDecisions(r.decisions, decisions));
    if (existing) return existing;

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
   *
   * REFUSED when the session has no row in the registry, which is the dangling case and the
   * one place it can arise: this method is reached only after `answerDriverRequest` has
   * AWAITED the driver taking the answer, and an eviction timer can fire inside that await.
   * What would be written is a conversation entry for a conversation that no longer exists -
   * nothing can render it, because the card is gone - and it would be durably
   * indistinguishable from an ordinary answer for ever after. That is not a cosmetic
   * difference: retro worthiness is reconstructed from these rows when a session is
   * introduced (`Registry.seedRetroFromReviews`), so a row written behind a departed session
   * would light the offer for the very path the design excludes, on this daemon or on any
   * later one. Refusing at the write is what makes that exclusion structural rather than a
   * piece of memory a restart discards.
   *
   * A throw rather than a silent no-op, and it costs nothing: the caller already treats a
   * failed record as a thing to log beside the delivery that did happen, and must not turn it
   * into a 409 - the operator would answer a question the agent is no longer blocked on.
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
    if (!this.registry.getSession(o.sessionId)) {
      throw new ReviewResolutionError(
        `session ${o.sessionId} is no longer registered, so its answer has no conversation to join`,
      );
    }
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
    this.markSteered(review);
    return review;
  }

  /**
   * A settled review the human authored is the same retro evidence as a typed correction.
   *
   * ONE test for both writers of a terminal status, and it is `isHumanResolvedReview` rather
   * than a status check spelled again here: Foreman resolves reviews through the very route
   * the dashboard does, and the daemon's own orphan settle carries no actor at all. Neither
   * is a person steering the work, and both are already excluded from the conversation by
   * this same predicate - so the offer and the log agree by construction.
   *
   * Called AFTER the durable write and the publish, never before. A rolled-back transaction
   * throws out of `record` before it reaches here, and a delivery that failed never reached
   * `record` at all (the driver route returns 409 first) - so nothing lights the offer on an
   * answer the agent never received. The Registry drops it on the floor when the session row
   * has already gone; see `recordRetroHumanReview`.
   */
  private markSteered(review: ReviewItem): void {
    if (!isHumanResolvedReview(review)) return;
    this.registry.recordRetroHumanReview(review.sessionId);
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

    // You decided this yourself, so Foreman's pinned note about the same review is spent.
    //
    // Gated on the HUMAN, and the two excluded actors are excluded for different reasons.
    // `foreman` is Foreman delivering its own approved answer, whose `applyVerdict` writes
    // the note itself - retiring it here would race that write and file the decision as one
    // nobody delivered. A null actor is the daemon orphaning reviews for a session that went
    // away: no decision was made, so there is no answer of yours to credit, and the note
    // rightly stays until the session's own teardown clears it.
    if (resolvedBy === "human") {
      this.registry.retireNoteAnsweredByYou(cur.sessionId, `review:${cur.id}`);
    }
    this.markSteered(updated);

    const set = this.waiters.get(cur.id);
    if (set) {
      for (const w of [...set]) w(updated);
      this.waiters.delete(cur.id);
    }
    return updated;
  }
}
