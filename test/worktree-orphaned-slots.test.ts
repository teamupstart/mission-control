import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { openDb } from "../src/server/db.ts";
import {
  ORPHANED_SLOT_REASON,
  WorktreeManager,
  type NativeWorktreeLease,
  type WorktreeManagerDeps,
} from "../src/server/worktrees/manager.ts";
import { observeSlotOrphan } from "../src/server/worktrees/orphan.ts";
import {
  WorktreeOperationsService,
  type WorktreeTaskView,
} from "../src/server/worktrees/operations.ts";
import { LegacyTreehouseService } from "../src/server/worktrees/legacy-treehouse.ts";
import { CheckLeaseManager } from "../src/server/workflows/check-lease.ts";
import type { WorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";

// The field failure from 2026-11-17. A pool-wide `git worktree list` failed (Xcode's licence
// had not been accepted), and the build of the day quarantined every slot while each still held
// its task's lease. A minute later the main checkout was moved aside and re-cloned in place, so
// every slot's `.git` link now named an administrative directory the new repository never had.
// Nothing could pass again: recovery needed a Git registration, Destroy needed Git to say the
// slot was clean and merged, and the task's own cleanup needed a reset. The pool sat full of
// quarantined slots with no button that could empty it.

const db = openDb();

afterEach(() => {
  db.exec("DELETE FROM worktree_slots; DELETE FROM worktree_pools; DELETE FROM app_config WHERE key = 'worktrees';");
});

const XCODE = "Git worktree registrations are unknown: git worktree list failed: You have not agreed to the Xcode license agreements.";

function acquired(result: Awaited<ReturnType<WorktreeManager["acquire"]>>): NativeWorktreeLease {
  assert.equal(result.outcome, "acquired", JSON.stringify(result));
  return (result as { outcome: "acquired"; lease: NativeWorktreeLease }).lease;
}

function harness(extra: Partial<WorktreeManagerDeps> = {}) {
  const deps: Partial<WorktreeManagerDeps> = {
    ownerReferenced: async () => false,
    pause: async () => {},
    resolvePolicy: () => ({ enabled: true, maxSlots: 2, setupArgv: null }),
    occupancy: async (paths) => new Map(paths.map((path): [string, WorktreeOccupancy] =>
      [path, { status: "known", occupants: [] }])),
    ...extra,
  };
  return new WorktreeManager(db, deps);
}

/** The lease as its owner looks it up now: quarantine moved the slot's version on. */
function current(manager: WorktreeManager, lease: NativeWorktreeLease): NativeWorktreeLease {
  const lookup = manager.lookupLease({ leaseId: lease.leaseId, path: lease.path, owner: lease.owner });
  assert.notEqual(lookup.state, "missing");
  assert.notEqual(lookup.state, "mismatch");
  return (lookup as { lease: NativeWorktreeLease }).lease;
}

/** The administrative directory a slot's `.git` file names. */
function adminDirectory(slotPath: string): string {
  const link = readFileSync(join(slotPath, ".git"), "utf8").trim();
  return link.replace(/^gitdir: /, "");
}

/**
 * A slot leased to task `task-1`, quarantined by the failed pool-wide read, with a report the
 * agent never committed, whose registration then disappears with the re-clone.
 */
async function orphanedTaskSlot(prefix: string, extra: Partial<WorktreeManagerDeps> = {}) {
  const { clone } = mkOriginAndClone(prefix);
  const sha = gitIn(clone, "rev-parse", "HEAD");
  const manager = harness(extra);
  const lease = acquired(await manager.acquire({ repositoryPath: clone, baseSha: sha,
    owner: { kind: "task", key: "task-1:0" } }));
  const leased = manager.store.slot(lease.slotId)!;
  const quarantined = manager.store.quarantine(lease.slotId, "observation", XCODE, null, 1_000, leased.version)!;
  mkdirSync(join(leased.path, "docs/reports/crash"), { recursive: true });
  writeFileSync(join(leased.path, "docs/reports/crash/report.md"), "never committed\n");
  rmSync(adminDirectory(leased.path), { recursive: true, force: true });
  return { manager, lease, clone, slot: quarantined };
}

function operationsFor(manager: WorktreeManager, task: { view: WorktreeTaskView | null; reclaimed: number }) {
  return new WorktreeOperationsService(manager, {
    legacy: new LegacyTreehouseService(db),
    tasks: {
      get: (id) => (id === task.view?.id ? task.view : null),
      // TaskManager's real teardown for a native resource: an owner-authorized release of the
      // exact lease, then the task stops naming it.
      reclaim: async (id) => {
        if (id !== task.view?.id) return { ok: false, error: "unexpected task" };
        for (const resource of task.view.resources) {
          const lookup = manager.lookupLease({ leaseId: resource.leaseId!, path: resource.path,
            owner: { kind: "task", key: `${id}:${resource.position}` } });
          if (lookup.state !== "active") return { ok: false, error: `lease is ${lookup.state}` };
          const released = await manager.release(lookup.lease, { ownerAuthorized: true });
          if (released.outcome !== "released") return { ok: false, error: JSON.stringify(released) };
        }
        task.reclaimed++;
        task.view = { ...task.view, resources: [] };
        return { ok: true };
      },
    },
    checks: new CheckLeaseManager(db, { manager, legacy: new LegacyTreehouseService(db) }),
    checkRecovery: async () => "unknown",
    notifyChanged: () => {},
    diskBytes: async () => null,
    claimVariablePresence: async () => [],
  });
}

function taskOwning(lease: NativeWorktreeLease, clone: string, path: string): WorktreeTaskView {
  return {
    id: "task-1",
    title: "Investigate Missing control crash",
    resources: [{ position: 0, repoRoot: clone, path, provider: "mission", leaseId: lease.leaseId, branch: null }],
  };
}

test("a slot whose Git registration vanished is proven orphaned, not merely unknown", async () => {
  const { manager, slot } = await orphanedTaskSlot("mission-orphan-status-");
  const entry = (await manager.status()).flatMap((pool) => pool.slots).find((candidate) => candidate.slot.id === slot.id)!;
  assert.equal(entry.registered, false);
  assert.equal(entry.dirty, null, "Git cannot describe it");
  assert.equal(entry.orphaned, "unregistered");
});

test("Destroy removes an orphaned task slot after one acknowledgement, through its task", async () => {
  // The task still names the lease, so the domain lookup says it is referenced: Destroy must go
  // through the task's own cleanup rather than treating the lease as stale.
  const task = { view: null as WorktreeTaskView | null, reclaimed: 0 };
  const { manager, lease, clone, slot } = await orphanedTaskSlot("mission-orphan-destroy-", {
    ownerReferenced: async (reference) =>
      task.view?.resources.some((resource) => resource.leaseId === reference.leaseId) ?? false,
  });
  task.view = taskOwning(lease, clone, slot.path);
  const operations = operationsFor(manager, task);

  const card = (await operations.inventory()).repositories.flatMap((pool) => pool.slots).find((entry) => entry.id === slot.id)!;
  assert.equal(card.orphaned, true);
  assert.deepEqual(card.actions, ["return", "destroy"],
    "the owner still holds it: Return lets go and keeps the files, Destroy removes it, and never Recover");
  assert.equal(card.quarantineRecoverable, false, "Reconcile cannot promise to recover it");

  const preview = await operations.preview({ action: "destroy", target: { kind: "slot", slotId: slot.id } });
  assert.equal(preview.allowed, true, JSON.stringify(preview.blockers));
  assert.deepEqual(preview.requiredAcknowledgements, ["unverifiable"],
    "what Git cannot check is named once, instead of blocking on cleanliness and merge state forever");

  await assert.rejects(operations.execute(preview.token, []), /missing acknowledgement: unverifiable/);
  const again = await operations.preview({ action: "destroy", target: { kind: "slot", slotId: slot.id } });
  const result = await operations.execute(again.token, ["unverifiable"]);
  assert.equal(result.ok, true);
  assert.equal(task.reclaimed, 1, "the task's own cleanup released its lease");
  assert.equal(manager.store.slot(slot.id), null, "the row is gone, so the pool regains its capacity");
  assert.equal(existsSync(slot.path), false);
  assert.ok(existsSync(dirname(slot.path)), "only the exact slot path is removed");
});

test("Destroy of the whole pool set empties a pool of orphaned slots", async () => {
  const { manager, lease, clone, slot } = await orphanedTaskSlot("mission-orphan-pool-");
  const task = { view: taskOwning(lease, clone, slot.path) as WorktreeTaskView | null, reclaimed: 0 };
  const operations = operationsFor(manager, task);
  const preview = await operations.preview({ action: "destroy", target: { kind: "pool", poolId: lease.poolId } });
  assert.equal(preview.allowed, true, JSON.stringify(preview.blockers));
  await operations.execute(preview.token, preview.requiredAcknowledgements);
  assert.deepEqual(manager.store.slots(lease.poolId), []);
});

test("an owner releasing an orphaned slot keeps its files and leaves it quarantined for Destroy", async () => {
  const { manager, lease, slot } = await orphanedTaskSlot("mission-orphan-release-");
  const released = await manager.release(current(manager, lease), { ownerAuthorized: true });
  assert.deepEqual(released, { outcome: "released" }, "no reset is possible, so none is waited for");
  const after = manager.store.slot(slot.id)!;
  assert.equal(after.state, "quarantined");
  assert.equal(after.activeLeaseId, null);
  assert.equal(after.lastReleasedLeaseId, lease.leaseId);
  assert.equal(after.quarantineCategory, "state", "positively unusable, so Reconcile never promises it back");
  assert.equal(after.quarantineReason, ORPHANED_SLOT_REASON);
  assert.equal(after.quarantinedAt, 1_000, "the moment it first entered quarantine stands");
  assert.equal(readFileSync(join(slot.path, "docs/reports/crash/report.md"), "utf8"), "never committed\n");
  assert.deepEqual(await manager.release(current(manager, lease), { ownerAuthorized: true }), { outcome: "alreadyReleased" });
});

test("an orphaned slot is never deleted without the acknowledgement, and never while a process is in it", async () => {
  let occupied = false;
  const { manager, lease, slot } = await orphanedTaskSlot("mission-orphan-refuse-", {
    occupancy: async (paths) => new Map(paths.map((path): [string, WorktreeOccupancy] => [path, occupied
      ? { status: "known", occupants: [{ pid: 4242, ppid: 1, startRaw: "", startMs: 0, command: "vim", cwd: path, knownOwner: null }] }
      : { status: "known", occupants: [] }])),
  });
  assert.equal((await manager.release(current(manager, lease), { ownerAuthorized: true })).outcome, "released");

  const unacknowledged = await manager.removeSlot({ slotId: slot.id, allowDirty: true, allowUnmerged: true });
  assert.equal(unacknowledged.outcome, "refused");
  occupied = true;
  const busy = await manager.removeSlot({ slotId: slot.id, allowDirty: true, allowUnmerged: true, allowUnverifiable: true });
  assert.equal(busy.outcome, "refused");
  assert.match((busy as { reason: string }).reason, /occupy/);
  assert.ok(existsSync(join(slot.path, "docs/reports/crash/report.md")));
  assert.equal(manager.store.slot(slot.id)?.state, "quarantined");
});

test("a slot with nothing left on disk is destroyed with no acknowledgement at all", async () => {
  const { manager, lease, clone, slot } = await orphanedTaskSlot("mission-orphan-absent-");
  rmSync(slot.path, { recursive: true, force: true });
  const task = { view: taskOwning(lease, clone, slot.path) as WorktreeTaskView | null, reclaimed: 0 };
  const operations = operationsFor(manager, task);
  const preview = await operations.preview({ action: "destroy", target: { kind: "slot", slotId: slot.id } });
  assert.equal(preview.allowed, true, JSON.stringify(preview.blockers));
  assert.deepEqual(preview.requiredAcknowledgements, []);
  await operations.execute(preview.token, []);
  assert.equal(manager.store.slot(slot.id), null);
});

test("a slot Git still links somewhere stays blocked: only provable orphans are released", async () => {
  const { manager, lease, clone, slot } = await orphanedTaskSlot("mission-orphan-linked-");
  // The link resolves again, to a directory this repository never listed: still Git's call.
  mkdirSync(adminDirectory(slot.path), { recursive: true });
  const operations = operationsFor(manager, { view: taskOwning(lease, clone, slot.path), reclaimed: 0 });
  const entry = (await manager.status()).flatMap((pool) => pool.slots).find((candidate) => candidate.slot.id === slot.id)!;
  assert.equal(entry.orphaned, null);
  const preview = await operations.preview({ action: "destroy", target: { kind: "slot", slotId: slot.id } });
  assert.equal(preview.allowed, false);
  assert.ok(preview.blockers.some((blocker) => /Git registration/.test(blocker)), JSON.stringify(preview.blockers));
  assert.notEqual((await manager.release(current(manager, lease), { ownerAuthorized: true })).outcome, "released");
  assert.equal(manager.store.slot(slot.id)?.activeLeaseId, lease.leaseId);
});

test("observeSlotOrphan proves only what is on disk, and nothing it cannot read", async () => {
  const { root } = mkOriginAndClone("mission-orphan-observe-");
  const empty = join(root, "empty");
  mkdirSync(empty);
  assert.equal(await observeSlotOrphan(join(root, "nothing-here")), "absent");
  assert.equal(await observeSlotOrphan(empty), "unregistered", "a directory with no Git link is no worktree");

  const dangling = join(root, "dangling");
  mkdirSync(dangling);
  writeFileSync(join(dangling, ".git"), `gitdir: ${join(root, "gone/.git/worktrees/x")}\n`);
  assert.equal(await observeSlotOrphan(dangling), "unregistered");

  const relative = join(root, "relative");
  mkdirSync(relative);
  writeFileSync(join(relative, ".git"), "gitdir: ../origin/.git\n");
  assert.equal(await observeSlotOrphan(relative), null, "a relative link that resolves is still a link");

  const embedded = join(root, "embedded");
  mkdirSync(join(embedded, ".git"), { recursive: true });
  assert.equal(await observeSlotOrphan(embedded), null, "a repository of its own is never an orphan");

  const garbage = join(root, "garbage");
  mkdirSync(garbage);
  writeFileSync(join(garbage, ".git"), "not a link\n");
  assert.equal(await observeSlotOrphan(garbage), null);

  const linked = join(root, "linked");
  symlinkSync(empty, linked);
  assert.equal(await observeSlotOrphan(linked), null, "a symbolic link is never followed into a deletion");
});

test("Return on an orphaned slot promises only what it does: the lease goes, the files and row stay", async () => {
  for (const disk of ["unregistered", "absent"] as const) {
    const { clone } = mkOriginAndClone(`mission-orphan-return-${disk}-`);
    const manager = harness();
    const lease = acquired(await manager.acquire({ repositoryPath: clone, baseSha: gitIn(clone, "rev-parse", "HEAD"),
      owner: { kind: "task", key: "task-1:0" } }));
    rmSync(adminDirectory(lease.path), { recursive: true, force: true });
    if (disk === "absent") rmSync(lease.path, { recursive: true, force: true });
    else writeFileSync(join(lease.path, "kept.md"), "kept\n");
    const task = { view: taskOwning(lease, clone, lease.path) as WorktreeTaskView | null, reclaimed: 0 };
    const operations = operationsFor(manager, task);

    const preview = await operations.preview({ action: "return", slotId: lease.slotId });
    assert.equal(preview.allowed, true, JSON.stringify(preview.blockers));
    assert.deepEqual(preview.requiredAcknowledgements, [], `${disk}: Return deletes nothing, so nothing is acknowledged`);
    assert.ok(!preview.consequences.some((line) => /deleted|record is removed|warm capacity/.test(line)),
      JSON.stringify(preview.consequences));
    assert.ok(preview.consequences.some((line) => /stays quarantined/.test(line)), JSON.stringify(preview.consequences));

    await operations.execute(preview.token, []);
    const after = manager.store.slot(lease.slotId)!;
    assert.equal(after.state, "quarantined", disk);
    assert.equal(after.activeLeaseId, null);
    if (disk === "unregistered") assert.equal(readFileSync(join(lease.path, "kept.md"), "utf8"), "kept\n");
    db.exec("DELETE FROM worktree_slots; DELETE FROM worktree_pools;");
  }
});

test("an orphaned slot reached through a symbolic link is never deleted, wherever the link sits", async () => {
  const { manager, lease, slot } = await orphanedTaskSlot("mission-orphan-symlink-");
  assert.equal((await manager.release(current(manager, lease), { ownerAuthorized: true })).outcome, "released");
  // The slot's parent `pool/N` now leads outside the pool to a directory with no `.git`: by its
  // string path this is still the exact slot, and without a physical-path proof every
  // filesystem read would call it an orphan.
  const { root } = mkOriginAndClone("mission-orphan-symlink-outside-");
  const outside = join(root, "outside");
  mkdirSync(join(outside, basename(slot.path)), { recursive: true });
  writeFileSync(join(outside, basename(slot.path), "precious.md"), "not the pool's\n");
  rmSync(dirname(slot.path), { recursive: true, force: true });
  symlinkSync(outside, dirname(slot.path));
  assert.equal(await observeSlotOrphan(slot.path), null, "a link in a parent component proves nothing");
  const entry = (await manager.status()).flatMap((pool) => pool.slots).find((candidate) => candidate.slot.id === slot.id)!;
  assert.equal(entry.orphaned, null, "so Settings never advertises a Destroy that removal would refuse");

  const removed = await manager.removeSlot({ slotId: slot.id, allowDirty: true, allowUnmerged: true, allowUnverifiable: true });
  assert.equal(removed.outcome, "refused");
  assert.equal(readFileSync(join(outside, basename(slot.path), "precious.md"), "utf8"), "not the pool's\n");
  assert.equal(manager.store.slot(slot.id)?.state, "quarantined");
});

test("the last awaited check before deleting an orphan is process occupancy", async () => {
  let armed = false;
  let calls = 0;
  const { manager, lease, slot } = await orphanedTaskSlot("mission-orphan-late-occupant-", {
    occupancy: async (paths) => {
      if (armed) calls++;
      // Removal reads occupancy three times; a process arrives just before the third.
      const occupied = armed && calls >= 3;
      return new Map(paths.map((path): [string, WorktreeOccupancy] => [path, occupied
        ? { status: "known", occupants: [{ pid: 4242, ppid: 1, startRaw: "", startMs: 0, command: "vim", cwd: path, knownOwner: null }] }
        : { status: "known", occupants: [] }]));
    },
  });
  assert.equal((await manager.release(current(manager, lease), { ownerAuthorized: true })).outcome, "released");
  armed = true;
  const removed = await manager.removeSlot({ slotId: slot.id, allowDirty: true, allowUnmerged: true, allowUnverifiable: true });
  assert.equal(removed.outcome, "outcomeUnknown", JSON.stringify(removed));
  assert.equal(calls, 3);
  assert.ok(existsSync(join(slot.path, "docs/reports/crash/report.md")), "nothing was deleted under the late occupant");
  assert.equal(manager.store.slot(slot.id)?.state, "quarantined");
});

test("the unverifiable acknowledgement reaches only the targets Git did not recognize at preview", async () => {
  const { clone } = mkOriginAndClone("mission-orphan-per-target-");
  const sha = gitIn(clone, "rev-parse", "HEAD");
  const manager = harness();
  const leases = [
    acquired(await manager.acquire({ repositoryPath: clone, baseSha: sha, owner: { kind: "task", key: "a:0" } })),
    acquired(await manager.acquire({ repositoryPath: clone, baseSha: sha, owner: { kind: "task", key: "b:0" } })),
  ];
  for (const lease of leases) assert.equal((await manager.release(current(manager, lease))).outcome, "released");
  const [orphan, healthy] = leases as [NativeWorktreeLease, NativeWorktreeLease];
  rmSync(adminDirectory(orphan.path), { recursive: true, force: true });

  const seen: Array<{ slotId: string; allowUnverifiable?: boolean }> = [];
  const removeSlot = manager.removeSlot.bind(manager);
  manager.removeSlot = async (input) => {
    seen.push({ slotId: input.slotId, allowUnverifiable: input.allowUnverifiable });
    return removeSlot(input);
  };
  const operations = operationsFor(manager, { view: null, reclaimed: 0 });
  const preview = await operations.preview({ action: "destroy", target: { kind: "pool", poolId: orphan.poolId } });
  assert.equal(preview.allowed, true, JSON.stringify(preview.blockers));
  assert.deepEqual(preview.requiredAcknowledgements, ["unverifiable"]);
  await operations.execute(preview.token, ["unverifiable"]);
  assert.deepEqual(
    seen.map(({ slotId, allowUnverifiable }) => [slotId === orphan.slotId ? "orphan" : "healthy", allowUnverifiable]).sort(),
    [["healthy", false], ["orphan", true]],
    "a registered target never inherits another target's acknowledgement",
  );
  assert.deepEqual(manager.store.slots(orphan.poolId), []);
  assert.equal(healthy.poolId, orphan.poolId);
});

test("an orphaned sibling released through its task is described as released, not deleted", async () => {
  const task = { view: null as WorktreeTaskView | null, reclaimed: 0 };
  const { clone } = mkOriginAndClone("mission-orphan-sibling-");
  const sha = gitIn(clone, "rev-parse", "HEAD");
  const manager = harness({
    ownerReferenced: async (reference) =>
      task.view?.resources.some((resource) => resource.leaseId === reference.leaseId) ?? false,
  });
  const leases = [0, 1].map(async (position) => acquired(await manager.acquire({ repositoryPath: clone, baseSha: sha,
    owner: { kind: "task", key: `task-1:${position}` } })));
  const [target, sibling] = [await leases[0]!, await leases[1]!];
  for (const lease of [target, sibling]) rmSync(adminDirectory(lease.path), { recursive: true, force: true });
  writeFileSync(join(sibling.path, "kept.md"), "kept\n");
  task.view = {
    id: "task-1",
    title: "Two repositories",
    resources: [target, sibling].map((lease, position) => ({ position, repoRoot: clone, path: lease.path,
      provider: "mission" as const, leaseId: lease.leaseId, branch: null })),
  };
  const operations = operationsFor(manager, task);
  const targetOrdinal = manager.store.slot(target.slotId)!.ordinal;
  const siblingOrdinal = manager.store.slot(sibling.slotId)!.ordinal;

  const preview = await operations.preview({ action: "destroy", target: { kind: "slot", slotId: target.slotId } });
  assert.equal(preview.allowed, true, JSON.stringify(preview.blockers));
  assert.ok(preview.consequences.some((line) => line.startsWith(`Slot ${targetOrdinal} is deleted from disk`)),
    JSON.stringify(preview.consequences));
  assert.ok(!preview.consequences.some((line) => line.startsWith(`Slot ${siblingOrdinal} is deleted`)),
    JSON.stringify(preview.consequences));
  assert.ok(preview.consequences.some((line) => line.startsWith(`Slot ${siblingOrdinal} cannot be reset`)),
    JSON.stringify(preview.consequences));

  await operations.execute(preview.token, preview.requiredAcknowledgements);
  assert.equal(manager.store.slot(target.slotId), null);
  const after = manager.store.slot(sibling.slotId)!;
  assert.deepEqual([after.state, after.activeLeaseId], ["quarantined", null]);
  assert.equal(readFileSync(join(sibling.path, "kept.md"), "utf8"), "kept\n");
});

test("a quarantined orphan still held by its owner can be returned, keeping its files", async () => {
  // The field state: a failed Git read quarantined the slot while its task's lease was live.
  const task = { view: null as WorktreeTaskView | null, reclaimed: 0 };
  const { manager, lease, clone, slot } = await orphanedTaskSlot("mission-orphan-quarantined-return-", {
    ownerReferenced: async (reference) =>
      task.view?.resources.some((resource) => resource.leaseId === reference.leaseId) ?? false,
  });
  task.view = taskOwning(lease, clone, slot.path);
  const operations = operationsFor(manager, task);

  const preview = await operations.preview({ action: "return", slotId: slot.id });
  assert.equal(preview.allowed, true, JSON.stringify(preview.blockers));
  assert.deepEqual(preview.requiredAcknowledgements, [], "Return deletes nothing");
  assert.ok(preview.consequences.some((line) => /stays quarantined with its files/.test(line)),
    JSON.stringify(preview.consequences));

  await operations.execute(preview.token, []);
  assert.equal(task.reclaimed, 1, "the owner's own cleanup released the lease");
  const after = manager.store.slot(slot.id)!;
  assert.deepEqual([after.state, after.activeLeaseId], ["quarantined", null]);
  assert.equal(readFileSync(join(slot.path, "docs/reports/crash/report.md"), "utf8"), "never committed\n");
  const card = (await operations.inventory()).repositories.flatMap((pool) => pool.slots).find((entry) => entry.id === slot.id)!;
  assert.deepEqual(card.actions, ["destroy"], "with the lease gone, only Destroy remains");
});

test("a quarantined orphan whose lease no owner references offers only Destroy", async () => {
  // The default harness answers every domain lookup with "not referenced": the lease is stale.
  const { manager, lease, clone, slot } = await orphanedTaskSlot("mission-orphan-stale-return-");
  const operations = operationsFor(manager, { view: taskOwning(lease, clone, slot.path), reclaimed: 0 });
  const card = (await operations.inventory()).repositories.flatMap((pool) => pool.slots).find((entry) => entry.id === slot.id)!;
  assert.deepEqual(card.actions, ["destroy"]);
  const preview = await operations.preview({ action: "return", slotId: slot.id });
  assert.equal(preview.allowed, false);
  assert.ok(preview.blockers.some((blocker) => /quarantined, not leased/.test(blocker)), JSON.stringify(preview.blockers));
});
