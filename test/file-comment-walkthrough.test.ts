// The advance state machine: which comment goes, when, and what stops the queue.
//
// No database, no pane, no session - the machine takes a port and everything below is a fake
// one. That is the point of the split: every branch here (a held outdated head, a missing
// file, an uncertain delivery, a restart, a reply-after-answer, a recall) is a case that would
// otherwise need a fixture daemon apiece, and the ones that matter most are exactly the ones
// hardest to reach through a real session.

import assert from "node:assert/strict";
import test from "node:test";

import type { FileCommentMessage, FileCommentReview, FileCommentThread, PendingTurn, Session } from "../src/shared/types.ts";
import {
  FILE_COMMENT_ADVANCE_SETTLE_MS,
  FileCommentWalkthrough,
  PAUSE_REASONS,
  nextMessage,
  progressOf,
  type FileCommentWalkthroughPort,
} from "../src/server/file-comment-walkthrough.ts";

const SESSION = "s1";
const REPLY_TOOL = "mcp__mission-control__respond_to_file_comments";

function message(over: Partial<FileCommentMessage> & { id: string }): FileCommentMessage {
  return {
    threadId: "t",
    author: "human",
    sessionId: SESSION,
    body: "say something",
    deliveredAt: null,
    readAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function thread(over: Partial<FileCommentThread> & { id: string }): FileCommentThread {
  const messages = over.messages ?? [message({ id: `${over.id}-m1`, threadId: over.id })];
  return {
    shortId: `MC-${over.id}`,
    sessionId: SESSION,
    path: "docs/spec.md",
    startLine: 3,
    endLine: 3,
    quote: "The retry budget is thirty seconds.",
    quoteHash: "hash",
    revision: "r1",
    surface: "editor",
    status: "queued",
    outdated: false,
    queueSeq: 0,
    deliveryId: null,
    sentAt: null,
    answeredAt: null,
    addressedAt: null,
    resolvedAt: null,
    createdAt: 1,
    updatedAt: 1,
    messageCount: messages.length,
    ...over,
    messages,
  };
}

const FILE = [
  "# The spec",
  "",
  "The retry budget is thirty seconds.",
  "",
  "The table below has no units column.",
].join("\n");

interface Harness {
  port: FileCommentWalkthroughPort;
  walkthrough: FileCommentWalkthrough;
  /** Every payload handed to the outbox, oldest first. */
  sent: string[];
  threads: Map<string, FileCommentThread>;
  review: FileCommentReview;
  now: { value: number };
  session: Session;
  turns: Map<string, PendingTurn>;
  files: Map<string, { text: string | null; revision: string }>;
  /** The tool this session can answer through, or null for one that has none. */
  replyTool: { value: string | null };
  /** Every prose turn this session has said, oldest first, with when it said it. */
  transcript: { text: string; at: number }[];
  /** Record an assistant turn as spoken NOW, which is what the fallback reads. */
  say(text: string): void;
  /** Play out the outbox: the row is retired and the confirmed-delivery signal fires. */
  deliver(): void;
}

function harness(rows: FileCommentThread[], over: Partial<Session> = {}): Harness {
  const now = { value: 1_000_000 };
  const threads = new Map(rows.map((row) => [row.id, row]));
  const turns = new Map<string, PendingTurn>();
  const files = new Map([["docs/spec.md", { text: FILE, revision: "r1" }]]);
  const sent: string[] = [];
  /**
   * What this session can answer through, mutable so a test can take the tool away.
   *
   * Null is the session an operator started without the integration, or one whose built
   * bundle does not publish the tool - the two cases the real port cannot tell apart and
   * deliberately renders the same way.
   */
  const replyTool: { value: string | null } = { value: REPLY_TOOL };
  /**
   * What this session has said in prose, oldest first, as the transcript recorded it.
   *
   * A LIST with timestamps rather than a lookup by handle, deliberately: the rule under test
   * is which turns fall inside the delivery being answered, and a fake that answered by handle
   * would decide that question itself and prove nothing about the machine.
   */
  const transcript: { text: string; at: number }[] = [];
  let turnSeq = 0;
  const session = {
    id: SESSION,
    runtime: "sdk",
    state: "idle",
    // Long enough ago that `settledIdle` is satisfied from the first tick unless a test
    // deliberately moves it.
    lastActivity: now.value - 10 * FILE_COMMENT_ADVANCE_SETTLE_MS,
    firstSeen: 0,
    terminals: [],
    pendingTurns: [],
    ...over,
  } as unknown as Session;
  const review: FileCommentReview = {
    sessionId: SESSION,
    state: "idle",
    pauseReason: null,
    startedAt: null,
    updatedAt: 0,
  };

  const patch = (id: string, over2: Partial<FileCommentThread>): FileCommentThread | null => {
    const current = threads.get(id);
    if (!current) return null;
    const next = { ...current, ...over2 };
    threads.set(id, next);
    return next;
  };

  const port: FileCommentWalkthroughPort = {
    now: () => now.value,
    replyTool: () => Promise.resolve(replyTool.value),
    session: () => session,
    review: () => review,
    setReviewState: (_id, state, pauseReason) => {
      review.state = state;
      review.pauseReason = pauseReason;
      if (state === "running" && review.startedAt === null) review.startedAt = now.value;
      review.updatedAt = now.value;
      return { ...review };
    },
    threads: () =>
      [...threads.values()].sort(
        (a, b) =>
          (a.queueSeq ?? Number.MAX_SAFE_INTEGER) - (b.queueSeq ?? Number.MAX_SAFE_INTEGER)
          || a.createdAt - b.createdAt,
      ),
    threadWithHistory: (id) => threads.get(id) ?? null,
    readFile: async (_id, path) => {
      const document = files.get(path);
      if (!document) throw new Error("file no longer exists");
      return document;
    },
    updateAnchor: (id, p) =>
      patch(id, {
        startLine: p.startLine ?? threads.get(id)?.startLine,
        endLine: p.endLine ?? threads.get(id)?.endLine,
        revision: p.revision === undefined ? threads.get(id)?.revision ?? null : p.revision,
        outdated: p.outdated,
      }),
    beginDelivery: (id, deliveryId) =>
      patch(id, {
        status: "sending",
        deliveryId,
        sentAt: threads.get(id)?.sentAt ?? now.value,
      }),
    markDelivered: (messageId) => {
      const owner = [...threads.values()].find((t) =>
        t.messages.some((m) => m.id === messageId));
      if (!owner) return null;
      return patch(owner.id, {
        status: owner.status === "sending" ? "awaiting" : owner.status,
        messages: owner.messages.map((m) =>
          m.id === messageId ? { ...m, deliveredAt: now.value } : m),
      });
    },
    markUnanswered: (id) => patch(id, { status: "unanswered", queueSeq: null }),
    returnToQueue: (id) =>
      threads.get(id)?.status === "sending"
        ? patch(id, { status: "queued", deliveryId: null })
        : null,
    requeueAtTail: (id) => {
      const tail = Math.max(-1, ...[...threads.values()].map((t) => t.queueSeq ?? -1)) + 1;
      return patch(id, { status: "queued", queueSeq: tail });
    },
    submit: (_id, text) => {
      turnSeq += 1;
      const id = `turn-${turnSeq}`;
      const turn = { id, state: "queued" } as unknown as PendingTurn;
      turns.set(id, turn);
      session.pendingTurns = [...turns.values()];
      sent.push(text);
      return { ok: true, turnId: id, error: null };
    },
    pendingTurn: (_id, turnId) => turns.get(turnId) ?? null,
    agentTurnsSince: (_id, since) =>
      transcript
        .filter((turn) => turn.at !== 0 && turn.at >= since)
        .map((turn) => turn.text)
        .reverse(),
    appendAgentReply: (id, body) => {
      const current = threads.get(id);
      if (!current) return null;
      return patch(id, {
        messages: [
          ...current.messages,
          message({ id: `${id}-fallback-${current.messages.length}`, threadId: id, author: "agent", body }),
        ],
      });
    },
  };

  const walkthrough = new FileCommentWalkthrough(port);
  return {
    port,
    walkthrough,
    sent,
    threads,
    review,
    now,
    session,
    turns,
    files,
    replyTool,
    transcript,
    say: (text: string) => transcript.push({ text, at: now.value }),
    deliver: () => {
      const out = [...threads.values()].find((t) => t.status === "sending");
      if (!out?.deliveryId) throw new Error("nothing is out with the agent");
      const turnId = out.deliveryId;
      // The two sites that retire a claimed row delete it and raise the signal with no await
      // in between - so this fake does the same, in that order.
      turns.delete(turnId);
      session.pendingTurns = [...turns.values()];
      walkthrough.onTurnDelivered(SESSION, turnId);
    },
  };
}

/** Let the machine's internal `void this.tick(...)` chains settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

test("nextMessage picks the oldest UNDELIVERED human message, with its ordinal", () => {
  const t = thread({
    id: "t1",
    messages: [
      message({ id: "m1", body: "the opening comment", deliveredAt: 5 }),
      message({ id: "m2", author: "agent", body: "an answer" }),
      message({ id: "m3", body: "the follow-up" }),
    ],
  });
  // Not "the thread's comment": that is only well defined on a thread's first turn, and
  // resending the opening comment is the failure this phase says is easiest to ship.
  assert.deepEqual(nextMessage(t)?.message.id, "m3");
  // The ordinal counts HUMAN messages only, so the agent's reply does not shift it.
  assert.equal(nextMessage(t)?.ordinal, 2);
  assert.equal(nextMessage(thread({ id: "t2", messages: [message({ id: "m", deliveredAt: 1 })] })), null);
});

test("progressOf never counts a queued thread as one already sent", () => {
  // `sent_at` records a thread's FIRST send and is not rewritten, so a thread that timed out
  // and was replied to still carries one. Counting it in both halves would push the position
  // line one past the truth on every requeued follow-up.
  const at = 100;
  const p = progressOf(
    [
      thread({ id: "a", status: "unanswered", queueSeq: null, sentAt: at + 1 }),
      thread({ id: "b", status: "queued", queueSeq: 1, sentAt: at + 2 }),
      thread({ id: "c", status: "queued", queueSeq: 2 }),
      // From an earlier review of this session, so it is not part of "of 12".
      thread({ id: "d", status: "unanswered", queueSeq: null, sentAt: at - 50 }),
    ],
    at,
  );
  assert.deepEqual({ sent: p.sent, queued: p.queued }, { sent: 1, queued: 2 });
});

test("Start review sends exactly one comment, and the next only after the first resolves", async () => {
  const h = harness([
    thread({ id: "a", queueSeq: 0 }),
    thread({ id: "b", queueSeq: 1, startLine: 5, quote: "The table below has no units column." }),
  ]);
  h.walkthrough.start(SESSION);
  await settle();

  assert.equal(h.sent.length, 1, "exactly one turn is outstanding");
  assert.match(h.sent[0]!, /^Comment 1 of 2 on this review\./);
  assert.equal(h.threads.get("a")!.status, "sending");
  assert.equal(h.threads.get("b")!.status, "queued");

  // A tick while it is still in flight must not release the second.
  await h.walkthrough.tick(SESSION);
  assert.equal(h.sent.length, 1);

  // Confirmed delivery stamps the message and moves it out of `sending`, but `awaiting` is
  // still outstanding - the longer half of the window - so nothing is released yet.
  h.deliver();
  await settle();
  assert.equal(h.threads.get("a")!.status, "awaiting");
  assert.equal(h.threads.get("a")!.messages[0]!.deliveredAt, h.now.value);
  assert.equal(h.sent.length, 1, "awaiting is outstanding too");

  // The grace window is measured from CONFIRMED delivery as well as from idleness.
  h.now.value += FILE_COMMENT_ADVANCE_SETTLE_MS - 1;
  await h.walkthrough.tick(SESSION);
  assert.equal(h.sent.length, 1);

  h.now.value += 2;
  await h.walkthrough.tick(SESSION);
  await settle();
  assert.equal(h.threads.get("a")!.status, "unanswered");
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1]!, /^Comment 2 of 2 on this review\./);
  assert.match(h.sent[1]!, /it is the last of this review/);
});

test("a busy session holds the queue rather than advancing past a live agent", async () => {
  const h = harness([thread({ id: "a" }), thread({ id: "b", queueSeq: 1 })]);
  h.walkthrough.start(SESSION);
  await settle();
  h.deliver();
  await settle();

  // The agent is working, so it is neither idle nor settled. The comment is not lost; the
  // walkthrough simply waits.
  h.session.state = "working" as Session["state"];
  h.now.value += FILE_COMMENT_ADVANCE_SETTLE_MS * 5;
  await h.walkthrough.tick(SESSION);
  assert.equal(h.sent.length, 1);
  assert.equal(h.threads.get("a")!.status, "awaiting");
  assert.equal(h.review.state, "running", "waiting is not pausing");
});

test("an outdated head is HELD and the pause says the agent's edit removed the text", async () => {
  const h = harness([
    thread({ id: "a", quote: "a sentence that is no longer anywhere", revision: "old" }),
    thread({ id: "b", queueSeq: 1 }),
  ]);
  h.walkthrough.start(SESSION);
  await settle();

  assert.equal(h.sent.length, 0, "a comment quoting deleted text is not delivered");
  assert.equal(h.threads.get("a")!.status, "queued");
  assert.equal(h.threads.get("a")!.outdated, true, "the outcome was PERSISTED, not just computed");
  assert.equal(h.review.state, "paused");
  assert.equal(h.review.pauseReason, PAUSE_REASONS.outdated("docs/spec.md", "MC-a"));
});

test("a comment further down goes outdated in place and the head still goes", async () => {
  const h = harness([
    thread({ id: "a", queueSeq: 0 }),
    thread({ id: "b", queueSeq: 1, quote: "gone from this file entirely", revision: "old" }),
  ]);
  h.walkthrough.start(SESSION);
  await settle();
  assert.equal(h.sent.length, 1);
  assert.equal(h.threads.get("b")!.outdated, true);
  assert.equal(h.threads.get("b")!.status, "queued", "outdated is a flag beside the status");
  assert.equal(h.review.state, "running");
});

test("a moved anchor is persisted, so the revision short-circuit can actually fire", async () => {
  const h = harness([thread({ id: "a", startLine: 1, revision: "old" })]);
  h.walkthrough.start(SESSION);
  await settle();
  const moved = h.threads.get("a")!;
  assert.equal(moved.startLine, 3, "the quote was found at its new line");
  assert.equal(moved.revision, "r1", "and the revision advanced with it");
  assert.equal(moved.outdated, false);
  // The payload carries the CURRENT line, not the one the comment was written against.
  assert.match(h.sent[0]!, /^docs\/spec\.md, line 3:$/m);
});

test("a file that has left the checkout pauses with its own reason", async () => {
  const h = harness([thread({ id: "a", path: "docs/gone.md" })]);
  h.walkthrough.start(SESSION);
  await settle();
  assert.equal(h.sent.length, 0);
  assert.equal(h.review.pauseReason, PAUSE_REASONS.missingFile("docs/gone.md"));
  // Distinct from a quote that moved: there were no bytes to search at all.
  assert.notEqual(h.review.pauseReason, PAUSE_REASONS.outdated("docs/gone.md", "MC-a"));
});

test("a session that cannot take a message is a pause with a reason, not a lost comment", async () => {
  // A terminal session with no handle at all: `canWriteTo` is false and `runtime !== "sdk"`,
  // which is what `messageBlockReason` calls "no-pane".
  const h = harness([thread({ id: "a" })], { runtime: "terminal" } as Partial<Session>);
  h.walkthrough.start(SESSION);
  await settle();
  assert.equal(h.sent.length, 0);
  assert.equal(h.review.state, "paused");
  assert.equal(h.review.pauseReason, PAUSE_REASONS.noPane);
  assert.equal(h.threads.get("a")!.status, "queued", "the comment is still there to send later");
});

test("a queue with nothing left to send pauses and says so", async () => {
  const h = harness([thread({ id: "a" })]);
  h.walkthrough.start(SESSION);
  await settle();
  h.deliver();
  await settle();
  h.now.value += FILE_COMMENT_ADVANCE_SETTLE_MS + 1;
  await h.walkthrough.tick(SESSION);
  await settle();
  assert.equal(h.review.state, "paused");
  assert.equal(h.review.pauseReason, PAUSE_REASONS.drained);
});

test("pause takes effect after the outstanding comment resolves, and never recalls it", async () => {
  const h = harness([thread({ id: "a" }), thread({ id: "b", queueSeq: 1 })]);
  h.walkthrough.start(SESSION);
  await settle();
  h.deliver();
  await settle();

  h.walkthrough.pause(SESSION);
  assert.equal(h.threads.get("a")!.status, "awaiting", "delivered bytes are not withdrawn");
  h.now.value += FILE_COMMENT_ADVANCE_SETTLE_MS + 1;
  await h.walkthrough.tick(SESSION);
  assert.equal(h.sent.length, 1, "a paused review releases nothing");

  // And resuming continues from where it stopped rather than restarting the numbering.
  const startedAt = h.review.startedAt;
  h.walkthrough.start(SESSION);
  await settle();
  assert.equal(h.review.startedAt, startedAt);
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1]!, /^Comment 2 of 2 on this review\./);
});

test("an uncertain delivery pauses the review and never stamps the message", async () => {
  const h = harness([thread({ id: "a" }), thread({ id: "b", queueSeq: 1 })]);
  h.walkthrough.start(SESSION);
  await settle();
  const turnId = h.threads.get("a")!.deliveryId!;
  h.turns.set(turnId, { ...h.turns.get(turnId)!, state: "uncertain" });

  await h.walkthrough.tick(SESSION);
  assert.equal(h.review.state, "paused");
  assert.equal(h.review.pauseReason, PAUSE_REASONS.uncertain("MC-a"));
  assert.equal(h.threads.get("a")!.status, "sending");
  assert.equal(h.threads.get("a")!.messages[0]!.deliveredAt, null, "uncertain never stamps");
  assert.equal(h.sent.length, 1);
});

test("Mark sent stamps the message, resumes the review, and the NEXT comment goes", async () => {
  // The failure this covers is a deadlock, not a wrong value: without the correlated write the
  // thread stays `sending` - outstanding, indexed - and blocks every later delivery. So the
  // assertion is about comment two, not about comment one's timestamp.
  const h = harness([thread({ id: "a" }), thread({ id: "b", queueSeq: 1 })]);
  h.walkthrough.start(SESSION);
  await settle();
  const turnId = h.threads.get("a")!.deliveryId!;
  h.turns.set(turnId, { ...h.turns.get(turnId)!, state: "uncertain" });
  await h.walkthrough.tick(SESSION);
  assert.equal(h.review.state, "paused");

  // "Mark sent" deletes the row, then the route calls this.
  h.turns.delete(turnId);
  h.session.pendingTurns = [...h.turns.values()];
  h.walkthrough.onTurnMarkedSent(SESSION, turnId);
  await settle();

  assert.equal(h.threads.get("a")!.status, "awaiting");
  assert.equal(h.threads.get("a")!.messages[0]!.deliveredAt, h.now.value);
  assert.equal(h.review.state, "running");

  // The grace window runs from HERE, not from the original send: the agent has not been
  // sitting on this comment, so it has not been ignoring it either.
  h.now.value += FILE_COMMENT_ADVANCE_SETTLE_MS + 1;
  await h.walkthrough.tick(SESSION);
  await settle();
  assert.equal(h.sent.length, 2, "the queue is not deadlocked behind a resolved turn");
});

test("Retry leaves delivered_at NULL, keeps the correlation, and resends the SAME message", async () => {
  const h = harness([thread({ id: "a" }), thread({ id: "b", queueSeq: 1 })]);
  h.walkthrough.start(SESSION);
  await settle();
  const turnId = h.threads.get("a")!.deliveryId!;
  h.turns.set(turnId, { ...h.turns.get(turnId)!, state: "uncertain" });
  await h.walkthrough.tick(SESSION);
  assert.equal(h.review.state, "paused");

  // `retryPendingTurn` moves the EXISTING row uncertain -> queued and leaves its id alone, so
  // the thread's `delivery_id` still names the row about to go out. No re-point is needed and
  // none is made - that is this phase's one deviation from its plan, and it is pinned here.
  h.turns.set(turnId, { ...h.turns.get(turnId)!, state: "queued" });
  h.session.pendingTurns = [...h.turns.values()];
  h.walkthrough.onTurnRetried(SESSION, turnId);
  await settle();

  assert.equal(h.review.state, "running");
  assert.equal(h.threads.get("a")!.status, "sending", "it never left the outstanding set");
  assert.equal(h.threads.get("a")!.deliveryId, turnId, "still correlated to the live row");
  assert.equal(h.threads.get("a")!.messages[0]!.deliveredAt, null);
  assert.equal(h.sent.length, 1, "nothing new was submitted");

  // And when that row is finally delivered, it is comment one that lands - not comment two.
  h.deliver();
  await settle();
  assert.equal(h.threads.get("a")!.status, "awaiting");
  assert.equal(h.threads.get("b")!.status, "queued");
});

test("a recalled turn puts its comment back, editable, in the place it held", async () => {
  const h = harness([thread({ id: "a" }), thread({ id: "b", queueSeq: 1 })]);
  h.walkthrough.start(SESSION);
  await settle();
  const turnId = h.threads.get("a")!.deliveryId!;

  // Recall removes the row WITHOUT raising the confirmed-delivery signal, which is exactly
  // why delivery is keyed off the signal and never off the row's absence.
  h.turns.delete(turnId);
  h.session.pendingTurns = [];
  await h.walkthrough.tick(SESSION);
  await settle();

  const back = h.threads.get("a")!;
  assert.equal(back.messages[0]!.deliveredAt, null, "the recall never stamped it delivered");
  assert.equal(back.queueSeq, 0, "and it did not lose its place in the review");
  // It went back to the head of the queue, so the same pass sent IT again rather than moving
  // on to comment two - and it is correlated to the NEW row, not the recalled one.
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1], h.sent[0], "the same comment, not the next one");
  assert.equal(back.status, "sending");
  assert.notEqual(back.deliveryId, turnId, "re-correlated to the row that is actually live");
  assert.equal(h.threads.get("b")!.status, "queued");
});

test("a thread answered and then replied to delivers the REPLY, not the opening comment", async () => {
  const h = harness([thread({ id: "a" })]);
  h.walkthrough.start(SESSION);
  await settle();
  h.deliver();
  await settle();
  h.now.value += FILE_COMMENT_ADVANCE_SETTLE_MS + 1;
  await h.walkthrough.tick(SESSION);
  await settle();
  assert.equal(h.threads.get("a")!.status, "unanswered");
  assert.match(h.sent[0]!, /^say something$/m);

  // A person replies to the thread. `FileCommentManager.appendMessage` requeues it - which is
  // simulated here, because this file is about what the MACHINE does with the requeued thread.
  const settled = h.threads.get("a")!;
  h.threads.set("a", {
    ...settled,
    status: "queued",
    queueSeq: 1,
    messages: [...settled.messages, message({ id: "m2", threadId: "a", body: "still not right" })],
    messageCount: 2,
  });
  h.walkthrough.start(SESSION);
  await settle();

  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1]!, /^still not right$/m, "the reply, not the opening comment");
  // The ordinal moved with it, which is what makes a reply answer a TURN rather than a thread.
  assert.match(h.sent[1]!, /quoting id MC-a\.2\./);
  assert.doesNotMatch(h.sent[1]!, /quoting id MC-a\.1\./);
});

test("a reply written while the comment was in flight requeues when the turn resolves", async () => {
  // Appending to the outstanding thread is always allowed, but its STATUS must not move: it is
  // the status the single-flight index is built on, and requeueing there would let the next
  // comment be released on top of a live turn. So the message waits, and this is the pickup.
  const h = harness([thread({ id: "a" })]);
  h.walkthrough.start(SESSION);
  await settle();
  h.deliver();
  await settle();

  const out = h.threads.get("a")!;
  assert.equal(out.status, "awaiting");
  h.threads.set("a", {
    ...out,
    messages: [...out.messages, message({ id: "m2", threadId: "a", body: "and another thing" })],
    messageCount: 2,
  });

  h.now.value += FILE_COMMENT_ADVANCE_SETTLE_MS + 1;
  await h.walkthrough.tick(SESSION);
  await settle();

  // It left `awaiting` - so the single-flight index is free - went back to the TAIL, and the
  // same pass then sent it again, because it was the only comment in the queue. What matters
  // is WHICH message that second turn carries.
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1]!, /^and another thing$/m);
  assert.doesNotMatch(h.sent[1]!, /^say something$/m);
  assert.match(h.sent[1]!, /quoting id MC-a\.2\./);
  assert.equal(h.threads.get("a")!.status, "sending");
});

test("a restart resumes the walkthrough without re-sending the outstanding comment", async () => {
  const h = harness([thread({ id: "a" }), thread({ id: "b", queueSeq: 1 })]);
  h.walkthrough.start(SESSION);
  await settle();
  h.deliver();
  await settle();
  assert.equal(h.threads.get("a")!.status, "awaiting");

  // The daemon goes down and comes back: a NEW machine over the SAME durable state, which is
  // the whole reason the progress lives on the rows and the run state lives in a table.
  const restarted = new FileCommentWalkthrough(h.port);
  restarted.resume([SESSION]);
  await settle();

  assert.equal(h.sent.length, 1, "the outstanding comment is not sent twice");
  assert.equal(h.threads.get("a")!.status, "awaiting");
  assert.equal(h.review.state, "running");

  // And it carries on from there rather than starting again.
  h.now.value += FILE_COMMENT_ADVANCE_SETTLE_MS + 1;
  await restarted.tick(SESSION);
  await settle();
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1]!, /^Comment 2 of 2 on this review\./);
  restarted.stop();
});

test("a restart mid-DELIVERY surfaces as a pause awaiting one human confirmation", async () => {
  // `recoverSendingPendingTurns` flips every in-flight row `uncertain` at startup, so this
  // case needs no design of its own: it lands on the existing pause-and-confirm path. Stamping
  // at submit would instead have recorded it delivered, and the comment would sit answered
  // for ever having never reached the agent.
  const h = harness([thread({ id: "a" })]);
  h.walkthrough.start(SESSION);
  await settle();
  const turnId = h.threads.get("a")!.deliveryId!;
  h.turns.set(turnId, { ...h.turns.get(turnId)!, state: "uncertain" });

  const restarted = new FileCommentWalkthrough(h.port);
  restarted.resume([SESSION]);
  await settle();

  assert.equal(h.review.state, "paused");
  assert.equal(h.review.pauseReason, PAUSE_REASONS.uncertain("MC-a"));
  assert.equal(h.threads.get("a")!.messages[0]!.deliveredAt, null);
  restarted.stop();
});

test("a review the store does not call running is not resumed", async () => {
  const h = harness([thread({ id: "a" })]);
  const restarted = new FileCommentWalkthrough(h.port);
  restarted.resume([SESSION]);
  await settle();
  assert.equal(h.sent.length, 0);
  restarted.stop();
});

test("a manual pause survives an unrelated turn being marked sent or retried", async () => {
  // The outbox is SHARED, and both recovery routes fire for every row a session resolves or
  // retries. Without the two checks in `resumeIfPausedFor`, clearing an ordinary conversation
  // turn by hand restarted a review the person had deliberately stopped - and the next comment
  // went out against their instruction.
  const h = harness([thread({ id: "a" }), thread({ id: "b", queueSeq: 1 })]);
  h.walkthrough.start(SESSION);
  await settle();
  h.deliver();
  await settle();
  h.walkthrough.pause(SESSION);
  await settle();
  assert.equal(h.review.state, "paused");

  // An unrelated human turn, uncertain, resolved from the conversation.
  const foreign = { id: "foreign-1", state: "uncertain" } as unknown as PendingTurn;
  h.turns.set(foreign.id, foreign);
  h.session.pendingTurns = [...h.turns.values()];
  h.walkthrough.onTurnMarkedSent(SESSION, foreign.id);
  h.walkthrough.onTurnRetried(SESSION, foreign.id);
  await settle();

  assert.equal(h.review.state, "paused", "somebody else's turn does not resume this review");
  assert.equal(h.sent.length, 1, "and no further comment was released");
});

test("a pause held for an uncertain delivery is not lifted by a DIFFERENT turn", async () => {
  const h = harness([thread({ id: "a" }), thread({ id: "b", queueSeq: 1 })]);
  h.walkthrough.start(SESSION);
  await settle();
  const turnId = h.threads.get("a")!.deliveryId!;
  h.turns.set(turnId, { ...h.turns.get(turnId)!, state: "uncertain" });
  await h.walkthrough.tick(SESSION);
  assert.equal(h.review.pauseReason, PAUSE_REASONS.uncertain("MC-a"));

  // Every state transition from here on, so "still paused" cannot be satisfied by a review
  // that resumed, released nothing because the same row was still uncertain, and stopped again.
  const transitions: string[] = [];
  const setReviewState = h.port.setReviewState;
  h.port.setReviewState = (id, state, reason) => {
    transitions.push(state);
    return setReviewState(id, state, reason);
  };

  const foreign = { id: "foreign-1", state: "uncertain" } as unknown as PendingTurn;
  h.turns.set(foreign.id, foreign);
  h.session.pendingTurns = [...h.turns.values()];
  h.walkthrough.onTurnMarkedSent(SESSION, foreign.id);
  await settle();

  assert.deepEqual(transitions, [], "an unrelated turn moves this review not at all");
  // The comment Mission Control could not confirm is still unconfirmed, so the review is still
  // stopped and the message is still unstamped.
  assert.equal(h.review.state, "paused");
  assert.equal(h.threads.get("a")!.status, "sending");
  assert.equal(h.threads.get("a")!.messages[0]!.deliveredAt, null);
  assert.equal(h.sent.length, 1);
});

test("pause still settles the comment already out with the agent", async () => {
  // "Pause takes effect after the outstanding comment resolves" is a promise about that
  // comment too, not only about the ones behind it. Freezing it in `awaiting` left a paused
  // queue presenting a comment as still in flight long after the agent had finished with it.
  const h = harness([thread({ id: "a" }), thread({ id: "b", queueSeq: 1 })]);
  h.walkthrough.start(SESSION);
  await settle();
  h.deliver();
  await settle();
  assert.equal(h.threads.get("a")!.status, "awaiting");

  h.walkthrough.pause(SESSION);
  await settle();
  assert.equal(h.threads.get("a")!.status, "awaiting", "delivered bytes are not withdrawn");

  h.now.value += FILE_COMMENT_ADVANCE_SETTLE_MS + 1;
  await h.walkthrough.tick(SESSION);
  await settle();

  assert.equal(h.threads.get("a")!.status, "unanswered", "it resolved on the ordinary signal");
  assert.equal(h.review.state, "paused", "and the pause is untouched by that");
  assert.equal(h.sent.length, 1, "a paused review still releases nothing");
});

test("no comment is released while ANY turn sits in the shared outbox", async () => {
  // Exactly one turn outstanding is a claim about `pending_turns`, not about this review's own
  // comments. A person can type into the conversation mid-review; releasing the next comment on
  // top of that row would make the outbox two deep, which is the one depth where recall reaching
  // only the tail, an `uncertain` row wedging the queue, and the missing correlation id all
  // start to matter.
  const h = harness([thread({ id: "a" }), thread({ id: "b", queueSeq: 1 })]);
  h.walkthrough.start(SESSION);
  await settle();
  h.deliver();
  await settle();

  // A turn the person wrote themselves, still queued behind nothing in particular.
  const mine = { id: "mine-1", state: "queued" } as unknown as PendingTurn;
  h.turns.set(mine.id, mine);
  h.session.pendingTurns = [...h.turns.values()];

  h.now.value += FILE_COMMENT_ADVANCE_SETTLE_MS + 1;
  await h.walkthrough.tick(SESSION);
  await settle();
  assert.equal(h.threads.get("a")!.status, "unanswered", "comment one still resolved");
  assert.equal(h.sent.length, 1, "but comment two did not join it in the outbox");
  assert.equal(h.review.state, "running", "and this is a wait, not a pause - it clears itself");

  // It drains, and the very next tick releases the comment. No person had to intervene.
  h.turns.delete(mine.id);
  h.session.pendingTurns = [...h.turns.values()];
  await h.walkthrough.tick(SESSION);
  await settle();
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1]!, /^Comment 2 of 2 on this review\./);
});

test("an unconfirmed turn belonging to somebody else pauses with a reason, not silently", async () => {
  // The one outbox row that never clears on its own: `uncertain` is a question waiting for a
  // person, and it wedges everything behind it. Waiting on it the way this waits on a queued
  // row would leave the review reading "running" for ever with nothing on screen to say why.
  const h = harness([thread({ id: "a" }), thread({ id: "b", queueSeq: 1 })]);
  h.walkthrough.start(SESSION);
  await settle();
  h.deliver();
  await settle();

  h.turns.set("mine-1", { id: "mine-1", state: "uncertain" } as unknown as PendingTurn);
  h.session.pendingTurns = [...h.turns.values()];
  h.now.value += FILE_COMMENT_ADVANCE_SETTLE_MS + 1;
  await h.walkthrough.tick(SESSION);
  await settle();

  assert.equal(h.review.state, "paused");
  assert.equal(h.review.pauseReason, PAUSE_REASONS.outboxBlocked);
  assert.equal(h.sent.length, 1);
});

test("a reorder made while the files are being read still decides which comment goes", async () => {
  // The queue is editable THROUGHOUT, and re-anchoring is the one genuine await in the pass -
  // it reads files. Deciding the head before that await and re-reading it by id afterwards
  // found the old head still queued and sent it, quietly overriding a reorder the person made
  // while the reads were in flight.
  const h = harness([
    thread({ id: "a", queueSeq: 0 }),
    thread({ id: "b", queueSeq: 1, startLine: 5, quote: "The table below has no units column." }),
  ]);
  const readFile = h.port.readFile;
  let reordered = false;
  h.port.readFile = async (id, path) => {
    const document = await readFile(id, path);
    if (!reordered) {
      reordered = true;
      // The person drags comment b to the front, mid-read.
      h.threads.set("a", { ...h.threads.get("a")!, queueSeq: 1 });
      h.threads.set("b", { ...h.threads.get("b")!, queueSeq: 0 });
    }
    return document;
  };

  h.walkthrough.start(SESSION);
  await settle();

  assert.equal(h.sent.length, 1, "still exactly one turn");
  assert.match(h.sent[0]!, /The table below has no units column\./, "the NEW head is what went");
  assert.equal(h.threads.get("b")!.status, "sending");
  assert.equal(h.threads.get("a")!.status, "queued", "and the old head kept its place in line");
});

test("a comment that joins the queue mid-read waits for its own re-anchor pass", async () => {
  // The other half of deciding the head after the await: a thread that was not in the snapshot
  // was never re-anchored, so its `outdated` flag is stale. It is not sent on that and not held
  // on it either - it simply waits for the next tick, which re-anchors it like any other.
  const h = harness([thread({ id: "a", queueSeq: 5 })]);
  const readFile = h.port.readFile;
  let joined = false;
  h.port.readFile = async (id, path) => {
    const document = await readFile(id, path);
    if (!joined) {
      joined = true;
      h.threads.set(
        "late",
        thread({ id: "late", queueSeq: 0, startLine: 5, quote: "The table below has no units column." }),
      );
    }
    return document;
  };

  h.walkthrough.start(SESSION);
  await settle();
  assert.equal(h.sent.length, 0, "nothing goes on an anchor this pass never checked");
  assert.equal(h.review.state, "running", "and it is a wait, not a pause");

  // The next tick has it in the snapshot, so it is re-anchored and then sent.
  await h.walkthrough.tick(SESSION);
  await settle();
  assert.equal(h.sent.length, 1);
  assert.equal(h.threads.get("late")!.status, "sending");
});

test("Pause pressed while the files are being read still stops the send", async () => {
  // `reanchorQueue` reads files, and the review is live throughout. A pass that snapshotted
  // "running" before the await and never re-asked would deliver a comment after the person had
  // already pressed Pause - the one thing Pause is for.
  const h = harness([thread({ id: "a" }), thread({ id: "b", queueSeq: 1 })]);
  const readFile = h.port.readFile;
  let paused = false;
  h.port.readFile = async (id, path) => {
    const document = await readFile(id, path);
    if (!paused) {
      paused = true;
      h.walkthrough.pause(SESSION);
    }
    return document;
  };

  h.walkthrough.start(SESSION);
  await settle();

  assert.equal(h.review.state, "paused");
  assert.equal(h.sent.length, 0, "nothing was released after the pause");
  assert.equal(h.threads.get("a")!.status, "queued", "and the head kept its place");
});

test("a conversation turn typed while the files are being read keeps the outbox at one", async () => {
  // The outbox is shared and the conversation is live during the read. Asking whether it was
  // empty BEFORE the await and sending on that answer afterwards is exactly how a comment ends
  // up as a second row beside a message the person just typed.
  const h = harness([thread({ id: "a" }), thread({ id: "b", queueSeq: 1 })]);
  const readFile = h.port.readFile;
  let typed = false;
  h.port.readFile = async (id, path) => {
    const document = await readFile(id, path);
    if (!typed) {
      typed = true;
      h.turns.set("mine-1", { id: "mine-1", state: "queued" } as unknown as PendingTurn);
      h.session.pendingTurns = [...h.turns.values()];
    }
    return document;
  };

  h.walkthrough.start(SESSION);
  await settle();

  assert.equal(h.sent.length, 0, "the comment did not join the person's own turn");
  assert.equal(h.review.state, "running", "and it is a wait, not a pause - the row drains");

  // It drains, and the next tick releases the comment with the outbox back to empty.
  h.turns.delete("mine-1");
  h.session.pendingTurns = [...h.turns.values()];
  await h.walkthrough.tick(SESSION);
  await settle();
  assert.equal(h.sent.length, 1);
});

test("an unconfirmed turn appearing during the read pauses instead of sending past it", async () => {
  const h = harness([thread({ id: "a" }), thread({ id: "b", queueSeq: 1 })]);
  const readFile = h.port.readFile;
  let appeared = false;
  h.port.readFile = async (id, path) => {
    const document = await readFile(id, path);
    if (!appeared) {
      appeared = true;
      h.turns.set("mine-1", { id: "mine-1", state: "uncertain" } as unknown as PendingTurn);
      h.session.pendingTurns = [...h.turns.values()];
    }
    return document;
  };

  h.walkthrough.start(SESSION);
  await settle();

  assert.equal(h.sent.length, 0);
  assert.equal(h.review.state, "paused");
  assert.equal(h.review.pauseReason, PAUSE_REASONS.outboxBlocked);
});

test("the payload names the reply tool, so the closing instruction can be honoured", () => {
  const h = harness([thread({ id: "a" })]);
  h.walkthrough.start(SESSION);
  return settle().then(() => {
    // An instruction the loop cannot honour is one it follows into silence, so the name here
    // has to be the fully-qualified one a launch actually registers.
    assert.match(h.sent[0]!, new RegExp(`^Answer with ${REPLY_TOOL} quoting id MC-a\\.1\\.$`, "m"));
  });
});

test("a session that cannot call the tool is asked for the id back instead of for a tool call", async () => {
  // The tool is not universally reachable: it reaches sessions the dashboard launched, and
  // sessions on a machine where the integration is installed. A session without it must not be
  // told to call one - an instruction the loop cannot honour is one it follows into silence -
  // so the payload falls back to citing the id, which is exactly what the transcript fallback
  // reads back out of the conversation.
  const h = harness([thread({ id: "a" })]);
  h.replyTool.value = null;
  h.walkthrough.start(SESSION);
  await settle();

  assert.match(h.sent[0]!, /^Answer in your next turn, quoting id MC-a\.1\.$/m);
  assert.doesNotMatch(h.sent[0]!, /respond_to_file_comments/);
  // The handle is cited either way. It is the only thing that makes a tool-less session
  // answerable at all, so it is the one part of that line that never changes.
  assert.match(h.sent[0]!, /MC-a\.1/);
});

test("a reply releases the next comment IMMEDIATELY, without waiting out the grace window", async () => {
  const h = harness([thread({ id: "a" }), thread({ id: "b", queueSeq: 1 })]);
  h.walkthrough.start(SESSION);
  await settle();
  h.deliver();
  await settle();
  assert.equal(h.threads.get("a")!.status, "awaiting");
  assert.equal(h.sent.length, 1, "and the second comment is still waiting its turn");

  // The route has already released the turn durably - that transaction is
  // `recordAgentFileCommentReply`'s and is pinned in `file-comments-http.test.ts`. What this
  // signal does is make the queue move NOW rather than within the second.
  h.threads.set("a", { ...h.threads.get("a")!, status: "answered", queueSeq: null, deliveryId: null });
  h.walkthrough.onCommentAnswered(SESSION);
  await settle();

  assert.equal(h.sent.length, 2, "the next comment went on the reply, not on the timeout");
  assert.equal(h.threads.get("b")!.status, "sending");
  // The clock never moved: this is the whole point of the phase. The queue stops advancing on
  // an inference about idleness and starts advancing on a real completion.
  assert.ok(h.now.value < 1_000_000 + FILE_COMMENT_ADVANCE_SETTLE_MS);
});

test("a reply signal for a review nobody started releases nothing", async () => {
  const h = harness([thread({ id: "a" }), thread({ id: "b", queueSeq: 1 })]);
  h.walkthrough.onCommentAnswered(SESSION);
  await settle();
  assert.equal(h.sent.length, 0);
  assert.equal(h.review.state, "idle");
});

test("a session with no reply tool has its answer recovered from the conversation", async () => {
  // The fallback, and the ONE thing it must not do. A session an operator started without the
  // integration has no tool at all, so free text is the only thing that works everywhere - but
  // it recovers the handle and not reliably the ordinal, so it can confirm no delivery.
  const h = harness([thread({ id: "a" }), thread({ id: "b", queueSeq: 1 })]);
  h.replyTool.value = null;
  h.walkthrough.start(SESSION);
  await settle();
  h.deliver();
  await settle();
  h.now.value += 1_000;
  h.say("MC-a.1 - fixed, the table was right.");

  h.now.value += FILE_COMMENT_ADVANCE_SETTLE_MS + 1;
  await h.walkthrough.tick(SESSION);
  await settle();

  const answered = h.threads.get("a")!;
  assert.deepEqual(
    answered.messages.map((m) => [m.author, m.body]),
    [["human", "say something"], ["agent", "MC-a.1 - fixed, the table was right."]],
  );
  // Filed on the thread, and the TIME-based signal is still what advanced the queue: the
  // status is the timeout's, not a release. Phase 3's floor carries these sessions.
  assert.equal(answered.status, "unanswered");
  assert.equal(h.sent.length, 2, "and the review kept moving on its own signal");
});

test("the fallback does not re-file the turn an earlier timeout already recovered", async () => {
  const h = harness([thread({ id: "a" })]);
  h.replyTool.value = null;
  h.walkthrough.start(SESSION);
  await settle();
  h.deliver();
  await settle();
  h.now.value += 1_000;
  h.say("MC-a - I looked at this.");
  h.now.value += FILE_COMMENT_ADVANCE_SETTLE_MS + 1;
  await h.walkthrough.tick(SESSION);
  await settle();
  assert.equal(h.threads.get("a")!.messages.filter((m) => m.author === "agent").length, 1);

  // A person follows up, it goes round again, and it times out again - reading a tail window
  // that still contains the turn the first timeout already filed. Only that turn's TIMESTAMP
  // says it belongs to the earlier delivery, which is what the window is for.
  const again = h.threads.get("a")!;
  h.threads.set("a", {
    ...again,
    status: "queued",
    queueSeq: 1,
    messages: [...again.messages, message({ id: "m2", threadId: "a", body: "and this?" })],
  });
  h.walkthrough.start(SESSION);
  await settle();
  h.deliver();
  await settle();
  h.now.value += FILE_COMMENT_ADVANCE_SETTLE_MS + 1;
  await h.walkthrough.tick(SESSION);
  await settle();

  assert.equal(
    h.threads.get("a")!.messages.filter((m) => m.author === "agent").length,
    1,
    "the same turn is not recorded twice",
  );
});

test("two distinct fallback answers are both kept, even worded identically", async () => {
  // The failure the text-equality guard this replaced would have caused, and it is a silent
  // one: a terse agent says "Done." to the comment and "Done." again to the follow-up, and
  // deduping on what the answer SAYS discards the second - so the human's follow-up reads as
  // unanswered when it was in fact answered. The delivery window is what tells them apart.
  const h = harness([thread({ id: "a" })]);
  h.replyTool.value = null;
  h.walkthrough.start(SESSION);
  await settle();
  h.deliver();
  await settle();
  h.now.value += 1_000;
  // BYTE-IDENTICAL to the second answer below. A tool-less agent recovers the handle but not
  // reliably the ordinal, so the terse form it actually writes carries nothing that
  // distinguishes one round from the next.
  h.say("MC-a Done.");
  h.now.value += FILE_COMMENT_ADVANCE_SETTLE_MS + 1;
  await h.walkthrough.tick(SESSION);
  await settle();
  assert.equal(h.threads.get("a")!.messages.filter((m) => m.author === "agent").length, 1);

  const again = h.threads.get("a")!;
  h.threads.set("a", {
    ...again,
    status: "queued",
    queueSeq: 1,
    messages: [...again.messages, message({ id: "m2", threadId: "a", body: "and this?" })],
  });
  h.walkthrough.start(SESSION);
  await settle();
  h.deliver();
  await settle();
  // A SECOND, genuinely distinct answer - to the follow-up - that reads exactly like the
  // first. It is a different turn, spoken after this delivery, so it is a different answer.
  h.now.value += 1_000;
  h.say("MC-a Done.");
  h.now.value += FILE_COMMENT_ADVANCE_SETTLE_MS + 1;
  await h.walkthrough.tick(SESSION);
  await settle();

  assert.deepEqual(
    h.threads.get("a")!.messages.filter((m) => m.author === "agent").map((m) => m.body),
    ["MC-a Done.", "MC-a Done."],
    "both answers are kept - the human asked twice and was answered twice",
  );
});

test("a turn the transcript could not timestamp is not attributed to a delivery", async () => {
  // `TranscriptMessage.ts` is 0 when the record carried no timestamp. Such a turn cannot be
  // placed against the delivery at all, and admitting it is how a turn from an earlier round
  // lands in this round's window - the precise thing the window exists to prevent.
  const h = harness([thread({ id: "a" })]);
  h.replyTool.value = null;
  h.walkthrough.start(SESSION);
  await settle();
  h.deliver();
  await settle();
  h.transcript.push({ text: "MC-a.1 - answered, but unstamped.", at: 0 });

  h.now.value += FILE_COMMENT_ADVANCE_SETTLE_MS + 1;
  await h.walkthrough.tick(SESSION);
  await settle();
  assert.equal(h.threads.get("a")!.messages.filter((m) => m.author === "agent").length, 0);
});

test("a turn spoken BEFORE the comment went out is not an answer to it", async () => {
  const h = harness([thread({ id: "a" })]);
  h.replyTool.value = null;
  // It quotes the handle, but the agent said it before the comment ever reached it - so
  // whatever it is, it is not an answer to this delivery.
  h.say("MC-a.1 - said before the comment was ever sent.");
  h.now.value += 1_000;
  h.walkthrough.start(SESSION);
  await settle();
  h.deliver();
  await settle();

  h.now.value += FILE_COMMENT_ADVANCE_SETTLE_MS + 1;
  await h.walkthrough.tick(SESSION);
  await settle();
  assert.equal(h.threads.get("a")!.messages.filter((m) => m.author === "agent").length, 0);
});

test("a transcript turn about a DIFFERENT comment is not filed on this one", async () => {
  const h = harness([thread({ id: "a" })]);
  h.replyTool.value = null;
  h.walkthrough.start(SESSION);
  await settle();
  h.deliver();
  await settle();
  h.now.value += 1_000;
  h.say("MC-b.1 - this answers another comment entirely.");
  h.now.value += FILE_COMMENT_ADVANCE_SETTLE_MS + 1;
  await h.walkthrough.tick(SESSION);
  await settle();
  assert.equal(h.threads.get("a")!.messages.filter((m) => m.author === "agent").length, 0);
});