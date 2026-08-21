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
  loadFileCommentThread,
  openDb,
  loadFileCommentThreadsForSession,
  orphanFileCommentThreadsForSession,
  setFileCommentThreadStatus,
} = await import("../src/server/db.ts");
const { FILE_COMMENT_THREAD_MESSAGE_CAP } = await import("../src/shared/file-comments.ts");
type Registry = import("../src/server/registry.ts").Registry;
type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
type TaskManager = import("../src/server/tasks.ts").TaskManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;
type FileCommentThread = import("../src/shared/types.ts").FileCommentThread;
type ServerEvent = import("../src/shared/types.ts").ServerEvent;

after(() => rmSync(home, { recursive: true, force: true }));

const events: ServerEvent[] = [];
const held = new Map<string, FileCommentThread>();
const sessions = new Set(["live"]);

const registry = {
  getSession: (id: string) => (sessions.has(id) ? { id, cwd: "/tmp" } : undefined),
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
} as unknown as Registry;

const stub = <T,>() => ({}) as unknown as T;
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

test("a comment out with the agent cannot be settled out from under its delivery", async () => {
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

  // The longer half of the outstanding window is refused for the same reason.
  markFileCommentMessageDelivered(loadFileCommentThread(t.id)!.messages[0]!.id, Date.now());
  assert.equal(loadFileCommentThread(t.id)?.status, "awaiting");
  assert.equal((await post(`/api/file-comments/${t.id}/status`, { status: "resolved" })).status, 409);

  // And this is not a hang. The grace window moves `awaiting` to `unanswered`, which sits
  // OUTSIDE the outstanding tuple precisely so the queue can move on - and from there a
  // person can close the thread normally.
  setFileCommentThreadStatus(t.id, "unanswered", Date.now());
  assert.equal((await post(`/api/file-comments/${t.id}/status`, { status: "resolved" })).status, 200);
  assert.equal(loadFileCommentThread(t.id)?.status, "resolved");
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
