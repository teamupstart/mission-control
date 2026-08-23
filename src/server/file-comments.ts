import { randomUUID } from "node:crypto";
import type { FileCommentMessage, FileCommentThread } from "@shared/types.ts";
import {
  boundQuote,
  fileCommentQuoteHash,
  type FileCommentSurface,
} from "@shared/file-comment-anchor.ts";
import type { FileCommentAuthor, HumanSettableThreadStatus } from "@shared/file-comments.ts";
import { isHumanSettableThreadStatus, isOutstandingThreadStatus } from "@shared/file-comments.ts";
import {
  FileCommentStoreError,
  appendFileCommentMessage,
  createFileCommentThread,
  deleteFileCommentThread,
  isOutstandingFileCommentViolation,
  loadFileCommentMessage,
  loadFileCommentThread,
  loadFileCommentThreadWithFullHistory,
  markFileCommentMessagesRead,
  markFileCommentThreadAddressed,
  orphanFileCommentThreadsForSession,
  queueFileCommentThread,
  reorderFileCommentQueue,
  setFileCommentThreadStatus,
  updateFileCommentMessageBody,
} from "./db.ts";
import type { Registry } from "./registry.ts";
import { unref } from "./util/timers.ts";

/** How long a settled thread survives after its session went away, before the prune. */
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;
/** How often the prune runs. Throttled, like `Registry.pruneGoals`' caller. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export class FileCommentError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Owns the session-scoped lifetime of line-comment threads, and is the one place a durable
 * write and its live frame are paired.
 *
 * **Threads end with the session that owns them, and it takes THREE mechanisms** - the
 * repository's actual pattern for durable session-scoped state, copied from `ReviewManager`
 * and `Registry.pruneGoals` rather than invented. No later phase adds a fourth teardown
 * path:
 *
 * 1. `session_remove` while the daemon is UP. Emitted by the Registry only from its
 *    eviction timer. Keying on `state === "exited"` instead would settle a live agent's
 *    review on one hiccuping sweep, and `orphaned` is terminal - there is no way back.
 * 2. `onSessionsObserved` for the restart case. A session that went away while the daemon
 *    was DOWN is in no map at all until discovery rebuilds it, so its threads would survive
 *    for ever; the reconciliation waits for the first COMPLETED sweep, because running it
 *    earlier would orphan the threads of every session that outlived the restart - exactly
 *    the ones still worth reading.
 * 3. A throttled prune that finally DELETES settled rows whose session key is gone, so the
 *    table does not grow for the daemon's whole life.
 *
 * Orphaning is an UPDATE, never a DELETE: the comment a human wrote is a record of what was
 * asked, and losing it because an agent exited would be the same mistake as losing a review.
 */
export class FileCommentManager {
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private registry: Registry) {
    this.registry.subscribe((e) => {
      if (e.type === "session_remove") this.orphanFor(e.id);
    });
    this.registry.onSessionsObserved(() => this.orphanWithNoLiveSession());
  }

  /**
   * Arm the prune. Separate from the constructor so a route-unit test can build a manager
   * without leaving a timer behind, the same accommodation every optional service in
   * `buildApp` documents.
   */
  start(): void {
    if (this.pruneTimer) return;
    this.pruneTimer = unref(
      setInterval(() => this.registry.pruneFileComments(Date.now() - PRUNE_AFTER_MS), PRUNE_INTERVAL_MS),
    );
  }

  stop(): void {
    if (!this.pruneTimer) return;
    clearInterval(this.pruneTimer);
    this.pruneTimer = null;
  }

  // ---- reads ----

  list(sessionId: string, path?: string): FileCommentThread[] {
    const all = this.registry.fileCommentThreadsForSession(sessionId);
    return path === undefined ? all : all.filter((t) => t.path === path);
  }

  get(id: string): FileCommentThread | null {
    return this.registry.getFileCommentThread(id) ?? loadFileCommentThread(id);
  }

  /**
   * One thread with its WHOLE reply history - the single-thread route's read.
   *
   * Never served from the registry, deliberately: the held copy is the one that rides the
   * wire, and its message list is capped. This is the escape hatch a surface takes once
   * `messageCount` has told it the frame was a tail, so answering it from the capped copy
   * would return the same truncation it was called to get past.
   */
  getFull(id: string): FileCommentThread | null {
    return loadFileCommentThreadWithFullHistory(id);
  }

  // ---- writes ----

  /**
   * Resolve a thread that may still be WRITTEN to, or refuse.
   *
   * This is where the session-ownership lifetime is enforced against a thread-scoped route.
   * A thread id is a durable uuid a dashboard may still be holding minutes after the session
   * that owned it was evicted, and every mutation below reaches the store by id alone - so
   * without this guard, a reply, a status change, a read stamp or an addressed stamp on a
   * retained id would write to a settled row AND republish it into the live collection,
   * putting a comment for a session that no longer exists back on every dashboard. That
   * would undo `orphaned` being terminal and would break the "bounded by live sessions"
   * claim the snapshot collection makes.
   *
   * `orphaned` is checked rather than "is the session live", because those differ in the one
   * direction that matters: a session that is merely idle, disconnected, or mid-restart is
   * absent from no map the operator can see and MUST keep taking comments - that is the
   * whole reason cleanup is keyed on `session_remove` and never on `state === "exited"`.
   * `orphaned` is the durable record that the eviction actually happened.
   *
   * `resolved` is deliberately NOT refused here: a person closed that thread and a person
   * may reopen it, which is the existing two-step through the status route.
   */
  private writable(threadId: string): FileCommentThread {
    // Read the DURABLE row, never `get()`'s registry-first copy. The held frame is a wire
    // artifact: it is whatever was last published, and the writers that move a thread without
    // republishing are precisely the ones this guard has to see. Phase 3's
    // `beginFileCommentDelivery` moves a row to `sending` from the outbox, so a guard reading
    // the held copy would still see `queued` and let a person settle a comment that is
    // already out with the agent - the hole this guard exists to close. One extra read per
    // mutation is the price of the guard meaning what it says.
    const thread = loadFileCommentThread(threadId);
    if (!thread) throw new FileCommentError("no such comment thread", 404);
    if (thread.status === "orphaned") {
      throw new FileCommentError("this comment's session has ended", 409);
    }
    return thread;
  }

  /**
   * `writable()`, plus the rule that a comment already out with the agent is not one a person
   * can END - by settling it to another status, or by destroying it.
   *
   * Named once and shared, because it has now been forgotten twice at two different doors.
   * `sending` and `awaiting` are the statuses the partial unique index is built on, so BOTH
   * ways out release the session's single-flight slot while the pending turn can still reach
   * the agent, after which the next queued thread begins delivery into a session that already
   * has one outstanding. Deleting is the worse of the two: it releases the slot and destroys
   * the row, so when the reply arrives there is nothing left for it to land on.
   *
   * A status write and a DELETE both act on this table alone; neither recalls bytes already
   * in the outbox. Cancelling a live delivery means recalling the turn in the same transaction
   * as the row change, against an outbox this phase does not own - that is phase 3's, and a
   * partial version of it here would be worse than a refusal.
   *
   * Not a hang: the grace window moves `awaiting` to `unanswered`, which sits outside the
   * outstanding tuple precisely so the queue can advance, and both doors open again from
   * there.
   */
  private settleable(threadId: string): FileCommentThread {
    const thread = this.writable(threadId);
    if (isOutstandingThreadStatus(thread.status)) {
      throw new FileCommentError(
        "this comment is already out with the agent; wait for a reply or the grace window",
        409,
      );
    }
    return thread;
  }

  /**
   * Create a thread and its opening comment as a `draft`.
   *
   * The quote is BOUNDED and the hash is computed HERE, never accepted from the caller -
   * the same rule `fingerprint()` states for the Inspector. The hash decides whether two
   * anchors are the same comment, so a caller that could choose it could make any comment
   * collide with any other.
   */
  create(input: {
    sessionId: string;
    path: string;
    startLine: number;
    endLine: number;
    quote: string;
    revision: string | null;
    surface: FileCommentSurface;
    body: string;
  }): FileCommentThread {
    if (!this.registry.getSession(input.sessionId)) {
      throw new FileCommentError("no such session", 404);
    }
    const quote = boundQuote(input.quote);
    const now = Date.now();
    try {
      // Wrapped like every other write on this manager. The store refuses a session that has
      // reached its live-thread budget, and without this that refusal reached the route as a
      // raw `FileCommentStoreError` and became an opaque 500 rather than the 409 with a reason
      // a person can act on.
      const thread = createFileCommentThread({
        id: randomUUID(),
        messageId: randomUUID(),
        sessionId: input.sessionId,
        path: input.path,
        startLine: input.startLine,
        endLine: Math.max(input.startLine, input.endLine),
        quote,
        quoteHash: fileCommentQuoteHash(input.path, quote),
        revision: input.revision,
        surface: input.surface,
        body: input.body,
        now,
      });
      this.registry.upsertFileCommentThread(thread);
      return thread;
    } catch (err) {
      throw this.asRouteError(err);
    }
  }

  /** The only way a message row is written, by either author. */
  appendMessage(threadId: string, author: FileCommentAuthor, body: string): FileCommentMessage {
    try {
      // Wrapped like the other writes: the store refuses a thread that has reached its
      // retention bound, and an unmapped `FileCommentStoreError` would reach the route as a
      // 500 rather than a 409 saying what to do about it.
      const thread = this.writable(threadId);
      const message = appendFileCommentMessage({
        id: randomUUID(),
        threadId,
        author,
        sessionId: thread.sessionId,
        body,
        now: Date.now(),
      });
      if (!message) throw new FileCommentError("no such comment thread", 404);
      // A human reply re-enters the review at the END, and is delivered in its turn exactly
      // like a new comment. What goes is THE REPLY, not the comment that opened the thread:
      // the payload always carries the thread's oldest human message with `delivered_at` NULL,
      // so a requeued thread sends what was just written rather than resending its first
      // message.
      //
      // **Scoped to the two statuses a reply may move, and that scope is load-bearing.**
      // Appending to the comment currently in flight is always allowed - a person may answer
      // the comment they are reading - but the STATUS must not move, because `sending` and
      // `awaiting` are the two statuses the single-flight index is built on. Requeueing one of
      // those would empty the outstanding set while a turn is genuinely live in
      // `pending_turns`, and the walkthrough would release the next comment on top of it. That
      // message simply waits: when the turn resolves with an undelivered human message left,
      // the walkthrough requeues the thread for it.
      //
      // A `draft` is left alone too, for a different reason: it is submitted by a person
      // pressing Comment, and auto-queueing on the first keystroke would put every abandoned
      // half-sentence into the review.
      if (
        author === "human" &&
        (thread.status === "answered" || thread.status === "unanswered")
      ) {
        // Phase 1's tail-allocating writer, never a status write plus a reorder: it refuses an
        // outstanding thread and a terminal one in the one place, where it cannot be forgotten.
        const requeued = queueFileCommentThread(threadId, Date.now());
        if (requeued) this.registry.upsertFileCommentThread(requeued);
        return message;
      }
      this.publish(threadId);
      return message;
    } catch (err) {
      throw this.asRouteError(err);
    }
  }

  editMessage(messageId: string, body: string): FileCommentThread {
    try {
      // The thread is resolved from the message BEFORE the write, so an edit cannot reach a
      // settled row through a message id either.
      const owner = loadFileCommentMessage(messageId);
      if (!owner) throw new FileCommentError("no such message", 404);
      this.writable(owner.threadId);
      const message = updateFileCommentMessageBody(messageId, body, Date.now());
      if (!message) throw new FileCommentError("no such message", 404);
      return this.publish(message.threadId);
    } catch (err) {
      throw this.asRouteError(err);
    }
  }

  /**
   * Submit a thread into the review queue, or put a replied-to one back at the tail.
   *
   * One operation rather than a status write followed by a reorder: those are two HTTP
   * requests, and a second submit landing between them takes the same position. The
   * integrated Files tab and the extracted Files window make two concurrent submits
   * ordinary rather than exotic.
   */
  queue(threadId: string): FileCommentThread {
    try {
      // The store's allow-list already refuses `orphaned`; this makes the refusal read as
      // the lifetime rule it is rather than as a queue-position rule.
      this.writable(threadId);
      const thread = queueFileCommentThread(threadId, Date.now());
      if (!thread) throw new FileCommentError("no such comment thread", 404);
      this.registry.upsertFileCommentThread(thread);
      return thread;
    } catch (err) {
      throw this.asRouteError(err);
    }
  }

  reorder(sessionId: string, orderedIds: readonly string[]): FileCommentThread[] {
    const reordered = reorderFileCommentQueue(sessionId, orderedIds, Date.now());
    // The store returns the session's whole list, which includes rows already settled to
    // `orphaned` (they hold no queue position, so the rewrite never touched them). Filtering
    // here is what stops a reorder from being a second way to put one back on screen.
    const threads = reordered.filter((t) => t.status !== "orphaned");
    for (const t of threads) this.registry.upsertFileCommentThread(t);
    return threads;
  }

  /**
   * Move a thread to a status A PERSON chose.
   *
   * The parameter is `HumanSettableThreadStatus`, not `FileCommentThreadStatus`, and the
   * narrowing is the point: `orphaned` is not a decision, it is what a thread becomes when
   * its session goes away. Only the three lifetime mechanisms reach it, and each of them
   * calls the store's `orphanFileCommentThreadsForSession` directly rather than coming
   * through here. Letting a request set it settled a LIVE session's thread to a terminal
   * status and dropped it out of the live collection, after which every later write on it
   * was refused with "this comment's session has ended" about a session still running.
   *
   * Checked at RUNTIME as well as in the type, because the caller is an HTTP route: the
   * schema refuses it first, and this refuses it if a later caller reaches the manager by
   * some other path.
   */
  setStatus(threadId: string, status: HumanSettableThreadStatus): FileCommentThread {
    try {
      if (!isHumanSettableThreadStatus(status)) {
        throw new FileCommentError(
          "a comment is orphaned by its session ending, not by request",
          400,
        );
      }
      // Without this an `orphaned` thread could be moved to a NON-terminal status and
      // upserted straight back into the live collection - the one transition that would make
      // `orphaned` reversible, and the only way out of a lifetime that has already ended.
      this.settleable(threadId);
      if (!setFileCommentThreadStatus(threadId, status, Date.now())) {
        throw new FileCommentError("no such comment thread", 404);
      }
      // Always an upsert now: the only status that would have called for a remove is the one
      // this method no longer accepts. `publish` keeps the orphan backstop anyway, for the
      // race where session cleanup settled the row between the guard and this line.
      return this.publish(threadId);
    } catch (err) {
      throw this.asRouteError(err);
    }
  }

  markRead(threadId: string): FileCommentThread {
    this.writable(threadId);
    const thread = markFileCommentMessagesRead(threadId, Date.now());
    if (!thread) throw new FileCommentError("no such comment thread", 404);
    this.registry.upsertFileCommentThread(thread);
    return thread;
  }

  /**
   * The agent's "I handled this". Declared here and called from phase 4's reply route -
   * there is deliberately no dashboard route for it, because nothing in the dashboard sets
   * it, and routing it through the status route would force a status transition in order to
   * write a timestamp, which is exactly how a suggestion becomes a closure.
   */
  markAddressed(threadId: string): FileCommentThread {
    this.writable(threadId);
    const thread = markFileCommentThreadAddressed(threadId, Date.now());
    if (!thread) throw new FileCommentError("no such comment thread", 404);
    this.registry.upsertFileCommentThread(thread);
    return thread;
  }

  /**
   * Delete a thread and its replies outright. The one operation that really does destroy the
   * comment, so it is the one that most needs the lifetime guard rather than least.
   *
   * `writable()` applies here for the same reason it applies to every other thread-scoped
   * mutation, and the earlier permissive version was a mistake: orphaning deliberately keeps
   * the row - the comment is a record of what was asked - and only the throttled prune
   * removes it, once the session key is gone AND the retention window has passed. A dashboard
   * still holding the id of a thread that left the live collection could delete an orphaned
   * thread and its whole history through this route, which is exactly the retention the
   * three-mechanism lifetime promises, undone by a stale client.
   *
   * `settleable()` rather than `writable()`, so it also refuses while the comment is out with
   * the agent. Deleting an outstanding thread released the session's single-flight slot AND
   * destroyed the row, so the next queued comment began delivery while the first turn was
   * still in flight - and when the reply arrived there was nothing left for it to land on.
   *
   * A person deleting a comment in a session that is still running is untouched; that is what
   * this route is for.
   */
  delete(threadId: string): boolean {
    try {
      this.settleable(threadId);
      const gone = deleteFileCommentThread(threadId);
      if (gone) this.registry.removeFileCommentThread(threadId);
      return gone;
    } catch (err) {
      throw this.asRouteError(err);
    }
  }

  // ---- lifetime ----

  /**
   * Mechanism 1. The session has gone; settle everything it owned.
   *
   * `orphaned` rather than deleted, and the emitted frame is a REMOVE because the row is no
   * longer something a browser can act on - not because the row is gone.
   */
  private orphanFor(sessionId: string): void {
    for (const id of orphanFileCommentThreadsForSession(sessionId, Date.now())) {
      this.registry.removeFileCommentThread(id);
    }
    // The store deletes the review row in the same transaction, because there is nothing left
    // to walk through and a row left `running` would resume a review for a session that no
    // longer exists. This drops the live projection to match. Unconditional rather than
    // guarded on the loop above: a review can outlive its last thread - every comment
    // resolved, the review still paused - and that row must go too.
    this.registry.removeFileCommentReview(sessionId);
  }

  /**
   * Mechanism 2. Threads bound to a session the first completed sweep never found.
   *
   * Deliberately shaped as `orphanReviewsWithNoLiveSession` is - ask each held thread
   * whether its session is here, and settle the ones whose is not through mechanism 1's
   * writer - rather than as a set-difference query. Asking per thread cannot misread an
   * empty session map as "everything is dead", because it only ever names sessions a thread
   * already claims, and it keeps `orphaned` to ONE declared writer.
   */
  private orphanWithNoLiveSession(): void {
    const dead = new Set<string>();
    for (const t of this.registry.listFileCommentThreads()) {
      if (!this.registry.getSession(t.sessionId)) dead.add(t.sessionId);
    }
    for (const sessionId of dead) this.orphanFor(sessionId);
  }

  /**
   * Persist-then-publish, with the one thing no caller may get wrong: a SETTLED thread is
   * never upserted into the live collection.
   *
   * `writable()` above is the guard every mutation goes through; this is the backstop at the
   * single point where a row becomes a frame, so a mutation added later cannot revive a
   * thread by forgetting the guard. It emits a remove instead, which is what the two orphan
   * arms emit and is exactly what a browser still holding the thread needs.
   */
  private publish(threadId: string): FileCommentThread {
    const thread = loadFileCommentThread(threadId);
    if (!thread) throw new FileCommentError("no such comment thread", 404);
    if (thread.status === "orphaned") this.registry.removeFileCommentThread(threadId);
    else this.registry.upsertFileCommentThread(thread);
    return thread;
  }

  /**
   * Turn the store's two refusals into clean HTTP rather than an opaque 500.
   *
   * The index and the allow-list stay the enforcement - that is the whole point of putting
   * them there - but a raw `ERR_SQLITE_ERROR` escaping the route means the daemon logs a
   * stack trace and the caller cannot tell "you broke the invariant" from "the daemon fell
   * over". Same accommodation `QueueManager.write` makes for `one_inflight_per_queue`.
   */
  private asRouteError(err: unknown): unknown {
    if (err instanceof FileCommentError) return err;
    if (isOutstandingFileCommentViolation(err)) {
      return new FileCommentError("another comment in this session is already outstanding", 409);
    }
    if (err instanceof FileCommentStoreError) return new FileCommentError(err.message, 409);
    return err;
  }
}
