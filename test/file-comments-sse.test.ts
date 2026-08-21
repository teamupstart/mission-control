import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// What is at stake: line-comment threads are SSE state, not a second polling subsystem. A
// reconnect snapshot and the incremental stream have to converge on the same set, and the
// browser has to REPLACE a thread rather than merge it - a marker drawn from two instants
// would show a status from one and replies from another.
//
// The source-parity assertions at the bottom check the shape of the browser's handling,
// which the `never` exhaustiveness check cannot see: it proves an arm EXISTS, not that the
// arm keys the collection correctly or that nobody added a poll beside it.

const home = mkdtempSync(join(tmpdir(), "mission-file-comments-sse-"));
process.env.HARNESS_HOME = join(home, "state");

const {
  createFileCommentThread,
  loadFileCommentThread,
  openDb,
  appendFileCommentMessage,
  queueFileCommentThread,
} = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { FILE_COMMENT_QUOTE_MAX } = await import("../src/shared/file-comment-anchor.ts");
const { FILE_COMMENT_THREAD_MESSAGE_CAP } = await import("../src/shared/file-comments.ts");
type ServerEvent = import("../src/shared/types.ts").ServerEvent;
type FileCommentThread = import("../src/shared/types.ts").FileCommentThread;

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));

function clear(): void {
  db.exec("DELETE FROM file_comment_messages");
  db.exec("DELETE FROM file_comment_threads");
}

let seq = 0;
function seed(over: Partial<Parameters<typeof createFileCommentThread>[0]> = {}): FileCommentThread {
  seq += 1;
  return createFileCommentThread({
    id: `st-${seq}`,
    messageId: `sm-${seq}`,
    sessionId: "s1",
    path: "docs/plan.md",
    startLine: 84,
    endLine: 86,
    quote: "the paragraph as it currently reads",
    quoteHash: "a".repeat(64),
    revision: "r1",
    surface: "editor",
    body: "This contradicts the diagram above it.",
    now: 1_700_000_000_000 + seq,
    ...over,
  });
}

test("an untouched fleet carries an empty collection, not an absent one", () => {
  // The shipped state, and the one every existing surface has to keep behaving under: an
  // array the browser holds and never renders. An absent field would make a build without
  // this feature and a fleet with no comments indistinguishable on the wire.
  clear();
  assert.deepEqual(new Registry().snapshot().fileCommentThreads, []);
});

test("a thread survives a daemon restart and is in the reconnect snapshot", () => {
  // The whole point of persisting drafts from the first keystroke: a restart must hand a
  // reconnecting dashboard the queue it was looking at, not a blank gutter.
  clear();
  const t = seed();
  queueFileCommentThread(t.id, 1_700_000_000_100);
  const rebooted = new Registry().snapshot().fileCommentThreads;
  assert.deepEqual(
    rebooted.map((x) => [x.id, x.status, x.queueSeq]),
    [[t.id, "queued", 0]],
  );
  assert.equal(rebooted[0]?.messages.length, 1, "a thread arrives WITH its messages");
});

test("snapshot, upsert and remove converge on one collection", () => {
  clear();
  const registry = new Registry();
  const opening = registry.snapshot().fileCommentThreads;

  const events: ServerEvent[] = [];
  const unsubscribe = registry.subscribe((event) => events.push(event));
  const a = seed();
  const b = seed({ path: "docs/other.md" });
  registry.upsertFileCommentThread(a);
  registry.upsertFileCommentThread(b);
  registry.upsertFileCommentThread(queueFileCommentThread(a.id, 1_700_000_001_000)!);
  registry.removeFileCommentThread(b.id);
  // A remove for a thread nobody is holding publishes nothing: every open window would
  // otherwise redraw a collection that never moved.
  registry.removeFileCommentThread("never-existed");
  unsubscribe();

  assert.deepEqual(
    [...new Set(events.map((e) => e.type))],
    ["file_comment_thread_upsert", "file_comment_thread_remove"],
  );

  // Reduce the frames onto the opening snapshot the way the browser does, and the result
  // must be what a freshly connected dashboard is handed.
  const reduced = new Map(opening.map((t) => [t.id, t]));
  for (const event of events) {
    if (event.type === "file_comment_thread_upsert") reduced.set(event.thread.id, event.thread);
    if (event.type === "file_comment_thread_remove") reduced.delete(event.id);
  }
  assert.deepEqual(
    [...reduced.values()],
    registry.snapshot().fileCommentThreads,
    "the stream and the snapshot must describe the same collection",
  );
});

test("a thread is replaced whole, never merged", () => {
  // A marker whose status came from one instant and whose replies came from another is a
  // picture of a conversation that never happened.
  clear();
  const registry = new Registry();
  const t = seed();
  registry.upsertFileCommentThread(t);
  appendFileCommentMessage({
    id: "reply-1",
    threadId: t.id,
    author: "agent",
    sessionId: "s1",
    body: "the agent's answer",
    now: 1_700_000_002_000,
  });
  registry.upsertFileCommentThread(loadFileCommentThread(t.id)!);
  assert.deepEqual(
    registry.snapshot().fileCommentThreads[0]?.messages.map((m) => m.author),
    ["human", "agent"],
  );
});

test("an orphaned thread leaves the live collection, so nothing accumulates", () => {
  // The collection is bounded by LIVE SESSIONS. The durable row survives by UPDATE; this is
  // only about what a browser should stop holding.
  clear();
  const registry = new Registry();
  const t = seed();
  registry.upsertFileCommentThread(t);
  registry.removeFileCommentThread(t.id);
  assert.deepEqual(registry.snapshot().fileCommentThreads, []);
  // The boot load excludes it too, which is what keeps a restart from resurrecting it.
  db.prepare("UPDATE file_comment_threads SET status = 'orphaned' WHERE id = ?").run(t.id);
  assert.deepEqual(new Registry().snapshot().fileCommentThreads, []);
});

test("one thread stays small enough that a whole fleet of them rides the snapshot", () => {
  // The budget this collection answers to, expressed PER THREAD, because per-thread size is
  // what a later phase can move and the fleet total is then arithmetic anybody can do.
  //
  // Measured against the WORST realistic thread: the quote at its cap, a long path, and a
  // full reply history at the message cap. That is the ceiling, not the typical case - a
  // real thread is one paragraph and two replies, at a few hundred bytes.
  clear();
  const registry = new Registry();
  const t = seed({
    path: "docs/plans/a-fairly-long-plan-directory-name/phase-1-anchor-and-model.md",
    quote: "x".repeat(FILE_COMMENT_QUOTE_MAX),
  });
  for (let i = 0; i < FILE_COMMENT_THREAD_MESSAGE_CAP + 10; i += 1) {
    appendFileCommentMessage({
      id: `bulk-${i}`,
      threadId: t.id,
      author: i % 2 === 0 ? "agent" : "human",
      sessionId: "s1",
      body: "a realistic reply that runs to about a line and a half of ordinary review prose.",
      now: 1_700_000_003_000 + i,
    });
  }
  const loaded = loadFileCommentThread(t.id)!;
  // The cap is what keeps a conversation on one line from deciding the snapshot's size, and
  // `messageCount` is how a surface knows it is looking at a tail.
  assert.equal(loaded.messages.length, FILE_COMMENT_THREAD_MESSAGE_CAP);
  assert.equal(loaded.messageCount, FILE_COMMENT_THREAD_MESSAGE_CAP + 11);
  assert.equal(loaded.messages.at(-1)?.body.startsWith("a realistic"), true);

  registry.upsertFileCommentThread(loaded);
  const bytes = new TextEncoder().encode(
    JSON.stringify(registry.snapshot().fileCommentThreads),
  ).byteLength;
  // Measured today: ~17kB for that worst case, of which ~4kB is the capped quote and the
  // rest is fifty capped replies. A `FileCommentThread` that grew past 24kB would mean one
  // of the two caps had moved, and the answer then is to fetch the long thread on demand
  // from `GET /api/file-comments/:id` - NOT to widen this number, which is why the failure
  // message says so.
  assert.ok(
    bytes < 24_576,
    `the worst realistic thread is ${bytes} bytes on the wire; fetch a long thread from ` +
      `GET /api/file-comments/:id rather than widening the snapshot`,
  );
  // The fleet arithmetic: a hundred WORST-case threads would be ~1.7MB, which is exactly why
  // the caps are per thread rather than per fleet. A realistic review is tens of ordinary
  // threads - one paragraph and two replies each, a few hundred bytes - so a busy fleet
  // carries single-digit kilobytes here, beside a snapshot that already holds every session,
  // task and workflow run.
});

test("the browser handles both frames, keys them by id, and polls nothing", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "src", "web", "useEventStream.ts"),
    "utf8",
  );
  assert.match(source, /case "file_comment_thread_upsert":/);
  assert.match(source, /case "file_comment_thread_remove":/);
  assert.match(
    source,
    /setFileCommentThreads\(\(prev\) => new Map\(prev\)\.set\(msg\.thread\.id, msg\.thread\)\)/,
  );
  // Seeded from the snapshot, wholesale, with the version-skew guard an older daemon needs.
  assert.match(
    source,
    /new Map\(\(msg\.fileCommentThreads \?\? \[\]\)\.map\(\(thread\) => \[thread\.id, thread\]\)\)/,
  );
  // The exhaustiveness check is what makes a THIRD frame impossible to add silently.
  assert.match(source, /const unhandled: never = msg;/);
  // And nothing polls a file-comments route from the stream hook.
  assert.equal(/setInterval[^\n]*[Ff]ileComment/.test(source), false);
});

test("file-comment frames are deliberately not Line inputs", () => {
  // The Line folds EXECUTION. A line comment is authoring state, in the same class as
  // personas and workflow definitions: writing one starts nothing and finishes nothing, and
  // drafts are persisted from the first keystroke, so membership would buy a refold per
  // keystroke for a fold whose output could not move. Pinned because `LINE_INPUT_EVENTS` is
  // a `Set` literal: the compiler cannot ask, so this does.
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "src", "server", "registry.ts"),
    "utf8",
  );
  const start = source.indexOf("const LINE_INPUT_EVENTS");
  const block = source.slice(start, source.indexOf("]);", start));
  assert.ok(block.length > 0, "LINE_INPUT_EVENTS should still be a literal Set");
  assert.equal(/"file_comment_thread_upsert"/.test(block), false);
  assert.equal(/"file_comment_thread_remove"/.test(block), false);
  // And the decision is WRITTEN beside the set rather than merely acted on, which is what
  // `change-contracts.md` asks for.
  assert.match(block, /file_comment_thread_upsert/);
});
