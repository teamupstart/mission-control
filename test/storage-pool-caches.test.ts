import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { openDb } from "../src/server/db.ts";
import { planIdleCache } from "../src/server/storage-pools.ts";
import { WorktreeManager, type NativePoolStatus, type NativeSlotStatus } from "../src/server/worktrees/manager.ts";
import { WorktreeOperationsService } from "../src/server/worktrees/operations.ts";
import { CheckLeaseManager } from "../src/server/workflows/check-lease.ts";
import { LegacyTreehouseService } from "../src/server/worktrees/legacy-treehouse.ts";
import type { WorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";
import type { WorktreeSlotRow } from "../src/server/worktrees/store.ts";
import {
  WORKTREE_INVENTORY_LIMITS,
  worktreeRetryRequest,
  type WorktreeOperationView,
} from "../src/shared/worktrees.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";

// What is at stake: the idle-cache budget is the first thing in Storage that can remove a warm
// checkout. These pin that it only ever chooses idle slots, keeps each pool's warmest ones,
// skips anything Safe prune would refuse while saying why, and that what Execute removes is
// exactly the set the operator was shown.

const GIB = 1024 ** 3;

function slot(
  id: string,
  state: string,
  { ordinal, lastUsedAt = null, dirty = false }: { ordinal: number; lastUsedAt?: number | null; dirty?: boolean },
): NativeSlotStatus {
  return {
    slot: { id, poolId: "", ordinal, path: `/pools/${id}`, state, version: 1, lastUsedAt } as unknown as WorktreeSlotRow,
    nativePath: true,
    registered: true,
    repositoryMatches: true,
    observedHead: "abc",
    dirty,
    occupancy: { status: "known", occupants: [] },
    ownerReferenced: false,
    mergedIntoDefault: true,
  };
}

function pool(id: string, slots: NativeSlotStatus[]): NativePoolStatus {
  for (const entry of slots) entry.slot.poolId = id;
  return {
    pool: { id, poolPath: `/state/worktree-pools/${id}-0123456789abcdef` } as NativePoolStatus["pool"],
    policy: { enabled: true, maxSlots: 16, setupArgv: null } as NativePoolStatus["policy"],
    identityValid: true,
    markerValid: true,
    observedDefaultSha: "abc",
    defaultFingerprint: null,
    slots,
  };
}

function fleet(overrides: { dirtyA3?: boolean } = {}): NativePoolStatus[] {
  return [
    pool("web", [
      slot("a1", "available", { ordinal: 1, lastUsedAt: 100 }),
      slot("a2", "available", { ordinal: 2, lastUsedAt: 50 }),
      slot("a3", "available", { ordinal: 3, lastUsedAt: 10, dirty: overrides.dirtyA3 }),
      slot("a4", "leased", { ordinal: 4 }),
    ]),
    pool("api", [
      slot("b1", "available", { ordinal: 1, lastUsedAt: 80 }),
      slot("b2", "available", { ordinal: 2, lastUsedAt: 5 }),
      slot("b3", "quarantined", { ordinal: 3 }),
    ]),
  ];
}

const everySlotOneGib = () => GIB;

test("the budget keeps each pool's warmest slots and removes the least recently used across pools", () => {
  const plan = planIdleCache({
    status: fleet(),
    slotBytes: everySlotOneGib,
    sizesMeasuredAt: 1,
    budgetBytes: 2 * GIB,
    keepWarm: 1,
    now: 1_000,
  });
  assert.equal(plan.idleBytes, 5 * GIB);
  assert.deepEqual(plan.remove.map((entry) => entry.slotId), ["b2", "a3", "a2"]);
  assert.equal(plan.freesBytes, 3 * GIB);
  assert.equal(plan.afterIdleBytes, 2 * GIB);
  assert.deepEqual(plan.blocked, []);
  assert.deepEqual(plan.untouched, {
    leased: 1,
    leasedBytes: GIB,
    quarantined: 1,
    quarantinedBytes: GIB,
    warm: 2,
    warmBytes: 2 * GIB,
  });
  assert.deepEqual(plan.pools.map((view) => [view.name, view.remove, view.idle]), [["web", 2, 3], ["api", 1, 2]]);
});

test("a slot Safe prune would refuse is listed as blocked with its reason, and the next one is tried", () => {
  const plan = planIdleCache({
    status: fleet({ dirtyA3: true }),
    slotBytes: everySlotOneGib,
    sizesMeasuredAt: 1,
    budgetBytes: 2 * GIB,
    keepWarm: 1,
    now: 1_000,
  });
  assert.deepEqual(plan.remove.map((entry) => entry.slotId), ["b2", "a2"]);
  assert.deepEqual(plan.blocked.map((entry) => [entry.slotId, entry.reason]), [["a3", "slot cleanliness is not proven"]]);
  assert.equal(plan.afterIdleBytes, 3 * GIB, "the budget is not met, and the plan says so rather than reaching for a leased slot");
});

test("with nothing measured the plan reports its idle slots as unsized, never as within budget", () => {
  const plan = planIdleCache({
    status: fleet(),
    slotBytes: () => null,
    sizesMeasuredAt: null,
    budgetBytes: 2 * GIB,
    keepWarm: 1,
    now: 1_000,
  });
  assert.equal(plan.unmeasuredIdle, 5, "every idle slot, the warm ones included");
  assert.equal(plan.idleBytes, 0, "a lower bound: only measured slots are summed");
  assert.deepEqual(plan.remove, []);
  // No sizes, so pools fall back to name order.
  assert.deepEqual(plan.pools.map((view) => [view.name, view.unmeasuredIdle, view.bytes]), [["api", 2, null], ["web", 3, null]]);

  const measured = planIdleCache({ status: fleet(), slotBytes: everySlotOneGib, sizesMeasuredAt: 1, budgetBytes: 2 * GIB, keepWarm: 1, now: 1_000 });
  assert.equal(measured.unmeasuredIdle, 0);
});

test("an unmeasured slot is never chosen, and no budget chooses nothing", () => {
  const unmeasured = planIdleCache({
    status: fleet(),
    slotBytes: (path) => (path.endsWith("b2") ? null : GIB),
    sizesMeasuredAt: 1,
    budgetBytes: 2 * GIB,
    keepWarm: 1,
    now: 1_000,
  });
  assert.equal(unmeasured.blocked[0]?.slotId, "b2");
  assert.match(unmeasured.blocked[0]!.reason, /not measured/);

  const off = planIdleCache({ status: fleet(), slotBytes: everySlotOneGib, sizesMeasuredAt: 1, budgetBytes: null, keepWarm: 1, now: 1_000 });
  assert.deepEqual(off.remove, []);
  assert.deepEqual(off.blocked, []);
  assert.equal(off.pools.length, 2);
});

test("at the Worktrees bulk limit the plan stops at 128 slots and reports what is still over budget", () => {
  // 130 idle slots of 1 GiB in one pool, none kept warm, against a 1 GiB budget: 129 would have to
  // go, but one Worktrees action takes at most `bulkSlots`.
  const slots = Array.from({ length: 130 }, (_, index) =>
    slot(`s${index}`, "available", { ordinal: index + 1, lastUsedAt: index + 1 }));
  const plan = planIdleCache({
    status: [pool("big", slots)],
    slotBytes: everySlotOneGib,
    sizesMeasuredAt: 1,
    budgetBytes: GIB,
    keepWarm: 0,
    now: 1_000,
  });
  assert.equal(WORKTREE_INVENTORY_LIMITS.bulkSlots, 128);
  assert.equal(plan.remove.length, 128);
  // Least recently used first: the oldest 128, leaving the two most recently used.
  assert.equal(plan.remove[0]!.slotId, "s0");
  assert.equal(plan.remove.at(-1)!.slotId, "s127");
  assert.equal(plan.freesBytes, 128 * GIB);
  assert.equal(plan.afterIdleBytes, 2 * GIB, "the plan says the budget is still 1 GiB short, for the next cleanup");
  assert.deepEqual(plan.blocked, []);
  assert.equal(plan.pools[0]!.remove, 128);
});

test("a partly finished removal retries only the slots it left", () => {
  const operation = {
    request: { action: "trimIdle", slotIds: ["a", "b", "c"] },
    completed: [{ id: "a" }, { id: "c" }],
  } as unknown as WorktreeOperationView;
  assert.deepEqual(worktreeRetryRequest(operation), { action: "trimIdle", slotIds: ["b"] });
  const done = { ...operation, completed: [{ id: "a" }, { id: "b" }, { id: "c" }] } as unknown as WorktreeOperationView;
  assert.equal(worktreeRetryRequest(done), null);
});

// ---- through the real Worktrees machinery ----

const db = openDb();
const occupancy = (paths: readonly string[]): Promise<Map<string, WorktreeOccupancy>> =>
  Promise.resolve(new Map(paths.map((path) => [path, { status: "known", occupants: [] }])));
const manager = new WorktreeManager(db, {
  occupancy,
  resolvePolicy: () => ({ enabled: true, maxSlots: 4, setupArgv: null }),
  publishChanged: () => {},
});
const operations = new WorktreeOperationsService(manager, {
  legacy: new LegacyTreehouseService(db),
  tasks: { get: () => null, reclaim: async () => ({ ok: false, error: "unexpected task" }) },
  checks: new CheckLeaseManager(db, { manager, legacy: new LegacyTreehouseService(db) }),
  checkRecovery: async () => "unknown",
  notifyChanged: () => {},
  diskBytes: async () => 1024,
});

after(() => db.exec("DELETE FROM worktree_slots; DELETE FROM worktree_pools;"));

test("Remove idle previews exactly the chosen slots, blocks on one that is no longer idle, and removes on Execute", async () => {
  const { clone } = mkOriginAndClone("mission-storage-trim-");
  const base = gitIn(clone, "rev-parse", "HEAD");
  const idle = await manager.acquire({ repositoryPath: clone, baseSha: base, owner: { kind: "manual", key: "trim-idle" } });
  const held = await manager.acquire({ repositoryPath: clone, baseSha: base, owner: { kind: "manual", key: "trim-held" } });
  assert.equal(idle.outcome, "acquired");
  assert.equal(held.outcome, "acquired");
  if (idle.outcome !== "acquired" || held.outcome !== "acquired") return;
  assert.equal((await manager.release(idle.lease, { ownerAuthorized: true, requireClean: true })).outcome, "released");

  // The plan, read the way the route reads it, chooses the released slot and not the held one.
  const plan = planIdleCache({
    status: await manager.status(),
    slotBytes: () => GIB,
    sizesMeasuredAt: 1,
    budgetBytes: GIB / 4,
    keepWarm: 0,
    now: Date.now(),
  });
  assert.deepEqual(plan.remove.map((entry) => entry.slotId), [idle.lease.slotId]);

  const blocked = await operations.preview({ action: "trimIdle", slotIds: [idle.lease.slotId, held.lease.slotId] });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.blockers.some((line) => line.includes("slot is leased")), blocked.blockers.join(" | "));

  const missing = await operations.preview({ action: "trimIdle", slotIds: ["no-such-slot"] });
  assert.equal(missing.allowed, false);
  assert.match(missing.blockers.join(" "), /no longer exists/);

  // One observation per preview: the slots are judged against the same read their versions and
  // heads came from, never a second one that could disagree with it.
  const status = manager.status.bind(manager);
  let observations = 0;
  manager.status = () => {
    observations += 1;
    return status();
  };
  let preview;
  try {
    preview = await operations.preview({ action: "trimIdle", slotIds: plan.remove.map((entry) => entry.slotId) });
  } finally {
    manager.status = status;
  }
  assert.equal(observations, 1);
  assert.equal(preview.allowed, true, preview.blockers.join(" | "));
  assert.deepEqual(preview.affected.map((target) => target.id), [idle.lease.slotId]);
  assert.ok(preview.consequences.some((line) => line.includes("Ignored files inside a slot are never cleaned one by one")));
  const path = preview.affected[0]!.path;
  await operations.execute(preview.token, []);
  assert.equal(manager.store.slot(idle.lease.slotId), null);
  assert.equal(existsSync(path), false);
  assert.notEqual(manager.store.slot(held.lease.slotId), null, "the leased slot is untouched");
});

test("the daemon refuses a removal at Execute when the budget saved since the preview no longer removes those slots", async () => {
  const { clone } = mkOriginAndClone("mission-storage-trim-budget-");
  const base = gitIn(clone, "rev-parse", "HEAD");
  const idle = await manager.acquire({ repositoryPath: clone, baseSha: base, owner: { kind: "manual", key: "trim-budget" } });
  assert.equal(idle.outcome, "acquired");
  if (idle.outcome !== "acquired") return;
  assert.equal((await manager.release(idle.lease, { ownerAuthorized: true, requireClean: true })).outcome, "released");

  // The budget as the daemon reads it when the preview is built, and again at Execute.
  let budgetBytes: number | null = GIB / 4;
  const guarded = new WorktreeOperationsService(manager, {
    legacy: new LegacyTreehouseService(db),
    tasks: { get: () => null, reclaim: async () => ({ ok: false, error: "unexpected task" }) },
    checks: new CheckLeaseManager(db, { manager, legacy: new LegacyTreehouseService(db) }),
    checkRecovery: async () => "unknown",
    notifyChanged: () => {},
    diskBytes: async () => 1024,
    trimIdleSelection: (status) => new Set(planIdleCache({
      status,
      slotBytes: () => GIB,
      sizesMeasuredAt: 1,
      budgetBytes,
      keepWarm: 0,
      now: Date.now(),
    }).remove.map((slot) => slot.slotId)),
  });

  // Previewed under a budget that removes it: allowed.
  const preview = await guarded.preview({ action: "trimIdle", slotIds: [idle.lease.slotId] });
  assert.equal(preview.allowed, true, preview.blockers.join(" | "));

  // Another window raises the budget past the slot before Execute: the daemon's rebuild refuses it.
  budgetBytes = 2 * GIB;
  await assert.rejects(guarded.execute(preview.token, []), (error: unknown) =>
    error instanceof Error && /changed after preview/.test(error.message));
  assert.notEqual(manager.store.slot(idle.lease.slotId), null, "the slot was not removed");

  // A new preview under that budget says why it cannot run.
  const blocked = await guarded.preview({ action: "trimIdle", slotIds: [idle.lease.slotId] });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.blockers.join(" "), /the current idle-cache budget no longer removes it/);

  // With the budget back where it removes the slot, a fresh preview runs.
  budgetBytes = GIB / 4;
  const fresh = await guarded.preview({ action: "trimIdle", slotIds: [idle.lease.slotId] });
  assert.equal(fresh.allowed, true);
  await guarded.execute(fresh.token, []);
  assert.equal(manager.store.slot(idle.lease.slotId), null);
});
