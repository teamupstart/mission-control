import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: every invariant the walkthrough rests on is enforced HERE, in SQL and in
// one declared operation per transition, rather than by the caller remembering. The two that
// fail silently if they are wrong are the partial unique index (a second comment typed into a
// live agent) and the edit refusal (the dashboard's copy of a comment diverging from the
// bytes already committed to the outbox).

const home = mkdtempSync(join(tmpdir(), "mission-file-comments-store-"));
process.env.MISSION_HOME = home;

const {
  FileCommentStoreError,
  appendFileCommentMessage,
  beginFileCommentDelivery,
  createFileCommentThread,
  deleteFileCommentThread,
  findFileCommentThreadByShortId,
  isOutstandingFileCommentViolation,
  loadFileCommentReview,
  loadFileCommentMessage,
  loadFileCommentThread,
  loadFileCommentThreadWithFullHistory,
  loadFileCommentThreads,
  loadFileCommentThreadsForSession,
  markFileCommentMessageDelivered,
  markFileCommentMessagesRead,
  markFileCommentThreadAddressed,
  openDb,
  orphanFileCommentThreadsForSession,
  pruneFileCommentThreads,
  queueFileCommentThread,
  reorderFileCommentQueue,
  setFileCommentReviewState,
  setFileCommentThreadStatus,
  updateFileCommentMessageBody,
  updateFileCommentThreadAnchor,
} = await import("../src/server/db.ts");
const { FILE_COMMENT_THREAD_MESSAGE_CAP } = await import("../src/shared/file-comments.ts");

after(() => rmSync(home, { recursive: true, force: true }));

let seq = 0;
function make(over: Partial<Parameters<typeof createFileCommentThread>[0]> = {}) {
  seq += 1;
  return createFileCommentThread({
    id: `t-${seq}`,
    messageId: `m-${seq}`,
    sessionId: "s1",
    path: "docs/plan.md",
    startLine: 3,
    endLine: 3,
    quote: "charlie",
    quoteHash: `hash-${seq}`,
    revision: "r1",
    surface: "editor",
    body: `comment ${seq}`,
    now: 1_000 + seq,
    ...over,
  });
}

beforeEach(() => {
  const db = openDb();
  db.exec("DELETE FROM file_comment_messages");
  db.exec("DELETE FROM file_comment_threads");
  db.exec("DELETE FROM file_comment_reviews");
});

test("a new thread is a draft carrying its opening comment as an ordinary message", () => {
  // Drafts are persisted from the first keystroke, and the body lives in
  // file_comment_messages rather than on the thread - which is what makes it editable.
  const thread = make();
  assert.equal(thread.status, "draft");
  assert.equal(thread.queueSeq, null);
  assert.equal(thread.outdated, false);
  assert.match(thread.shortId, /^MC-[0-9a-f]{4,}$/);
  assert.deepEqual(
    thread.messages.map((m) => [m.author, m.deliveredAt, m.readAt]),
    [["human", null, null]],
  );
  assert.match(thread.messages[0]!.body, /^comment \d+$/);
  assert.equal(thread.messageCount, 1);
});

test("short_id minting survives a forced collision rather than failing the insert", () => {
  // Seed a session's handle, force the next mint onto it, and the thread is still created.
  // A read-then-write pre-check would race another create in the same session, which is why
  // minting attempts the insert and inspects the failure instead.
  const first = make();
  const db = openDb();
  const realRandom = Math.random;
  // Drive the first mint onto the taken handle by replaying its hex, then let it be random.
  const taken = first.shortId.slice(3);
  let calls = 0;
  Math.random = () => {
    calls += 1;
    if (calls <= taken.length) return Number.parseInt(taken[calls - 1]!, 16) / 16 + 0.001;
    return realRandom();
  };
  let second;
  try {
    second = make();
    assert.notEqual(second.shortId, first.shortId);
    assert.ok(calls > taken.length, "the first candidate must actually have been the taken one");
  } finally {
    Math.random = realRandom;
  }
  // And nothing half-created survived the retry: exactly two threads, two messages.
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM file_comment_threads").get() as { n: number }).n,
    2,
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM file_comment_messages").get() as { n: number }).n,
    2,
  );
  assert.equal(findFileCommentThreadByShortId("s1", second.shortId)?.id, second.id);
});

test("short_id is unique PER SESSION, so a lookup is always session-scoped", () => {
  // Phase 4 resolves a reply through this column. A global lookup would land it on another
  // session's thread.
  const mine = make({ sessionId: "s1" });
  assert.equal(findFileCommentThreadByShortId("s1", mine.shortId)?.id, mine.id);
  assert.equal(findFileCommentThreadByShortId("s2", mine.shortId), null);
});

test("queueing allocates consecutive positions per session, and a second session starts at 0", () => {
  const a = make();
  const b = make();
  assert.equal(queueFileCommentThread(a.id, 2_000)?.queueSeq, 0);
  assert.equal(queueFileCommentThread(b.id, 2_001)?.queueSeq, 1);
  const other = make({ sessionId: "s2" });
  assert.equal(queueFileCommentThread(other.id, 2_002)?.queueSeq, 0);
});

test("a requeue lands at the TAIL, never back in its old position", () => {
  // "Re-enters the queue at the end" is the contract. Reusing the old number would send a
  // follow-up ahead of everything queued since.
  const first = make();
  queueFileCommentThread(first.id, 2_000);
  setFileCommentThreadStatus(first.id, "answered", 2_100);
  const later = make();
  queueFileCommentThread(later.id, 2_200);
  const requeued = queueFileCommentThread(first.id, 2_300);
  assert.equal(requeued?.status, "queued");
  assert.ok(
    (requeued?.queueSeq ?? -1) > (loadFileCommentThread(later.id)?.queueSeq ?? 0),
    "a follow-up must sit behind the comments queued while it was answered",
  );
});

test("queueing is refused on every status outside the allow-list, for two different reasons", () => {
  // Outstanding would empty the set the single-flight index is built on; terminal would undo
  // a human decision or queue work for a session that no longer exists.
  for (const status of ["sending", "awaiting", "resolved", "orphaned"] as const) {
    // A session each: two outstanding rows in one session is what the index refuses, and
    // this test is about the ALLOW-LIST, not about that.
    const t = make({ sessionId: `refuse-${status}` });
    openDb()
      .prepare("UPDATE file_comment_threads SET status = ? WHERE id = ?")
      .run(status, t.id);
    assert.throws(
      () => queueFileCommentThread(t.id, 3_000),
      (err: unknown) => err instanceof FileCommentStoreError && /cannot be queued/.test(String(err)),
      `${status} must be refused`,
    );
  }
  // And the three that ARE allowed, which is the other half of an allow-list being one.
  for (const status of ["draft", "answered", "unanswered"] as const) {
    const t = make({ sessionId: `allow-${status}` });
    openDb().prepare("UPDATE file_comment_threads SET status = ? WHERE id = ?").run(status, t.id);
    assert.equal(queueFileCommentThread(t.id, 3_100)?.status, "queued", status);
  }
});

test("the partial unique index refuses a second outstanding row from EITHER status", () => {
  // The asymmetric case is the one an index over `sending` alone would pass: a comment is
  // outstanding until the agent answers it, and `awaiting` is the longer half of that.
  const first = make();
  queueFileCommentThread(first.id, 2_000);
  beginFileCommentDelivery(first.id, "d1", 2_001);
  markFileCommentMessageDelivered(first.messages[0]!.id, 2_002);
  assert.equal(loadFileCommentThread(first.id)?.status, "awaiting");

  const second = make();
  queueFileCommentThread(second.id, 2_010);
  let caught: unknown;
  try {
    beginFileCommentDelivery(second.id, "d2", 2_011);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "a sending row beside an awaiting one must be refused");
  assert.equal(isOutstandingFileCommentViolation(caught), true);

  // Two `sending` rows are refused too, which is the easy half.
  const third = make({ sessionId: "s3" });
  const fourth = make({ sessionId: "s3" });
  queueFileCommentThread(third.id, 2_020);
  queueFileCommentThread(fourth.id, 2_021);
  beginFileCommentDelivery(third.id, "d3", 2_022);
  assert.throws(() => beginFileCommentDelivery(fourth.id, "d4", 2_023));
});

test("a short_id collision is NOT mistaken for an outstanding violation", () => {
  // Both indices are on file_comment_threads and both mention session_id, so the predicate
  // that tells them apart is load-bearing: swallowing a mint collision as an outstanding
  // violation would refuse to save a comment and report the wrong reason.
  const t = make();
  let caught: unknown;
  try {
    openDb()
      .prepare(
        `INSERT INTO file_comment_threads
           (id, short_id, session_id, path, start_line, end_line, quote, quote_hash, revision,
            surface, status, outdated, created_at, updated_at)
         VALUES ('dup', ?, 's1', 'p', 1, 1, 'q', 'h', NULL, 'editor', 'draft', 0, 1, 1)`,
      )
      .run(t.shortId);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught);
  assert.equal(isOutstandingFileCommentViolation(caught), false);
});

test("submitting does not stamp delivery; confirmed delivery does, and completes the move", () => {
  // pendingTurns.submit() only enqueues a turn, so `sending` is outstanding but not
  // delivered - the bytes can still be recalled or turned uncertain by a restart.
  const t = make();
  queueFileCommentThread(t.id, 2_000);
  const sending = beginFileCommentDelivery(t.id, "delivery-1", 2_001);
  assert.equal(sending?.status, "sending");
  assert.equal(sending?.deliveryId, "delivery-1");
  assert.equal(sending?.sentAt, 2_001);
  assert.equal(sending?.messages[0]?.deliveredAt, null);

  const delivered = markFileCommentMessageDelivered(t.id === "" ? "" : t.messages[0]!.id, 2_005);
  assert.equal(delivered?.status, "awaiting");
  assert.equal(delivered?.messages[0]?.deliveredAt, 2_005);
});

test("beginFileCommentDelivery re-points an uncertain delivery and refuses anything else", () => {
  const t = make();
  queueFileCommentThread(t.id, 2_000);
  beginFileCommentDelivery(t.id, "d1", 2_001);
  // The retry case: still `sending` before and after, so the index is unaffected.
  assert.equal(beginFileCommentDelivery(t.id, "d2", 2_002)?.deliveryId, "d2");
  // sent_at records the FIRST send, so a retry does not rewrite when the comment went out.
  assert.equal(loadFileCommentThread(t.id)?.sentAt, 2_001);
  const draft = make();
  assert.throws(() => beginFileCommentDelivery(draft.id, "d3", 2_003), FileCommentStoreError);
});

test("a message is editable while queued and refused once its thread is outstanding", () => {
  // BOTH halves. Refusing on `delivered_at` alone leaves the `sending` window editable, and
  // an edit inside it changes the dashboard's copy of a comment whose bytes are already in
  // pending_turns.text.
  const t = make();
  assert.equal(updateFileCommentMessageBody(t.messages[0]!.id, "edited", 2_000)?.body, "edited");
  queueFileCommentThread(t.id, 2_001);
  assert.equal(updateFileCommentMessageBody(t.messages[0]!.id, "again", 2_002)?.body, "again");

  beginFileCommentDelivery(t.id, "d1", 2_003);
  assert.throws(
    () => updateFileCommentMessageBody(t.messages[0]!.id, "too late", 2_004),
    (err: unknown) => err instanceof FileCommentStoreError && /outbox/.test(String(err)),
    "an outstanding thread's comment is frozen even before delivered_at exists",
  );

  markFileCommentMessageDelivered(t.messages[0]!.id, 2_005);
  // Now it is refused on the OTHER half: the thread is `awaiting`, and delivered_at is set.
  assert.throws(() => updateFileCommentMessageBody(t.messages[0]!.id, "no", 2_006));
  setFileCommentThreadStatus(t.id, "answered", 2_007);
  assert.throws(
    () => updateFileCommentMessageBody(t.messages[0]!.id, "still no", 2_008),
    (err: unknown) => err instanceof FileCommentStoreError && /already been sent/.test(String(err)),
  );
});

test("messages append and load in time order for both authors", () => {
  const t = make();
  const opening = t.messages[0]!.body;
  appendFileCommentMessage({
    id: "am-1",
    threadId: t.id,
    author: "agent",
    sessionId: "s1",
    body: "the agent's answer",
    now: 2_000,
  });
  appendFileCommentMessage({
    id: "hm-1",
    threadId: t.id,
    author: "human",
    sessionId: "s1",
    body: "a follow-up",
    now: 2_001,
  });
  assert.deepEqual(
    loadFileCommentThread(t.id)?.messages.map((m) => [m.author, m.body]),
    [["human", opening], ["agent", "the agent's answer"], ["human", "a follow-up"]],
  );
  assert.equal(appendFileCommentMessage({
    id: "x",
    threadId: "nope",
    author: "human",
    sessionId: null,
    body: "b",
    now: 1,
  }), null);
});

test("the anchor writer moves lines and the flag without touching the status", () => {
  // Whether to HOLD an outdated comment at the head of the queue is phase 3's decision, not
  // this function's.
  const t = make();
  queueFileCommentThread(t.id, 2_000);
  const moved = updateFileCommentThreadAnchor(
    t.id,
    { startLine: 40, endLine: 42, revision: "r9", outdated: false },
    2_001,
  );
  assert.deepEqual(
    [moved?.startLine, moved?.endLine, moved?.revision, moved?.outdated, moved?.status],
    [40, 42, "r9", false, "queued"],
  );
  // Outdated must NOT advance the revision, so the writer is told not to write one.
  const stale = updateFileCommentThreadAnchor(t.id, { outdated: true }, 2_002);
  assert.deepEqual([stale?.revision, stale?.outdated, stale?.status, stale?.startLine], [
    "r9",
    true,
    "queued",
    40,
  ]);
});

test("outdated survives a status change in BOTH directions", () => {
  // Two dimensions, so two columns: a thread that goes outdated keeps its place in the
  // review, and if the quote comes back it re-anchors and the flag clears.
  const t = make();
  updateFileCommentThreadAnchor(t.id, { outdated: true }, 2_000);
  queueFileCommentThread(t.id, 2_001);
  assert.equal(loadFileCommentThread(t.id)?.outdated, true);
  setFileCommentThreadStatus(t.id, "answered", 2_002);
  assert.equal(loadFileCommentThread(t.id)?.outdated, true);
  updateFileCommentThreadAnchor(t.id, { startLine: 3, endLine: 3, revision: "r2", outdated: false }, 2_003);
  assert.equal(loadFileCommentThread(t.id)?.outdated, false);
  assert.equal(loadFileCommentThread(t.id)?.status, "answered");
});

test("addressed_at and read_at are each written WITHOUT the status moving", () => {
  // `addressed` is the agent's suggestion, never a closure - only a person resolves - so it
  // cannot ride the status route, which would have to move the thread to write a timestamp.
  const t = make();
  queueFileCommentThread(t.id, 2_000);
  const addressed = markFileCommentThreadAddressed(t.id, 2_001);
  assert.equal(addressed?.addressedAt, 2_001);
  assert.equal(addressed?.status, "queued");
  assert.equal(addressed?.resolvedAt, null);

  appendFileCommentMessage({
    id: "am-2",
    threadId: t.id,
    author: "agent",
    sessionId: "s1",
    body: "answer",
    now: 2_002,
  });
  const read = markFileCommentMessagesRead(t.id, 2_003);
  assert.equal(read?.status, "queued");
  assert.deepEqual(
    read?.messages.map((m) => [m.author, m.readAt]),
    [["human", null], ["agent", 2_003]],
  );
});

test("reordering rewrites the whole queue and never leaves a hole", () => {
  const ids = [make(), make(), make()].map((t) => t.id);
  for (const [i, id] of ids.entries()) queueFileCommentThread(id, 2_000 + i);
  const reordered = reorderFileCommentQueue("s1", [ids[2]!, ids[0]!], 2_100);
  assert.deepEqual(
    reordered.filter((t) => t.queueSeq !== null).map((t) => [t.id, t.queueSeq]),
    [
      [ids[2]!, 0],
      [ids[0]!, 1],
      [ids[1]!, 2],
    ],
    "an unnamed thread keeps its relative order behind the named ones",
  );
  // An id from another session is ignored rather than refused - a reorder is a drag in a
  // list that may have moved under the operator.
  const stranger = make({ sessionId: "s9" });
  queueFileCommentThread(stranger.id, 2_200);
  reorderFileCommentQueue("s1", [stranger.id, ids[1]!], 2_300);
  assert.equal(loadFileCommentThread(stranger.id)?.queueSeq, 0);
});

test("a repeated id in the drag list does not punch a hole in the order", () => {
  // The list is assembled by a browser and arrives over HTTP, so `[a, a, b]` is a reachable
  // body. Writing `a` twice advanced the running index twice, leaving `a` at 1 and `b` at 2
  // with position 0 unfilled - a permanent hole in the consecutive order this function
  // promises, and the order phase 3 reads to find the head of the review. First occurrence
  // wins, which is what a drag actually means.
  const ids = [make(), make(), make()].map((t) => t.id);
  for (const [i, id] of ids.entries()) queueFileCommentThread(id, 2_400 + i);
  const reordered = reorderFileCommentQueue("s1", [ids[1]!, ids[1]!, ids[0]!, ids[1]!], 2_500);
  const order = reordered
    .filter((t) => t.queueSeq !== null)
    .map((t) => [t.id, t.queueSeq]);
  assert.deepEqual(order, [
    [ids[1]!, 0],
    [ids[0]!, 1],
    [ids[2]!, 2],
  ]);
  // Stated as the invariant rather than only as this example: the positions are 0..n-1 with
  // nothing missing and nothing repeated.
  assert.deepEqual(
    order.map(([, seq]) => seq),
    order.map((_, index) => index),
  );
});

test("a terminal status drops the thread out of the queue", () => {
  const t = make();
  queueFileCommentThread(t.id, 2_000);
  const resolved = setFileCommentThreadStatus(t.id, "resolved", 2_001);
  assert.equal(resolved?.queueSeq, null);
  assert.equal(resolved?.resolvedAt, 2_001);
  // Un-resolving clears the stamp; getting back into the review is then the ordinary
  // requeue, which is the deliberate two-step.
  const reopened = setFileCommentThreadStatus(t.id, "answered", 2_002);
  assert.equal(reopened?.resolvedAt, null);
  assert.equal(queueFileCommentThread(t.id, 2_003)?.status, "queued");
});

test("orphaning is an UPDATE that keeps the row and the comment a human wrote", () => {
  const t = make();
  const opening = t.messages[0]!.body;
  queueFileCommentThread(t.id, 2_000);
  setFileCommentReviewState("s1", "running", null, 2_000);
  assert.deepEqual(orphanFileCommentThreadsForSession("s1", 2_100), [t.id]);
  const after = loadFileCommentThread(t.id);
  assert.equal(after?.status, "orphaned");
  assert.equal(after?.queueSeq, null);
  assert.equal(after?.messages[0]?.body, opening);
  // The review's run state goes with them: a row left `running` would resume a review for a
  // session that no longer exists.
  assert.equal(loadFileCommentReview("s1").state, "idle");
  // Orphaned threads leave the live load, which is what the registry holds.
  assert.equal(loadFileCommentThreads().some((x) => x.id === t.id), false);
  // Idempotent: nothing moved the second time, so nothing is reported.
  assert.deepEqual(orphanFileCommentThreadsForSession("s1", 2_200), []);
});

test("the prune deletes only settled rows whose session is gone, and never on an empty set", () => {
  const settled = make({ sessionId: "dead" });
  const queued = make({ sessionId: "dead" });
  queueFileCommentThread(queued.id, 2_000);
  setFileCommentThreadStatus(settled.id, "resolved", 2_000);
  const live = make({ sessionId: "alive" });
  setFileCommentThreadStatus(live.id, "resolved", 2_000);

  // An EMPTY live set means "liveness unknown", never "nothing is live".
  assert.equal(pruneFileCommentThreads([], 9_000), 0);
  assert.equal(pruneFileCommentThreads(["alive"], 9_000), 1);
  assert.equal(loadFileCommentThread(settled.id), null);
  assert.ok(loadFileCommentThread(queued.id), "a queued comment is never pruned");
  assert.ok(loadFileCommentThread(live.id), "a live session's thread is never pruned");
  // Its messages went with it rather than being left behind.
  assert.equal(
    (openDb()
      .prepare("SELECT COUNT(*) AS n FROM file_comment_messages WHERE thread_id = ?")
      .get(settled.id) as { n: number }).n,
    0,
  );
});

test("the full-history loader is the only uncapped read, and every frame stays capped", () => {
  // The cap is what keeps a conversation on one line from deciding the snapshot's size; the
  // uncapped loader is what keeps it a CAP rather than a loss. If both read the same way, a
  // thread past the cap has no route that can return it whole.
  const t = make();
  for (let i = 0; i < FILE_COMMENT_THREAD_MESSAGE_CAP + 5; i += 1) {
    appendFileCommentMessage({
      id: `cap-${i}`,
      threadId: t.id,
      author: "agent",
      sessionId: "s1",
      body: `reply ${i}`,
      now: 4_000 + i,
    });
  }
  const total = FILE_COMMENT_THREAD_MESSAGE_CAP + 6;

  const framed = loadFileCommentThread(t.id)!;
  assert.equal(framed.messages.length, FILE_COMMENT_THREAD_MESSAGE_CAP);
  assert.equal(framed.messageCount, total, "the count is exact even when the list is a tail");

  const whole = loadFileCommentThreadWithFullHistory(t.id)!;
  assert.equal(whole.messages.length, total);
  assert.equal(whole.messages[0]!.body, t.messages[0]!.body);

  // The session list stays capped: it is what the registry holds and what rides the wire.
  const listed = loadFileCommentThreadsForSession("s1").find((x) => x.id === t.id)!;
  assert.equal(listed.messages.length, FILE_COMMENT_THREAD_MESSAGE_CAP);
  assert.equal(listed.messageCount, total);
});

test("a message resolves to its owning thread, which is what guards an edit by message id", () => {
  const t = make();
  assert.equal(loadFileCommentMessage(t.messages[0]!.id)?.threadId, t.id);
  assert.equal(loadFileCommentMessage("no-such-message"), null);
});

test("listing by session and by path is the gutter's read", () => {
  const a = make({ path: "docs/a.md" });
  make({ path: "docs/b.md" });
  make({ sessionId: "s2", path: "docs/a.md" });
  assert.equal(loadFileCommentThreadsForSession("s1").length, 2);
  assert.deepEqual(
    loadFileCommentThreadsForSession("s1", "docs/a.md").map((t) => t.id),
    [a.id],
  );
});

test("deleting a thread takes its messages with it", () => {
  const t = make();
  assert.equal(deleteFileCommentThread(t.id), true);
  assert.equal(deleteFileCommentThread(t.id), false);
  assert.equal(
    (openDb()
      .prepare("SELECT COUNT(*) AS n FROM file_comment_messages WHERE thread_id = ?")
      .get(t.id) as { n: number }).n,
    0,
  );
});

test("a session's review state defaults to idle rather than to an absence", () => {
  // "Never started" is a real answer the walkthrough and the toolbar both need, and making
  // every caller handle a null would invite each of them to pick its own default.
  assert.equal(loadFileCommentReview("never-seen").state, "idle");
  setFileCommentReviewState("s1", "running", null, 5_000);
  const paused = setFileCommentReviewState("s1", "paused", "the agent deleted the text", 5_100);
  assert.equal(paused.pauseReason, "the agent deleted the text");
  assert.equal(paused.startedAt, 5_000, "a pause does not restart the review");
});
