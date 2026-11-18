import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, upsertTask } from "../src/server/db.ts";
import { WorktreeManager, type WorktreeManagerDeps } from "../src/server/worktrees/manager.ts";
import { NativeWorktreeGit } from "../src/server/worktrees/git.ts";
import { nativeWorktreeOwnerReferenced } from "../src/server/worktrees/owners.ts";
import { WorktreeOperationsService } from "../src/server/worktrees/operations.ts";
import { CheckLeaseManager } from "../src/server/workflows/check-lease.ts";
import { LegacyTreehouseService } from "../src/server/worktrees/legacy-treehouse.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";
import { mkTask } from "./helpers/session-fixture.ts";

const db = openDb();
afterEach(() => db.exec("DELETE FROM worktree_slots; DELETE FROM worktree_pools; DELETE FROM tasks;"));
const occupancy: WorktreeManagerDeps["occupancy"] = async (paths) =>
  new Map(paths.map((path) => [path, { status: "known", occupants: [] }]));

async function fixture(deps: Partial<WorktreeManagerDeps> = {}, taskExists = true) {
  const { clone } = mkOriginAndClone("mission-orphan-lease-");
  const manager = new WorktreeManager(db, { occupancy,
    ownerReferenced: async (ref) => nativeWorktreeOwnerReferenced(ref, db), ...deps });
  const acquired = await manager.acquire({ repositoryPath: clone, baseSha: gitIn(clone, "rev-parse", "HEAD"),
    owner: { kind: "task", key: "orphan-task:0" } });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") throw new Error("fixture acquisition failed");
  const lease = acquired.lease;
  manager.store.quarantine(lease.slotId, "transition", "failed reset", "index.lock", Date.now(), lease.slotVersion);
  let reclaimed = 0;
  const legacy = new LegacyTreehouseService(db);
  const operations = new WorktreeOperationsService(manager, { legacy,
    tasks: { get: () => taskExists ? ({ id: "orphan-task", title: "Redispatched task", resources: [] }) : null,
      reclaim: async () => { reclaimed++; return { ok: true }; } },
    checks: new CheckLeaseManager(db, { manager, legacy }), checkRecovery: async () => "unknown",
    diskBytes: async () => null, notifyChanged: () => {} });
  const request = { action: "destroy", target: { kind: "slot", slotId: lease.slotId } } as const;
  return { manager, operations, lease, request, reclaimed: () => reclaimed };
}

for (const existing of [true, false]) {
  test(`Destroy removes an orphan quarantine with ${existing ? "an existing" : "a deleted"} task`, async () => {
    if (existing) upsertTask(mkTask({ id: "orphan-task", status: "done", worktreePath: null, worktreeLeaseId: null }));
    const f = await fixture({}, existing);
    const preview = await f.operations.preview(f.request);
    assert.equal(preview.allowed, true, preview.blockers.join("; "));
    assert.match(preview.consequences.join(" "), /stale lease/i);
    assert.doesNotMatch(preview.consequences.join(" "), /Stops the task agent/);
    f.operations.submit(preview.token, []);
    await f.operations.idle();
    assert.equal(f.manager.store.slot(f.lease.slotId), null);
    assert.equal(existsSync(f.lease.path), false);
    assert.equal(f.reclaimed(), 0);
  });
}

test("Destroy blocks unknown ownership and an owner that still refers to the lease", async () => {
  let unknown = false;
  const f = await fixture({ ownerReferenced: async () => { if (unknown) throw new Error("lookup unavailable"); return true; }, pause: async () => {} });
  for (unknown of [false, true]) {
    const preview = await f.operations.preview(f.request);
    assert.equal(preview.allowed, false);
    const result = await f.manager.removeSlot({ slotId: f.lease.slotId, allowStaleLease: true, allowDirty: false, allowUnmerged: false });
    assert.notEqual(result.outcome, "removed");
    assert.equal(f.manager.store.slot(f.lease.slotId)?.activeLeaseId, f.lease.leaseId);
  }
});

test("a stale lease preview cannot authorize a newly referenced lease", async () => {
  const f = await fixture();
  const preview = await f.operations.preview(f.request);
  assert.equal(preview.allowed, true);
  upsertTask(mkTask({ id: "orphan-task", provider: "mission", worktreeLeaseId: f.lease.leaseId, worktreePath: f.lease.path }));
  f.operations.submit(preview.token, []);
  await f.operations.idle();
  assert.equal(f.manager.store.slot(f.lease.slotId)?.activeLeaseId, f.lease.leaseId);
  assert.equal(f.reclaimed(), 0);
  assert.equal((await f.operations.inventory()).operations[0]?.state, "failed");
});

test("stale lease Destroy still requires dirty acknowledgement and known empty occupancy", async () => {
  let unknown = false;
  const f = await fixture({ occupancy: async (paths) => unknown
    ? new Map(paths.map((path) => [path, { status: "unknown", reason: "process scan failed" }])) : occupancy(paths) });
  writeFileSync(join(f.lease.path, "keep.txt"), "operator work");
  const preview = await f.operations.preview(f.request);
  assert.ok(preview.risks.some((risk) => risk.key === "dirty" && risk.acknowledgeable));
  assert.throws(() => f.operations.submit(preview.token, []), /acknowledge/i);
  unknown = true;
  const blocked = await f.operations.preview(f.request);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.blockers.join(" "), /process scan failed/);
  assert.equal(f.manager.store.slot(f.lease.slotId)?.activeLeaseId, f.lease.leaseId);
});

for (const failure of ["add", "reset", "inspect", "setup"] as const) {
  test(`failed acquisition ${failure} quarantines without a never-granted lease`, async (t) => {
    const { clone } = mkOriginAndClone("mission-failed-reservation-");
    const git = new NativeWorktreeGit();
    const manager = new WorktreeManager(db, { git, occupancy,
      resolvePolicy: () => ({ enabled: true, maxSlots: 1, setupArgv: failure === "setup" ? ["false"] : null }),
      runSetup: async () => ({ ok: false, outcomeUnknown: false, reason: "setup failed" }) });
    const input = { repositoryPath: clone, baseSha: gitIn(clone, "rev-parse", "HEAD"), owner: { kind: "task" as const, key: "failed:0" } };
    if (failure === "reset") {
      const first = await manager.acquire(input);
      assert.equal(first.outcome, "acquired");
      if (first.outcome !== "acquired") throw new Error("fixture acquisition failed");
      assert.equal((await manager.release(first.lease)).outcome, "released");
    }
    if (failure !== "setup") t.mock.method(git, failure, async () => ({ ok: false, reason: `${failure} failed` }));
    assert.equal((await manager.acquire(input)).outcome, "outcomeUnknown");
    const [slot] = manager.store.slots();
    assert.equal(slot?.state, "quarantined");
    assert.equal(slot?.quarantineCategory, "transition");
    assert.equal(slot?.activeLeaseId, null);
    assert.equal(slot?.activeOwnerKind, null);
    assert.equal(slot?.activeOwnerKey, null);
    assert.equal(slot?.leasedAt, null);
  });
}


test("removal rechecks ownership after Git inspection and keeps the lease on refusal", async (t) => {
  const git = new NativeWorktreeGit();
  const f = await fixture({ git });
  const mergedInto = git.mergedInto.bind(git);
  t.mock.method(git, "mergedInto", async (...args: Parameters<typeof git.mergedInto>) => {
    const result = await mergedInto(...args);
    upsertTask(mkTask({ id: "orphan-task", provider: "mission", worktreeLeaseId: f.lease.leaseId }));
    return result;
  });
  const result = await f.manager.removeSlot({ slotId: f.lease.slotId,
    expectedVersion: f.manager.store.slot(f.lease.slotId)!.version,
    allowStaleLease: true, allowDirty: false, allowUnmerged: false });
  assert.equal(result.outcome, "refused");
  assert.equal(f.manager.store.slot(f.lease.slotId)?.activeLeaseId, f.lease.leaseId);
  assert.equal(existsSync(f.lease.path), true);
});

test("prune CAS refuses a stale version or different lease identity", async () => {
  const f = await fixture();
  const slot = f.manager.store.slot(f.lease.slotId)!;
  const stale = { leaseId: f.lease.leaseId, ownerKind: "task", ownerKey: "orphan-task:0" };
  const references = [{ slotId: slot.id, leaseId: f.lease.leaseId, owner: f.lease.owner }];
  assert.equal(f.manager.store.markPruning(slot.id, slot.version - 1, Date.now(), references, stale), null);
  assert.equal(f.manager.store.markPruning(slot.id, slot.version, Date.now(), references, { ...stale, leaseId: "other" }), null);
  assert.equal(f.manager.store.slot(slot.id)?.activeLeaseId, stale.leaseId);
});

test("quarantining a stale reservation cannot clear a finalized grant", async () => {
  const { clone } = mkOriginAndClone("mission-reservation-cas-");
  const manager = new WorktreeManager(db, { occupancy });
  const granted = await manager.acquire({ repositoryPath: clone, baseSha: gitIn(clone, "rev-parse", "HEAD"),
    owner: { kind: "task", key: "pending:0" }, awaitingDomainRecord: true });
  assert.equal(granted.outcome, "acquired");
  if (granted.outcome !== "acquired") throw new Error("fixture acquisition failed");
  const slot = manager.store.slot(granted.lease.slotId)!;
  assert.equal(manager.store.quarantine(slot.id, "transition", "late failure", null,
    Date.now(), slot.version, slot.activeLeaseId!), null);
  assert.equal(manager.store.slot(slot.id)?.activeLeaseId, granted.lease.leaseId);
  manager.store.quarantine(slot.id, "observation", "unknown scan", null, Date.now(), slot.version);
  const result = await manager.removeSlot({ slotId: slot.id, allowStaleLease: true, allowDirty: false, allowUnmerged: false });
  assert.equal(result.outcome, "refused", "a grant awaiting its domain record is still owned");
});


test("Destroy leaves the redispatched task's replacement lease alone", async () => {
  const f = await fixture();
  const pool = f.manager.store.poolForSlot(f.lease.slotId)!;
  const replacement = await f.manager.acquire({ repositoryPath: pool.mainCheckoutRoot,
    baseSha: f.lease.baseSha, owner: f.lease.owner });
  assert.equal(replacement.outcome, "acquired");
  if (replacement.outcome !== "acquired") throw new Error("replacement acquisition failed");
  upsertTask(mkTask({ id: "orphan-task", provider: "mission", worktreeLeaseId: replacement.lease.leaseId,
    worktreePath: replacement.lease.path }));
  const preview = await f.operations.preview(f.request);
  assert.equal(preview.allowed, true);
  assert.deepEqual(preview.affected.map((target) => target.id), [f.lease.slotId]);
  f.operations.submit(preview.token, []);
  await f.operations.idle();
  assert.equal(f.manager.store.slot(f.lease.slotId), null);
  assert.equal(f.manager.store.slot(replacement.lease.slotId)?.activeLeaseId, replacement.lease.leaseId);
  assert.equal(f.reclaimed(), 0);
});

for (const unsafe of ["occupied", "unlanded", "invalid-identity"] as const) {
  test(`stale lease removal refuses ${unsafe} without clearing the lease`, async (t) => {
    const git = new NativeWorktreeGit();
    let occupied = false;
    const f = await fixture({ git, occupancy: async (paths) => occupied
      ? new Map(paths.map((path) => [path, { status: "known", occupants: [{ pid: 99999, ppid: 1, startRaw: "fixture", startMs: 0, command: "editor", cwd: path, knownOwner: null }] }]))
      : occupancy(paths) });
    if (unsafe === "occupied") occupied = true;
    if (unsafe === "unlanded") t.mock.method(git, "mergedInto", async () => ({ ok: true, value: false }));
    if (unsafe === "invalid-identity") db.prepare("UPDATE worktree_slots SET active_owner_key = NULL WHERE id = ?").run(f.lease.slotId);
    const result = await f.manager.removeSlot({ slotId: f.lease.slotId, allowStaleLease: true,
      allowDirty: false, allowUnmerged: false });
    assert.equal(result.outcome, "refused");
    assert.equal(f.manager.store.slot(f.lease.slotId)?.activeLeaseId, f.lease.leaseId);
    assert.equal(existsSync(f.lease.path), true);
  });
}

for (const acknowledgement of ["dirty", "unlanded"] as const) {
  test(`stale lease Destroy removes the selected slot with ${acknowledgement} acknowledgement`, async () => {
    const f = await fixture();
    writeFileSync(join(f.lease.path, "keep.txt"), "work explicitly acknowledged for disposal\n");
    if (acknowledgement === "unlanded") {
      gitIn(f.lease.path, "commit", "-qam", "unlanded fixture work");
    }
    const preview = await f.operations.preview(f.request);
    assert.equal(preview.allowed, true, preview.blockers.join("; "));
    assert.deepEqual(preview.requiredAcknowledgements, [acknowledgement]);
    assert.deepEqual(preview.affected.map((target) => target.id), [f.lease.slotId]);

    f.operations.submit(preview.token, [acknowledgement]);
    await f.operations.idle();

    assert.equal(f.manager.store.slot(f.lease.slotId), null);
    assert.equal(existsSync(f.lease.path), false);
    assert.deepEqual((await f.operations.inventory()).operations, [], "successful removal leaves no failure report");
    assert.equal(f.reclaimed(), 0, "acknowledgement does not authorize reclaiming the stale task owner");
  });
}

test("Git removal failure after stale lease prune intent remains pending removal and is reported as failed", async (t) => {
  const git = new NativeWorktreeGit();
  const f = await fixture({ git });
  const before = f.manager.store.slot(f.lease.slotId)!;
  const preview = await f.operations.preview(f.request);
  assert.equal(preview.allowed, true, preview.blockers.join("; "));
  const remove = t.mock.method(git, "remove", async () => ({ ok: false as const, reason: "Git removal failed" }));
  const outcomes: Array<Awaited<ReturnType<WorktreeManager["removeSlot"]>>> = [];
  const removeSlot = f.manager.removeSlot.bind(f.manager);
  t.mock.method(f.manager, "removeSlot", async (input: Parameters<typeof removeSlot>[0]) => {
    const outcome = await removeSlot(input);
    outcomes.push(outcome);
    return outcome;
  });

  const accepted = f.operations.submit(preview.token, []);
  await f.operations.idle();

  assert.equal(remove.mock.callCount(), 1, "the failure occurred at Git removal, after the safety checks");
  assert.deepEqual(outcomes, [{ outcome: "outcomeUnknown", reason: "Git removal failed" }]);
  const after = f.manager.store.slot(f.lease.slotId)!;
  assert.equal(after.state, "pruning");
  assert.equal(after.version, before.version + 1);
  assert.equal(after.activeLeaseId, null);
  assert.equal(after.activeOwnerKind, null);
  assert.equal(after.activeOwnerKey, null);
  assert.equal(after.leasedAt, null);
  assert.equal(existsSync(f.lease.path), true, "the checkout is still present");
  const [failed] = (await f.operations.inventory()).operations;
  assert.equal(failed?.id, accepted.operation.id);
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.changed, false, "an unknown removal outcome is not a stale preview");
  assert.equal(failed?.error, "Git removal failed");
  assert.deepEqual(failed?.completed, [], "the selected slot must not be reported as removed");
  assert.deepEqual(failed?.removals, [{ id: f.lease.slotId, path: f.lease.path }]);
  assert.equal(f.reclaimed(), 0);
});

test("stale lease removal refuses a process that enters during the final ownership lookup", async (t) => {
  const git = new NativeWorktreeGit();
  let ownershipReads = 0;
  let occupied = false;
  let lookupStarted!: () => void;
  let finishLookup!: () => void;
  const lookupPending = new Promise<void>((resolve) => { lookupStarted = resolve; });
  const lookupGate = new Promise<void>((resolve) => { finishLookup = resolve; });
  const f = await fixture({ git,
    ownerReferenced: async (reference) => {
      if (++ownershipReads === 2) {
        lookupStarted();
        await lookupGate;
      }
      return nativeWorktreeOwnerReferenced(reference, db);
    },
    occupancy: async (paths) => occupied
      ? new Map(paths.map((path) => [path, { status: "known", occupants: [{
        pid: 99999, ppid: 1, startRaw: "fixture", startMs: 0,
        command: "editor", cwd: path, knownOwner: null,
      }] }]))
      : occupancy(paths),
  });
  const before = f.manager.store.slot(f.lease.slotId)!;
  const remove = t.mock.method(git, "remove");
  const pending = f.manager.removeSlot({ slotId: f.lease.slotId, expectedVersion: before.version,
    allowStaleLease: true, allowDirty: false, allowUnmerged: false });
  try {
    await Promise.race([lookupPending, pending.then(() => {
      throw new Error("removal finished before the final ownership lookup");
    })]);
    // Initial checks saw an empty worktree. A process enters while the final domain
    // lookup is awaiting its answer, so only a later occupancy scan can protect it.
    occupied = true;
  } finally {
    finishLookup();
  }
  const outcome = await pending;
  assert.equal(outcome.outcome, "refused");
  if (outcome.outcome !== "refused") throw new Error("expected an occupancy refusal");
  assert.match(outcome.reason, /processes still occupy the worktree/);
  assert.equal(remove.mock.callCount(), 0, "Git removal must not begin after a process entered");
  assert.deepEqual(f.manager.store.slot(f.lease.slotId), before, "no prune intent or lease clearing is allowed");
  assert.equal(existsSync(f.lease.path), true);
});

for (const referenceState of ["active", "last-released"] as const) {
  test(`removal preserves ${referenceState} ownership recorded during the final occupancy scan`, async (t) => {
    const git = new NativeWorktreeGit();
    let removalStarted = false;
    let scans = 0;
    let scanStarted!: () => void;
    let finishScan!: () => void;
    const scanPending = new Promise<void>((resolve) => { scanStarted = resolve; });
    const scanGate = new Promise<void>((resolve) => { finishScan = resolve; });
    const f = await fixture({ git, occupancy: async (paths) => {
      if (removalStarted && ++scans === 2) {
        scanStarted();
        await scanGate;
      }
      return occupancy(paths);
    } });
    if (referenceState === "last-released") {
      assert.equal((await f.manager.release({ ...f.lease,
        slotVersion: f.manager.store.slot(f.lease.slotId)!.version })).outcome, "released");
    }
    const before = f.manager.store.slot(f.lease.slotId)!;
    const remove = t.mock.method(git, "remove");
    removalStarted = true;
    const pending = f.manager.removeSlot({ slotId: f.lease.slotId, expectedVersion: before.version,
      allowStaleLease: true, allowDirty: false, allowUnmerged: false });
    try {
      await Promise.race([scanPending, pending.then(() => {
        throw new Error("removal finished before the final occupancy scan");
      })]);
      upsertTask(mkTask({ id: "orphan-task", provider: "mission",
        worktreeLeaseId: f.lease.leaseId, worktreePath: f.lease.path }));
      assert.deepEqual(f.manager.store.slot(f.lease.slotId), before, "domain ownership does not change the slot version");
    } finally {
      finishScan();
    }
    const outcome = await pending;
    assert.equal(outcome.outcome, "conflict");
    assert.equal(remove.mock.callCount(), 0, "Git removal must not begin after a task records the lease");
    assert.deepEqual(f.manager.store.slot(f.lease.slotId), before, "ownership must block the prune intent and lease clearing");
    assert.equal(existsSync(f.lease.path), true);
    assert.equal(nativeWorktreeOwnerReferenced({ slotId: f.lease.slotId, leaseId: f.lease.leaseId, owner: f.lease.owner }, db), true);
  });
}

test("an unknown ownership read in the prune transaction rolls back without removing the slot", async (t) => {
  const git = new NativeWorktreeGit();
  const f = await fixture({ git });
  const before = f.manager.store.slot(f.lease.slotId)!;
  const remove = t.mock.method(git, "remove");
  const prepare = db.prepare.bind(db);
  let atomicReads = 0;
  t.mock.method(db, "prepare", (sql: string) => {
    if (db.isTransaction && sql.includes("SELECT 1 FROM tasks")) {
      atomicReads++;
      throw new Error("domain read failed inside prune transaction");
    }
    return prepare(sql);
  });
  const outcome = await f.manager.removeSlot({ slotId: f.lease.slotId, expectedVersion: before.version,
    allowStaleLease: true, allowDirty: false, allowUnmerged: false });
  assert.deepEqual(outcome, { outcome: "outcomeUnknown",
    reason: "prune ownership transaction failed: Error: domain read failed inside prune transaction" });
  assert.equal(atomicReads, 1);
  assert.equal(db.isTransaction, false, "the failed read must not leave a transaction open");
  assert.equal(remove.mock.callCount(), 0);
  assert.deepEqual(f.manager.store.slot(f.lease.slotId), before);
  assert.equal(existsSync(f.lease.path), true);
});
