import test from "node:test";
import assert from "node:assert/strict";
import {
  AppendFileCommentMessageSchema,
  CreateFileCommentSchema,
  EditFileCommentMessageSchema,
  ReorderFileCommentsSchema,
  SetFileCommentStatusSchema,
} from "../src/shared/protocol.ts";
import {
  FILE_COMMENT_QUOTE_MAX,
  FILE_COMMENT_SURFACES,
  normalizeQuote,
} from "../src/shared/file-comment-anchor.ts";
import {
  FILE_COMMENT_AUTHORS,
  FILE_COMMENT_TEXT_LIMITS,
  FILE_COMMENT_THREADS_PER_SESSION_MAX,
  FILE_COMMENT_THREAD_MESSAGE_CAP,
  FILE_COMMENT_THREAD_STATUSES,
  HUMAN_SETTABLE_THREAD_STATUSES,
  OUTSTANDING_THREAD_STATUSES,
  QUEUE_POSITION_THREAD_STATUSES,
  REQUEUEABLE_THREAD_STATUSES,
  TERMINAL_THREAD_STATUSES,
  holdsQueuePosition,
  isHumanSettableThreadStatus,
  isOutstandingThreadStatus,
  isRequeueableThreadStatus,
  isTerminalThreadStatus,
} from "../src/shared/file-comments.ts";

// What is at stake: these are the only validation between a browser (or a version-skewed
// one) and a table whose invariants the walkthrough rests on. The tuples below are also a
// declared cross-phase contract - phase 3 enforces one turn outstanding ON TOP of the index
// built from `OUTSTANDING_THREAD_STATUSES`, never instead of it, and never by widening it.

const VALID = {
  path: "docs/plans/x/plan.md",
  startLine: 84,
  endLine: 86,
  quote: "the paragraph as it currently reads",
  revision: "abc123",
  surface: "editor",
  body: "This contradicts the diagram above it.",
};

test("a well-formed comment parses, and revision defaults to null rather than being required", () => {
  assert.equal(CreateFileCommentSchema.parse(VALID).revision, "abc123");
  const { revision: _dropped, ...withoutRevision } = VALID;
  assert.equal(CreateFileCommentSchema.parse(withoutRevision).revision, null);
});

test("every string is bounded, and an empty one is not a comment", () => {
  const refuse = (over: Record<string, unknown>) =>
    assert.equal(CreateFileCommentSchema.safeParse({ ...VALID, ...over }).success, false, JSON.stringify(over));
  refuse({ body: "" });
  refuse({ body: "  " });
  refuse({ body: "x".repeat(FILE_COMMENT_TEXT_LIMITS.body + 1) });
  refuse({ quote: "" });
  refuse({ quote: "x".repeat(FILE_COMMENT_QUOTE_MAX + 1) });
  // Whitespace-only passes a LENGTH check and normalizes to empty, which is a different
  // failure: see the test below.
  refuse({ quote: "   " });
  refuse({ path: "" });
  refuse({ path: "x".repeat(FILE_COMMENT_TEXT_LIMITS.path + 1) });
  refuse({ startLine: 0 });
  refuse({ startLine: 1.5 });
  refuse({ endLine: -1 });
});

test("the surface is the closed renderer set and nothing else", () => {
  for (const surface of FILE_COMMENT_SURFACES) {
    assert.equal(CreateFileCommentSchema.safeParse({ ...VALID, surface }).success, true, surface);
  }
  // A diff hunk has its own reader and its own Open in Files door; v1 takes no comment there.
  assert.equal(CreateFileCommentSchema.safeParse({ ...VALID, surface: "diff" }).success, false);
});

test("nothing lets a caller supply the hash or the handle", () => {
  // Both are computed on the daemon, exactly as `fingerprint()` is. A caller that could
  // choose the hash could make any comment collide with any other; one that could choose the
  // handle could point a reply at somebody else's thread.
  const parsed = CreateFileCommentSchema.parse({
    ...VALID,
    quoteHash: "f".repeat(64),
    shortId: "MC-dead",
  }) as Record<string, unknown>;
  assert.equal("quoteHash" in parsed, false);
  assert.equal("shortId" in parsed, false);
});

test("a message body is bounded on both the append and the edit paths", () => {
  assert.equal(AppendFileCommentMessageSchema.parse({ body: "hi" }).author, "human");
  assert.equal(AppendFileCommentMessageSchema.parse({ author: "human", body: "hi" }).author, "human");
  assert.equal(AppendFileCommentMessageSchema.safeParse({ body: "" }).success, false);
  assert.equal(EditFileCommentMessageSchema.safeParse({ body: "" }).success, false);
  assert.equal(
    EditFileCommentMessageSchema.safeParse({ body: "x".repeat(FILE_COMMENT_TEXT_LIMITS.body + 1) })
      .success,
    false,
  );
});

test("the dashboard reply schema is human-only, and refuses rather than reattributes", () => {
  // An agent reply is phase 4's, delivered through `respond_to_file_comments` and its
  // token-guarded `/mcp/*` route, where the session is established by `findSessionByEnv`
  // before anything is written. THIS schema backs a route any ordinary dashboard caller can
  // reach over loopback, so accepting `agent` would let one forge a reply the UI renders as
  // the agent's answer - and, once phase 3 lands, hand the walkthrough a false advance
  // signal. The author field is a literal, not the `FILE_COMMENT_AUTHORS` enum.
  assert.equal(AppendFileCommentMessageSchema.safeParse({ author: "agent", body: "hi" }).success, false);
  assert.equal(AppendFileCommentMessageSchema.safeParse({ author: "foreman", body: "hi" }).success, false);
  // Refused, never silently rewritten to `human`: reattributing it would file a message
  // under an author nobody chose.
  assert.equal(FILE_COMMENT_AUTHORS.includes("agent"), true, "the STORE seam still has both");
});

test("the reorder list is bounded, and the status route takes only declared statuses", () => {
  assert.equal(ReorderFileCommentsSchema.parse({ order: ["a", "b"] }).order.length, 2);
  assert.equal(
    ReorderFileCommentsSchema.safeParse({ order: Array.from({ length: 501 }, () => "x") }).success,
    false,
  );
  for (const status of HUMAN_SETTABLE_THREAD_STATUSES) {
    assert.equal(SetFileCommentStatusSchema.safeParse({ status }).success, true, status);
  }
  // `addressed` is not a status at all - only a person closes a thread.
  assert.equal(SetFileCommentStatusSchema.safeParse({ status: "addressed" }).success, false);
  assert.equal(SetFileCommentStatusSchema.safeParse({ status: "outdated" }).success, false);
  // And `orphaned` is a status, but not one a PERSON sets: a thread reaches it when the
  // session that owns it goes away, through the three lifetime mechanisms alone.
  assert.equal(SetFileCommentStatusSchema.safeParse({ status: "orphaned" }).success, false);
});

test("the status route is human DECISIONS only, never a mechanism's recorded outcome", () => {
  // Pinned as an explicit membership rather than as "the persisted tuple minus one", because
  // the rule is not an exclusion list - it is that every status except these two is the
  // outcome of a mechanism with its own writer, and a status added to
  // `FILE_COMMENT_THREAD_STATUSES` later is one of those until somebody argues otherwise.
  // Deriving it would have made a new status human-settable by default, which is the wrong
  // default in both directions this has already failed in.
  assert.deepEqual([...HUMAN_SETTABLE_THREAD_STATUSES], ["draft", "resolved"]);
  // `draft` withdraws a thread from the queue and is the way back from `resolved`; `resolved`
  // is the human close.
  assert.equal(isHumanSettableThreadStatus("draft"), true);
  assert.equal(isHumanSettableThreadStatus("resolved"), true);
  // The delivery states, in particular: `answered` on an `awaiting` thread would release the
  // single-flight index while the original comment is still out with the agent, and
  // `sending`/`awaiting` on a draft would make a thread outstanding with no delivery.
  for (const status of ["queued", "sending", "awaiting", "answered", "unanswered", "orphaned"]) {
    assert.equal(isHumanSettableThreadStatus(status), false, status);
    assert.equal(SetFileCommentStatusSchema.safeParse({ status }).success, false, status);
  }
  // Every one of them is still a real persisted status with a real writer; only the request
  // door is closed.
  for (const status of HUMAN_SETTABLE_THREAD_STATUSES) {
    assert.equal(FILE_COMMENT_THREAD_STATUSES.includes(status), true, status);
  }
});

test("a queue position belongs to the statuses that actually hold one", () => {
  // `setFileCommentThreadStatus` clears `queue_seq` for everything outside this tuple, which
  // is what keeps a withdrawn thread from sitting in the order as a `draft` and a closed one
  // from leaving a permanent hole in it.
  assert.deepEqual([...QUEUE_POSITION_THREAD_STATUSES], ["queued", "sending", "awaiting"]);
  assert.equal(holdsQueuePosition("draft"), false);
  assert.equal(holdsQueuePosition("resolved"), false);
  // The outstanding statuses keep their place: a comment out with the agent is still the head
  // of the review.
  for (const status of OUTSTANDING_THREAD_STATUSES) {
    assert.equal(holdsQueuePosition(status), true, status);
  }
});

test("the lifecycle tuples say exactly what the index and the allow-list are built from", () => {
  // Pinned because these are read by SQL that the compiler cannot check, and because a later
  // phase widening either one is the failure the whole design guards against.
  assert.deepEqual([...OUTSTANDING_THREAD_STATUSES], ["sending", "awaiting"]);
  assert.deepEqual([...TERMINAL_THREAD_STATUSES], ["resolved", "orphaned"]);
  assert.deepEqual([...REQUEUEABLE_THREAD_STATUSES], ["draft", "answered", "unanswered"]);
  // `unanswered` sits outside the outstanding tuple, which is what makes decision 3's
  // auto-advance possible without deadlocking the queue.
  assert.equal(isOutstandingThreadStatus("unanswered"), false);
  assert.equal(isRequeueableThreadStatus("unanswered"), true);
  // `outdated` is a column, not a status, so it appears in neither.
  assert.equal(FILE_COMMENT_THREAD_STATUSES.includes("outdated" as never), false);
  // The three sets are disjoint, and every status is in at most one of them.
  for (const status of FILE_COMMENT_THREAD_STATUSES) {
    const memberships = [
      isOutstandingThreadStatus(status),
      isTerminalThreadStatus(status),
      isRequeueableThreadStatus(status),
    ].filter(Boolean).length;
    assert.ok(memberships <= 1, `${status} is in more than one lifecycle set`);
  }
});

test("a quote that normalizes to nothing is refused, not born unanchorable", () => {
  // `reanchor()` searches with the NORMALIZED quote - CRLF folded, trailing whitespace
  // stripped per line, blank edges dropped - and reports an empty one as `outdated` before it
  // searches at all. A whitespace-only quote passes a length check, so without this the
  // thread would be created already stale, marked outdated the first time phase 3 looked at
  // it, with no edit that could repair it: an empty quote names no text in the file.
  for (const quote of ["   ", "\n\n", "\r\n\r\n", "  \n \t \n  "]) {
    assert.equal(
      CreateFileCommentSchema.safeParse({ ...VALID, quote }).success,
      false,
      JSON.stringify(quote),
    );
  }
  // The check is on the normalized form, not `.trim()`: surrounding blank lines are fine as
  // long as there is text between them, because that is exactly what normalization keeps.
  const padded = CreateFileCommentSchema.parse({ ...VALID, quote: "\n\n  const x = 1;  \n\n" });
  assert.equal(normalizeQuote(padded.quote).length > 0, true);
  // And the raw quote is passed through untouched - normalization is a validity question
  // here, not a rewrite. The daemon computes the hash from the normalized form itself.
  assert.equal(padded.quote, "\n\n  const x = 1;  \n\n");
});

test("the live collection states a per-session bound, not only a per-thread one", () => {
  // `change-contracts.md` asks a collection to state its bound and pin it. "Bounded by live
  // sessions" was half a bound: it capped how LONG a thread lives, not how MANY one session
  // can accumulate while it is alive, and the prune only reaches settled threads whose
  // session key is already gone.
  assert.equal(FILE_COMMENT_THREADS_PER_SESSION_MAX, 200);
  // A runaway guard rather than a product limit, so it sits far above any real review - and
  // far enough above the message cap that the two bound different things.
  assert.ok(FILE_COMMENT_THREADS_PER_SESSION_MAX > FILE_COMMENT_THREAD_MESSAGE_CAP);
});
