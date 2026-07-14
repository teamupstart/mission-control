import { test, after } from "node:test";
import assert from "node:assert/strict";
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
