import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkItem, WorkItemState } from "../src/shared/types.ts";

// Point the daemon's state dir at a throwaway home BEFORE anything reads config,
// so this never touches the real ~/.fleet-control db (config.ts resolves the
// state dir at module load, so db must be imported dynamically after).
const home = mkdtempSync(join(tmpdir(), "fleet-queue-db-"));
process.env.FLEET_HOME = home;

const {
  openDb,
  upsertQueue,
  getQueueRow,
  listQueueRows,
  deleteQueue,
  upsertQueueItem,
  getQueueItem,
  listQueueItems,
  deleteQueueItem,
  nextQueueSeq,
  rekeyQueue,
  reorderQueueItems,
} = await import("../src/server/db.ts");

after(() => rmSync(home, { recursive: true, force: true }));

openDb();

let n = 0;
function mkItem(over: Partial<WorkItem> = {}): WorkItem {
  const now = 1000;
  return {
    id: `i${++n}`,
    noteKey: "k1",
    seq: 0,
    intent: "do the thing",
    state: "queued",
    round: 0,
    baseSha: null,
    transcriptAnchor: null,
    gaps: [],
    sendAttempts: 0,
    verifyFailures: 0,
    escalationReason: null,
    lastVerdict: null,
    approvedAt: null,
    proposedPayload: null,
    recoveredAt: null,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    sentAt: null,
    completedAt: null,
    ...over,
  };
}

test("a queue row round-trips and upserts in place", () => {
  upsertQueue({
    noteKey: "k1",
    cwd: "/repo",
    branch: "main",
    wrapupAskedAt: null,
    wrapupAnswer: null,
    updatedAt: 1,
  });
  assert.equal(getQueueRow("k1")?.cwd, "/repo");

  upsertQueue({
    noteKey: "k1",
    cwd: "/repo",
    branch: "feature",
    wrapupAskedAt: 55,
    wrapupAnswer: "ship it",
    updatedAt: 2,
  });
  const r = getQueueRow("k1");
  assert.equal(r?.branch, "feature");
  assert.equal(r?.wrapupAskedAt, 55);
  assert.equal(listQueueRows().filter((q) => q.noteKey === "k1").length, 1, "no duplicate row");
});

test("an item round-trips with its gaps, and upsert updates in place", () => {
  const item = mkItem({
    id: "gapped",
    gaps: [
      {
        id: "g1",
        severity: "blocking",
        kind: "untested",
        path: "src/a.ts",
        detail: "no test covers the new branch",
        fix: "add a test",
        strikes: 2,
        firstSeenRound: 0,
      },
    ],
  });
  upsertQueueItem(item);
  const back = getQueueItem("gapped");
  assert.equal(back?.gaps.length, 1);
  assert.equal(back?.gaps[0]?.strikes, 2);
  assert.equal(back?.gaps[0]?.severity, "blocking");

  upsertQueueItem({ ...item, state: "verified", gaps: [] });
  assert.equal(getQueueItem("gapped")?.state, "verified");
  assert.equal(getQueueItem("gapped")?.gaps.length, 0);
  assert.equal(listQueueItems("k1").filter((i) => i.id === "gapped").length, 1);
});

test("items list in authored order, and nextQueueSeq appends after the last", () => {
  const key = "order-key";
  upsertQueueItem(mkItem({ id: "b", noteKey: key, seq: 1, intent: "second" }));
  upsertQueueItem(mkItem({ id: "a", noteKey: key, seq: 0, intent: "first" }));
  upsertQueueItem(mkItem({ id: "c", noteKey: key, seq: 2, intent: "third" }));
  assert.deepEqual(
    listQueueItems(key).map((i) => i.id),
    ["a", "b", "c"],
  );
  assert.equal(nextQueueSeq(key), 3);
  assert.equal(nextQueueSeq("never-used"), 0, "an empty queue starts at 0");
});

test("queues are isolated per key: one key's items never leak into another's", () => {
  upsertQueueItem(mkItem({ id: "mine", noteKey: "iso-a" }));
  upsertQueueItem(mkItem({ id: "yours", noteKey: "iso-b" }));
  assert.deepEqual(
    listQueueItems("iso-a").map((i) => i.id),
    ["mine"],
  );
  assert.deepEqual(
    listQueueItems("iso-b").map((i) => i.id),
    ["yours"],
  );
});

test("reorder renumbers the whole list in one transaction", () => {
  const key = "reorder-key";
  upsertQueueItem(mkItem({ id: "r1", noteKey: key, seq: 0 }));
  upsertQueueItem(mkItem({ id: "r2", noteKey: key, seq: 1 }));
  upsertQueueItem(mkItem({ id: "r3", noteKey: key, seq: 2 }));

  reorderQueueItems(key, ["r3", "r1", "r2"], 5000);

  const items = listQueueItems(key);
  assert.deepEqual(
    items.map((i) => i.id),
    ["r3", "r1", "r2"],
  );
  // Contiguous from 0 - the authored order is the queue's whole contract, so it
  // must never be left with gaps or collisions.
  assert.deepEqual(
    items.map((i) => i.seq),
    [0, 1, 2],
  );
});

test("reorder leaves an item the client didn't list AFTER the reordered block", () => {
  // A concurrent add races the drop: the new item isn't in the client's id list,
  // so it must keep a stable position rather than colliding at seq 0.
  const key = "reorder-race";
  upsertQueueItem(mkItem({ id: "x1", noteKey: key, seq: 0 }));
  upsertQueueItem(mkItem({ id: "x2", noteKey: key, seq: 1 }));
  upsertQueueItem(mkItem({ id: "late", noteKey: key, seq: 2 }));

  reorderQueueItems(key, ["x2", "x1"], 6000);

  const items = listQueueItems(key);
  assert.deepEqual(
    items.map((i) => i.id),
    ["x2", "x1", "late"],
  );
  assert.equal(items.at(-1)?.seq, 2, "the unlisted item lands right after the block");
});

test("reorder of a PARTIAL list still leaves every unlisted item after the block", () => {
  // The case the "unlisted items are handled" claim actually rests on, and the one
  // the test above passes vacuously: an unlisted row that would COLLIDE. The route
  // only validates that each id it was given is known - it never requires the whole
  // list - so a subset reorder is legal, and here `x1` sits at the very seq the
  // reordered head is about to take. Two rows at seq 0 hands `nextSendable`'s
  // strict `<` to arbitrary row order, i.e. which work instruction gets typed
  // becomes luck. Every seq below is distinct on purpose.
  const key = "reorder-partial";
  upsertQueueItem(mkItem({ id: "p1", noteKey: key, seq: 0 }));
  upsertQueueItem(mkItem({ id: "p2", noteKey: key, seq: 1 }));
  upsertQueueItem(mkItem({ id: "p3", noteKey: key, seq: 2 }));

  reorderQueueItems(key, ["p2"], 6500);

  const items = listQueueItems(key);
  assert.deepEqual(
    items.map((i) => i.id),
    ["p2", "p1", "p3"],
    "the listed item leads; the unlisted ones follow in their authored order",
  );
  assert.deepEqual(
    items.map((i) => i.seq),
    [0, 1, 2],
    "contiguous and collision-free - the head must never be decided by a tie",
  );
});

test("reorder with an empty id list is a no-op, not a renumber to nothing", () => {
  const key = "reorder-empty";
  upsertQueueItem(mkItem({ id: "e1", noteKey: key, seq: 0 }));
  upsertQueueItem(mkItem({ id: "e2", noteKey: key, seq: 1 }));

  reorderQueueItems(key, [], 6600);

  const items = listQueueItems(key);
  assert.deepEqual(
    items.map((i) => i.id),
    ["e1", "e2"],
  );
  assert.deepEqual(
    items.map((i) => i.seq),
    [0, 1],
  );
});

// The single-flight index is the one constraint the whole design rests on: the
// stakes of two in-flight items in one queue are a duplicated WORK INSTRUCTION
// typed into a live agent, which can duplicate commits or re-run migrations. It
// is enforced by the DB rather than by hope, so prove the DB actually rejects it.
const IN_FLIGHT: WorkItemState[] = ["sending", "awaiting_pickup", "in_progress", "verifying"];

test("the single-flight index rejects a second in-flight item in one queue", () => {
  const key = "flight-key";
  upsertQueueItem(mkItem({ id: "f1", noteKey: key, seq: 0, state: "in_progress" }));
  assert.throws(
    () => upsertQueueItem(mkItem({ id: "f2", noteKey: key, seq: 1, state: "sending" })),
    /UNIQUE|constraint/i,
    "a second in-flight item must be rejected by the DB",
  );
});

test("every in-flight state collides with every other one", () => {
  for (const a of IN_FLIGHT) {
    for (const b of IN_FLIGHT) {
      const key = `pair-${a}-${b}`;
      upsertQueueItem(mkItem({ noteKey: key, seq: 0, state: a }));
      assert.throws(
        () => upsertQueueItem(mkItem({ noteKey: key, seq: 1, state: b })),
        /UNIQUE|constraint/i,
        `${a} + ${b} must not coexist`,
      );
    }
  }
});

test("the index constrains one queue only - two queues each run their own item", () => {
  upsertQueueItem(mkItem({ id: "q1-flight", noteKey: "sep-a", state: "in_progress" }));
  upsertQueueItem(mkItem({ id: "q2-flight", noteKey: "sep-b", state: "in_progress" }));
  assert.equal(getQueueItem("q1-flight")?.state, "in_progress");
  assert.equal(getQueueItem("q2-flight")?.state, "in_progress");
});

test("waiting and terminal items are unconstrained - only the cycle is single-flight", () => {
  const key = "many-key";
  upsertQueueItem(mkItem({ noteKey: key, seq: 0, state: "queued" }));
  upsertQueueItem(mkItem({ noteKey: key, seq: 1, state: "queued" }));
  upsertQueueItem(mkItem({ noteKey: key, seq: 2, state: "proposed" }));
  upsertQueueItem(mkItem({ noteKey: key, seq: 3, state: "verified" }));
  upsertQueueItem(mkItem({ noteKey: key, seq: 4, state: "escalated" }));
  upsertQueueItem(mkItem({ noteKey: key, seq: 5, state: "cancelled" }));
  // ...plus exactly one in flight alongside them all.
  upsertQueueItem(mkItem({ noteKey: key, seq: 6, state: "verifying" }));
  assert.equal(listQueueItems(key).length, 7);
});

test("an item leaving the cycle releases the index for the next one", () => {
  // This is what makes the queue advance at all: item N finishes, item N+1 starts.
  const key = "release-key";
  upsertQueueItem(mkItem({ id: "rel1", noteKey: key, seq: 0, state: "verifying" }));
  upsertQueueItem({ ...getQueueItem("rel1")!, state: "verified" });
  upsertQueueItem(mkItem({ id: "rel2", noteKey: key, seq: 1, state: "sending" }));
  assert.equal(getQueueItem("rel2")?.state, "sending");
});

test("deleting an item and a queue row leaves nothing behind", () => {
  upsertQueue({
    noteKey: "gone",
    cwd: "/x",
    branch: null,
    wrapupAskedAt: null,
    wrapupAnswer: null,
    updatedAt: 1,
  });
  upsertQueueItem(mkItem({ id: "doomed", noteKey: "gone" }));
  deleteQueueItem("doomed");
  deleteQueue("gone");
  assert.equal(getQueueItem("doomed"), undefined);
  assert.equal(getQueueRow("gone"), undefined);
});

test("the single-flight index is rebuilt when its predicate drifts from the shared constant", () => {
  // Deriving the index SQL from IN_FLIGHT_ITEM_STATES only makes the enforcement
  // agree with its readers on a FRESH db - `CREATE UNIQUE INDEX IF NOT EXISTS`
  // leaves an existing index alone. So a db written by an older build would keep
  // enforcing the OLD predicate while both TypeScript readers used the new one: the
  // same silent drift the shared constant exists to prevent, just deferred to
  // upgrade time. The stakes are two items in flight in one queue, i.e. a duplicated
  // work instruction typed into a live agent.
  //
  // Across two PROCESSES on one db file, because that's the only way the repair can
  // actually happen: openDb caches its handle, so migrate runs once per start.
  const drifted = mkdtempSync(join(tmpdir(), "fleet-drift-"));
  const run = (src: string): string =>
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", src], {
      env: { ...process.env, FLEET_HOME: drifted },
      encoding: "utf8",
      cwd: process.cwd(),
    }).trim();

  const READ = `const d = (await import("./src/server/db.ts")).openDb();
    console.log(d.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='one_inflight_per_queue'").get().sql);`;

  // A fresh db derives the full in-flight set from the constant.
  assert.match(run(READ), /'verifying'/);

  // Rewrite it the way an older build would have left it, then start again.
  run(`const d = (await import("./src/server/db.ts")).openDb();
    d.exec("DROP INDEX one_inflight_per_queue;");
    d.exec("CREATE UNIQUE INDEX one_inflight_per_queue ON foreman_queue_items(note_key) WHERE state IN ('sending','awaiting_pickup','in_progress');");`);

  assert.match(run(READ), /'verifying'/, "the next start rebuilds it from the constant");

  // And the repaired index really enforces the state it regained: a second
  // `verifying` item in one queue is rejected by the db, not merely by hope.
  const guard = run(`const db = await import("./src/server/db.ts");
    db.openDb();
    db.upsertQueue({ noteKey: "drift", cwd: null, branch: null, wrapupAskedAt: null, wrapupAnswer: null, updatedAt: 0 });
    const mk = (id, seq) => ({ id, noteKey: "drift", seq, intent: "i", state: "verifying", round: 0,
      baseSha: null, transcriptAnchor: null, gaps: [], sendAttempts: 0, verifyFailures: 0,
      escalationReason: null, lastVerdict: null, approvedAt: null, proposedPayload: null,
      recoveredAt: null, revision: 0, createdAt: 0, updatedAt: 0, sentAt: null, completedAt: null });
    db.upsertQueueItem(mk("d1", 0));
    try { db.upsertQueueItem(mk("d2", 1)); console.log("ACCEPTED"); }
    catch { console.log("REJECTED"); }`);
  assert.equal(guard, "REJECTED", "two items must never be in flight in one queue");

  rmSync(drifted, { recursive: true, force: true });
});

test("a single-flight rebuild that CANNOT succeed keeps the old index and still opens", () => {
  // The failure path of the rebuild above, which the success-path test can't reach.
  // Widening the predicate can surface rows that already violate it - that's worth
  // reporting, but not worth refusing to open the db over.
  //
  // DDL is transactional in SQLite, and that is load-bearing here rather than tidy.
  // Without a transaction the DROP commits on its own: the CREATE then fails on the
  // violating rows, the catch logs, and the table is left with NO index at all. So
  // single-flight enforcement is silently gone AND the next openDb() runs
  // `CREATE UNIQUE INDEX IF NOT EXISTS` against those same rows with nothing to make
  // it a no-op, throws uncaught, and the daemon never starts again - the exact
  // bricking the catch was written to prevent.
  //
  // Hence THREE starts: the bug is invisible on the start that drops the index and
  // only bites on the one after it.
  const stuck = mkdtempSync(join(tmpdir(), "fleet-stuck-"));
  const run = (src: string): string =>
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", src], {
      env: { ...process.env, FLEET_HOME: stuck },
      encoding: "utf8",
      cwd: process.cwd(),
    }).trim();

  const READ = `const d = (await import("./src/server/db.ts")).openDb();
    const r = d.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='one_inflight_per_queue'").get();
    console.log(r ? r.sql : "NO INDEX");`;

  // Start 1: narrow the index the way an older build left it, then seed two
  // `verifying` items in ONE queue. That's legal under the narrow predicate and a
  // violation of the widened one, so the next start's rebuild cannot succeed.
  run(`const db = await import("./src/server/db.ts");
    const d = db.openDb();
    d.exec("DROP INDEX one_inflight_per_queue;");
    d.exec("CREATE UNIQUE INDEX one_inflight_per_queue ON foreman_queue_items(note_key) WHERE state IN ('sending','awaiting_pickup','in_progress');");
    db.upsertQueue({ noteKey: "stuck", cwd: null, branch: null, wrapupAskedAt: null, wrapupAnswer: null, updatedAt: 0 });
    const mk = (id, seq) => ({ id, noteKey: "stuck", seq, intent: "i", state: "verifying", round: 0,
      baseSha: null, transcriptAnchor: null, gaps: [], sendAttempts: 0, verifyFailures: 0,
      escalationReason: null, lastVerdict: null, approvedAt: null, proposedPayload: null,
      recoveredAt: null, revision: 0, createdAt: 0, updatedAt: 0, sentAt: null, completedAt: null });
    db.upsertQueueItem(mk("k1", 0));
    db.upsertQueueItem(mk("k2", 1));`);

  // Start 2: the rebuild is attempted and fails. The db must still open, and the old
  // index must still be there enforcing what it can.
  const second = run(READ);
  assert.notEqual(second, "NO INDEX", "a failed rebuild must not leave the table unindexed");
  assert.doesNotMatch(second, /'verifying'/, "the old, narrower index is kept");

  // Start 3: the one that actually catches it. An uncommitted DROP leaves openDb's
  // own CREATE UNIQUE INDEX to throw here, and the daemon never starts again.
  assert.doesNotThrow(
    () => run(READ),
    "a db whose rebuild failed must still open on every subsequent start",
  );

  rmSync(stuck, { recursive: true, force: true });
});

test("rekeyQueue moves a whole queue onto a new key", () => {
  upsertQueue({ noteKey: "rk-from", cwd: "/r", branch: "b", wrapupAskedAt: 7, wrapupAnswer: null, updatedAt: 1 });
  const a = mkItem({ noteKey: "rk-from", seq: 0, intent: "first" });
  const b = mkItem({ noteKey: "rk-from", seq: 1, intent: "second" });
  upsertQueueItem(a);
  upsertQueueItem(b);

  rekeyQueue(
    "rk-from",
    { noteKey: "rk-to", cwd: "/r", branch: "b", wrapupAskedAt: 7, wrapupAnswer: null, updatedAt: 2 },
    [
      { ...a, noteKey: "rk-to", seq: 0 },
      { ...b, noteKey: "rk-to", seq: 1 },
    ],
  );

  assert.equal(getQueueRow("rk-from"), undefined, "the source row is gone");
  assert.deepEqual(listQueueItems("rk-from"), []);
  assert.deepEqual(
    listQueueItems("rk-to").map((i) => i.intent),
    ["first", "second"],
    "in authored order, on the new key",
  );
});

test("rekeyQueue ROLLS BACK a half-applied move - the batch is never split", () => {
  // The whole reason this is one transaction. Statement-by-statement, a throw partway
  // leaves some items re-keyed under a queue row that may already be deleted and the
  // rest on the old key: a split no reader models, and one the re-attach button can't
  // repair, since the hint it keys off is computed from the very rows that got moved.
  upsertQueue({ noteKey: "rb-from", cwd: "/r", branch: "b", wrapupAskedAt: null, wrapupAnswer: null, updatedAt: 1 });
  const good = mkItem({ noteKey: "rb-from", seq: 0, intent: "keep me" });
  const also = mkItem({ noteKey: "rb-from", seq: 1, intent: "and me" });
  upsertQueueItem(good);
  upsertQueueItem(also);

  // The second write is rejected by SQLite (intent is NOT NULL) AFTER the first has
  // already been re-keyed - the exact "died partway" shape.
  assert.throws(() =>
    rekeyQueue(
      "rb-from",
      { noteKey: "rb-to", cwd: "/r", branch: "b", wrapupAskedAt: null, wrapupAnswer: null, updatedAt: 2 },
      [
        { ...good, noteKey: "rb-to", seq: 0 },
        { ...also, noteKey: "rb-to", seq: 1, intent: null as unknown as string },
      ],
    ),
  );

  assert.ok(getQueueRow("rb-from"), "the source queue row survives");
  assert.equal(getQueueRow("rb-to"), undefined, "and no half-built target row is left behind");
  assert.deepEqual(
    listQueueItems("rb-from").map((i) => i.intent),
    ["keep me", "and me"],
    "every item is still on the source key - all of it, or none of it",
  );
  assert.deepEqual(listQueueItems("rb-to"), [], "nothing leaked onto the target");
});
