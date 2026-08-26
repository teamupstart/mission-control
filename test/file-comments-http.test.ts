import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: every route here is a mutating one, and the two that can go wrong
// quietly are the ones the phase plan names - queueing a thread (one route, not the status
// route composed with the reorder route) and editing a message (refused once the bytes are
// committed to the outbox). This drives all of them through `buildApp()`, including the
// loopback guard and the 503 the routes answer when the manager is absent.

const home = mkdtempSync(join(tmpdir(), "mission-file-comments-http-"));
process.env.MISSION_HOME = home;

const { buildApp } = await import("../src/server/routes.ts");
const { FileCommentManager } = await import("../src/server/file-comments.ts");
const {
  appendFileCommentMessage,
  beginFileCommentDelivery,
  loadFileCommentThread,
  markFileCommentMessageDelivered,
  openDb,
  loadFileCommentThreadWithFullHistory,
  loadFileCommentThreadsForSession,
  orphanFileCommentThreadsForSession,
  setFileCommentThreadStatus,
} = await import("../src/server/db.ts");
const { FILE_COMMENT_THREAD_MESSAGE_CAP } = await import("../src/shared/file-comments.ts");
const { FileCommentWalkthrough } = await import("../src/server/file-comment-walkthrough.ts");
const { loadFileCommentReview, setFileCommentReviewState } = await import("../src/server/db.ts");
const { ensureToken } = await import("../src/server/auth.ts");
type Registry = import("../src/server/registry.ts").Registry;
type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
type TaskManager = import("../src/server/tasks.ts").TaskManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;
type FileCommentThread = import("../src/shared/types.ts").FileCommentThread;
type FileCommentReview = import("../src/shared/types.ts").FileCommentReview;
type ServerEvent = import("../src/shared/types.ts").ServerEvent;

after(() => rmSync(home, { recursive: true, force: true }));

const events: ServerEvent[] = [];
const held = new Map<string, FileCommentThread>();
const reviews = new Map<string, FileCommentReview>();
const sessions = new Set(["live", "other"]);
/** Which session a `cwd` resolves to, so a reply can bind the way a real agent does. */
const cwdSessions = new Map<string, string>([["/tmp", "live"], ["/tmp/other", "other"]]);

const registry = {
  getSession: (id: string) => (sessions.has(id) ? { id, cwd: "/tmp" } : undefined),
  // The `/mcp/*` join. The real one resolves a pane token, then an agent session id, then a
  // UNIQUE cwd; what matters to these tests is only that a reply arrives already scoped to a
  // session, because that scoping is what makes a per-session `short_id` safe to resolve.
  findSessionByEnv: (_env: unknown, sessionId: string | null, cwd: string | null) => {
    const id = sessionId ?? (cwd ? cwdSessions.get(cwd) ?? null : null);
    return id && sessions.has(id) ? { id, cwd } : undefined;
  },
  subscribe: () => () => {},
  onSessionsObserved: () => () => {},
  listFileCommentThreads: () => [...held.values()],
  getFileCommentThread: (id: string) => held.get(id),
  fileCommentThreadsForSession: (sessionId: string) =>
    [...held.values()]
      .filter((t) => t.sessionId === sessionId)
      .sort(
        (a, b) =>
          (a.queueSeq ?? Number.MAX_SAFE_INTEGER) - (b.queueSeq ?? Number.MAX_SAFE_INTEGER) ||
          a.createdAt - b.createdAt,
      ),
  upsertFileCommentThread: (thread: FileCommentThread) => {
    held.set(thread.id, thread);
    events.push({ type: "file_comment_thread_upsert", thread });
  },
  removeFileCommentThread: (id: string) => {
    if (held.delete(id)) events.push({ type: "file_comment_thread_remove", id });
  },
  pruneFileComments: () => 0,
  fileCommentReview: (sessionId: string) =>
    reviews.get(sessionId) ?? {
      sessionId,
      state: "idle",
      pauseReason: null,
      startedAt: null,
      updatedAt: 0,
    },
  upsertFileCommentReview: (review: FileCommentReview) => {
    reviews.set(review.sessionId, review);
    events.push({ type: "file_comment_review_upsert", review });
  },
  removeFileCommentReview: (sessionId: string) => {
    if (reviews.delete(sessionId)) events.push({ type: "file_comment_review_remove", sessionId });
  },
} as unknown as Registry;

const stub = <T,>() => ({}) as unknown as T;
/**
 * The real walkthrough over a port that submits nowhere.
 *
 * The state machine has its own file - `file-comment-walkthrough.test.ts` drives every branch
 * of it with no database at all. What is at stake HERE is only the doors: that start, pause
 * and resume reach it through `parseBody`, that the run state comes back on the wire, and that
 * both answer 503 without it. So the port is the durable one for reads and a no-op for the
 * outbox, which is what keeps this file about routes.
 */
const submitted: string[] = [];
const walkthrough = new FileCommentWalkthrough({
  now: () => Date.now(),
  replyTool: () => Promise.resolve("mcp__mission-control__respond_to_file_comments"),
  session: () => ({ id: "live", runtime: "sdk", state: "idle", terminals: [], lastActivity: 0, firstSeen: 0, pendingTurns: [] }) as never,
  review: (sessionId) => loadFileCommentReview(sessionId),
  setReviewState: (sessionId, state, pauseReason) => {
    const review = setFileCommentReviewState(sessionId, state, pauseReason, Date.now());
    registry.upsertFileCommentReview(review);
    return review;
  },
  threads: (sessionId) => loadFileCommentThreadsForSession(sessionId),
  threadWithHistory: (id) => loadFileCommentThreadWithFullHistory(id),
  // No checkout behind this app, so nothing re-anchors. The pause that produces is a real
  // outcome of this route pair and is asserted below rather than papered over.
  readFile: () => Promise.reject(new Error("no checkout in this test")),
  updateAnchor: () => null,
  beginDelivery: () => null,
  markDelivered: () => null,
  markUnanswered: () => null,
  returnToQueue: () => null,
  requeueAtTail: () => null,
  submit: (_id, text) => {
    submitted.push(text);
    return { ok: true, turnId: `turn-${submitted.length}`, error: null };
  },
  pendingTurn: () => null,
  // The tool-less fallback is the walkthrough's, and it has its own file. What is at stake
  // here is the doors, so this reads nothing and files nothing.
  agentTurnsSince: () => [],
  appendAgentReply: () => null,
});
const app = buildApp(
  registry,
  stub<ReviewManager>(),
  stub<TaskManager>(),
  stub<QueueManager>(),
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  new FileCommentManager(registry),
  walkthrough,
);
// The same construction with the manager LEFT OFF, which is what ~50 focused route tests do.
const without = buildApp(registry, stub<ReviewManager>(), stub<TaskManager>(), stub<QueueManager>());

const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

function reset(): void {
  const db = openDb();
  db.exec("DELETE FROM file_comment_messages");
  db.exec("DELETE FROM file_comment_threads");
  db.exec("DELETE FROM file_comment_reviews");
  held.clear();
  reviews.clear();
  submitted.length = 0;
  events.length = 0;
}

async function post(path: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const COMMENT = {
  path: "docs/plan.md",
  startLine: 84,
  endLine: 86,
  quote: "the paragraph as it currently reads",
  revision: "r1",
  surface: "editor" as const,
  body: "This contradicts the diagram above it.",
};

async function create(over: Record<string, unknown> = {}): Promise<FileCommentThread> {
  const res = await post("/api/sessions/live/file-comments", { ...COMMENT, ...over });
  const body = (await res.json()) as { thread?: FileCommentThread; error?: string };
  assert.equal(res.status, 200, body.error ?? "");
  return body.thread!;
}

test("a comment is created as a draft, hashed by the daemon, and reaches the stream", async () => {
  reset();
  const thread = await create();
  assert.equal(thread.status, "draft");
  assert.match(thread.shortId, /^MC-[0-9a-f]{4,}$/);
  // The hash is computed HERE and never supplied by the caller - the rule `fingerprint()`
  // states for the Inspector, because a caller that could choose it could make any comment
  // collide with any other.
  assert.match(thread.quoteHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(thread.messages.map((m) => [m.author, m.body]), [["human", COMMENT.body]]);
  assert.deepEqual(events.map((e) => e.type), ["file_comment_thread_upsert"]);
  // And it is durable, not just held.
  assert.equal(loadFileCommentThread(thread.id)?.id, thread.id);
});

test("an HTML comment keeps the exact block identity returned by the resolver", async () => {
  reset();
  const htmlBlockPath = [{ index: 0, tag: "p" }];
  const thread = await create({
    surface: "html",
    htmlBlockPath,
    htmlBlockQuote: "<p>the paragraph as it currently reads</p>",
  });
  assert.deepEqual(thread.htmlBlockPath, htmlBlockPath);
  assert.equal(thread.htmlBlockQuote, "<p>the paragraph as it currently reads</p>");
});

test("the schemas refuse what they are supposed to refuse", async () => {
  reset();
  assert.equal((await post("/api/sessions/live/file-comments", { ...COMMENT, body: "" })).status, 400);
  assert.equal((await post("/api/sessions/live/file-comments", { ...COMMENT, quote: "" })).status, 400);
  assert.equal((await post("/api/sessions/live/file-comments", { ...COMMENT, startLine: 0 })).status, 400);
  assert.equal(
    (await post("/api/sessions/live/file-comments", { ...COMMENT, surface: "diff" })).status,
    400,
  );
  assert.equal(
    (await post("/api/sessions/live/file-comments", { ...COMMENT, body: "x".repeat(9_000) })).status,
    400,
  );
  assert.equal((await post("/api/sessions/ghost/file-comments", COMMENT)).status, 404);
});

test("listing is by session, and filtered by path", async () => {
  reset();
  const a = await create({ path: "docs/a.md" });
  await create({ path: "docs/b.md" });
  const all = await app.request("/api/sessions/live/file-comments", { headers: HEADERS });
  assert.equal(((await all.json()) as { threads: FileCommentThread[] }).threads.length, 2);
  const one = await app.request("/api/sessions/live/file-comments?path=docs%2Fa.md", {
    headers: HEADERS,
  });
  assert.deepEqual(
    ((await one.json()) as { threads: FileCommentThread[] }).threads.map((t) => t.id),
    [a.id],
  );
});

test("queueing is ONE route, and it allocates the tail position", async () => {
  reset();
  const a = await create();
  const b = await create();
  const first = await post(`/api/file-comments/${a.id}/queue`);
  const second = await post(`/api/file-comments/${b.id}/queue`);
  assert.equal(((await first.json()) as { thread: FileCommentThread }).thread.queueSeq, 0);
  assert.equal(((await second.json()) as { thread: FileCommentThread }).thread.queueSeq, 1);
  assert.equal((await post("/api/file-comments/ghost/queue")).status, 404);
});

test("a refused requeue is a 409 with a reason, never an opaque 500", async () => {
  reset();
  const t = await create();
  await post(`/api/file-comments/${t.id}/status`, { status: "resolved" });
  const res = await post(`/api/file-comments/${t.id}/queue`);
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /cannot be queued/);
  // Reopening stays possible and stays deliberate: un-resolve back to `draft`, then requeue
  // normally. `draft` and `resolved` are the two decisions this route takes.
  assert.equal((await post(`/api/file-comments/${t.id}/status`, { status: "draft" })).status, 200);
  assert.equal((await post(`/api/file-comments/${t.id}/queue`)).status, 200);
});

test("a reply appends a message, and an undelivered one can still be edited", async () => {
  reset();
  const t = await create();
  const appended = await post(`/api/file-comments/${t.id}/messages`, { body: "a follow-up" });
  assert.equal(appended.status, 200);
  const thread = ((await appended.json()) as { thread: FileCommentThread }).thread;
  assert.deepEqual(thread.messages.map((m) => m.body), [COMMENT.body, "a follow-up"]);

  const edited = await post(`/api/file-comment-messages/${thread.messages[0]!.id}`, {
    body: "rewritten while it is still mine",
  });
  assert.equal(edited.status, 200);
  assert.equal(
    ((await edited.json()) as { thread: FileCommentThread }).thread.messages[0]!.body,
    "rewritten while it is still mine",
  );
  assert.equal((await post("/api/file-comment-messages/ghost", { body: "x" })).status, 404);
});

test("a comment already committed to the outbox cannot be rewritten behind the agent", async () => {
  reset();
  const t = await create();
  await post(`/api/file-comments/${t.id}/queue`);
  // Phase 3's submit write, reached here directly because this phase ships no walkthrough.
  const { beginFileCommentDelivery } = await import("../src/server/db.ts");
  beginFileCommentDelivery(t.id, "delivery-1", Date.now());
  const res = await post(`/api/file-comment-messages/${t.messages[0]!.id}`, { body: "too late" });
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /outbox/);
});

test("reorder rewrites the queue, and marking read clears the pip's input", async () => {
  reset();
  const ids: string[] = [];
  for (let i = 0; i < 3; i += 1) ids.push((await create()).id);
  for (const id of ids) await post(`/api/file-comments/${id}/queue`);
  const res = await post("/api/sessions/live/file-comments/reorder", {
    order: [ids[2]!, ids[0]!, ids[1]!],
  });
  assert.deepEqual(
    ((await res.json()) as { threads: FileCommentThread[] }).threads.map((t) => t.id),
    [ids[2]!, ids[0]!, ids[1]!],
  );

  // Seeded through the STORE seam, the way phase 4's own route will: the dashboard route is
  // human-only and cannot write this row, which is the point of the test below.
  appendFileCommentMessage({
    id: "agent-answer",
    threadId: ids[0]!,
    author: "agent",
    sessionId: "live",
    body: "answered",
    now: Date.now(),
  });
  const read = await post(`/api/file-comments/${ids[0]!}/read`);
  const thread = ((await read.json()) as { thread: FileCommentThread }).thread;
  assert.deepEqual(
    thread.messages.map((m) => [m.author, m.readAt === null]),
    [["human", true], ["agent", false]],
  );
  assert.equal(thread.status, "queued", "marking read moves no status");
});

test("the dashboard reply route cannot forge an agent answer", async () => {
  // Phase 4 owns agent replies: they arrive through `respond_to_file_comments` and its
  // token-guarded `/mcp/*` route, where `findSessionByEnv` establishes the session before
  // anything is written. THIS route is reachable by any ordinary dashboard caller over
  // loopback, so an `agent` message accepted here is a reply the UI renders as the agent's
  // answer that no agent sent - and, once phase 3 lands, a false advance signal for the
  // walkthrough. That is a phase-4 surface this phase must leave alone.
  reset();
  const t = await create();

  const forged = await post(`/api/file-comments/${t.id}/messages`, {
    author: "agent",
    body: "I have handled this",
  });
  assert.equal(forged.status, 400);
  // Refused, not silently reattributed to `human`: filing it under an author nobody chose
  // would be a quieter version of the same wrong record.
  assert.deepEqual(
    loadFileCommentThread(t.id)!.messages.map((m) => m.author),
    ["human"],
    "nothing was written",
  );

  // A person replying in the thread is what this route is for, and still works.
  const real = await post(`/api/file-comments/${t.id}/messages`, { body: "a human follow-up" });
  assert.equal(real.status, 200);
  assert.deepEqual(
    loadFileCommentThread(t.id)!.messages.map((m) => [m.author, m.body]),
    [["human", COMMENT.body], ["human", "a human follow-up"]],
  );

  // The STORE seam is untouched - it is the declared cross-phase write path, and phase 4
  // calls it with `agent` from its own trusted route. What closed is the HTTP door.
  appendFileCommentMessage({
    id: "seam-check",
    threadId: t.id,
    author: "agent",
    sessionId: "live",
    body: "the tool's answer",
    now: Date.now(),
  });
  assert.deepEqual(
    loadFileCommentThread(t.id)!.messages.map((m) => m.author),
    ["human", "human", "agent"],
  );
});

test("the status route takes the two human decisions and no mechanism's outcome", async () => {
  // Every status except these two is the recorded outcome of a mechanism, owned by one writer
  // that does bookkeeping a request cannot reproduce. Exposing them here was not merely
  // untidy:
  //
  // - `answered` on an `awaiting` thread RELEASES the single-flight index while the original
  //   comment is still out with the agent, so a second comment can be delivered into a
  //   session that already has one outstanding - the exact harm one-at-a-time prevents.
  // - `sending` or `awaiting` on a draft makes a thread outstanding with no delivery behind
  //   it, after which the index refuses the session's next REAL send.
  // - `queued` sets the status without allocating a position, leaving a thread in the review
  //   by status and nowhere in its order.
  reset();
  const t = await create();
  assert.equal((await post(`/api/file-comments/${t.id}/status`, { status: "resolved" })).status, 200);
  assert.equal((await post(`/api/file-comments/${t.id}/status`, { status: "draft" })).status, 200);
  for (const status of ["queued", "sending", "awaiting", "answered", "unanswered", "orphaned"]) {
    assert.equal(
      (await post(`/api/file-comments/${t.id}/status`, { status })).status,
      400,
      status,
    );
  }
  assert.equal(loadFileCommentThread(t.id)?.status, "draft", "nothing moved the thread");
  // `addressed` is not a status and gets no route: only a person closes a thread, and
  // routing an agent's suggestion through a status transition is how it becomes a closure.
  assert.equal((await post(`/api/file-comments/${t.id}/status`, { status: "addressed" })).status, 400);
  assert.equal((await post(`/api/file-comments/${t.id}/status`, {})).status, 400);
});

test("withdrawing or closing a queued thread takes its place in the queue with it", async () => {
  // `queue_seq` is meaningful only while a thread holds a position. A withdrawn thread that
  // kept its number sat in the order as a `draft`; a closed one left a permanent hole, and
  // the consecutive order is what phase 3 reads to find the head of the review.
  reset();
  const a = await create();
  const b = await create();
  await post(`/api/file-comments/${a.id}/queue`);
  await post(`/api/file-comments/${b.id}/queue`);
  assert.deepEqual(
    [loadFileCommentThread(a.id)?.queueSeq, loadFileCommentThread(b.id)?.queueSeq],
    [0, 1],
  );
  assert.equal((await post(`/api/file-comments/${a.id}/status`, { status: "draft" })).status, 200);
  assert.equal(loadFileCommentThread(a.id)?.queueSeq, null, "withdrawn, and out of the order");
  assert.equal((await post(`/api/file-comments/${b.id}/status`, { status: "resolved" })).status, 200);
  assert.equal(loadFileCommentThread(b.id)?.queueSeq, null, "closed, and out of the order");
});

test("a live session's thread cannot be orphaned through the status route", async () => {
  // `orphaned` is not a status anyone DECIDES - it is what a thread becomes when the session
  // that owns it goes away, and it is reached by the three lifetime mechanisms alone. While
  // this route accepted it, an ordinary dashboard caller could settle a LIVE session's thread
  // to a terminal status and drop it out of the live collection, after which every later
  // write on it was refused with "this comment's session has ended" about a session that had
  // not ended. `orphaned` is terminal, so there was no way back.
  reset();
  const t = await create();
  const refused = await post(`/api/file-comments/${t.id}/status`, { status: "orphaned" });
  assert.equal(refused.status, 400);
  const after = loadFileCommentThread(t.id)!;
  assert.equal(after.status, "draft", "the durable row did not move");
  assert.notEqual(
    events.at(-1)?.type,
    "file_comment_thread_remove",
    "and it did not leave the live collection",
  );
  // The doors that DO mean what they say are still open: `resolved` is the human close.
  assert.equal((await post(`/api/file-comments/${t.id}/status`, { status: "resolved" })).status, 200);
  assert.equal(loadFileCommentThread(t.id)?.status, "resolved");

  // And the STORE's writer is untouched, because session cleanup is the mechanism that is
  // supposed to write this status. Only the request-side door closed.
  orphanFileCommentThreadsForSession("live", Date.now());
  assert.equal(loadFileCommentThread(t.id)?.status, "orphaned");
});

test("a comment out with the agent can be neither settled nor deleted", async () => {
  // `sending` and `awaiting` are the two statuses the partial unique index is built on, so
  // settling one to `draft` or `resolved` releases the session's single-flight slot while its
  // pending turn can still reach the agent. The next queue then delivers a SECOND comment
  // into a session that already has one outstanding, which is the exact harm one-at-a-time
  // exists to prevent. A status write does not recall bytes already in the outbox.
  reset();
  const { beginFileCommentDelivery, markFileCommentMessageDelivered } = await import(
    "../src/server/db.ts"
  );
  const t = await create();
  await post(`/api/file-comments/${t.id}/queue`);
  beginFileCommentDelivery(t.id, "delivery-out", Date.now());
  assert.equal(loadFileCommentThread(t.id)?.status, "sending");

  for (const status of ["draft", "resolved"]) {
    const res = await post(`/api/file-comments/${t.id}/status`, { status });
    assert.equal(res.status, 409, status);
    assert.match(((await res.json()) as { error: string }).error, /out with the agent/, status);
  }
  assert.equal(loadFileCommentThread(t.id)?.status, "sending", "nothing moved it");

  // DELETE is the same rule through the other door, and the worse half of it: settling
  // releases the session's single-flight slot, deleting releases it AND destroys the row, so
  // when the reply arrives there is nothing left for it to land on.
  const destroyed = await app.request(`/api/file-comments/${t.id}`, {
    method: "DELETE",
    headers: HEADERS,
  });
  assert.equal(destroyed.status, 409);
  assert.match(((await destroyed.json()) as { error: string }).error, /out with the agent/);
  assert.ok(loadFileCommentThread(t.id), "the outstanding thread and its turn survive");

  // The longer half of the outstanding window is refused for the same reason, both ways.
  markFileCommentMessageDelivered(loadFileCommentThread(t.id)!.messages[0]!.id, Date.now());
  assert.equal(loadFileCommentThread(t.id)?.status, "awaiting");
  assert.equal((await post(`/api/file-comments/${t.id}/status`, { status: "resolved" })).status, 409);
  assert.equal(
    (await app.request(`/api/file-comments/${t.id}`, { method: "DELETE", headers: HEADERS })).status,
    409,
  );

  // And this is not a hang. The grace window moves `awaiting` to `unanswered`, which sits
  // OUTSIDE the outstanding tuple precisely so the queue can move on - and from there a
  // person can close the thread normally.
  setFileCommentThreadStatus(t.id, "unanswered", Date.now());
  assert.equal((await post(`/api/file-comments/${t.id}/status`, { status: "resolved" })).status, 200);
  assert.equal(loadFileCommentThread(t.id)?.status, "resolved");
  // Both doors reopen together, because they are one rule stated once.
  assert.equal(
    (await app.request(`/api/file-comments/${t.id}`, { method: "DELETE", headers: HEADERS })).status,
    200,
  );
});

test("a session's live comments are bounded, and closing one makes room", async () => {
  // The live collection is bounded by live SESSIONS, which caps how long a thread lives but
  // not how many one session accumulates while it is alive. The prune only reaches settled
  // threads whose session key is already gone, so without this a long-lived session - or a
  // client stuck retrying the create route - grows SQLite, the registry map, and every
  // reconnect snapshot without limit.
  reset();
  const { FILE_COMMENT_THREADS_PER_SESSION_MAX } = await import("../src/shared/file-comments.ts");
  const made: string[] = [];
  for (let i = 0; i < FILE_COMMENT_THREADS_PER_SESSION_MAX; i += 1) made.push((await create()).id);
  assert.equal(made.length, FILE_COMMENT_THREADS_PER_SESSION_MAX);

  const refused = await post("/api/sessions/live/file-comments", COMMENT);
  assert.equal(refused.status, 409);
  assert.match(((await refused.json()) as { error: string }).error, /already holds 200 comments/);
  // Refused BEFORE anything was written - not a partially created thread.
  assert.equal(
    loadFileCommentThreadsForSession("live").length,
    FILE_COMMENT_THREADS_PER_SESSION_MAX,
  );

  // Closing a thread makes room, which is the behaviour a person hitting this expects. The
  // count is over what the session still HOLDS, and a `resolved` thread is still one of them,
  // so it takes a delete rather than a resolve.
  assert.equal(
    (await app.request(`/api/file-comments/${made[0]}`, { method: "DELETE", headers: HEADERS }))
      .status,
    200,
  );
  assert.equal((await post("/api/sessions/live/file-comments", COMMENT)).status, 200);

  // The cap is per SESSION, never per fleet: another session is unaffected by this one.
  sessions.add("second");
  assert.equal((await post("/api/sessions/second/file-comments", COMMENT)).status, 200);
});

test("a whitespace-only quote is refused rather than stored unanchorable", async () => {
  // It would pass a length check and normalize to empty, and `reanchor()` reports empty as
  // `outdated` before it searches - so the thread would be created already stale with no edit
  // that could repair it.
  reset();
  const res = await post("/api/sessions/live/file-comments", { ...COMMENT, quote: "  \n  " });
  assert.equal(res.status, 400);
  assert.equal(loadFileCommentThreadsForSession("live").length, 0, "nothing was written");
});

test("an agent's reply cannot be rewritten through the edit route", async () => {
  // The same forgery the append schema refuses at creation, through the other door - and
  // worse, because it destroys a real answer rather than inventing one beside it. Neither
  // existing refusal fires: an agent reply arrives UNDELIVERED (nobody sends it anywhere) and
  // moves its thread to `answered`, which is not outstanding.
  reset();
  const t = await create();
  const agentReply = appendFileCommentMessage({
    id: "agent-record",
    threadId: t.id,
    author: "agent",
    sessionId: "live",
    body: "the agent's real answer",
    now: Date.now(),
  })!;
  assert.equal(agentReply.deliveredAt, null, "undelivered, so the send-window guard cannot fire");

  const forged = await post(`/api/file-comment-messages/${agentReply.id}`, {
    body: "something the agent never said",
  });
  assert.equal(forged.status, 409);
  assert.match(((await forged.json()) as { error: string }).error, /record and cannot be edited/);
  assert.equal(
    loadFileCommentThread(t.id)!.messages.find((m) => m.id === agentReply.id)?.body,
    "the agent's real answer",
    "the record is intact",
  );

  // A person's own undelivered message is still editable - that is what the route is for.
  const mine = loadFileCommentThread(t.id)!.messages[0]!;
  assert.equal((await post(`/api/file-comment-messages/${mine.id}`, { body: "reworded" })).status, 200);
});

test("a thread retains a bounded history, and says so rather than trimming", async () => {
  // The 50-message frame cap bounds the SNAPSHOT only; `GET /api/file-comments/:id` returns
  // everything, and "everything" was itself unbounded - so a session appending in a loop grew
  // SQLite and that response without limit.
  reset();
  const { FILE_COMMENT_MESSAGES_PER_THREAD_MAX } = await import("../src/shared/file-comments.ts");
  const t = await create();
  // The opening comment is already message 1.
  for (let i = 1; i < FILE_COMMENT_MESSAGES_PER_THREAD_MAX; i += 1) {
    appendFileCommentMessage({
      id: `bulk-${i}`,
      threadId: t.id,
      author: "human",
      sessionId: "live",
      body: `reply ${i}`,
      now: Date.now(),
    });
  }
  const full = await app.request(`/api/file-comments/${t.id}`, { headers: HEADERS });
  const { thread } = (await full.json()) as { thread: FileCommentThread };
  assert.equal(thread.messageCount, FILE_COMMENT_MESSAGES_PER_THREAD_MAX);

  const refused = await post(`/api/file-comments/${t.id}/messages`, { body: "one too many" });
  assert.equal(refused.status, 409);
  assert.match(((await refused.json()) as { error: string }).error, /start a new comment/);

  // REFUSED, never trimmed. Dropping the oldest would destroy the original comment - the one
  // the thread is anchored to, and the one an orphaned thread is retained for - to make room
  // for the newest reply.
  const after = loadFileCommentThreadWithFullHistory(t.id)!;
  assert.equal(after.messageCount, FILE_COMMENT_MESSAGES_PER_THREAD_MAX, "nothing was dropped");
  assert.equal(after.messages[0]!.body, COMMENT.body, "the original comment survives");
  // And the two caps are different numbers bounding different things.
  assert.ok(FILE_COMMENT_MESSAGES_PER_THREAD_MAX > FILE_COMMENT_THREAD_MESSAGE_CAP);
});

test("a thread can be fetched whole, and deleted", async () => {
  reset();
  const t = await create();
  const got = await app.request(`/api/file-comments/${t.id}`, { headers: HEADERS });
  assert.equal(((await got.json()) as { thread: FileCommentThread }).thread.id, t.id);
  const gone = await app.request(`/api/file-comments/${t.id}`, { method: "DELETE", headers: HEADERS });
  assert.equal(gone.status, 200);
  assert.equal(loadFileCommentThread(t.id), null);
  assert.equal(events.at(-1)?.type, "file_comment_thread_remove");
  assert.equal(
    (await app.request(`/api/file-comments/${t.id}`, { method: "DELETE", headers: HEADERS })).status,
    404,
  );
});

test("a thread whose session has ended cannot be revived through a retained id", async () => {
  // A thread id is a durable uuid, and a dashboard can still be holding one minutes after
  // the session that owned it was evicted. Every thread-scoped route reaches the store by
  // that id alone, so without a lifetime guard any of these would write to a settled row AND
  // upsert it back into the live collection - putting a comment for a session that no longer
  // exists back on every dashboard, and making `orphaned` reversible when it is terminal.
  reset();
  const t = await create();
  await post(`/api/file-comments/${t.id}/queue`);
  const message = t.messages[0]!.id;

  // The session goes. This is the manager's own `session_remove` arm, reached the way the
  // Registry reaches it.
  orphanFileCommentThreadsForSession("live", Date.now());
  held.delete(t.id);
  sessions.delete("live");

  for (const [path, body] of [
    [`/api/file-comments/${t.id}/messages`, { body: "a reply after the session ended" }],
    [`/api/file-comment-messages/${message}`, { body: "an edit after the session ended" }],
    [`/api/file-comments/${t.id}/queue`, undefined],
    [`/api/file-comments/${t.id}/read`, undefined],
    [`/api/file-comments/${t.id}/status`, { status: "resolved" }],
  ] as const) {
    const res = await post(path, body);
    assert.equal(res.status, 409, path);
    assert.match(((await res.json()) as { error: string }).error, /session has ended/, path);
  }

  // DELETE is the one that would really destroy it, so it carries the guard too. Orphaning
  // deliberately KEEPS the row - the comment is a record of what was asked - and only the
  // throttled prune removes it, once the session key is gone and the window has passed. A
  // stale dashboard deleting an orphaned thread and its whole history would undo exactly the
  // retention the three-mechanism lifetime promises.
  const deleted = await app.request(`/api/file-comments/${t.id}`, {
    method: "DELETE",
    headers: HEADERS,
  });
  assert.equal(deleted.status, 409);
  assert.match(((await deleted.json()) as { error: string }).error, /session has ended/);
  assert.ok(loadFileCommentThread(t.id), "the orphaned row and its history survive");

  // Nothing was written, and nothing was republished.
  const settled = loadFileCommentThread(t.id)!;
  assert.equal(settled.status, "orphaned");
  assert.equal(settled.messages.length, 1, "no reply reached a settled thread");
  assert.equal(settled.messages[0]!.body, COMMENT.body, "no edit reached a settled comment");
  assert.equal(settled.messages[0]!.readAt, null);
  assert.equal(held.has(t.id), false, "a settled thread must not be back in the collection");
  assert.equal(
    events.some((e) => e.type === "file_comment_thread_upsert" && e.thread.id === t.id && e.thread.status === "orphaned"),
    false,
  );

  sessions.add("live");
});

test("a reorder is not a second way to put a settled thread back on screen", async () => {
  // The store returns the session's whole list, orphaned rows included - they hold no queue
  // position, so the rewrite never touched them. Publishing that list unfiltered would
  // republish every one of them.
  reset();
  const live = await create();
  const doomed = await create();
  await post(`/api/file-comments/${live.id}/queue`);
  await post(`/api/file-comments/${doomed.id}/queue`);
  openDb()
    .prepare("UPDATE file_comment_threads SET status = 'orphaned', queue_seq = NULL WHERE id = ?")
    .run(doomed.id);
  held.delete(doomed.id);

  const res = await post("/api/sessions/live/file-comments/reorder", { order: [live.id] });
  const threads = ((await res.json()) as { threads: FileCommentThread[] }).threads;
  assert.deepEqual(threads.map((t) => t.id), [live.id]);
  assert.equal(held.has(doomed.id), false);
});

test("the single-thread route returns the WHOLE history, past the frame's cap", async () => {
  // The other half of the message cap being a cap rather than a loss. Every frame carries a
  // bounded tail plus the true `messageCount`; this is the declared escape hatch a surface
  // takes once those two disagree, so answering it with the same truncation would make a
  // long thread unreadable by any route at all.
  reset();
  const t = await create();
  for (let i = 0; i < FILE_COMMENT_THREAD_MESSAGE_CAP + 5; i += 1) {
    await post(`/api/file-comments/${t.id}/messages`, { body: `reply ${i}` });
  }

  // What the stream carries: a tail, and a count that says so.
  const framed = ((await (await post(`/api/file-comments/${t.id}/read`)).json()) as {
    thread: FileCommentThread;
  }).thread;
  assert.equal(framed.messages.length, FILE_COMMENT_THREAD_MESSAGE_CAP);
  assert.equal(framed.messageCount, FILE_COMMENT_THREAD_MESSAGE_CAP + 6);

  // What the route answers: all of it, opening comment included.
  const whole = ((await (
    await app.request(`/api/file-comments/${t.id}`, { headers: HEADERS })
  ).json()) as { thread: FileCommentThread }).thread;
  assert.equal(whole.messages.length, whole.messageCount);
  assert.equal(whole.messages.length, FILE_COMMENT_THREAD_MESSAGE_CAP + 6);
  assert.equal(whole.messages[0]!.body, COMMENT.body, "the opening comment is reachable again");
  assert.equal(whole.messages.at(-1)?.body, `reply ${FILE_COMMENT_THREAD_MESSAGE_CAP + 4}`);
});

test("without the manager every route answers 503, never a route-built twin", async () => {
  // A twin would be a second subscriber on `session_remove` and a second emitter on one
  // live stream - two teardown paths for state whose whole contract is that it has three.
  for (const [method, path] of [
    ["GET", "/api/sessions/live/file-comments"],
    ["POST", "/api/sessions/live/file-comments"],
    ["POST", "/api/sessions/live/file-comments/reorder"],
    ["GET", "/api/file-comments/x"],
    ["POST", "/api/file-comments/x/queue"],
    ["POST", "/api/file-comments/x/messages"],
    ["POST", "/api/file-comment-messages/x"],
    ["POST", "/api/file-comments/x/read"],
    ["POST", "/api/file-comments/x/status"],
    ["DELETE", "/api/file-comments/x"],
    ["GET", "/api/sessions/live/file-comment-review"],
    ["POST", "/api/sessions/live/file-comment-review"],
  ] as const) {
    const res = await without.request(path, {
      method,
      headers: HEADERS,
      body: method === "GET" || method === "DELETE" ? undefined : "{}",
    });
    assert.equal(res.status, 503, `${method} ${path}`);
  }
});

test("the loopback guard applies to all of it", async () => {
  const res = await app.request("/api/sessions/live/file-comments", {
    headers: { host: "evil.example.com" },
  });
  assert.equal(res.status, 403);
});


test("the walkthrough controls are one route with an action", async () => {
  reset();
  const t = await create();
  await post(`/api/file-comments/${t.id}/queue`);

  // Never started reads as `idle` rather than as a missing row: the toolbar has to draw
  // something, and making every caller invent a default would give it two answers.
  const before = (await (
    await app.request("/api/sessions/live/file-comment-review", { headers: HEADERS })
  ).json()) as { review: FileCommentReview; progress: { queued: number } };
  assert.equal(before.review.state, "idle");
  assert.equal(before.progress.queued, 1);

  const started = await post("/api/sessions/live/file-comment-review", { action: "start" });
  assert.equal(started.status, 200);
  // This app has no checkout, so the re-anchor pass has no bytes and the review pauses with a
  // reason rather than delivering blind. That IS the contract: a comment is never sent against
  // a file the daemon could not read.
  const after = loadFileCommentReview("live");
  assert.equal(after.state, "paused");
  assert.ok(after.pauseReason);
  assert.equal(submitted.length, 0);
  // And the run state reached the stream, which is the only way a second dashboard hears it.
  assert.ok(events.some((e) => e.type === "file_comment_review_upsert"));

  const paused = await post("/api/sessions/live/file-comment-review", {
    action: "pause",
    reason: "reading something else",
  });
  assert.equal(paused.status, 200);
  assert.equal(loadFileCommentReview("live").pauseReason, "reading something else");

  const dismissed = await post("/api/sessions/live/file-comment-review", {
    action: "dismiss",
  });
  assert.equal(dismissed.status, 200);
  const afterDismiss = loadFileCommentReview("live");
  assert.equal(afterDismiss.state, "paused");
  assert.equal(afterDismiss.pauseReason, null);
  assert.equal(submitted.length, 0, "dismiss does not resume or send the queued comment");
});

test("a reason is refused on anything but a pause, and an unknown action is refused", async () => {
  reset();
  // A reason attached to "running" would be a pause reason on a review that is not paused,
  // which is the one state the column must never hold.
  assert.equal(
    (await post("/api/sessions/live/file-comment-review", { action: "start", reason: "why" })).status,
    400,
  );
  assert.equal(
    (await post("/api/sessions/live/file-comment-review", { action: "dismiss", reason: "why" })).status,
    400,
  );
  assert.equal(
    (await post("/api/sessions/live/file-comment-review", { action: "resume" })).status,
    400,
  );
  assert.equal(
    (await post("/api/sessions/gone/file-comment-review", { action: "start" })).status,
    404,
  );
});

test("a human reply requeues an unanswered thread at the TAIL, and never one in flight", async () => {
  reset();
  const first = await create();
  const second = await create({ startLine: 90, endLine: 90, quote: "another paragraph" });
  await post(`/api/file-comments/${first.id}/queue`);
  await post(`/api/file-comments/${second.id}/queue`);
  assert.equal(loadFileCommentThread(first.id)!.queueSeq, 0);

  // The walkthrough gave up on the first comment. A person writes a follow-up.
  setFileCommentThreadStatus(first.id, "unanswered", Date.now());
  const replied = await post(`/api/file-comments/${first.id}/messages`, {
    author: "human",
    body: "still not right",
  });
  assert.equal(replied.status, 200);
  const back = loadFileCommentThread(first.id)!;
  assert.equal(back.status, "queued");
  assert.equal(back.queueSeq, 2, "at the END, behind everything queued since - not in its old slot");

  // And a reply to the comment currently OUT WITH THE AGENT appends without moving it. Moving
  // it would empty the outstanding set the single-flight index is built on while a turn is
  // genuinely live, and the walkthrough would release the next comment on top of it.
  setFileCommentThreadStatus(second.id, "awaiting", Date.now());
  const during = await post(`/api/file-comments/${second.id}/messages`, {
    author: "human",
    body: "one more thing",
  });
  assert.equal(during.status, 200);
  const outstanding = loadFileCommentThread(second.id)!;
  assert.equal(outstanding.status, "awaiting", "appending is allowed; the status must not move");
  assert.equal(outstanding.messageCount, 2);
});

// ---- phase 4: the agent's reply, through `POST /mcp/file-comments/replies` ----
//
// The `/mcp/*` shape, not the dashboard's: the token is the gate and no `host` header is
// needed. What is at stake in every case below is the pair of questions the route keeps
// apart - does this reply ANSWER the outstanding delivery (which releases the turn), and does
// the thread still owe another turn (which decides only where it goes next). Collapsing them
// is what deadlocked the review once already.

/** The reply an agent's MCP child posts, bound by `cwd` exactly as a real one binds. */
async function reply(
  body: Record<string, unknown>,
  cwd = "/tmp",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request("/mcp/file-comments/replies", {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": ensureToken() },
    body: JSON.stringify({ env: {}, sessionId: null, cwd, ...body }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/**
 * Put a queued thread through a real delivery: `sending` with a correlation, then the
 * confirmed-delivery stamp that moves it to `awaiting`.
 *
 * Through phase 1's and phase 3's own writers rather than by writing the columns, so a
 * scenario here is reachable by the daemon that actually runs it.
 */
/**
 * Stage a delivery the way the walkthrough does.
 *
 * `at` is a parameter rather than always `Date.now()` so a test can pin two deliveries of one
 * thread to the SAME millisecond. That is not a contrivance: a timeout, a follow-up, and its
 * send all inside one tick is ordinary on a fast machine, and it is what a real CI runner
 * produced.
 */
function deliver(threadId: string, turnId: string, at: number = Date.now()): void {
  beginFileCommentDelivery(threadId, turnId, at);
  const thread = loadFileCommentThread(threadId)!;
  const next = thread.messages.find((m) => m.author === "human" && m.deliveredAt === null)!;
  markFileCommentMessageDelivered(next.id, at);
}

test("a reply quoting the handle the payload printed lands in that thread and releases the turn", async () => {
  reset();
  const first = await create();
  const second = await create({ startLine: 90, endLine: 90, quote: "another paragraph" });
  await post(`/api/file-comments/${first.id}/queue`);
  await post(`/api/file-comments/${second.id}/queue`);
  deliver(first.id, "turn-1");
  const handle = `${loadFileCommentThread(first.id)!.shortId}.1`;

  events.length = 0;
  const answered = await reply({ commentId: handle, body: "Fixed - the table was right." });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.equal(answered.body.released, true);

  const thread = loadFileCommentThread(first.id)!;
  assert.equal(thread.status, "answered");
  assert.equal(thread.answeredAt !== null, true);
  // `delivery_id` names a `pending_turns` row, and this thread is correlated to nothing now.
  assert.equal(thread.deliveryId, null);
  assert.deepEqual(
    thread.messages.map((m) => [m.author, m.body]),
    [["human", COMMENT.body], ["agent", "Fixed - the table was right."]],
  );
  // One frame carries the whole outcome to every dashboard, without a refresh.
  assert.deepEqual(events.map((e) => e.type), ["file_comment_thread_upsert"]);
  // And the next comment is free to go: nothing is outstanding.
  assert.equal(loadFileCommentThread(second.id)!.status, "queued");
});

test("`addressed` stamps a timestamp and moves no status", async () => {
  reset();
  const t = await create();
  await post(`/api/file-comments/${t.id}/queue`);
  deliver(t.id, "turn-1");
  const answered = await reply({
    commentId: `${loadFileCommentThread(t.id)!.shortId}.1`,
    body: "Done.",
    addressed: true,
  });
  assert.equal(answered.status, 200);
  const thread = loadFileCommentThread(t.id)!;
  assert.equal(thread.addressedAt !== null, true, "the agent said it handled this");
  // A suggestion, never a closure: only a person resolves a thread.
  assert.equal(thread.status, "answered");
  assert.equal(thread.resolvedAt, null);
});

test("the same short id in two sessions resolves to each session's OWN thread", async () => {
  reset();
  const mine = await create();
  const theirs = (await (async () => {
    const res = await post("/api/sessions/other/file-comments", COMMENT);
    return ((await res.json()) as { thread: FileCommentThread }).thread;
  })());
  // `short_id` is unique PER SESSION, so this collision is legal - and it is the case a
  // global lookup passes silently by filing a reply onto the wrong session's thread.
  const shared = mine.shortId;
  openDb()
    .prepare(`UPDATE file_comment_threads SET short_id = ? WHERE id = ?`)
    .run(shared, theirs.id);
  await post(`/api/file-comments/${mine.id}/queue`);
  deliver(mine.id, "turn-1");
  await post(`/api/file-comments/${theirs.id}/queue`);
  deliver(theirs.id, "turn-2");

  const answered = await reply({ commentId: `${shared}.1`, body: "theirs" }, "/tmp/other");
  assert.equal(answered.status, 200);
  assert.equal(answered.body.threadId, theirs.id, "the reply landed in the session it came from");
  assert.equal(loadFileCommentThread(theirs.id)!.messageCount, 2);
  assert.equal(loadFileCommentThread(mine.id)!.messageCount, 1, "and not on the other session's");
});

test("a handle this session does not hold is refused, never resolved globally", async () => {
  reset();
  const mine = await create();
  await post(`/api/file-comments/${mine.id}/queue`);
  deliver(mine.id, "turn-1");
  // The handle exists - in the OTHER session. A global fallback on a miss is exactly what
  // turns an honest refusal into the wrong thread.
  const missed = await reply({ commentId: `${mine.shortId}.1`, body: "wrong door" }, "/tmp/other");
  assert.equal(missed.status, 404);
  assert.match(String(missed.body.error), /no comment MC-/);
  assert.equal(loadFileCommentThread(mine.id)!.messageCount, 1);
});

test("the reply door refuses an unknown session, a bad token, and a value that is not a handle", async () => {
  reset();
  const t = await create();
  await post(`/api/file-comments/${t.id}/queue`);
  deliver(t.id, "turn-1");

  const anonymous = await app.request("/mcp/file-comments/replies", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ env: {}, cwd: "/tmp", commentId: `${t.shortId}.1`, body: "hi" }),
  });
  assert.equal(anonymous.status, 401);

  assert.equal((await reply({ commentId: `${t.shortId}.1`, body: "hi" }, "/nowhere")).status, 404);
  // A uuid is the identifier the agent is never given, and a tool that took one would be a
  // tool no agent could call. It is refused as what it is rather than resolved by accident.
  const uuid = await reply({ commentId: t.id, body: "hi" });
  assert.equal(uuid.status, 400);
  assert.match(String(uuid.body.error), /is not a comment id/);
  assert.equal((await reply({ commentId: `${t.shortId}.1`, body: "" })).status, 400);
  assert.equal(loadFileCommentThread(t.id)!.messageCount, 1);
});

test("a bare handle - what the transcript fallback recovers - files the reply and advances nothing", async () => {
  reset();
  const t = await create();
  await post(`/api/file-comments/${t.id}/queue`);
  deliver(t.id, "turn-1");
  const answered = await reply({ commentId: t.shortId, body: "an answer with no ordinal" });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.released, false, "it names a thread, so it confirms no delivery");
  const thread = loadFileCommentThread(t.id)!;
  assert.equal(thread.messageCount, 2, "the reply is real content and is always persisted");
  assert.equal(thread.status, "awaiting", "and the turn is still the one the timeout will settle");
});

test("round 14: a late reply does not move a thread the human has already requeued", async () => {
  reset();
  const first = await create();
  const second = await create({ startLine: 90, endLine: 90, quote: "another paragraph" });
  await post(`/api/file-comments/${first.id}/queue`);
  await post(`/api/file-comments/${second.id}/queue`);
  deliver(first.id, "turn-1");
  const handle = `${loadFileCommentThread(first.id)!.shortId}.1`;

  // It timed out, and a person wrote a follow-up, which put it back at the TAIL.
  setFileCommentThreadStatus(first.id, "unanswered", Date.now());
  await post(`/api/file-comments/${first.id}/messages`, { body: "still not right" });
  const requeued = loadFileCommentThread(first.id)!;
  assert.equal(requeued.status, "queued");
  const place = requeued.queueSeq;

  // Only NOW does the slow reply to the first comment arrive.
  const late = await reply({ commentId: handle, body: "sorry, I was slow" });
  assert.equal(late.status, 200);
  assert.equal(late.body.released, false);
  const after = loadFileCommentThread(first.id)!;
  // The message persists - dropping it would lose the agent's work - and NOTHING else moves.
  // Moving it to `answered` here would take it out of the queue and the follow-up would never
  // be delivered, silently, with this reply reported as a success.
  assert.equal(after.messageCount, 3);
  assert.equal(after.status, "queued");
  assert.equal(after.queueSeq, place, "and it keeps its place in the review");
});

test("round 14: a resolved thread stays closed, because only a person closes one", async () => {
  reset();
  const t = await create();
  await post(`/api/file-comments/${t.id}/queue`);
  deliver(t.id, "turn-1");
  const handle = `${loadFileCommentThread(t.id)!.shortId}.1`;
  // The reachable route to `resolved`: the grace window gave up on it, and only then could a
  // person close it - the status route refuses a thread still out with the agent.
  setFileCommentThreadStatus(t.id, "unanswered", Date.now());
  assert.equal((await post(`/api/file-comments/${t.id}/status`, { status: "resolved" })).status, 200);

  const late = await reply({ commentId: handle, body: "answering anyway" });
  assert.equal(late.status, 200);
  assert.equal(late.body.released, false);
  const after = loadFileCommentThread(t.id)!;
  assert.equal(after.messageCount, 2, "the reply is still a record of what was said");
  assert.equal(after.status, "resolved");
});

test("round 17: a reply naming an EARLIER delivery of an outstanding thread releases nothing", async () => {
  reset();
  const t = await create();
  const other = await create({ startLine: 90, endLine: 90, quote: "another paragraph" });
  await post(`/api/file-comments/${t.id}/queue`);
  await post(`/api/file-comments/${other.id}/queue`);
  deliver(t.id, "turn-1");
  const shortId = loadFileCommentThread(t.id)!.shortId;

  // It timed out, a person followed up, and that follow-up was DELIVERED - so the thread is
  // legitimately outstanding again, on its SECOND delivery.
  setFileCommentThreadStatus(t.id, "unanswered", Date.now());
  await post(`/api/file-comments/${t.id}/messages`, { body: "still not right" });
  deliver(t.id, "turn-2");
  assert.equal(loadFileCommentThread(t.id)!.status, "awaiting");

  // The stale reply to the FIRST comment arrives. The thread identifier alone cannot survive
  // this: matching on it would mark the follow-up's delivery answered and release the next
  // comment, having answered nothing. The ordinal refuses that.
  const stale = await reply({ commentId: `${shortId}.1`, body: "about your first point" });
  assert.equal(stale.status, 200);
  assert.equal(stale.body.released, false);
  const after = loadFileCommentThread(t.id)!;
  assert.equal(after.messageCount, 3, "the reply persists");
  assert.equal(after.status, "awaiting", "and the delivery that IS outstanding is still open");

  // Whereas the answer to the delivery actually outstanding does release it.
  const right = await reply({ commentId: `${shortId}.2`, body: "and about the follow-up" });
  assert.equal(right.body.released, true);
  assert.equal(loadFileCommentThread(t.id)!.status, "answered");
});

test("two deliveries sharing a millisecond still resolve to the LATER one", async () => {
  // The same shape as round 17, with the clock pinned instead of trusted. `Date.now()` has
  // millisecond resolution and a timeout, a follow-up, and its send can land inside one tick,
  // so "the greatest delivered_at" is a tie and the tie-break decides which delivery a reply
  // is judged against. Getting it backwards releases the queue on a reply that answered an
  // earlier delivery - which is the whole failure round 17 exists to refuse, reachable
  // without any stale reply at all.
  reset();
  const t = await create();
  const other = await create({ startLine: 90, endLine: 90, quote: "another paragraph" });
  await post(`/api/file-comments/${t.id}/queue`);
  await post(`/api/file-comments/${other.id}/queue`);

  const TICK = 1_770_000_000_000;
  deliver(t.id, "turn-1", TICK);
  const shortId = loadFileCommentThread(t.id)!.shortId;
  setFileCommentThreadStatus(t.id, "unanswered", TICK);
  await post(`/api/file-comments/${t.id}/messages`, { body: "still not right" });
  deliver(t.id, "turn-2", TICK);

  const delivered = loadFileCommentThread(t.id)!.messages.filter((m) => m.author === "human");
  assert.deepEqual(
    delivered.map((m) => m.deliveredAt),
    [TICK, TICK],
    "the fixture really did tie the two deliveries",
  );

  assert.equal(
    (await reply({ commentId: `${shortId}.1`, body: "about your first point" })).body.released,
    false,
    "the earlier delivery is not the outstanding one, however the clock reads",
  );
  assert.equal(
    (await reply({ commentId: `${shortId}.2`, body: "and about the follow-up" })).body.released,
    true,
  );
});

test("round 21: answering a thread that gained a follow-up leaves it QUEUED, never awaiting", async () => {
  reset();
  const t = await create();
  const other = await create({ startLine: 90, endLine: 90, quote: "another paragraph" });
  await post(`/api/file-comments/${t.id}/queue`);
  await post(`/api/file-comments/${other.id}/queue`);
  deliver(t.id, "turn-1");
  const handle = `${loadFileCommentThread(t.id)!.shortId}.1`;

  // A person writes a follow-up while the comment is still out. Appending is allowed; the
  // status must not move, so the thread stays `awaiting` with an undelivered message on it.
  await post(`/api/file-comments/${t.id}/messages`, { body: "and another thing" });
  assert.equal(loadFileCommentThread(t.id)!.status, "awaiting");

  const answered = await reply({ commentId: handle, body: "here is your answer" });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.released, true);

  // The trap: leaving it `awaiting` because it has queued work. `awaiting` is an outstanding
  // status, `queueFileCommentThread` refuses it, and the partial unique index would block
  // every later delivery - so the follow-up could never be sent and the whole review would
  // deadlock behind a comment that had in fact been answered.
  const after = loadFileCommentThread(t.id)!;
  assert.equal(after.status, "queued");
  assert.equal(after.queueSeq, 2, "at the TAIL, behind everything queued since");
  assert.equal(after.deliveryId, null);
  // And the review keeps moving: nothing is outstanding, so the next comment is free to go.
  assert.equal(
    loadFileCommentThreadsForSession("live").filter((x) => x.status === "awaiting").length,
    0,
  );
});

test("a reply arriving while the next delivery is still UNCONFIRMED releases nothing", async () => {
  reset();
  const t = await create();
  await post(`/api/file-comments/${t.id}/queue`);
  deliver(t.id, "turn-1");
  const shortId = loadFileCommentThread(t.id)!.shortId;

  // It timed out, a person followed up, and that follow-up has been handed to the outbox but
  // NOT yet confirmed delivered - the thread is `sending`, and its newest `delivered_at` still
  // names the FIRST delivery.
  setFileCommentThreadStatus(t.id, "unanswered", Date.now());
  await post(`/api/file-comments/${t.id}/messages`, { body: "still not right" });
  beginFileCommentDelivery(t.id, "turn-2", Date.now());
  assert.equal(loadFileCommentThread(t.id)!.status, "sending");

  // Releasing here would mark the thread answered - and clear the correlation - while its turn
  // is genuinely live in `pending_turns`.
  const late = await reply({ commentId: `${shortId}.1`, body: "about your first point" });
  assert.equal(late.status, 200);
  assert.equal(late.body.released, false);
  const after = loadFileCommentThread(t.id)!;
  assert.equal(after.messageCount, 3);
  assert.equal(after.status, "sending");
  assert.equal(after.deliveryId, "turn-2", "the live correlation is untouched");
});
