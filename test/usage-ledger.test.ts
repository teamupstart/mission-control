import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: the difference between "we were not told" and "it cost nothing".
//
// Those are different claims and only one of them is ever true of a session with no ledger
// rows, but SQL will happily blur them - `SUM` over no rows is NULL, and one stray `?? 0`
// turns an untracked session into one that confidently reports $0.00 on a card. The other
// half is per-column replacement: cost and tokens arrive as SEPARATE metrics sharing one
// window, so a writer that replaced the whole row would have each metric erase the other's
// figures on arrival, and the ledger would hold only whichever landed last.

const home = mkdtempSync(join(tmpdir(), "mission-ledger-"));
process.env.MISSION_HOME = home;

const {
  openDb,
  fleetSpendSince,
  pruneUsageLedger,
  sessionCostFor,
  upsertUsageCell,
  usageLedgerHasRows,
} = await import("../src/server/db.ts");

after(() => rmSync(home, { recursive: true, force: true }));

openDb();

function cell(noteKey: string, windowEndNs: string, ts: number) {
  return {
    noteKey,
    sessionId: null,
    agent: "claude",
    modelId: "claude-opus-4-8[1m]",
    querySource: "main",
    windowEndNs,
    ts,
  };
}

test("an unseen key reports null, not a zeroed summary", () => {
  assert.equal(sessionCostFor("never-heard-of-it"), null);
});

test("the ledger reports whether it holds anything at all", () => {
  // Before anything is written this is the honest answer to "has telemetry ever arrived",
  // which is what tells an unconfigured install apart from a quiet one.
  const before = usageLedgerHasRows();
  upsertUsageCell(cell("k-any", "1000000000000000001", 1_000), "costUsd", 0.01);
  assert.equal(before, false);
  assert.equal(usageLedgerHasRows(), true);
});

test("per-column writes preserve each other within one window", () => {
  const k = cell("k-cols", "1784489513488000000", 1_700_000_000_000);
  upsertUsageCell(k, "costUsd", 0.4);
  upsertUsageCell(k, "input", 12);
  upsertUsageCell(k, "output", 34);
  upsertUsageCell(k, "cacheRead", 56);
  upsertUsageCell(k, "cacheWrite", 78);
  const cost = sessionCostFor("k-cols");
  assert.deepEqual(
    { ...cost, updatedAt: 0 },
    { costUsd: 0.4, input: 12, output: 34, cacheRead: 56, cacheWrite: 78, updatedAt: 0 },
    "cost and tokens are separate metrics on one window - neither may erase the other",
  );
});

test("a replayed cell replaces rather than adds", () => {
  const k = cell("k-replay", "1784489513488000000", 1_700_000_000_000);
  upsertUsageCell(k, "costUsd", 0.9);
  upsertUsageCell(k, "costUsd", 0.9);
  upsertUsageCell(k, "costUsd", 0.9);
  assert.equal(sessionCostFor("k-replay")?.costUsd, 0.9);
});

test("`updatedAt` follows the newest window, and a replace moves it forward", () => {
  upsertUsageCell(cell("k-fresh", "1784489513488000000", 5_000), "costUsd", 0.1);
  upsertUsageCell(cell("k-fresh", "1784489573488000000", 9_000), "costUsd", 0.1);
  assert.equal(sessionCostFor("k-fresh")?.updatedAt, 9_000);
  // A cumulative series replaces one row repeatedly; its freshness must still advance,
  // or a live session would look frozen at the moment it started.
  upsertUsageCell(cell("k-fresh", "1784489573488000000", 12_000), "costUsd", 0.2);
  assert.equal(sessionCostFor("k-fresh")?.updatedAt, 12_000);
});

test("keys are independent - one session's spend is never another's", () => {
  upsertUsageCell(cell("k-a", "2000000000000000000", 1_000), "costUsd", 1);
  upsertUsageCell(cell("k-b", "2000000000000000000", 1_000), "costUsd", 2);
  assert.equal(sessionCostFor("k-a")?.costUsd, 1);
  assert.equal(sessionCostFor("k-b")?.costUsd, 2);
});

test("fleetSpendSince windows on ts, and reports 0 rather than null for an empty window", () => {
  upsertUsageCell(cell("k-win", "3000000000000000001", 10_000), "costUsd", 5);
  upsertUsageCell(cell("k-win", "3000000000000000002", 20_000), "costUsd", 7);
  assert.equal(fleetSpendSince(20_000) >= 7, true, "the newer window is in range");
  assert.equal(fleetSpendSince(9_000) >= 12, true, "both windows are in range");
  // 0, not null: "nothing was spent in the last hour" IS a fact, unlike an unseen key.
  assert.equal(fleetSpendSince(Date.now() + 86_400_000), 0);
});

test("pruning is by age alone and leaves newer rows untouched", () => {
  upsertUsageCell(cell("k-old", "4000000000000000001", 1_000), "costUsd", 3);
  upsertUsageCell(cell("k-old", "4000000000000000002", 100_000), "costUsd", 4);
  const removed = pruneUsageLedger(50_000);
  assert.ok(removed >= 1, "the row older than the cutoff goes");
  const cost = sessionCostFor("k-old");
  assert.equal(cost?.costUsd, 4, "the newer one stays, whatever session it belonged to");
});
