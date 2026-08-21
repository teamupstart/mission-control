import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: the phase plan names this as one of the two things that fail SILENTLY.
// Cleanup keyed on the wrong signal - `state === "exited"` - settles a live agent's review
// on one hiccuping sweep, and `orphaned` is terminal, so there is no way back. The other
// half is the arm nobody writes: a session that went away while the daemon was DOWN is in no
// map at all until discovery rebuilds it, so `session_remove` never fires for it and its
// threads survive for ever.

const home = mkdtempSync(join(tmpdir(), "mission-file-comments-lifecycle-"));
process.env.MISSION_HOME = home;

const { FileCommentManager } = await import("../src/server/file-comments.ts");
const { Registry } = await import("../src/server/registry.ts");
const {
  createFileCommentThread,
  loadFileCommentThread,
  openDb,
  pruneFileCommentThreads,
  queueFileCommentThread,
} = await import("../src/server/db.ts");
type Registry = import("../src/server/registry.ts").Registry;
type ServerEvent = import("../src/shared/types.ts").ServerEvent;
type FileCommentThread = import("../src/shared/types.ts").FileCommentThread;

after(() => rmSync(home, { recursive: true, force: true }));

/**
 * A Registry stand-in with the two subscription seams the manager uses, plus the live
 * collection. `observe()` is the first COMPLETED sweep, deliberately separate from
 * construction - that separation is the thing under test in the restart case.
 */
function harness() {
  const held = new Map<string, FileCommentThread>();
  const sessions = new Set<string>();
  const events: ServerEvent[] = [];
  let onEvent: ((e: ServerEvent) => void) | null = null;
  let onObserved: (() => void) | null = null;
  const registry = {
    getSession: (id: string) => (sessions.has(id) ? { id } : undefined),
    subscribe: (fn: (e: ServerEvent) => void) => {
      onEvent = fn;
      return () => {};
    },
    onSessionsObserved: (fn: () => void) => {
      onObserved = fn;
      return () => {};
    },
    listFileCommentThreads: () => [...held.values()],
    getFileCommentThread: (id: string) => held.get(id),
    fileCommentThreadsForSession: (sessionId: string) =>
      [...held.values()].filter((t) => t.sessionId === sessionId),
    upsertFileCommentThread: (thread: FileCommentThread) => {
      held.set(thread.id, thread);
      events.push({ type: "file_comment_thread_upsert", thread });
    },
    removeFileCommentThread: (id: string) => {
      if (held.delete(id)) events.push({ type: "file_comment_thread_remove", id });
    },
    pruneFileComments: () => 0,
  } as unknown as Registry;
  const manager = new FileCommentManager(registry);
  return {
    manager,
    events,
    held,
    live: (id: string) => sessions.add(id),
    emit: (e: ServerEvent) => onEvent?.(e),
    observe: () => onObserved?.(),
  };
}

let seq = 0;
function seed(sessionId: string, held?: Map<string, FileCommentThread>): FileCommentThread {
  seq += 1;
  const thread = createFileCommentThread({
    id: `lt-${seq}`,
    messageId: `lm-${seq}`,
    sessionId,
    path: "docs/plan.md",
    startLine: 1,
    endLine: 1,
    quote: "alpha",
    quoteHash: `h-${seq}`,
    revision: "r1",
    surface: "editor",
    body: "a comment a human wrote",
    now: 1_000,
  });
  const queued = queueFileCommentThread(thread.id, 1_001)!;
  held?.set(queued.id, queued);
  return queued;
}

beforeEach(() => {
  const db = openDb();
  db.exec("DELETE FROM file_comment_messages");
  db.exec("DELETE FROM file_comment_threads");
  db.exec("DELETE FROM file_comment_reviews");
});

test("session_remove orphans that session's threads, by UPDATE, and leaves others alone", () => {
  const h = harness();
  const mine = seed("gone", h.held);
  const yours = seed("staying", h.held);

  h.emit({ type: "session_remove", id: "gone" });

  const settled = loadFileCommentThread(mine.id);
  assert.equal(settled?.status, "orphaned");
  assert.equal(settled?.queueSeq, null);
  // Not a DELETE: the comment a human wrote is a record of what was asked.
  assert.equal(settled?.messages[0]?.body, "a comment a human wrote");
  assert.equal(loadFileCommentThread(yours.id)?.status, "queued");
  // It leaves the LIVE collection, because there is nothing left to act on.
  assert.deepEqual(
    h.events.map((e) => [e.type, e.type === "file_comment_thread_remove" ? e.id : ""]),
    [["file_comment_thread_remove", mine.id]],
  );
  assert.equal(h.held.has(mine.id), false);
});

test("state === \"exited\" alone changes NOTHING", () => {
  // The signal that must never be the one keyed on. An exited card is still on screen with
  // its file open, and a hiccuping sweep must not settle a live agent's review.
  const h = harness();
  const t = seed("blinking", h.held);
  h.emit({
    type: "session_upsert",
    session: { id: "blinking", state: "exited" } as never,
  });
  assert.equal(loadFileCommentThread(t.id)?.status, "queued");
  assert.deepEqual(h.events, []);
  assert.equal(h.held.has(t.id), true);
});

test("the first completed sweep settles threads whose session went away while we were down", () => {
  // Without this arm those rows survive for ever: they are in no map at all until discovery
  // rebuilds it, so `session_remove` never fires for them.
  const h = harness();
  const survivor = seed("still-here", h.held);
  const stranded = seed("vanished", h.held);
  h.live("still-here");

  h.observe();

  assert.equal(loadFileCommentThread(stranded.id)?.status, "orphaned");
  assert.equal(
    loadFileCommentThread(survivor.id)?.status,
    "queued",
    "a session that outlived the restart keeps every thread it owns",
  );
  assert.deepEqual(
    h.events.filter((e) => e.type === "file_comment_thread_remove").map((e) => e.id),
    [stranded.id],
  );
});

test("a session that is merely idle or disconnected keeps its threads", () => {
  const h = harness();
  const t = seed("quiet", h.held);
  h.live("quiet");
  h.observe();
  h.emit({ type: "session_upsert", session: { id: "quiet", state: "idle" } as never });
  assert.equal(loadFileCommentThread(t.id)?.status, "queued");
  assert.deepEqual(h.events, []);
});

test("the prune is the third mechanism, and never the first two's substitute", () => {
  // Orphaning keeps the row; only the prune deletes it, and only when it is terminal AND its
  // session key is gone AND it is past the window.
  const h = harness();
  const t = seed("gone", h.held);
  h.emit({ type: "session_remove", id: "gone" });
  assert.ok(loadFileCommentThread(t.id), "orphaning alone deletes nothing");

  const survivor = seed("alive", h.held);
  h.live("alive");
  // An EMPTY live set means "liveness unknown", never "nothing is live".
  assert.equal(pruneFileCommentThreads([], Date.now()), 0);
  assert.ok(loadFileCommentThread(t.id));

  assert.equal(pruneFileCommentThreads(["alive"], Date.now()), 1);
  assert.equal(loadFileCommentThread(t.id), null);
  assert.ok(loadFileCommentThread(survivor.id), "a live session's thread is never pruned");
});

test("the registry's prune is gated on the first completed sweep", () => {
  // The trap `pruneGoals` documents at length, and it applies identically here: "no live
  // session owns this thread" is a claim about the session map, and before the first sweep
  // that map is empty because nobody has filled it in - not because there are no sessions.
  // The constructor loads the whole thread table while it is still empty, so an ungated
  // sweep at boot would read every thread as stranded.
  const t = seed("gone");
  const registry = new Registry();
  assert.equal(registry.pruneFileComments(Date.now()), 0);
  assert.ok(loadFileCommentThread(t.id), "nothing may be deleted before the first sweep");
});

test("a manager that was never started leaves no timer behind", () => {
  // The accommodation every optional service in `buildApp` documents: ~50 focused route
  // tests construct one, and a constructor-armed interval would keep the runner alive.
  const h = harness();
  h.manager.stop();
  h.manager.start();
  h.manager.stop();
  assert.ok(true);
});
