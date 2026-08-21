// The line-comment lifecycle's load-bearing state sets, defined ONCE.
//
// The same argument `src/shared/queue.ts` makes for `IN_FLIGHT_ITEM_STATES`, and for the
// same reason: one of the copies would be a partial unique index in SQL. `db.ts` DERIVES
// `one_outstanding_file_comment`'s WHERE clause from `OUTSTANDING_THREAD_STATUSES` rather
// than restating it, so adding a lifecycle status and forgetting the SQL cannot put two
// comments in flight in one session - which is the exact harm one-at-a-time exists to
// prevent, and the whole reason the review is walked through rather than batched.
//
// Persisted values. Append-only, never renamed or reordered.

/**
 * Every status a thread can hold.
 *
 * `outdated` is deliberately NOT here. A thread whose quote has stopped resolving is still
 * queued, or still awaiting, or still answered - losing that would lose its place in the
 * review - and the flag is reversible where a status transition would not be. Two
 * dimensions, so two columns; see `file_comment_threads.outdated`.
 */
export const FILE_COMMENT_THREAD_STATUSES = [
  /** Written but not submitted. Persisted from the first keystroke, so it is a real row. */
  "draft",
  /** In the review queue at `queue_seq`, waiting its turn. */
  "queued",
  /** Handed to the outbox. Outstanding, but not yet confirmed delivered. */
  "sending",
  /** Delivered and waiting for the agent. Outstanding, and the longer half of that window. */
  "awaiting",
  /** The agent replied through the tool. */
  "answered",
  /** The grace window expired with no reply. See `OUTSTANDING_THREAD_STATUSES` below. */
  "unanswered",
  /** A person closed it. Terminal, and only a person reaches it. */
  "resolved",
  /** Its session went away. Terminal, and the one status reached without anyone acting. */
  "orphaned",
] as const;
export type FileCommentThreadStatus = (typeof FILE_COMMENT_THREAD_STATUSES)[number];

/**
 * A comment is out with the agent: at most one per SESSION, enforced by
 * `one_outstanding_file_comment`, whose WHERE clause is built from this array.
 *
 * **Both statuses, not just `sending`.** A comment is outstanding from the moment it is
 * handed to the outbox until the agent answers it, and `awaiting` is by far the longer
 * half of that. An index naming `sending` alone would let a second Start review, or a
 * resume, open a new delivery while the first comment is still unanswered.
 *
 * **`unanswered` is deliberately outside this tuple, and that is what makes auto-advance
 * possible.** The walkthrough sends comment 2 while comment 1 has still never been
 * answered; a timed-out thread left in `awaiting` would collide on the index and deadlock
 * the queue the index exists to protect. Timing out therefore moves `awaiting` to
 * `unanswered`. No later phase widens this tuple to make a transition easier.
 */
export const OUTSTANDING_THREAD_STATUSES = [
  "sending",
  "awaiting",
] as const satisfies readonly FileCommentThreadStatus[];

/** Nothing will advance this thread again. */
export const TERMINAL_THREAD_STATUSES = ["resolved", "orphaned"] as const satisfies
  readonly FileCommentThreadStatus[];

/**
 * The statuses a thread may be (re-)queued from - an ALLOW-LIST, not "anything that is not
 * outstanding", because the set that phrase admits grows every time a status is added.
 *
 * The three are the three callers: a submitted `draft`, a human follow-up on an `answered`
 * or `unanswered` thread, and a thread requeued when its turn resolved with undelivered
 * human messages left. Everything else is refused, for two different reasons:
 *
 * - `sending` and `awaiting` are outstanding. Pulling a thread out of that set while its
 *   turn is live in `pending_turns` would empty the set the single-flight index is built on.
 * - `resolved` and `orphaned` are terminal. Requeueing a `resolved` thread would reopen
 *   something a person closed; requeueing an `orphaned` one would allocate a queue position
 *   inside a session that no longer exists. A person who wants a resolved thread back
 *   un-resolves it through the status route first, and the ordinary requeue then applies.
 *   The two-step is the point.
 */
export const REQUEUEABLE_THREAD_STATUSES = ["draft", "answered", "unanswered"] as const satisfies
  readonly FileCommentThreadStatus[];

/** Who wrote a message. Phase 2's reply box is `human`; phase 4's MCP tool is `agent`. */
export const FILE_COMMENT_AUTHORS = ["human", "agent"] as const;
export type FileCommentAuthor = (typeof FILE_COMMENT_AUTHORS)[number];

/**
 * The walkthrough's run state, one row per session.
 *
 * A table rather than a derived value: "paused" and "never started" are the same set of
 * rows - everything `queued`, nothing outstanding - and between two comments the
 * outstanding set is briefly empty, which would make a derived "running" flicker.
 */
export const FILE_COMMENT_REVIEW_STATES = ["idle", "running", "paused"] as const;
export type FileCommentReviewState = (typeof FILE_COMMENT_REVIEW_STATES)[number];

const THREAD_STATUS_SET = new Set<string>(FILE_COMMENT_THREAD_STATUSES);
const OUTSTANDING = new Set<FileCommentThreadStatus>(OUTSTANDING_THREAD_STATUSES);
const TERMINAL = new Set<FileCommentThreadStatus>(TERMINAL_THREAD_STATUSES);
const REQUEUEABLE = new Set<FileCommentThreadStatus>(REQUEUEABLE_THREAD_STATUSES);

export function isFileCommentThreadStatus(value: string): value is FileCommentThreadStatus {
  return THREAD_STATUS_SET.has(value);
}

/** The comment is out with the agent. The DB's partial unique index guarantees ≤1 per session. */
export function isOutstandingThreadStatus(status: FileCommentThreadStatus): boolean {
  return OUTSTANDING.has(status);
}

export function isTerminalThreadStatus(status: FileCommentThreadStatus): boolean {
  return TERMINAL.has(status);
}

export function isRequeueableThreadStatus(status: FileCommentThreadStatus): boolean {
  return REQUEUEABLE.has(status);
}

/**
 * How many of a thread's messages ride the wire.
 *
 * A thread arrives with its messages so phase 2 can render one from a single frame and
 * phase 4 can deliver a reply through one - neither has a second fetch. That makes the
 * reply history a snapshot cost, so it is capped rather than left to a conversation on one
 * line to decide. Past the cap the frame carries the NEWEST 50 in time order and
 * `messageCount` reports the true total, so a surface can tell it is looking at a tail and
 * fetch the whole thread from `GET /api/file-comments/:id`, which reads through
 * `loadFileCommentThreadWithFullHistory` and applies no cap at all. That route is what makes
 * this a CAP rather than a loss: without an uncapped read somewhere, a thread past fifty
 * replies would be unreachable whole by any route, which is the failure the budget exists to
 * avoid rather than cause. Fifty replies on one line is already a conversation that should
 * have moved.
 */
export const FILE_COMMENT_THREAD_MESSAGE_CAP = 50;

/** Bounds on the text a route accepts. Shared so the schema and the store cannot disagree. */
export const FILE_COMMENT_TEXT_LIMITS = {
  /** One comment or reply. Long enough for a paragraph of review, short of an essay. */
  body: 8_000,
  /** A repository-relative path, matching what the Files tab lists. */
  path: 1_024,
  /** Why the walkthrough stopped, as a human reads it. */
  pauseReason: 400,
} as const;

/**
 * The statuses a PERSON may set through `POST /api/file-comments/:id/status`.
 *
 * Two of the eight, and the smallness is the point: this route is for the decisions a human
 * makes about a thread, and every OTHER status is the recorded outcome of a mechanism, owned
 * by exactly one writer that does bookkeeping no request can reproduce.
 *
 * - `draft` - withdraw a thread from the queue, and the way back from `resolved`. The store
 *   drops its `queue_seq` with it, because a draft holding a queue position is a hole.
 * - `resolved` - the human close, and the only terminal status a person reaches.
 *
 * What is deliberately NOT here, and who owns each instead:
 *
 * - `queued` belongs to `POST /api/file-comments/:id/queue`, which ALLOCATES the tail
 *   position in the same transaction. Setting the status alone would leave a queued thread
 *   with a null `queue_seq` - in the review by status, and nowhere in its order.
 * - `sending` and `awaiting` are delivery states, written by `beginFileCommentDelivery` and
 *   `markFileCommentMessageDelivered` from phase 3's outbox signals. Setting either by
 *   request would make a thread outstanding with no delivery behind it, and the partial
 *   unique index would then refuse the session's next real send.
 * - `answered` is phase 4's, stamped with the reply that justifies it. Setting it by request
 *   on an `awaiting` thread is the worse direction: it RELEASES the single-flight index while
 *   the original comment is still out with the agent, so a second comment can be delivered
 *   into a session that already has one outstanding - which is the exact harm one-at-a-time
 *   exists to prevent.
 * - `unanswered` is phase 3's grace-window timeout.
 * - `orphaned` is not a decision at all. It is what a thread becomes when the session that
 *   owns it goes away, written by session cleanup alone
 *   (`orphanFileCommentThreadsForSession`). While it was reachable here, a caller could
 *   settle a LIVE session's thread to a terminal status and drop it out of the live
 *   collection, after which every later write on it was refused with "this comment's session
 *   has ended" about a session still running - and `orphaned` is terminal, so there was no
 *   way back.
 *
 * Every one of those writers is untouched by this tuple. What it closes is the request-side
 * door, not the column.
 *
 * Spelled out rather than derived, because `z.enum` needs a literal tuple. The `satisfies`
 * clause catches a RENAME; a test pins the membership, which is what catches an ADDITION.
 */
export const HUMAN_SETTABLE_THREAD_STATUSES = [
  "draft",
  "resolved",
] as const satisfies readonly FileCommentThreadStatus[];
export type HumanSettableThreadStatus = (typeof HUMAN_SETTABLE_THREAD_STATUSES)[number];

const HUMAN_SETTABLE = new Set<string>(HUMAN_SETTABLE_THREAD_STATUSES);

/** Whether a person may set this status through the dashboard's status route. */
export function isHumanSettableThreadStatus(
  value: string,
): value is HumanSettableThreadStatus {
  return HUMAN_SETTABLE.has(value);
}

/**
 * The statuses that hold a place in a session's review queue.
 *
 * `queue_seq` is meaningful for exactly these, so `setFileCommentThreadStatus` clears it for
 * everything else. Withdrawing a `queued` thread to `draft` while it kept its number left a
 * draft sitting in the order, and resolving one left a permanent hole.
 */
export const QUEUE_POSITION_THREAD_STATUSES = [
  "queued",
  "sending",
  "awaiting",
] as const satisfies readonly FileCommentThreadStatus[];

const HOLDS_QUEUE_POSITION = new Set<string>(QUEUE_POSITION_THREAD_STATUSES);

export function holdsQueuePosition(status: FileCommentThreadStatus): boolean {
  return HOLDS_QUEUE_POSITION.has(status);
}

/**
 * How many threads one session may hold in the LIVE collection at once.
 *
 * `change-contracts.md` asks a collection to state its bound and pin it, and "bounded by live
 * sessions" was only half a bound: it capped how long a thread lives, not how many a session
 * can accumulate while it is alive. The prune only reaches SETTLED threads whose session key
 * is gone, so a long-lived session - or a client stuck in a retry loop against the create
 * route - could grow SQLite, the registry map, and every reconnect snapshot without limit.
 *
 * The arithmetic, in the same terms as the per-thread wire budget: an ordinary thread is one
 * paragraph and a reply or two, a few hundred bytes, so 200 of them is tens of kilobytes per
 * session. The pathological thread measured by the SSE budget test is ~17kB, which is the
 * ceiling nobody reaches in practice, and the message cap is what bounds that half.
 *
 * 200 comments on one working tree is already a review that should have been several. This is
 * a runaway guard, not a product limit, and it is deliberately far above any real review so
 * that hitting it means something is wrong rather than that somebody was thorough.
 *
 * Counted over everything a session still holds - `orphaned` is excluded because those rows
 * have left the live collection and are the prune's to remove. Closing threads therefore
 * makes room, which is the behaviour a person hitting this would expect.
 */
export const FILE_COMMENT_THREADS_PER_SESSION_MAX = 200;
