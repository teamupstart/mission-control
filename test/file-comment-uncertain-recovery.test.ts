// The two recovery controls, against the real store.
//
// The failure this file covers is a DEADLOCK, not a wrong value. Retry and Mark sent act on
// `pending_turns` and know nothing about a comment thread, so without a correlated write the
// thread stays `sending` - an outstanding status - and `one_outstanding_file_comment` refuses
// every later delivery for that session. The review would be permanently stuck behind a
// comment the human had just dealt with, with nothing on screen to say so.
//
// So the assertions here are about what happens to the NEXT comment. A test that only checked
// comment one's timestamp would pass against the bug.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-file-comment-uncertain-"));
process.env.MISSION_HOME = home;

const {
  beginFileCommentDelivery,
  createFileCommentThread,
  loadFileCommentThread,
  markFileCommentMessageDelivered,
  openDb,
  queueFileCommentThread,
  returnFileCommentDeliveryToQueue,
  setFileCommentThreadStatus,
} = await import("../src/server/db.ts");
const { isOutstandingFileCommentViolation } = await import("../src/server/db.ts");

after(() => rmSync(home, { recursive: true, force: true }));

let seq = 0;
function comment(): { id: string; messageId: string } {
  seq += 1;
  const id = `t${seq}`;
  const messageId = `m${seq}`;
  createFileCommentThread({
    id,
    messageId,
    sessionId: "live",
    path: "docs/plan.md",
    startLine: seq,
    endLine: seq,
    quote: `paragraph ${seq}`,
    quoteHash: `hash-${seq}`,
    revision: "r1",
    surface: "editor",
    body: `comment ${seq}`,
    now: Date.now(),
  });
  queueFileCommentThread(id, Date.now());
  return { id, messageId };
}

function reset(): void {
  const db = openDb();
  db.exec("DELETE FROM file_comment_messages");
  db.exec("DELETE FROM file_comment_threads");
  db.exec("DELETE FROM file_comment_reviews");
}

/** What the index actually does, asked directly rather than inferred from a status. */
function secondDeliveryPermitted(threadId: string): boolean {
  try {
    beginFileCommentDelivery(threadId, "turn-next", Date.now());
    return true;
  } catch (error) {
    if (isOutstandingFileCommentViolation(error)) return false;
    throw error;
  }
}

test("while a comment is genuinely outstanding, the index refuses the next delivery", () => {
  reset();
  const first = comment();
  const second = comment();
  beginFileCommentDelivery(first.id, "turn-1", Date.now());
  assert.equal(loadFileCommentThread(first.id)!.status, "sending");
  // This is the guarantee the whole phase rests on: depth one, enforced in SQL rather than by
  // the walkthrough's bookkeeping.
  assert.equal(secondDeliveryPermitted(second.id), false);
});

test("Mark sent stamps the message, frees the index, and the next comment can go", () => {
  reset();
  const first = comment();
  const second = comment();
  beginFileCommentDelivery(first.id, "turn-1", Date.now());

  // "Mark sent" is the human supplying the confirmation the daemon could not observe, so it
  // performs the confirmed-delivery write - the same one the outbox's own signal performs.
  const at = Date.now();
  markFileCommentMessageDelivered(first.messageId, at);
  const settled = loadFileCommentThread(first.id)!;
  assert.equal(settled.status, "awaiting");
  assert.equal(settled.messages[0]!.deliveredAt, at);

  // `awaiting` is still outstanding, so the queue advances by the ordinary route: the grace
  // window moves it to `unanswered`, which sits OUTSIDE the outstanding tuple.
  assert.equal(secondDeliveryPermitted(second.id), false);
  setFileCommentThreadStatus(first.id, "unanswered", Date.now());
  assert.equal(secondDeliveryPermitted(second.id), true, "the review is not deadlocked");
});

test("Retry keeps the thread sending, leaves delivered_at NULL, and re-points on demand", () => {
  reset();
  const first = comment();
  beginFileCommentDelivery(first.id, "turn-1", Date.now());

  // `retryPendingTurn` moves the EXISTING row uncertain -> queued and keeps its id, so the
  // thread's `delivery_id` already names the row about to go out. This asserts the store
  // permits a re-point anyway - `sending` -> `sending` - because that is what a correlation
  // that DID move would need, and because the index must be untouched by it either way.
  const repointed = beginFileCommentDelivery(first.id, "turn-1-again", Date.now());
  assert.equal(repointed!.status, "sending");
  assert.equal(repointed!.deliveryId, "turn-1-again");
  assert.equal(repointed!.messages[0]!.deliveredAt, null, "a retry never claims delivery");
  // `sent_at` records the FIRST send, so a retry does not rewrite when the comment went out.
  assert.equal(repointed!.sentAt, loadFileCommentThread(first.id)!.sentAt);
});

test("a recalled turn returns its comment to the queue, in the place it held", () => {
  reset();
  const first = comment();
  const second = comment();
  const before = loadFileCommentThread(first.id)!.queueSeq;
  beginFileCommentDelivery(first.id, "turn-1", Date.now());

  const back = returnFileCommentDeliveryToQueue(first.id, Date.now())!;
  assert.equal(back.status, "queued");
  assert.equal(back.deliveryId, null);
  assert.equal(back.messages[0]!.deliveredAt, null, "so the comment is editable again");
  assert.equal(back.queueSeq, before, "a recall did not lose it its place in the review");
  // And the index is free, so the review carries on.
  assert.equal(secondDeliveryPermitted(second.id), true);
});

test("it refuses a thread whose bytes provably reached the agent", () => {
  reset();
  const first = comment();
  beginFileCommentDelivery(first.id, "turn-1", Date.now());
  markFileCommentMessageDelivered(first.messageId, Date.now());
  assert.equal(loadFileCommentThread(first.id)!.status, "awaiting");
  // `awaiting` means the confirmed-delivery signal fired. There is nothing to take back.
  assert.equal(returnFileCommentDeliveryToQueue(first.id, Date.now()), null);
  assert.equal(loadFileCommentThread(first.id)!.status, "awaiting");
});
