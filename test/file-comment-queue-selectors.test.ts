// The queue panel's selectors, which are pure and therefore cost milliseconds here rather
// than the seventeen seconds an equivalent browser assertion costs in `e2e/`.
//
// What the panel itself owes `e2e/` is that a click reaches the daemon and comes back. What
// it owes this file is the arithmetic underneath: which threads are in the review, in what
// order, which one is out with the agent, which text each row shows, and the one sentence a
// screen reader is given in place of watching the head move.

import test from "node:test";
import assert from "node:assert/strict";

import type { FileCommentMessage, FileCommentReview, FileCommentThread } from "../src/shared/types.ts";
import {
  isEditableInQueue,
  outstandingThread,
  queueRowText,
  reviewAnnouncement,
  reviewQueue,
  unreadAgentReplies,
  unsentMessage,
} from "../src/web/lib/fileComments.ts";

function message(over: Partial<FileCommentMessage> = {}): FileCommentMessage {
  return {
    id: "m1",
    threadId: "t1",
    author: "human",
    sessionId: "s1",
    body: "the comment as written",
    deliveredAt: null,
    readAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function thread(over: Partial<FileCommentThread> = {}): FileCommentThread {
  return {
    id: "t1",
    shortId: "MC-0001",
    sessionId: "s1",
    path: "docs/spec.md",
    startLine: 3,
    endLine: 3,
    quote: "The retry budget is thirty seconds.",
    quoteHash: "hash",
    revision: null,
    surface: "editor",
    status: "queued",
    outdated: false,
    queueSeq: 1,
    deliveryId: null,
    sentAt: null,
    answeredAt: null,
    addressedAt: null,
    resolvedAt: null,
    createdAt: 1,
    updatedAt: 1,
    messages: [message()],
    messageCount: 1,
    ...over,
  };
}

test("the queue is this session's comments in delivery order, with the outstanding one at its head", () => {
  const queue = reviewQueue(
    [
      thread({ id: "c", shortId: "MC-000c", queueSeq: 3 }),
      thread({ id: "other", shortId: "MC-00ff", sessionId: "s2", queueSeq: 1 }),
      thread({ id: "a", shortId: "MC-000a", queueSeq: 1, status: "sending" }),
      thread({ id: "b", shortId: "MC-000b", queueSeq: 2 }),
      // Terminal threads hold no queue position and are not part of the review any more.
      thread({ id: "done", shortId: "MC-00dd", queueSeq: null, status: "resolved" }),
    ],
    "s1",
  );
  assert.deepEqual(queue.map((t) => t.id), ["a", "b", "c"]);
  assert.equal(outstandingThread(queue)?.id, "a");
});

test("nothing is outstanding between two turns", () => {
  assert.equal(outstandingThread([thread(), thread({ id: "t2", queueSeq: 2 })]), null);
});

test("a comment awaiting a reply is still the outstanding one", () => {
  const queue = [thread({ status: "awaiting" })];
  assert.equal(outstandingThread(queue)?.id, "t1");
  assert.equal(isEditableInQueue(queue[0]!), false);
});

test("only a comment the agent has not been committed is editable", () => {
  assert.equal(isEditableInQueue(thread({ status: "queued" })), true);
  // `sending` too: the bytes are in the outbox even though delivery is not confirmed.
  assert.equal(isEditableInQueue(thread({ status: "sending" })), false);
  assert.equal(isEditableInQueue(thread({ status: "awaiting" })), false);
});

test("the message that goes next is the oldest human one not yet delivered", () => {
  const t = thread({
    messages: [
      message({ id: "m1", body: "first, already read", deliveredAt: 10 }),
      message({ id: "m2", author: "agent", body: "the agent's answer" }),
      message({ id: "m3", body: "the follow-up" }),
      message({ id: "m4", body: "and one after that" }),
    ],
    messageCount: 4,
  });
  assert.equal(unsentMessage(t)?.id, "m3");
});

test("a thread with nothing left to send offers no message to edit", () => {
  const t = thread({ messages: [message({ deliveredAt: 10 })] });
  assert.equal(unsentMessage(t), null);
});

test("a row shows the comment somebody wrote, and keeps showing it after it goes", () => {
  // The regression this exists for: the head row fell back to the QUOTE the moment its
  // message was stamped delivered, so the one row a reader watches stopped showing the
  // sentence it had just sent.
  const sent = thread({
    status: "awaiting",
    messages: [message({ body: "This number disagrees with the table.", deliveredAt: 10 })],
  });
  assert.equal(queueRowText(sent), "This number disagrees with the table.");
  assert.equal(unsentMessage(sent), null, "and it is not editable, which is a separate answer");
});

test("a row shows the newest human message, not the opening one", () => {
  const t = thread({
    messages: [
      message({ id: "m1", body: "the opening comment", deliveredAt: 10 }),
      message({ id: "m2", author: "agent", body: "the agent's answer" }),
      message({ id: "m3", body: "the follow-up that will go next" }),
    ],
    messageCount: 3,
  });
  assert.equal(queueRowText(t), "the follow-up that will go next");
});

test("a row falls back to the quote only when the thread carries no human message", () => {
  const t = thread({ messages: [message({ author: "agent", body: "unprompted" })] });
  assert.equal(queueRowText(t), "The retry budget is thirty seconds.");
});

function review(over: Partial<FileCommentReview> = {}): FileCommentReview {
  return { sessionId: "s1", state: "idle", pauseReason: null, startedAt: null, updatedAt: 1, ...over };
}

test("the announcement says what the walkthrough is doing", () => {
  assert.equal(reviewAnnouncement(null, []), "No comments are queued for review.");
  assert.equal(
    reviewAnnouncement(null, [thread(), thread({ id: "t2", queueSeq: 2 })]),
    "Review not started. 2 comments waiting.",
  );
  assert.equal(
    reviewAnnouncement(review({ state: "running" }), [
      thread({ status: "sending" }),
      thread({ id: "t2", queueSeq: 2 }),
    ]),
    "MC-0001 on docs/spec.md line 3 is out with the agent. 1 comment waiting.",
  );
});

test("a paused announcement leaves the reason to the alert that already carries it", () => {
  // Both are announced - `role="status"` and `role="alert"` alike - so repeating the reason
  // here said it twice to a screen reader and drew it twice on screen, one line under the
  // other.
  const reason = "MC-0001 quotes text that is no longer in docs/spec.md.";
  assert.equal(
    reviewAnnouncement(review({ state: "paused", pauseReason: reason }), [thread()]),
    "Review paused. 1 comment waiting.",
  );
  assert.equal(
    reviewAnnouncement(review({ state: "paused" }), [thread()]),
    "Review paused. 1 comment waiting.",
  );
});

test("a running review with nothing out says so rather than naming a comment", () => {
  assert.equal(
    reviewAnnouncement(review({ state: "running" }), [thread()]),
    "Review running. 1 comment waiting.",
  );
});

// ---- the Files tab's pip ----

test("the pip counts unread AGENT replies, and never the human's own queue", () => {
  const threads = [
    thread({
      id: "t1",
      status: "answered",
      messages: [message(), message({ id: "m2", author: "agent", body: "done" })],
    }),
    // Queued comments are the human's own work. A pip counting these would light up the
    // moment they wrote one, saying "somebody needs you" about a note they just typed.
    thread({ id: "t2", status: "queued", messages: [message({ id: "m3" })] }),
  ];
  assert.equal(unreadAgentReplies(threads, "s1"), 1);
  assert.equal(unreadAgentReplies(threads, "other-session"), 0, "bounded to one session");
});

test("a reply that has been read, and a thread that has been closed, raise nothing", () => {
  const read = thread({
    id: "t1",
    status: "answered",
    messages: [message(), message({ id: "m2", author: "agent", readAt: 9 })],
  });
  assert.equal(unreadAgentReplies([read], "s1"), 0);
  // A resolved thread is a conversation the person has already closed; re-raising a pip for
  // it would make closing a thread the one action that cannot be finished.
  const closed = thread({
    id: "t2",
    status: "resolved",
    messages: [message(), message({ id: "m3", author: "agent" })],
  });
  assert.equal(unreadAgentReplies([closed], "s1"), 0);
});
