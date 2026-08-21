import test from "node:test";
import assert from "node:assert/strict";
import {
  AppendFileCommentMessageSchema,
  CreateFileCommentSchema,
  EditFileCommentMessageSchema,
  ReorderFileCommentsSchema,
  SetFileCommentStatusSchema,
} from "../src/shared/protocol.ts";
import { FILE_COMMENT_QUOTE_MAX, FILE_COMMENT_SURFACES } from "../src/shared/file-comment-anchor.ts";
import {
  FILE_COMMENT_AUTHORS,
  FILE_COMMENT_TEXT_LIMITS,
  FILE_COMMENT_THREAD_STATUSES,
  HUMAN_SETTABLE_THREAD_STATUSES,
  OUTSTANDING_THREAD_STATUSES,
  REQUEUEABLE_THREAD_STATUSES,
  TERMINAL_THREAD_STATUSES,
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

test("the human-settable tuple is the persisted one minus `orphaned`, exactly", () => {
  // The tuple is spelled out rather than derived, because `z.enum` needs a literal. The
  // `satisfies` clause beside it catches a RENAME; this catches an ADDITION - a status added
  // to `FILE_COMMENT_THREAD_STATUSES` and forgotten here would be silently unreachable from
  // the dashboard, and one added to BOTH by reflex would reopen the hole if it were another
  // status only cleanup should write.
  assert.deepEqual(
    [...HUMAN_SETTABLE_THREAD_STATUSES],
    FILE_COMMENT_THREAD_STATUSES.filter((status) => status !== "orphaned"),
  );
  assert.equal(isHumanSettableThreadStatus("orphaned"), false);
  assert.equal(isHumanSettableThreadStatus("resolved"), true, "the human close still is one");
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
