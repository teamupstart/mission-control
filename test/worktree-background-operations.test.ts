import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/server/db.ts";
import { WorktreeManager } from "../src/server/worktrees/manager.ts";
import { NativeWorktreeGit } from "../src/server/worktrees/git.ts";
import { WorktreeOperationsService } from "../src/server/worktrees/operations.ts";
import { CheckLeaseManager } from "../src/server/workflows/check-lease.ts";
import { LegacyTreehouseService } from "../src/server/worktrees/legacy-treehouse.ts";
import type { WorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";
import { worktreeRetryRequest } from "../src/shared/worktrees.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";

const db = openDb();
const occupancy = (paths: readonly string[]): Promise<Map<string, WorktreeOccupancy>> =>
  Promise.resolve(new Map(paths.map((path) => [path, { status: "known", occupants: [] }])));
const manager = new WorktreeManager(db, {
  occupancy,
  resolvePolicy: () => ({ enabled: true, maxSlots: 8, setupArgv: null }),
});
const checks = new CheckLeaseManager(db, { manager, legacy: new LegacyTreehouseService(db) });
const measured: string[] = [];
let notifications = 0;
const operations = new WorktreeOperationsService(manager, {
  legacy: new LegacyTreehouseService(db),
  tasks: { get: () => null, reclaim: async () => ({ ok: false, error: "unexpected task" }) },
  checks,
  checkRecovery: async () => "unknown",
  notifyChanged: () => {
    notifications += 1;
  },
  diskBytes: async (path) => {
    measured.push(path);
    return 4096;
  },
});

after(() => db.exec("DELETE FROM worktree_slots; DELETE FROM worktree_pools; DELETE FROM app_config WHERE key = 'worktrees';"));

/** Idle, clean, merged slots: exactly what Destroy and bulk Destroy may remove. */
async function availableSlots(prefix: string, count: number): Promise<Array<{ slotId: string; path: string }>> {
  const { clone } = mkOriginAndClone(prefix);
  const base = gitIn(clone, "rev-parse", "HEAD");
  const leases = [];
  for (let index = 0; index < count; index += 1) {
    const acquired = await manager.acquire({
      repositoryPath: clone,
      baseSha: base,
      owner: { kind: "manual", key: `${prefix}${index}` },
    });
    assert.equal(acquired.outcome, "acquired");
    if (acquired.outcome !== "acquired") throw new Error("acquire failed");
    leases.push(acquired.lease);
  }
  for (const lease of leases) {
    assert.equal((await manager.release(lease, { ownerAuthorized: true, requireClean: true })).outcome, "released");
  }
  return leases.map((lease) => ({ slotId: lease.slotId, path: lease.path }));
}

test("Execute is accepted at once and the removal finishes in the background", async () => {
  const [slot] = await availableSlots("mission-worktree-bg-", 1);
  const preview = await operations.preview({ action: "destroy", target: { kind: "slot", slotId: slot!.slotId } });
  assert.equal(preview.allowed, true, preview.blockers.join("; "));
  measured.length = 0;
  const before = notifications;

  // `submit` is synchronous: nothing the operator waits on runs Git or walks the disk.
  const accepted = operations.submit(preview.token, []);
  assert.equal(accepted.operation.state, "queued");
  assert.deepEqual(accepted.operation.targets.map((target) => target.path), [slot!.path]);
  assert.ok(notifications > before, "other windows learn about the queued work");
  assert.deepEqual((await operations.inventory()).operations.map((entry) => entry.id), [accepted.operation.id]);

  await operations.idle();
  assert.equal(manager.store.slot(slot!.slotId), null);
  assert.equal(existsSync(slot!.path), false);
  assert.deepEqual((await operations.inventory()).operations, [], "success leaves no record behind");
  assert.deepEqual(measured, [], "the safety rebuild never measures disk size");
});

test("a token is claimed synchronously, so a stale or reused one is refused before queueing", async () => {
  const [slot] = await availableSlots("mission-worktree-bg-claim-", 1);
  const preview = await operations.preview({ action: "destroy", target: { kind: "slot", slotId: slot!.slotId } });
  operations.submit(preview.token, []);
  assert.throws(() => operations.submit(preview.token, []), /expired|no longer valid/);
  await operations.idle();
});

test("bulk destroy previews one fixed set of selected slots and removes exactly that set", async () => {
  const slots = await availableSlots("mission-worktree-bulk-", 3);
  const [first, second, kept] = slots;
  const preview = await operations.preview({
    action: "destroy",
    target: { kind: "slots", slotIds: [first!.slotId, second!.slotId] },
  });
  assert.equal(preview.allowed, true, preview.blockers.join("; "));
  assert.deepEqual(preview.affected.map((target) => target.path).sort(), [first!.path, second!.path].sort());
  assert.deepEqual(preview.affected.map((target) => target.diskBytes), [4096, 4096], "sizes are measured for the dialog");

  operations.submit(preview.token, []);
  await operations.idle();
  assert.equal(manager.store.slot(first!.slotId), null);
  assert.equal(manager.store.slot(second!.slotId), null);
  assert.equal(manager.store.slot(kept!.slotId)?.state, "available", "an unselected sibling is untouched");
});

test("a bulk selection naming a slot that no longer exists is blocked, not silently narrowed", async () => {
  const [slot] = await availableSlots("mission-worktree-bulk-missing-", 1);
  const preview = await operations.preview({
    action: "destroy",
    target: { kind: "slots", slotIds: [slot!.slotId, "slot-that-was-removed"] },
  });
  assert.equal(preview.allowed, false);
  assert.match(preview.blockers.join("\n"), /1 selected slot no longer exists/);
  // A selection that lost every slot still answers with a blocked preview, not a 404.
  const allGone = await operations.preview({ action: "destroy", target: { kind: "slots", slotIds: ["gone-1", "gone-2"] } });
  assert.equal(allGone.allowed, false);
  assert.deepEqual(allGone.affected, []);
  assert.match(allGone.blockers.join("\n"), /2 selected slots no longer exist; clear the selection/);
});

test("a second cleanup of a path that already has one queued is refused", async () => {
  const [slot] = await availableSlots("mission-worktree-bg-overlap-", 1);
  const first = await operations.preview({ action: "destroy", target: { kind: "slot", slotId: slot!.slotId } });
  const second = await operations.preview({ action: "destroy", target: { kind: "slot", slotId: slot!.slotId } });
  operations.submit(first.token, []);
  assert.throws(() => operations.submit(second.token, []), /already has a cleanup queued/);
  await operations.idle();
  assert.equal(manager.store.slot(slot!.slotId), null);
});

test("a preview that went stale fails in the background as changed, and can be dismissed", async () => {
  const [slot] = await availableSlots("mission-worktree-bg-stale-", 1);
  const preview = await operations.preview({ action: "destroy", target: { kind: "slot", slotId: slot!.slotId } });
  writeFileSync(join(slot!.path, "appeared-after-preview.txt"), "state changed\n");

  const accepted = operations.submit(preview.token, []);
  await operations.idle();
  const [failed] = (await operations.inventory()).operations;
  assert.equal(failed?.id, accepted.operation.id);
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.changed, true);
  assert.match(failed?.error ?? "", /changed after preview/);
  assert.equal(existsSync(slot!.path), true, "nothing was removed");

  assert.equal(operations.dismiss("not-an-operation"), false);
  assert.equal(operations.dismiss(accepted.operation.id), true);
  assert.deepEqual((await operations.inventory()).operations, []);
});

test("inventory reads share one later observation and never join one that predates them", async () => {
  let reads = 0;
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const legacy = {
    capabilities: async () => ({ kind: "missing" as const, diagnostic: "not installed" }),
    inventory: async () => {
      reads += 1;
      await gate;
      return [];
    },
  } as unknown as LegacyTreehouseService;
  const service = new WorktreeOperationsService(manager, {
    legacy,
    tasks: { get: () => null, reclaim: async () => ({ ok: false, error: "unexpected task" }) },
    checks,
    checkRecovery: async () => "unknown",
    notifyChanged: () => {},
    diskBytes: async () => null,
  });
  const first = service.inventory();
  while (reads === 0) await new Promise((resolve) => setImmediate(resolve));
  // Both arrive while the first observation is running, so neither may reuse it.
  const second = service.inventory();
  const third = service.inventory();
  release();
  await Promise.all([first, second, third]);
  assert.equal(reads, 2, "the two late callers shared exactly one fresh observation");
});

test("an unexpected background failure is kept as failed, not changed, and can be dismissed", async (t) => {
  const [slot] = await availableSlots("mission-worktree-bg-crash-", 1);
  const preview = await operations.preview({ action: "destroy", target: { kind: "slot", slotId: slot!.slotId } });
  assert.equal(preview.allowed, true, preview.blockers.join("; "));
  // Not a WorktreeOperationError: the branch for failures nobody anticipated.
  t.mock.method(manager, "removeSlot", async () => {
    throw new Error("disk vanished mid-removal");
  });
  const logged = t.mock.method(console, "error", () => {});

  const accepted = operations.submit(preview.token, []);
  await operations.idle();
  const [failed] = (await operations.inventory()).operations;
  assert.equal(failed?.id, accepted.operation.id);
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.changed, false, "an unexpected failure is not presented as a stale preview");
  assert.equal(failed?.error, "disk vanished mid-removal");
  assert.equal(typeof failed?.finishedAt, "number");
  assert.equal(logged.mock.callCount(), 1, "an unanticipated error is logged for the operator");
  assert.equal(manager.store.slot(slot!.slotId)?.state, "available", "the slot is untouched");

  // A failure no longer blocks its path: the same slot can be previewed and queued again.
  t.mock.restoreAll();
  assert.equal(operations.dismiss(accepted.operation.id), true);
  assert.equal(operations.dismiss(accepted.operation.id), false, "dismissal is one-shot");
  assert.deepEqual((await operations.inventory()).operations, []);
  const retry = await operations.preview({ action: "destroy", target: { kind: "slot", slotId: slot!.slotId } });
  operations.submit(retry.token, []);
  await operations.idle();
  assert.equal(manager.store.slot(slot!.slotId), null);
});

test("queued and running operations cannot be dismissed", async () => {
  const [slot] = await availableSlots("mission-worktree-bg-nodismiss-", 1);
  const preview = await operations.preview({ action: "destroy", target: { kind: "slot", slotId: slot!.slotId } });
  const accepted = operations.submit(preview.token, []);
  assert.equal(operations.dismiss(accepted.operation.id), false);
  await operations.idle();
});

test("a bulk preview measures sizes a few at a time and stops waiting at its budget", async () => {
  const slots = await availableSlots("mission-worktree-bulk-budget-", 6);
  let started = 0;
  let inFlight = 0;
  let peak = 0;
  const bounded = new WorktreeOperationsService(manager, {
    legacy: new LegacyTreehouseService(db),
    tasks: { get: () => null, reclaim: async () => ({ ok: false, error: "unexpected task" }) },
    checks,
    checkRecovery: async () => "unknown",
    notifyChanged: () => {},
    diskMeasureBudgetMs: 150,
    // A walk that never finishes: the warm, dependency-heavy checkout in the worst case.
    diskBytes: () => {
      started += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise<number | null>(() => {});
    },
  });
  const began = Date.now();
  const preview = await bounded.preview({
    action: "destroy",
    target: { kind: "slots", slotIds: slots.map((slot) => slot.slotId) },
  });
  const waited = Date.now() - began;
  assert.equal(preview.affected.length, 6);
  assert.deepEqual(preview.affected.map((target) => target.diskBytes), [null, null, null, null, null, null]);
  assert.equal(peak, 4, "no more than four walks run at once");
  assert.equal(started, 4, "nothing new starts once the budget is spent");
  assert.ok(waited < 5_000, `the dialog is not held by unfinished walks (waited ${waited}ms)`);
  assert.equal(preview.allowed, true, preview.blockers.join("; "));
});

test("a full queue refuses new cleanups without consuming the token or dropping accepted work", async (t) => {
  const slots = await availableSlots("mission-worktree-bg-cap-", 3);
  const capped = new WorktreeOperationsService(manager, {
    legacy: new LegacyTreehouseService(db),
    tasks: { get: () => null, reclaim: async () => ({ ok: false, error: "unexpected task" }) },
    checks,
    checkRecovery: async () => "unknown",
    notifyChanged: () => {},
    diskBytes: async () => null,
    maxOperations: 2,
  });
  const previews: Awaited<ReturnType<typeof capped.preview>>[] = [];
  for (const slot of slots) {
    previews.push(await capped.preview({ action: "destroy", target: { kind: "slot", slotId: slot.slotId } }));
  }
  // Hold the queue so the first two stay pending while the third is submitted.
  let open = (): void => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const removeSlot = manager.removeSlot.bind(manager);
  t.mock.method(manager, "removeSlot", async (...args: Parameters<typeof removeSlot>) => {
    await gate;
    return removeSlot(...args);
  });

  capped.submit(previews[0]!.token, []);
  capped.submit(previews[1]!.token, []);
  assert.throws(
    () => capped.submit(previews[2]!.token, []),
    (error: unknown) => error instanceof Error && /2 cleanups are already queued/.test(error.message) &&
      (error as { status?: number }).status === 503,
  );
  assert.equal((await capped.inventory()).operations.length, 2, "accepted work is kept, the refused one is not recorded");

  open();
  await capped.idle();
  assert.equal(manager.store.slot(slots[0]!.slotId), null);
  assert.equal(manager.store.slot(slots[1]!.slotId), null);
  // Recovery: the refused preview's token was not consumed, so it executes once there is room.
  capped.submit(previews[2]!.token, []);
  await capped.idle();
  assert.equal(manager.store.slot(slots[2]!.slotId), null);
  assert.deepEqual((await capped.inventory()).operations, []);
});

test("a preview naming a slot that already has a cleanup queued is blocked for that slot", async (t) => {
  const [queued, free] = await availableSlots("mission-worktree-bg-pending-preview-", 2);
  let open = (): void => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const removeSlot = manager.removeSlot.bind(manager);
  t.mock.method(manager, "removeSlot", async (...args: Parameters<typeof removeSlot>) => {
    await gate;
    return removeSlot(...args);
  });
  const first = await operations.preview({ action: "destroy", target: { kind: "slot", slotId: queued!.slotId } });
  operations.submit(first.token, []);

  const bulk = await operations.preview({
    action: "destroy",
    target: { kind: "slots", slotIds: [queued!.slotId, free!.slotId] },
  });
  assert.equal(bulk.allowed, false, "the dialog cannot offer an Execute that would only 409");
  assert.match(bulk.blockers.join("\n"), /already has a cleanup queued/);
  const alone = await operations.preview({ action: "destroy", target: { kind: "slot", slotId: free!.slotId } });
  assert.equal(alone.allowed, true, "an unrelated slot is not blocked by someone else's queue");
  const prune = await operations.preview({ action: "prune", poolId: manager.store.slot(free!.slotId)!.poolId, mode: "safe" });
  assert.deepEqual(prune.affected.map((target) => target.path), [free!.path], "prune leaves the queued slot to its own cleanup");

  open();
  await operations.idle();
  assert.equal(manager.store.slot(queued!.slotId), null, "the running operation was not blocked by its own targets");
  assert.deepEqual((await operations.inventory()).operations, []);
});

test("a bulk destroy that fails partway reports what it removed and retries only the rest", async (t) => {
  const [first, second] = await availableSlots("mission-worktree-bg-partial-", 2);
  const preview = await operations.preview({
    action: "destroy",
    target: { kind: "slots", slotIds: [first!.slotId, second!.slotId] },
  });
  assert.equal(preview.allowed, true, preview.blockers.join("; "));
  const order = preview.affected.map((target) => target.id);
  const removeSlot = manager.removeSlot.bind(manager);
  let calls = 0;
  t.mock.method(manager, "removeSlot", async (...args: Parameters<typeof removeSlot>) => {
    calls += 1;
    if (calls === 2) throw new Error("git worktree remove failed");
    return removeSlot(...args);
  });
  t.mock.method(console, "error", () => {});

  const accepted = operations.submit(preview.token, []);
  await operations.idle();
  const [failed] = (await operations.inventory()).operations;
  assert.equal(failed?.id, accepted.operation.id);
  assert.equal(failed?.state, "failed");
  const removedId = order[0]!;
  const leftId = order[1]!;
  assert.deepEqual(failed?.completed.map((target) => target.id), [removedId], "the removal that happened is reported");
  assert.equal(manager.store.slot(removedId), null);
  assert.equal(manager.store.slot(leftId)?.state, "available", "the rest is left in place");

  const retry = worktreeRetryRequest(failed!);
  assert.deepEqual(retry, { action: "destroy", target: { kind: "slots", slotIds: [leftId] } });
  t.mock.restoreAll();
  operations.dismiss(accepted.operation.id);
  const again = await operations.preview(retry!);
  assert.equal(again.allowed, true, "the narrowed retry does not trip over the slot already removed");
  operations.submit(again.token, []);
  await operations.idle();
  assert.equal(manager.store.slot(leftId), null);
});

test("the retry request narrows bulk destroys, drops finished single slots, and keeps everything else", () => {
  const base = {
    id: "op",
    state: "failed" as const,
    targets: [],
    removals: [] as Array<{ id: string; path: string }>,
    error: "x",
    changed: false,
    queuedAt: 1,
    finishedAt: 2,
  };
  const bulk = { action: "destroy" as const, target: { kind: "slots" as const, slotIds: ["a", "b", "c"] } };
  assert.deepEqual(worktreeRetryRequest({ ...base, request: bulk, completed: [] }), bulk);
  assert.deepEqual(
    worktreeRetryRequest({ ...base, request: bulk, completed: [{ id: "b", path: "/b" }] }),
    { action: "destroy", target: { kind: "slots", slotIds: ["a", "c"] } },
  );
  assert.equal(worktreeRetryRequest({
    ...base,
    request: bulk,
    completed: ["a", "b", "c"].map((id) => ({ id, path: `/${id}` })),
  }), null);
  const single = { action: "destroy" as const, target: { kind: "slot" as const, slotId: "a" } };
  assert.equal(worktreeRetryRequest({ ...base, request: single, completed: [{ id: "a", path: "/a" }] }), null);
  // A pool destroy retries as the fixed set it was accepted with, never as the pool.
  const pool = { action: "destroy" as const, target: { kind: "pool" as const, poolId: "p" } };
  const removals = ["a", "b", "c"].map((id) => ({ id, path: `/${id}` }));
  assert.deepEqual(
    worktreeRetryRequest({ ...base, request: pool, removals, completed: [{ id: "a", path: "/a" }] }),
    { action: "destroy", target: { kind: "slots", slotIds: ["b", "c"] } },
  );
  assert.deepEqual(
    worktreeRetryRequest({ ...base, request: pool, removals, completed: [] }),
    { action: "destroy", target: { kind: "slots", slotIds: ["a", "b", "c"] } },
  );
  assert.equal(worktreeRetryRequest({ ...base, request: pool, removals, completed: removals }), null);
  const prune = { action: "prune" as const, poolId: "p", mode: "safe" as const };
  assert.deepEqual(worktreeRetryRequest({ ...base, request: prune, completed: [{ id: "a", path: "/a" }] }), prune);
});

test("a pool destroy that fails partway retries its original slots, not whatever the pool holds now", async (t) => {
  const { clone } = mkOriginAndClone("mission-worktree-bg-pool-partial-");
  const base = gitIn(clone, "rev-parse", "HEAD");
  // Leases are held together and released together: a released slot is warm capacity that
  // the next acquire would reuse, so acquiring one at a time would keep landing on one slot.
  const acquireReleased = async (...keys: string[]) => {
    const leases = [];
    for (const key of keys) {
      const acquired = await manager.acquire({ repositoryPath: clone, baseSha: base, owner: { kind: "manual", key } });
      assert.equal(acquired.outcome, "acquired");
      if (acquired.outcome !== "acquired") throw new Error("acquire failed");
      leases.push(acquired.lease);
    }
    for (const lease of leases) {
      assert.equal((await manager.release(lease, { ownerAuthorized: true, requireClean: true })).outcome, "released");
    }
    return leases;
  };
  const [first, second] = await acquireReleased("pool-partial-1", "pool-partial-2");
  assert.notEqual(first!.slotId, second!.slotId);
  const preview = await operations.preview({ action: "destroy", target: { kind: "pool", poolId: first!.poolId } });
  assert.equal(preview.allowed, true, preview.blockers.join("; "));
  const removeSlot = manager.removeSlot.bind(manager);
  let calls = 0;
  t.mock.method(manager, "removeSlot", async (...args: Parameters<typeof removeSlot>) => {
    calls += 1;
    if (calls === 2) throw new Error("git worktree remove failed");
    return removeSlot(...args);
  });
  t.mock.method(console, "error", () => {});

  const accepted = operations.submit(preview.token, []);
  assert.deepEqual(accepted.operation.removals.map((target) => target.id).sort(), [first!.slotId, second!.slotId].sort());
  await operations.idle();
  t.mock.restoreAll();
  const [failed] = (await operations.inventory()).operations;
  assert.equal(failed?.completed.length, 1);
  const left = [first!.slotId, second!.slotId].find((id) => id !== failed!.completed[0]!.id)!;

  // A slot joins the pool after the failure. It was never part of that cleanup. The first
  // acquire reuses the surviving warm slot, so the second is the genuinely new one.
  const late = await acquireReleased("pool-partial-late-1", "pool-partial-late-2");
  const joined = late.find((lease) => lease.slotId !== left)!;
  assert.ok(joined, "a new slot joined the pool");
  const retry = worktreeRetryRequest(failed!);
  assert.deepEqual(retry, { action: "destroy", target: { kind: "slots", slotIds: [left] } });
  operations.dismiss(failed!.id);
  const again = await operations.preview(retry!);
  assert.deepEqual(again.affected.map((target) => target.id), [left]);
  assert.ok(!again.affected.some((target) => target.id === joined.slotId), "the late slot does not ride along");
  operations.submit(again.token, []);
  await operations.idle();
  assert.equal(manager.store.slot(left), null);
  assert.equal(manager.store.slot(joined.slotId)?.state, "available");
});

test("failure reports are never evicted: a full list refuses new cleanups until one is dismissed", async () => {
  const slots = await availableSlots("mission-worktree-bg-reports-", 3);
  const capped = new WorktreeOperationsService(manager, {
    legacy: new LegacyTreehouseService(db),
    tasks: { get: () => null, reclaim: async () => ({ ok: false, error: "unexpected task" }) },
    checks,
    checkRecovery: async () => "unknown",
    notifyChanged: () => {},
    diskBytes: async () => null,
    maxOperations: 2,
  });
  // Two cleanups that fail as stale: each dirties its slot after the preview.
  const failedIds: string[] = [];
  for (const slot of slots.slice(0, 2)) {
    const preview = await capped.preview({ action: "destroy", target: { kind: "slot", slotId: slot.slotId } });
    writeFileSync(join(slot.path, "appeared-after-preview.txt"), "state changed\n");
    failedIds.push(capped.submit(preview.token, []).operation.id);
    await capped.idle();
  }
  const third = await capped.preview({ action: "destroy", target: { kind: "slot", slotId: slots[2]!.slotId } });
  assert.throws(
    () => capped.submit(third.token, []),
    (error: unknown) => error instanceof Error &&
      /2 cleanups are listed \(2 failed, 0 queued\); dismiss a failed report/.test(error.message) &&
      (error as { status?: number }).status === 503,
  );
  const listed = (await capped.inventory()).operations;
  assert.deepEqual(listed.map((entry) => entry.id), failedIds, "both failure reports are still listed");
  assert.ok(listed.every((entry) => entry.state === "failed"));

  // Dismissing one report makes room; the refused preview was not consumed and now runs.
  assert.equal(capped.dismiss(failedIds[0]!), true);
  capped.submit(third.token, []);
  await capped.idle();
  assert.equal(manager.store.slot(slots[2]!.slotId), null);
  assert.deepEqual((await capped.inventory()).operations.map((entry) => entry.id), [failedIds[1]]);
});

test("a failing process read degrades status to unknown occupancy, never a crash", async () => {
  const [slot] = await availableSlots("mission-worktree-bg-occupancy-reject-", 1);
  const unhandled: unknown[] = [];
  const listen = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", listen);
  try {
    const failing = new WorktreeManager(db, {
      // Rejects at once, long before any slot worker reaches the await.
      occupancy: () => Promise.reject(new Error("lsof exploded")),
      resolvePolicy: () => ({ enabled: true, maxSlots: 8, setupArgv: null }),
    });
    const status = await failing.status();
    await new Promise((resolve) => setImmediate(resolve));
    const observed = status.flatMap((pool) => pool.slots).find((entry) => entry.slot.id === slot!.slotId);
    assert.equal(observed?.occupancy.status, "unknown");
    assert.match(observed?.occupancy.status === "unknown" ? observed.occupancy.reason : "", /slot occupancy query failed: Error: lsof exploded/);
    assert.deepEqual(unhandled, [], "no rejection escaped");
  } finally {
    process.off("unhandledRejection", listen);
  }
});

test("observations never overlap, and no process read runs while this daemon's Git reads do", async () => {
  // Occupancy is a process whose cwd is inside a slot, and `git -C <slot>` has exactly that
  // cwd. A process read taken during our own Git reads would count them as occupants and make
  // a preview and its recheck disagree - the stale-preview refusals CI saw under load.
  await availableSlots("mission-worktree-bg-observation-order-", 2);
  let gitInFlight = 0;
  let readsInFlight = 0;
  const violations: string[] = [];
  class CountingGit extends NativeWorktreeGit {
    override async inspect(path: string) {
      gitInFlight += 1;
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return await super.inspect(path);
      } finally {
        gitInFlight -= 1;
      }
    }
  }
  const observed = new WorktreeManager(db, {
    git: new CountingGit(),
    occupancy: async (paths: readonly string[]) => {
      if (gitInFlight > 0) violations.push(`process read started with ${gitInFlight} Git read(s) in flight`);
      if (readsInFlight > 0) violations.push("two process reads overlapped");
      readsInFlight += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      readsInFlight -= 1;
      return new Map(paths.map((path) => [path, { status: "known" as const, occupants: [] }]));
    },
    resolvePolicy: () => ({ enabled: true, maxSlots: 8, setupArgv: null }),
  });
  await Promise.all([observed.status(), observed.status(), observed.status()]);
  assert.deepEqual(violations, []);
});
