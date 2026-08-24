// The walkthrough: a review's comments reaching one session, one turn at a time.
//
// **Exactly one turn is outstanding, ever.** That single constraint is what keeps three
// known limits of the existing outbox from mattering at all: `pending_turns` recalls only
// its TAIL row (`test/pending-turn-db.test.ts` pins "an older row cannot jump the stack"),
// an `uncertain` row wedges everything behind it, and it carries no correlation id. At depth
// one, the tail IS the queue, there is nothing behind the wedge, and the one row in flight is
// named by the thread's own `delivery_id`. Nothing here may raise that depth to two.
//
// The queue itself lives on `file_comment_threads`, NOT in `pending_turns` - that table gives
// strict FIFO and nothing else: no edit, no reorder, no mid-review steering, which is exactly
// what one-at-a-time exists to provide. And delivery goes through the EXISTING human outbox
// rather than beside it. Two outboxes already share one pane with no arbiter, separated only
// by differing settle windows; a third scheduler would be the first without that accidental
// separation. This is a caller of that outbox, never a peer to it.
//
// Everything durable. The per-comment progress is the thread's own status; the review's
// `idle | running | paused` is a `file_comment_reviews` row, because "paused" and "never
// started" are otherwise the same set of threads. A daemon restart therefore resumes rather
// than re-sends.

import type { FileCommentMessage, FileCommentReview, FileCommentThread, PendingTurn, Session } from "@shared/types.ts";
import { reanchor, type FileCommentAnchor } from "@shared/file-comment-anchor.ts";
import { isOutstandingThreadStatus } from "@shared/file-comments.ts";
import { messageBlockReason } from "@shared/pane.ts";
import { settledIdle } from "@shared/session.ts";
import { openingDeliveryHandle, renderFileCommentPayload } from "./file-comment-payload.ts";

/**
 * How long a session must sit settled-idle before a comment it never answered is given up on.
 *
 * The same ten seconds `WORKFLOW_RESUMPTION_SETTLE_MS` uses, and for its reason rather than by
 * coincidence: it is this daemon's existing answer to "the agent has genuinely stopped", as
 * opposed to the outbox's 1,500ms, which only asks "is there a gap big enough to type into".
 * Giving up on an answer is the heavier of those two questions, so it takes the heavier window.
 *
 * Measured from CONFIRMED delivery as well as from the session's last activity. Idle alone is
 * not enough: a session can be settled-idle at the instant a comment is handed to the outbox,
 * and advancing then would abandon a comment the agent has not had a chance to read.
 */
export const FILE_COMMENT_ADVANCE_SETTLE_MS = 10_000;

/** How often a RUNNING review re-asks the time-based questions. Armed only while one runs. */
const TICK_MS = 1_000;

/**
 * Everything the state machine touches that is not itself.
 *
 * A port rather than direct imports, so `test/file-comment-walkthrough.test.ts` drives the
 * whole advance machine with no database, no pane, and no session - which is the only way the
 * restart, hold, pause and requeue paths get covered without a fixture per case. `index.ts`
 * supplies the real one.
 */
export interface FileCommentWalkthroughPort {
  now(): number;
  /**
   * The MCP tool THIS session can answer a comment through, or null when it cannot.
   *
   * Asked per session, and asked of the bundle rather than of the launch, because that is the
   * half that can honestly be established - the same reading `TaskManager` already applies
   * before it resets a scout's checkout. Whether a particular process registered our server is
   * a property of a process we did not necessarily start: a dispatch carried `--mcp-config`,
   * an operator's own session reaches the same server only if they installed the integration,
   * and nothing here can interrogate that child. What CAN be established is whether the bundle
   * publishes the tool at all, and whether it is the same build this session started with.
   *
   * Null is not a degraded answer, it is the tool-less rendering: the payload then cites the
   * comment's id and asks for it back in the next turn, which is what the transcript fallback
   * reads. Naming a tool the session cannot call would be the failure `FINAL_INSTRUCTION`
   * documents - an instruction the loop cannot honour is one it follows into silence.
   *
   * A port member rather than an import, so this file still opens no database, touches no pane
   * and knows nothing about how a launch registers an MCP server - which is what lets the whole
   * advance machine be driven from a fake port.
   */
  replyTool(sessionId: string): Promise<string | null>;
  /** The session, for `canMessage` and for the settled-idle question. Null once it is gone. */
  session(sessionId: string): Session | null;
  /** The review's run state. Never null: an absent row reads as `idle`. */
  review(sessionId: string): FileCommentReview;
  setReviewState(sessionId: string, state: FileCommentReview["state"], pauseReason: string | null): FileCommentReview;

  /**
   * Every non-terminal thread this session holds, in QUEUE order then creation order.
   *
   * Message history may be CAPPED here - this is read on every tick and the cap is what keeps
   * that cheap. `threadWithHistory` is the uncapped read, taken for one thread at the two
   * moments an ordinal is decided.
   */
  threads(sessionId: string): FileCommentThread[];
  /**
   * One thread with its WHOLE reply history.
   *
   * The delivery ordinal is a message's position among ALL of a thread's human messages, and
   * the ordinary hydration carries only the newest fifty. A thread past that cap read through
   * the capped path would print an ordinal the agent could quote back and nothing could
   * resolve - which is the one thing the ordinal exists to make possible.
   */
  threadWithHistory(threadId: string): FileCommentThread | null;
  /** The file's current bytes and revision. Throws when it has left the checkout. */
  readFile(sessionId: string, path: string): Promise<{ text: string | null; revision: string }>;
  /** Phase 1's re-anchor writer. Pure `reanchor()` persists nothing on its own. */
  updateAnchor(
    threadId: string,
    patch: { startLine?: number; endLine?: number; revision?: string | null; outdated: boolean },
  ): FileCommentThread | null;
  /** `queued`/`sending` -> `sending`, storing the correlation. Never stamps `delivered_at`. */
  beginDelivery(threadId: string, deliveryId: string): FileCommentThread | null;
  /** The confirmed-delivery write: stamps the message and moves `sending` -> `awaiting`. */
  markDelivered(messageId: string): FileCommentThread | null;
  /** `awaiting` -> `unanswered`, which is what lets the next comment take the turn. */
  markUnanswered(threadId: string): FileCommentThread | null;
  /**
   * A `sending` thread whose outbox row went away without being delivered, back to `queued`.
   *
   * NOT phase 1's `queueFileCommentThread`, and the difference is deliberate in both
   * directions. That operation refuses an outstanding thread - `sending` is not in
   * `REQUEUEABLE_THREAD_STATUSES`, for the good reason that pulling a thread out of the
   * outstanding set while its turn is live would empty the set the single-flight index is
   * built on - and it allocates a FRESH tail position. Neither is right here: this turn is
   * provably not live, and a recalled comment did not lose its place in the review, it simply
   * did not go. It keeps its `queue_seq` and goes again next.
   */
  returnToQueue(threadId: string): FileCommentThread | null;
  /**
   * Phase 1's `queueFileCommentThread`: a thread back at the TAIL with a fresh `queue_seq`.
   *
   * Used for the one requeue this phase performs on its own - a thread whose turn resolved
   * with undelivered human messages still on it, because a person replied while it was out.
   * The tail rather than its old position: "at the end" is the contract, and a reused number
   * would send the follow-up ahead of everything queued since.
   */
  requeueAtTail(threadId: string): FileCommentThread | null;
  /** The outbox. `pendingTurns.submit`, narrowed to what this needs. */
  submit(sessionId: string, text: string): { ok: boolean; turnId: string | null; error: string | null };
  /** The `pending_turns` row this thread is correlated to, or null once it is gone. */
  pendingTurn(sessionId: string, turnId: string): PendingTurn | null;
  /**
   * What this session said, in prose, at or after `since` - newest turn first, and bounded.
   *
   * The read behind the tool-less fallback. A session an operator started without the Mission
   * Control integration has no reply tool at all, and free text is the only thing that works
   * everywhere. Asked once, at the moment the grace window gives up on a comment, rather than
   * by a watcher: the read is bounded to the transcript's tail and costs nothing until a
   * comment has actually timed out.
   *
   * **`since` is a filter this port owes its caller, not a hint.** It is the moment the
   * comment being answered actually reached the agent, and it is what keeps a thread's SECOND
   * timeout from re-reading the turn its first timeout already filed - the tail window still
   * contains that turn, and only its timestamp says it belongs to the earlier delivery. A turn
   * the transcript recorded with no usable timestamp cannot be placed against `since` at all,
   * so it is omitted rather than guessed at.
   *
   * Deliberately a plain read: WHICH of these turns answers WHICH comment is decided by the
   * state machine, so the rule is covered by the fake port rather than by each implementation
   * of it.
   */
  agentTurnsSince(sessionId: string, since: number): string[];
  /** File a fallback reply on a thread as the agent. Changes no status and no queue position. */
  appendAgentReply(threadId: string, body: string): FileCommentThread | null;
}

/** The reasons a review stops, in one place so the UI and the tests read the same sentences. */
export const PAUSE_REASONS = {
  drained: "Every comment in this review has been sent.",
  outdated: (path: string, shortId: string) =>
    `${shortId} quotes text that is no longer in ${path}, so it was held rather than sent. Editing the comment changes what it says, not the text it quotes, so the way past is to drop it and comment again on the text that is there. Resuming re-checks the file and releases it only if the quote comes back.`,
  missingFile: (path: string) =>
    `${path} is no longer in this checkout, so the comment anchored to it was held rather than sent.`,
  noPane: "This session has no pane to deliver a comment to.",
  pipeline: "This session is driven by an external engine and reads nothing sent to its pane.",
  gone: "This session has ended, so there is nothing left to deliver to.",
  uncertain: (shortId: string) =>
    `Mission Control could not confirm that ${shortId} reached the agent. Retry it or mark it sent from the conversation, and the review resumes.`,
  outboxBlocked:
    "Another message in this session's outbox could not be confirmed, and the review will not send a second turn on top of it. Retry it or mark it sent from the conversation, then resume.",
  refused: (why: string) => `The outbox refused this comment: ${why}`,
  empty: "There is nothing in this review to send.",
} as const;

/**
 * The message a turn carries: a thread's OLDEST human message that has not been delivered.
 *
 * Not "the thread's comment", which is only well defined on a thread's first turn. A thread
 * that timed out and was replied to, or that was answered and followed up on, holds several
 * human messages, and picking the first would resend the opening comment for ever - the
 * failure this phase's exit criteria call out as the easiest one to ship.
 *
 * `deliveredAt` is what makes this terminate: it is stamped from confirmed delivery, so a
 * message that reached the agent is never selected again.
 */
export function nextMessage(thread: FileCommentThread): { message: FileCommentMessage; ordinal: number } | null {
  let ordinal = 0;
  for (const message of thread.messages) {
    if (message.author !== "human") continue;
    ordinal += 1;
    if (message.deliveredAt === null) return { message, ordinal };
  }
  return null;
}

function anchorOf(thread: FileCommentThread): FileCommentAnchor {
  return {
    path: thread.path,
    startLine: thread.startLine,
    endLine: thread.endLine,
    quote: thread.quote,
    quoteHash: thread.quoteHash,
    revision: thread.revision,
    surface: thread.surface,
  };
}

/** What the review is currently doing, as a person reads it, plus the numbers the UI draws. */
export interface WalkthroughProgress {
  /** Comments this review has already handed to the outbox, including the one in flight. */
  sent: number;
  /** Comments still queued behind it. */
  queued: number;
  /** The thread currently out with the agent, or null. */
  outstanding: FileCommentThread | null;
}

/**
 * Where a review stands, derived rather than stored.
 *
 * `sent` counts threads whose `sentAt` falls at or after the review began, so a comment sent
 * by an EARLIER review of the same session does not inflate "Comment 3 of 12" on this one.
 *
 * A `queued` thread is counted as queued and never as sent, even when it has a `sentAt` from
 * an earlier turn of its own. `sent_at` records a thread's FIRST send and is deliberately not
 * rewritten, so a thread that timed out and was replied to still carries one - and counting it
 * in both halves would push the position line one past the truth on every requeued follow-up.
 */
export function progressOf(threads: readonly FileCommentThread[], startedAt: number | null): WalkthroughProgress {
  let sent = 0;
  let queued = 0;
  let outstanding: FileCommentThread | null = null;
  for (const thread of threads) {
    if (thread.status === "queued") {
      queued += 1;
      continue;
    }
    if (isOutstandingThreadStatus(thread.status)) outstanding = thread;
    if (thread.sentAt !== null && startedAt !== null && thread.sentAt >= startedAt) sent += 1;
  }
  return { sent, queued, outstanding };
}

export class FileCommentWalkthrough {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Sessions whose tick is already running, so a burst of signals does not re-enter it. */
  private ticking = new Set<string>();
  /** Reviews this instance believes are running, so the timer is armed only when one is. */
  private running = new Set<string>();

  constructor(private port: FileCommentWalkthroughPort) {}

  // ---- the operator's three controls ----

  /**
   * Begin, or resume after a pause.
   *
   * One entry point for both, because they differ in nothing the machine can see: `running`
   * is `running`, and `started_at` is kept by the store on a resume rather than rewritten.
   * What a resume DOES do that a first start does not is clear the pause reason, so the next
   * pass decides the question again from the file as it now stands rather than from a sentence
   * written a minute ago. For a held-outdated head that is a RE-CHECK and not a skip: if the
   * quote is back - the agent restored the text, or a person put it back - it goes, and if it
   * is still missing it is held again with the same reason. Note what resume canNOT do, and
   * what the reason therefore must not offer: `quote` is fixed when the comment is written and
   * the Edit control rewrites the message BODY, so editing a held comment cannot re-anchor it.
   * Dropping it and commenting again on the text that is actually there is the way past.
   * Resume deliberately cannot wave a comment through to the agent about text that is not in
   * the file, because the quote is the only thing telling the agent what the comment is about.
   */
  start(sessionId: string): FileCommentReview {
    const review = this.port.setReviewState(sessionId, "running", null);
    this.running.add(sessionId);
    this.arm();
    void this.tick(sessionId);
    return review;
  }

  /**
   * Stop releasing comments.
   *
   * It takes effect AFTER the outstanding comment resolves and never recalls a delivered one:
   * the bytes have already reached the agent, and a pause that could reach into the agent's
   * context and remove a message it has read would be a different and much larger promise.
   *
   * **Which is why this keeps ticking rather than going quiet.** "Takes effect after the
   * outstanding comment resolves" is a promise about the comment, not only about the ones
   * behind it: the comment out with the agent still has to leave `awaiting` on the ordinary
   * settled-idle signal. Dropping the session from the tick set here would have frozen it
   * there until somebody pressed Resume, so a paused queue would sit presenting a comment as
   * still in flight long after the agent had finished with it. `pass` drops the session the
   * moment nothing is outstanding, so the timer stays armed for exactly as long as that one
   * comment takes and no longer.
   */
  pause(sessionId: string, reason: string | null = null): FileCommentReview {
    const review = this.port.setReviewState(sessionId, "paused", reason);
    this.running.add(sessionId);
    this.arm();
    void this.tick(sessionId);
    return review;
  }

  // ---- the two signals that wake it ----

  /**
   * A pending turn positively reached the agent. See `Registry.onTurnDelivered`.
   *
   * This is the ONLY place `delivered_at` is stamped. Submitting is not delivering:
   * `submit()` creates a `queued` row and returns `delivery: "pending"` with
   * `submitVerified: false`, and the bytes reach the agent later, from the drain - where the
   * attempt can still end `uncertain`, be recalled, be dropped, or be caught by a restart.
   * Stamping at submit would have frozen a comment and recorded it as answered-for-ever
   * having never been read.
   */
  onTurnDelivered(sessionId: string, turnId: string): void {
    const found = this.port
      .threads(sessionId)
      .find((t) => t.status === "sending" && t.deliveryId === turnId);
    if (!found) return;
    const thread = this.port.threadWithHistory(found.id) ?? found;
    const next = nextMessage(thread);
    if (!next) return;
    this.port.markDelivered(next.message.id);
    void this.tick(sessionId);
  }

  /**
   * The human supplied the confirmation the daemon could not observe ("Mark sent").
   *
   * It performs the confirmed-delivery write, because that is what the operator just
   * asserted. Without a correlated write here the thread would stay `sending` - an
   * outstanding status - and the partial unique index would block every later delivery, so
   * resolving the turn would leave the review permanently stuck behind a comment the human
   * had just dealt with.
   *
   * The grace window then runs from HERE rather than from the original send: the agent has
   * not been sitting on this comment, so it has not been ignoring it either.
   */
  onTurnMarkedSent(sessionId: string, turnId: string): void {
    // Read BEFORE the delivery write, which is what moves the thread out of `sending`.
    const outstanding = this.outstandingDelivery(sessionId, turnId);
    this.onTurnDelivered(sessionId, turnId);
    this.resumeIfPausedFor(sessionId, outstanding);
  }

  /**
   * The human chose to re-send an uncertain turn ("Retry").
   *
   * **It needs no re-point in this repository**, and that is a deviation from the phase plan
   * worth stating: `retryPendingTurn` moves the EXISTING row `uncertain` -> `queued` and
   * leaves its id alone, so `delivery_id` still names the row that is about to go out.
   * `beginFileCommentDelivery`'s re-point exists for a correlation that actually moves; here
   * calling it would rewrite `updated_at` and change nothing else. The thread stays `sending`
   * - it never left the outstanding set, so the index is untouched - and `delivered_at` stays
   * NULL, so the same message goes rather than the next one.
   */
  onTurnRetried(sessionId: string, turnId: string): void {
    this.resumeIfPausedFor(sessionId, this.outstandingDelivery(sessionId, turnId));
  }

  /**
   * The agent answered the outstanding comment through the reply tool, and the route has
   * ALREADY released the turn durably.
   *
   * Nothing is passed in and nothing is decided here: the release is a transaction on
   * `file_comment_threads`, and this only asks the machine to look again now rather than
   * within the second. Phase 3's time-based advance stays exactly as it was underneath -
   * this makes the queue move on a real completion, it does not replace the floor.
   */
  onCommentAnswered(sessionId: string): void {
    if (this.running.has(sessionId)) void this.tick(sessionId);
  }

  /** A session reported activity, or settled. The time-based advance re-asks itself. */
  onSessionChanged(sessionId: string): void {
    if (this.running.has(sessionId)) void this.tick(sessionId);
  }

  /** The session went away. Its threads are already `orphaned`; the review has nothing left. */
  onSessionGone(sessionId: string): void {
    this.running.delete(sessionId);
    this.disarmIfQuiet();
  }

  // ---- lifetime ----

  /** Adopt every review the store already believes is running. The restart path. */
  resume(sessionIds: Iterable<string>): void {
    for (const sessionId of sessionIds) {
      const state = this.port.review(sessionId).state;
      if (state === "running") this.running.add(sessionId);
      // A review paused while a comment was still out with the agent owes that comment its
      // ordinary resolution, and a restart does not discharge the debt. Adopted only when
      // something is actually outstanding, so an ordinary paused review costs no tick at all.
      else if (
        state === "paused"
        && this.port.threads(sessionId).some((t) => isOutstandingThreadStatus(t.status))
      ) {
        this.running.add(sessionId);
      }
    }
    this.arm();
    for (const sessionId of this.running) void this.tick(sessionId);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private arm(): void {
    if (this.timer || !this.running.size) return;
    // Unref'd, like every other periodic here: a review in progress must not be what keeps
    // the daemon's event loop alive.
    this.timer = setInterval(() => {
      // Copied before iterating, deliberately: a tick can pause its own review, which deletes
      // from this set mid-loop.
      // eslint-disable-next-line unicorn/no-useless-spread
      for (const sessionId of [...this.running]) void this.tick(sessionId);
    }, TICK_MS);
    this.timer.unref?.();
  }

  /** Stop ticking this session. It has nothing left that time alone can move. */
  private leave(sessionId: string): void {
    this.running.delete(sessionId);
    this.disarmIfQuiet();
  }

  private disarmIfQuiet(): void {
    if (this.running.size || !this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** The review's outstanding comment, but only when THIS turn is the one carrying it. */
  private outstandingDelivery(sessionId: string, turnId: string): FileCommentThread | null {
    return (
      this.port.threads(sessionId).find((t) => t.status === "sending" && t.deliveryId === turnId)
      ?? null
    );
  }

  /**
   * Lift the pause this exact delivery caused, and no other.
   *
   * Both callers arrive from a route that fires for EVERY pending turn a session resolves or
   * retries, review-owned or not - the outbox is shared, and one conversation turn a person
   * marked sent by hand looks identical from there. So two things are checked rather than
   * assumed. First, the turn has to be the one the review's own outstanding comment is
   * correlated to; an unrelated turn says nothing about this review. Second, the review has to
   * be paused for THAT comment's uncertain delivery, matched on the reason itself. A person
   * who pressed Pause has said something about the queue that a turn resolving elsewhere does
   * not override, and without the second check clearing an unrelated uncertain row would have
   * restarted a review somebody had deliberately stopped - releasing the next comment against
   * their instruction.
   */
  private resumeIfPausedFor(sessionId: string, thread: FileCommentThread | null): void {
    if (!thread) return;
    const review = this.port.review(sessionId);
    if (review.state !== "paused") return;
    if (review.pauseReason !== PAUSE_REASONS.uncertain(thread.shortId)) return;
    this.start(sessionId);
  }

  private stopWith(sessionId: string, reason: string): void {
    this.running.delete(sessionId);
    this.port.setReviewState(sessionId, "paused", reason);
    this.disarmIfQuiet();
  }

  // ---- the machine ----

  /**
   * One pass: resolve what is outstanding, then release the next comment if nothing is.
   *
   * Re-entrant-safe by a per-session guard rather than by luck. Three different signals wake
   * this - a delivery, a session change, and the timer - and two of them can arrive inside
   * the same millisecond, so without the guard two passes could both find nothing
   * outstanding and both submit. The partial unique index would refuse the second, but as a
   * `FileCommentStoreError` out of a background timer rather than as a decision.
   */
  async tick(sessionId: string): Promise<void> {
    if (this.ticking.has(sessionId)) return;
    this.ticking.add(sessionId);
    try {
      await this.pass(sessionId);
    } catch (error) {
      // Most ticks are fired with `void`, so an escaping rejection would be an unhandled one -
      // and, worse, would leave the review saying "running" with nothing ever advancing it.
      // Pausing says what happened where a person can read it and act on it.
      this.stopWith(
        sessionId,
        PAUSE_REASONS.refused(error instanceof Error ? error.message : String(error)),
      );
    } finally {
      this.ticking.delete(sessionId);
    }
  }

  private async pass(sessionId: string): Promise<void> {
    const review = this.port.review(sessionId);
    if (review.state === "idle") return this.leave(sessionId);
    // A PAUSED review still runs the half of this pass that resolves what is already out with
    // the agent - that is what "pause takes effect after the outstanding comment resolves"
    // means - and none of the half that releases anything new.
    const paused = review.state === "paused";

    const session = this.port.session(sessionId);
    if (!session) {
      // Already paused: the operator's reason is theirs, and overwriting it to announce that a
      // review nobody was waiting on has nothing left to deliver to helps no one.
      if (paused) return this.leave(sessionId);
      return this.stopWith(sessionId, PAUSE_REASONS.gone);
    }

    let threads = this.port.threads(sessionId);
    const outstanding = threads.find((t) => isOutstandingThreadStatus(t.status)) ?? null;
    if (outstanding) {
      const resolved = this.resolveOutstanding(sessionId, session, outstanding, paused);
      if (resolved === "wait") return;
      if (resolved === "paused") return;
      threads = this.port.threads(sessionId);
    }

    // The outstanding comment has resolved, so the pause is now fully in effect and there is
    // nothing further for the timer to do until somebody resumes.
    if (paused) return this.leave(sessionId);

    const head = threads.find((t) => t.status === "queued") ?? null;
    if (!head) {
      return this.stopWith(
        sessionId,
        review.startedAt === null ? PAUSE_REASONS.empty : PAUSE_REASONS.drained,
      );
    }

    // Asked here as well as after the await, purely so a session that plainly cannot take a
    // message does not send this pass off to read files it will not use.
    const early = deliveryBlock(session);
    if (early) {
      if (early.pause) return this.stopWith(sessionId, early.pause);
      return;
    }

    // Which threads this pass is about to re-anchor, captured BEFORE the await for the
    // comparison after it.
    const reanchored = new Set(threads.filter((t) => t.status === "queued").map((t) => t.id));
    // Resolved ABOVE the delivery boundary deliberately. It is an await, so it widens the
    // window the block below exists to close - which costs nothing, because that block re-asks
    // every question that can make a send unsafe and this is not one of them. What this decides
    // is one LINE of the payload, and it is a property of a file on disk and a process start,
    // neither of which the queue or the conversation can change underneath it.
    const replyTool = await this.port.replyTool(sessionId);
    const missing = await this.reanchorQueue(sessionId, threads);

    // ---- the delivery boundary ----
    //
    // **Everything read before the await is now a snapshot, and none of it may decide a send.**
    // `reanchorQueue` reads files, which is the one genuine await in this pass, and the queue
    // and the conversation are both live throughout it - that is the feature, not an edge case.
    // In that window a person can press Pause, type an ordinary message into the conversation,
    // reorder the queue, drop the head, or close the session. Each of those was read into a
    // local before the await, so every one of them has to be asked again here. The rule for
    // this block is simply that nothing above the await is trusted below it.
    const now = this.port.review(sessionId);
    // Paused mid-read. The send does not happen, and nothing else is needed: `pause` keeps the
    // session ticking, and the pass that follows resolves whatever is outstanding and then
    // leaves. Not `leave` here, because this pass no longer knows what is outstanding.
    if (now.state !== "running") return;
    const live = this.port.session(sessionId);
    if (!live) return this.stopWith(sessionId, PAUSE_REASONS.gone);

    // **Re-select the head rather than re-reading the thread that WAS the head.**
    //
    // Two different reasons, and the second is the one that bites. The first is ordinary: the
    // pass above is the only writer of `outdated`, so the flag the decision below turns on has
    // just changed underneath the snapshot. The second is that `reanchorQueue` reads files, so
    // this is the one genuine await in the pass - and the queue is editable throughout, which
    // is the whole point of the feature. Somebody can move another comment to the front while
    // those reads are in flight. Looking the captured thread back up by id finds it still
    // queued and sends it, quietly delivering the comment that used to be first and overriding
    // the order the person just asked for. So the head is decided from the queue as it stands
    // now, after the await, exactly as it was decided before it.
    const current = this.port.threads(sessionId).find((t) => t.status === "queued") ?? null;
    // The queue emptied while the files were being read - dropped, or requeued elsewhere.
    // Nothing to send and nothing to announce; the next pass will find it drained and say so.
    if (!current) return;
    // A head that arrived during the await was never re-anchored by the pass above, so its
    // `outdated` flag is whatever it was before the file was read. Sending on that would be
    // acting on a stale anchor, and holding on it would be a pause somebody has to clear. It
    // simply waits: the review is still running and the armed tick re-asks within the second,
    // by which time this thread is in the snapshot and gets re-anchored like any other.
    if (!reanchored.has(current.id)) return;
    if (missing.has(current.path)) return this.stopWith(sessionId, PAUSE_REASONS.missingFile(current.path));
    if (current.outdated) {
      return this.stopWith(sessionId, PAUSE_REASONS.outdated(current.path, current.shortId));
    }

    // The outbox and the pane, re-asked against the session as it is NOW. A conversation turn
    // submitted while the files were being read would otherwise be joined by this comment, and
    // two rows in `pending_turns` is exactly the depth this phase exists never to reach.
    const late = deliveryBlock(live);
    if (late) {
      if (late.pause) return this.stopWith(sessionId, late.pause);
      return;
    }

    this.send(sessionId, current, now.startedAt, replyTool);
  }

  /**
   * What to do about the comment already out with the agent.
   *
   * `wait` - it is genuinely in flight, or the grace window has not run out.
   * `paused` - it needs a person.
   * `advanced` - it is no longer outstanding, so the caller may release the next comment.
   */
  private resolveOutstanding(
    sessionId: string,
    session: Session,
    thread: FileCommentThread,
    paused: boolean,
  ): "wait" | "paused" | "advanced" {
    const now = this.port.now();
    if (thread.status === "sending") {
      const row = thread.deliveryId ? this.port.pendingTurn(sessionId, thread.deliveryId) : null;
      if (row?.state === "uncertain") {
        // On an ALREADY paused review the state is left exactly as the operator set it - the
        // reason is theirs, and the uncertain row is visible in the conversation either way.
        // Only the ticking stops, because from here nothing but a person can move this.
        if (paused) this.leave(sessionId);
        else this.stopWith(sessionId, PAUSE_REASONS.uncertain(thread.shortId));
        return "paused";
      }
      if (row) return "wait";
      // The row is gone and the confirmed-delivery signal never fired, so it was recalled or
      // dropped rather than delivered. Those two remove rows too, which is exactly why
      // delivery is keyed off the signal and never off a row's absence - but the ABSENCE, read
      // only after the signal has had its chance, is what says the comment never went. It goes
      // back to the tail with `delivered_at` still NULL, so it is editable again.
      //
      // There is no window to race here: the two sites that retire a claimed row delete it and
      // raise the signal with no `await` between them, so a tick cannot land in between.
      this.port.returnToQueue(thread.id);
      return "advanced";
    }

    // `awaiting`. Phase 3 has exactly one advance signal, and it is time: phase 4 adds the
    // reply, and this stays as the floor beneath it.
    const deliveredAt = lastDeliveredAt(thread);
    if (deliveredAt !== null && now - deliveredAt < FILE_COMMENT_ADVANCE_SETTLE_MS) return "wait";
    if (!settledIdle(session, now, FILE_COMMENT_ADVANCE_SETTLE_MS)) return "wait";
    // Out of `awaiting`, which is not bookkeeping: `unanswered` sits outside the outstanding
    // tuple precisely so the next comment can take the turn without colliding on the
    // single-flight index. The thread is not lost - it keeps its anchor, its marker, and the
    // absence of a reply is what the marker shows.
    this.settle(sessionId, thread.id);
    return "advanced";
  }

  /**
   * A thread's turn is over: out of `awaiting`, and back in the queue if it owes another turn.
   *
   * The second half is the reply-while-outstanding case. Appending to the comment currently in
   * flight is always allowed - a person may answer the comment they are looking at - but the
   * STATUS must not move while it is outstanding, because `sending` and `awaiting` are the two
   * statuses the single-flight index is built on and emptying that set mid-flight would let the
   * next comment be released on top of a live turn. So the message simply waits, and this is
   * where it is picked up: the turn resolved, an undelivered human message remains, so the
   * thread goes back to the tail and its next turn carries THAT message rather than the
   * opening comment.
   */
  private settle(sessionId: string, threadId: string): void {
    // The tool-less fallback, asked at the one moment it is worth paying for: this comment
    // has just run out its grace window, so either the agent answered it somewhere this
    // daemon cannot see, or it did not answer at all. It is filed and NOTHING else moves -
    // the timeout below is what advances the queue, exactly as it did before this existed.
    const timedOut = this.port.threadWithHistory(threadId);
    if (timedOut) this.fileTranscriptReply(sessionId, timedOut);

    const settled = this.port.markUnanswered(threadId);
    if (!settled) return;
    const full = this.port.threadWithHistory(threadId) ?? settled;
    if (nextMessage(full)) this.port.requeueAtTail(threadId);
  }

  /**
   * Recover an answer from the conversation for a session with no reply tool.
   *
   * **Scoped to the delivery being answered, never deduped by text.** A thread that times out
   * twice reads two overlapping tail windows, so the second read can still see the turn the
   * first one filed - and the obvious guard, skipping a recovered answer whose text already
   * appears on the thread, silently discards a REAL second answer whenever the agent says
   * something as ordinary as "Done." twice. That is the fallback failing at exactly the thing
   * it exists to do, with no error and nothing on screen: the human's follow-up reads as
   * unanswered when it was answered.
   *
   * The delivery is the honest key. An assistant turn recorded BEFORE this comment reached the
   * agent cannot be an answer to it, whatever it says, and a thread's next delivery is always
   * later than the turn its previous timeout recovered - the requeue happens at that timeout.
   * So the window alone separates the two, and two distinct answers that happen to read
   * identically are both kept.
   *
   * The FIRST matching turn in the window, newest first: a thread delivered once and answered
   * twice wants the agent's latest word on it.
   */
  private fileTranscriptReply(sessionId: string, thread: FileCommentThread): void {
    // Nothing on this thread has provably reached the agent, so no turn can be an answer to
    // it. Unreachable from `settle`, which only runs on a confirmed delivery, and stated here
    // because it is what makes the window below a real bound rather than "everything".
    const deliveredAt = lastDeliveredAt(thread);
    if (deliveredAt === null) return;
    for (const text of this.port.agentTurnsSince(sessionId, deliveredAt)) {
      // Matched HERE rather than in the port, so "an assistant turn that opens with this
      // thread's handle" is one rule the fake port cannot quietly implement differently.
      if (openingDeliveryHandle(text)?.shortId !== thread.shortId) continue;
      this.port.appendAgentReply(thread.id, text);
      return;
    }
  }

  /**
   * Re-anchor every UNSENT comment against the file's current bytes, and persist each outcome.
   *
   * Persisting is the half that is easy to skip and expensive to have skipped: `reanchor()` is
   * pure, so without the write a moved comment is recomputed from its original anchor on every
   * send and `revision` never advances - which defeats the revision short-circuit that exists
   * to stop every send rescanning the whole file.
   *
   * Each distinct path is read ONCE per pass, not once per comment: a twelve-comment review of
   * one spec is one read rather than twelve.
   *
   * Returns the paths that have left the checkout. A comment on one of those is marked
   * outdated in place like any other unresolvable quote; whether that HOLDS the review is the
   * caller's decision, and only when it is the head.
   */
  private async reanchorQueue(
    sessionId: string,
    threads: readonly FileCommentThread[],
  ): Promise<Set<string>> {
    const queued = threads.filter((t) => t.status === "queued");
    const missing = new Set<string>();
    const documents = new Map<string, { text: string | null; revision: string }>();
    for (const path of new Set(queued.map((t) => t.path))) {
      try {
        documents.set(path, await this.port.readFile(sessionId, path));
      } catch {
        // A file that has left the checkout is a different failure from a quote that moved -
        // there are no bytes to search at all - but the durable consequence is the same flag,
        // and the pause reason is what tells the two apart.
        missing.add(path);
      }
    }
    for (const thread of queued) {
      const document = documents.get(thread.path);
      if (!document || document.text === null) {
        this.port.updateAnchor(thread.id, { outdated: true });
        continue;
      }
      const outcome = reanchor(anchorOf(thread), document.text, document.revision);
      if (outcome.kind === "outdated") this.port.updateAnchor(thread.id, { outdated: true });
      else {
        this.port.updateAnchor(thread.id, {
          startLine: outcome.startLine,
          endLine: outcome.endLine,
          revision: outcome.revision,
          outdated: false,
        });
      }
    }
    return missing;
  }

  /** Render this comment's turn and hand it to the outbox. */
  private send(
    sessionId: string,
    head: FileCommentThread,
    startedAt: number | null,
    replyTool: string | null,
  ): void {
    const thread = this.port.threadWithHistory(head.id) ?? head;
    const next = nextMessage(thread);
    if (!next) {
      // Every human message on this thread has already been delivered, so there is nothing for
      // its turn to carry. That is not an error and not a hang: it simply has no business at
      // the head, so it leaves the outstanding path entirely and the next comment goes.
      this.port.markUnanswered(head.id);
      void this.tick(sessionId);
      return;
    }
    const { sent, queued } = progressOf(this.port.threads(sessionId), startedAt);
    const rendered = renderFileCommentPayload({
      path: thread.path,
      startLine: thread.startLine,
      endLine: thread.endLine,
      quote: thread.quote,
      body: next.message.body,
      shortId: thread.shortId,
      ordinal: next.ordinal,
      position: sent + 1,
      total: sent + queued,
      replyTool,
    });

    const result = this.port.submit(sessionId, rendered.payload);
    if (!result.ok || !result.turnId) {
      return this.stopWith(sessionId, PAUSE_REASONS.refused(result.error ?? "it could not be queued"));
    }
    // `queued` -> `sending`, storing the correlation `pending_turns` cannot hold. NOT
    // `delivered_at`: that waits for the confirmed-delivery signal, and the whole split is
    // there so a restart mid-delivery surfaces as a question rather than as a lie.
    this.port.beginDelivery(thread.id, result.turnId);
  }
}

/**
 * Why this session cannot take a review comment right now, or null when it can.
 *
 * One function with two call sites, and the SECOND one is the one that decides. Everything it
 * reads - the outbox depth, an unconfirmed row, whether the pane can be written to at all - can
 * change while `reanchorQueue` is awaiting file reads, so asking once before that await and
 * sending on the answer afterwards is how a comment ends up joining a conversation turn a
 * person typed in the meantime. The early call exists only to avoid reading files this pass
 * will not use; the late call is the guarantee.
 *
 * `pause` set means it needs a person and the review stops with that reason. `pause` null means
 * wait: it clears on its own, the review stays running, and the armed tick re-asks.
 */
function deliveryBlock(session: Session): { pause: string | null } | null {
  // **One turn outstanding means one turn in the SHARED outbox, not one review comment.**
  //
  // The outbox belongs to the whole session, so this review's own comment resolving says
  // nothing about what else is queued. Releasing on top of another row would put two turns in
  // `pending_turns` at once - the depth at which all three of the limits named at the top of
  // this file start mattering: recall reaches only the tail, an `uncertain` row wedges
  // everything behind it, and neither row can be told apart by a correlation id the table does
  // not have.
  //
  // An `uncertain` row is the one case that does NOT clear on its own - it is a question
  // waiting for a person, and it wedges the outbox until they answer it. Waiting on that
  // silently would leave a review reading "running" for ever with nothing to say why.
  if (session.pendingTurns.some((turn) => turn.state === "uncertain")) {
    return { pause: PAUSE_REASONS.outboxBlocked };
  }
  // Any other row clears on its own: it drains, and the next tick sends the comment. A pause
  // would demand a person for a condition that resolves in a second.
  if (session.pendingTurns.length > 0) return { pause: null };

  const blocked = messageBlockReason(session);
  if (blocked) {
    return { pause: blocked === "pipeline" ? PAUSE_REASONS.pipeline : PAUSE_REASONS.noPane };
  }
  return null;
}

/**
 * When this thread's most recently delivered human message actually reached the agent.
 *
 * The newest rather than the oldest: an `awaiting` thread is waiting on the turn that just
 * went, and the grace window is about that turn.
 */
function lastDeliveredAt(thread: FileCommentThread): number | null {
  let latest: number | null = null;
  for (const message of thread.messages) {
    if (message.deliveredAt === null) continue;
    if (latest === null || message.deliveredAt > latest) latest = message.deliveredAt;
  }
  return latest;
}
