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
 * Every status except `orphaned`, and the exception is the whole reason this tuple exists
 * rather than the route reusing `FILE_COMMENT_THREAD_STATUSES`.
 *
 * `orphaned` is not a thing anyone decides. It is what a thread becomes when the session
 * that owns it goes away, and it is reached by exactly one of the three lifetime mechanisms
 * - `session_remove`, the first-completed-sweep reconciliation, or (for deletion) the
 * throttled prune - never by a request. Leaving it reachable from the dashboard gave an
 * ordinary caller a way to settle a LIVE session's thread to a terminal status and drop it
 * out of the live collection, after which every subsequent write on it was refused with
 * "this comment's session has ended" about a session that had not ended. That is a lie the
 * UI would repeat, and `orphaned` is terminal, so there is no way back from it.
 *
 * A person who wants a thread gone has two doors that mean what they say: `resolved`, which
 * is the human close, and `DELETE /api/file-comments/:id`.
 *
 * The STORE's writer is untouched: `orphanFileCommentThreadsForSession` still writes the
 * status, because session cleanup is the mechanism that is supposed to. What is closed here
 * is the request-side door, not the column.
 */
export const HUMAN_SETTABLE_THREAD_STATUSES = [
  "draft",
  "queued",
  "sending",
  "awaiting",
  "answered",
  "unanswered",
  "resolved",
] as const satisfies readonly Exclude<FileCommentThreadStatus, "orphaned">[];
export type HumanSettableThreadStatus = (typeof HUMAN_SETTABLE_THREAD_STATUSES)[number];

const HUMAN_SETTABLE = new Set<string>(HUMAN_SETTABLE_THREAD_STATUSES);

/** Whether a person may set this status through the dashboard's status route. */
export function isHumanSettableThreadStatus(
  value: string,
): value is HumanSettableThreadStatus {
  return HUMAN_SETTABLE.has(value);
}
