import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { openDb } from "../src/server/db.ts";
import {
  WorktreeManager,
  type NativeWorktreeLease,
  type WorktreeManagerDeps,
} from "../src/server/worktrees/manager.ts";
import { NativeWorktreeGit } from "../src/server/worktrees/git.ts";
import {
  WORKTREE_POOL_MARKER,
  ensureWorktreePoolMarker,
  observeWorktreePoolMarker,
} from "../src/server/worktrees/marker.ts";
import { quarantineAutoRecoverable, quarantineRecoverable } from "../src/server/worktrees/store.ts";
import { WorktreeOperationsService } from "../src/server/worktrees/operations.ts";
import { LegacyTreehouseService } from "../src/server/worktrees/legacy-treehouse.ts";
import { CheckLeaseManager } from "../src/server/workflows/check-lease.ts";
import type { WorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";

// The field failure from 2026-11-12: under load the machine-wide process listing is killed
// before it answers, so one occupancy read in a run of healthy ones comes back unknown. Each
// such read used to strand a native slot in quarantine for good, until the pool was full of
// quarantined slots and every dispatch fell back to a disposable Git worktree.

const db = openDb();

afterEach(() => {
  db.exec("DELETE FROM worktree_slots; DELETE FROM worktree_pools; DELETE FROM app_config WHERE key = 'worktrees';");
});

const KILLED = "cwd/process listing was killed before it answered";

function acquired(result: Awaited<ReturnType<WorktreeManager["acquire"]>>): NativeWorktreeLease {
  assert.equal(result.outcome, "acquired", JSON.stringify(result));
  return (result as { outcome: "acquired"; lease: NativeWorktreeLease }).lease;
}

/**
 * A manager whose occupancy observer answers each call from `script` in order, then reads
 * every path as known and empty. `"timeout"` is the killed listing: unknown for every path.
 */
function harness(maxSlots: number, extra: Partial<WorktreeManagerDeps> = {}) {
  const script: Array<"ok" | "timeout"> = [];
  let calls = 0;
  const deps: Partial<WorktreeManagerDeps> = {
    ownerReferenced: async () => false,
    pause: async () => {},
    resolvePolicy: () => ({ enabled: true, maxSlots, setupArgv: null }),
    occupancy: async (paths) => {
      calls++;
      const step = script.shift() ?? "ok";
      return new Map(paths.map((path): [string, WorktreeOccupancy] => [
        path,
        step === "timeout" ? { status: "unknown", reason: KILLED } : { status: "known", occupants: [] },
      ]));
    },
    ...extra,
  };
  return { manager: new WorktreeManager(db, deps), script, calls: () => calls };
}

function repo(prefix: string): { origin: string; clone: string; sha: string } {
  const { origin, clone } = mkOriginAndClone(prefix);
  return { origin, clone, sha: gitIn(clone, "rev-parse", "HEAD") };
}

test("an occupancy read killed after screening never strands the slot it reserved", async () => {
  const repository = repo("mission-quarantine-repro-");
  const { manager, script } = harness(2);
  // Two slots, both returned: the pool is full, and both are idle.
  const first = acquired(await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha,
    owner: { kind: "task", key: "first" } }));
  const second = acquired(await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha,
    owner: { kind: "task", key: "second" } }));
  for (const lease of [first, second]) assert.equal((await manager.release(lease)).outcome, "released");

  // Two dispatches, each meeting the timeout on the recheck it takes after reserving a slot.
  for (const key of ["unlucky-1", "unlucky-2"]) {
    script.push("ok", "timeout");
    const deferred = await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha,
      owner: { kind: "task", key } });
    assert.equal(deferred.outcome, "outcomeUnknown", "an unanswered recheck grants nothing");
  }
  for (const lease of [first, second]) {
    const slot = manager.store.slot(lease.slotId)!;
    assert.equal(slot.state, "available", "an unknown recheck is not evidence against the slot");
    assert.equal(slot.activeLeaseId, null, "the ungranted reservation does not linger");
    assert.equal(slot.quarantineReason, null);
    assert.equal(slot.quarantinedAt, null);
  }

  // Several reconciles change nothing, and the next dispatch gets a native slot, not a fallback.
  for (let pass = 0; pass < 3; pass++) await manager.reconcile();
  const next = acquired(await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha,
    owner: { kind: "task", key: "next" } }));
  assert.ok([first.slotId, second.slotId].includes(next.slotId));
});

test("a transient quarantine is re-proven by reconcile and the pool regains its capacity", async () => {
  const repository = repo("mission-quarantine-recover-");
  const { manager } = harness(1);
  const lease = acquired(await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha,
    owner: { kind: "task", key: "only" } }));
  assert.equal((await manager.release(lease)).outcome, "released");
  const released = manager.store.slot(lease.slotId)!;
  const quarantined = manager.store.quarantine(lease.slotId, "observation", "slot process occupancy is unknown", KILLED,
    1_000, released.version)!;
  assert.equal(quarantined.quarantineCategory, "observation");
  assert.equal(quarantined.quarantinedAt, 1_000);

  const exhausted = await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha,
    owner: { kind: "task", key: "blocked" } });
  assert.deepEqual(exhausted, { outcome: "notAcquired", reason: "native pool capacity 1 is exhausted" });

  await manager.reconcile();
  const recovered = manager.store.slot(lease.slotId)!;
  assert.equal(recovered.state, "available");
  assert.equal(recovered.version, quarantined.version + 1, "recovery is one compare-and-swap");
  assert.equal(recovered.quarantineReason, null);
  assert.equal(recovered.quarantineCategory, null);
  assert.equal(recovered.quarantinedAt, null);
  assert.equal(recovered.lastReleasedLeaseId, lease.leaseId, "release history survives recovery");
  assert.equal(manager.store.pool(lease.poolId)?.reconciliationError, null);
  acquired(await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha,
    owner: { kind: "task", key: "after" } }));
});

// ---- store ---------------------------------------------------------------------------------

/** A released slot in a real pool, so the store's compare-and-swaps meet real rows. */
async function releasedSlot(prefix: string) {
  const repository = repo(prefix);
  const { manager } = harness(4);
  const lease = acquired(await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha,
    owner: { kind: "task", key: prefix } }));
  assert.equal((await manager.release(lease)).outcome, "released");
  return { manager, lease, repository, slot: manager.store.slot(lease.slotId)! };
}

test("store: only the transition into quarantine records its reason, category and time", async () => {
  const { manager, slot } = await releasedSlot("mission-quarantine-store-enter-");
  const store = manager.store;
  const entered = store.quarantine(slot.id, "state", "available slot has dirty or untracked work", null, 5_000, slot.version)!;
  assert.deepEqual([entered.state, entered.quarantineCategory, entered.quarantinedAt], ["quarantined", "state", 5_000]);

  // A second quarantine is refused, so a later observation cannot relabel it recoverable.
  assert.equal(store.quarantine(slot.id, "observation", "slot Git state is unknown", "timeout", 9_000), null);
  assert.equal(store.quarantine(slot.id, "observation", "slot Git state is unknown", "timeout", 9_000, entered.version), null);
  // Observation refreshes write HEAD and the diagnostic, never the quarantine record.
  store.updateObserved(slot.id, "f".repeat(40), "observed later", 12_000);
  const after = store.slot(slot.id)!;
  assert.equal(after.version, entered.version);
  assert.equal(after.quarantineReason, "available slot has dirty or untracked work");
  assert.equal(after.quarantineCategory, "state");
  assert.equal(after.quarantinedAt, 5_000);
  assert.equal(after.updatedAt, 12_000);
});

test("store: recovery is a compare-and-swap that only a recoverable, unleased, unmoved slot passes", async () => {
  const { manager, slot } = await releasedSlot("mission-quarantine-store-recover-");
  const store = manager.store;
  const head = slot.currentHeadSha!;
  const set = (column: string, value: string | number | null) =>
    db.prepare(`UPDATE worktree_slots SET ${column} = ? WHERE id = ?`).run(value, slot.id);
  const quarantined = store.quarantine(slot.id, "observation", "slot process occupancy is unknown", KILLED, 1, slot.version)!;

  for (const category of ["state", "transition", null, "a-category-from-a-newer-build"]) {
    set("quarantine_category", category);
    assert.equal(store.recoverQuarantined(slot.id, quarantined.version, head, 2), null, `category ${category} is not recoverable`);
  }
  set("quarantine_category", "observation");
  assert.equal(store.recoverQuarantined(slot.id, quarantined.version, "e".repeat(40), 2), null, "HEAD moved");
  assert.equal(store.recoverQuarantined(slot.id, quarantined.version - 1, head, 2), null, "stale version");
  set("active_lease_id", "lease-still-held");
  assert.equal(store.recoverQuarantined(slot.id, quarantined.version, head, 2), null, "active lease");
  set("active_lease_id", null);

  const recovered = store.recoverQuarantined(slot.id, quarantined.version, head, 3)!;
  assert.equal(recovered.state, "available");
  assert.equal(recovered.version, quarantined.version + 1);
  assert.deepEqual([recovered.quarantineReason, recovered.quarantineCategory, recovered.quarantinedAt, recovered.lastError],
    [null, null, null, null]);
  assert.equal(recovered.currentHeadSha, head);
  assert.equal(recovered.lastReleasedLeaseId, slot.lastReleasedLeaseId);
});

test("store: a return out of quarantine clears the quarantine record only when it completes", async () => {
  const repository = repo("mission-quarantine-store-return-");
  const { manager } = harness(2);
  const lease = acquired(await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha,
    owner: { kind: "task", key: "held" } }));
  const store = manager.store;
  const quarantined = store.quarantine(lease.slotId, "observation", "slot Git state is unknown", "timeout", 7, lease.slotVersion)!;
  const returning = store.markReturning(lease.slotId, quarantined.version, repository.sha, 8)!;
  assert.deepEqual([returning.quarantineCategory, returning.quarantinedAt], ["observation", 7]);
  const released = store.completeRelease(lease.slotId, returning.version, repository.sha, 9)!;
  assert.deepEqual([released.state, released.quarantineReason, released.quarantineCategory, released.quarantinedAt],
    ["available", null, null, null]);
});

test("store: an ungranted reservation is undone only under its own lease, version and no claim", async () => {
  const { manager, slot } = await releasedSlot("mission-quarantine-store-cancel-");
  const store = manager.store;
  const reserved = store.reserveAvailable({ slotId: slot.id, version: slot.version, leaseId: "lease-r", ownerKind: "task",
    ownerKey: "r", requestedHeadSha: slot.currentHeadSha!, now: 10 })!;
  assert.equal(store.cancelReservation(slot.id, reserved.version, "another-lease", 11), null);
  assert.equal(store.cancelReservation(slot.id, reserved.version - 1, "lease-r", 11), null);
  assert.ok(store.beginClaim(slot.id, reserved.version, 11));
  assert.equal(store.cancelReservation(slot.id, reserved.version, "lease-r", 11), null, "a claim began");
  db.prepare("UPDATE worktree_slots SET deps_state = 'failed' WHERE id = ?").run(slot.id);

  const cancelled = store.cancelReservation(slot.id, reserved.version, "lease-r", 12)!;
  assert.equal(cancelled.state, "available");
  assert.equal(cancelled.version, reserved.version + 1);
  assert.deepEqual([cancelled.activeLeaseId, cancelled.activeOwnerKind, cancelled.activeOwnerKey, cancelled.leasedAt],
    [null, null, null, null]);
  assert.equal(cancelled.lastReleasedLeaseId, slot.lastReleasedLeaseId, "release history is kept");
  assert.equal(cancelled.currentHeadSha, slot.currentHeadSha);
  assert.equal(cancelled.quarantinedAt, null);
});

// ---- reconcile -----------------------------------------------------------------------------

for (const category of ["state", "transition", null] as const) {
  test(`reconcile keeps a ${category ?? "legacy uncategorized"} quarantine even when the slot looks idle`, async () => {
    const { manager, slot } = await releasedSlot(`mission-quarantine-keep-${category ?? "legacy"}-`);
    const quarantined = manager.store.quarantine(slot.id, "state", "available slot HEAD moved outside an allocator transition",
      null, 4_000, slot.version)!;
    db.prepare("UPDATE worktree_slots SET quarantine_category = ? WHERE id = ?").run(category, slot.id);
    for (let pass = 0; pass < 2; pass++) await manager.reconcile();
    const after = manager.store.slot(slot.id)!;
    assert.equal(after.state, "quarantined");
    assert.equal(after.version, quarantined.version);
    assert.equal(after.quarantineCategory, category);
    assert.equal(after.quarantinedAt, 4_000);
    assert.equal(after.quarantineReason, quarantined.quarantineReason);
    // A Reconcile that changed nothing says why, naming the category.
    assert.equal(manager.store.pool(slot.poolId)?.reconciliationError,
      `slot ${slot.ordinal}: ${category === null ? "an uncategorized legacy quarantine" : `a ${category} quarantine`} ` +
      "needs operator action; Reconcile does not recover it");
  });
}

for (const change of ["moved HEAD", "attached branch"] as const) {
  test(`reconcile keeps a transient quarantine whose slot now has a ${change}`, async () => {
    const { manager, slot, lease, repository } = await releasedSlot(`mission-quarantine-${change.replace(" ", "-")}-`);
    const quarantined = manager.store.quarantine(slot.id, "observation", "slot process occupancy is unknown", KILLED,
      4_000, slot.version)!;
    if (change === "moved HEAD") {
      // A commit that IS merged into the default, so only the moved-HEAD proof can refuse it.
      gitIn(repository.origin, "commit", "--allow-empty", "-qm", "landed");
      gitIn(repository.clone, "fetch", "-q", "origin");
      gitIn(lease.path, "checkout", "-q", "--detach", gitIn(repository.clone, "rev-parse", "origin/main"));
    } else {
      gitIn(lease.path, "checkout", "-q", "-b", "someone-elses-branch");
    }
    await manager.reconcile();
    const after = manager.store.slot(slot.id)!;
    assert.equal(after.state, "quarantined");
    assert.equal(after.version, quarantined.version);
    assert.equal(after.quarantinedAt, 4_000, "a failed recovery proof leaves the quarantine time alone");
    assert.match(manager.store.pool(slot.poolId)?.reconciliationError ?? "",
      change === "moved HEAD" ? /HEAD moved/ : /attached to a branch/);
  });
}

test("reconcile defers on unreadable Git registrations instead of quarantining the pool", async () => {
  const repository = repo("mission-quarantine-reconcile-list-");
  const git = new NativeWorktreeGit();
  const { manager } = harness(4, { git });
  const lease = acquired(await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha,
    owner: { kind: "task", key: "listed" } }));
  assert.equal((await manager.release(lease)).outcome, "released");
  const before = manager.store.slot(lease.slotId)!;
  const list = git.list.bind(git);
  git.list = async () => ({ ok: false, reason: "git worktree list timed out after 15 s, and after 30 s on retry", outcomeUnknown: true });
  await manager.reconcile();
  const after = manager.store.slot(lease.slotId)!;
  assert.equal(after.state, "available");
  assert.equal(after.version, before.version);
  assert.match(manager.store.pool(lease.poolId)?.reconciliationError ?? "", /registrations are unknown/);
  git.list = list;
  await manager.reconcile();
  assert.equal(manager.store.pool(lease.poolId)?.reconciliationError, null);
});

// ---- acquire screening ---------------------------------------------------------------------

/** Two released idle slots in one pool, with a Git whose reads a test can intercept. */
async function twoIdleSlots(prefix: string, extra: Partial<WorktreeManagerDeps> = {}) {
  const repository = repo(prefix);
  const git = new NativeWorktreeGit();
  const { manager } = harness(2, { git, ...extra });
  const leases: NativeWorktreeLease[] = [];
  for (const key of ["a", "b"]) {
    leases.push(acquired(await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha,
      owner: { kind: "task", key } })));
  }
  for (const lease of leases) assert.equal((await manager.release(lease)).outcome, "released");
  return { manager, git, repository, first: leases[0]!, second: leases[1]! };
}

test("acquire: an unreadable registration list quarantines nothing and defers", async () => {
  const { manager, git, repository } = await twoIdleSlots("mission-quarantine-acquire-list-");
  const versions = manager.store.slots().map((slot) => [slot.state, slot.version]);
  git.list = async () => { throw new Error("git worktree list was killed"); };
  const result = await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha,
    owner: { kind: "task", key: "deferred" } });
  assert.equal(result.outcome, "outcomeUnknown");
  assert.match((result as { reason: string }).reason, /Git registrations could not be read/);
  assert.deepEqual(manager.store.slots().map((slot) => [slot.state, slot.version]), versions);
});

test("acquire: one slot's failed Git read makes only that slot ineligible", async () => {
  const { manager, git, repository, first, second } = await twoIdleSlots("mission-quarantine-acquire-inspect-");
  const inspect = git.inspect.bind(git);
  git.inspect = async (path) => path === first.path
    ? { ok: false, reason: "git status timed out after 15 s, and after 30 s on retry", outcomeUnknown: true }
    : inspect(path);
  const before = manager.store.slot(first.slotId)!;
  const next = acquired(await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha,
    owner: { kind: "task", key: "next" } }));
  assert.equal(next.slotId, second.slotId, "the observed idle sibling is granted");
  const skipped = manager.store.slot(first.slotId)!;
  assert.equal(skipped.state, "available", "an unanswered read is not evidence against the slot");
  assert.equal(skipped.version, before.version);
  assert.equal(skipped.quarantinedAt, null);
});

test("acquire: an unreadable last owner makes only that slot ineligible", async () => {
  let unreadable = "";
  const { manager, repository, first, second } = await twoIdleSlots("mission-quarantine-acquire-owner-", {
    ownerReferenced: async (reference) => {
      if (reference.leaseId === unreadable) throw new Error("database is locked");
      return false;
    },
  });
  unreadable = first.leaseId;
  const next = acquired(await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha,
    owner: { kind: "task", key: "next" } }));
  assert.equal(next.slotId, second.slotId);
  assert.equal(manager.store.slot(first.slotId)?.state, "available");
});

test("acquire: when every idle slot is unobserved it defers rather than growing the pool", async () => {
  const repository = repo("mission-quarantine-acquire-all-unknown-");
  const git = new NativeWorktreeGit();
  const { manager } = harness(4, { git });
  const lease = acquired(await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha,
    owner: { kind: "task", key: "only" } }));
  assert.equal((await manager.release(lease)).outcome, "released");
  git.inspect = async () => { throw new Error("git status was killed"); };
  const result = await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha,
    owner: { kind: "task", key: "deferred" } });
  assert.equal(result.outcome, "outcomeUnknown");
  assert.equal(manager.store.slots().length, 1, "no slot was added beside the unobserved one");
  assert.equal(manager.store.slot(lease.slotId)?.state, "available");
});

test("acquire: a positively dirty slot is still quarantined, as a state fact with its time", async () => {
  const now = 1_700_000_000_000;
  const { manager, repository, first, second } = await twoIdleSlots("mission-quarantine-acquire-dirty-", { now: () => now });
  writeFileSync(`${first.path}/unfinished.txt`, "someone's work\n");
  const next = acquired(await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha,
    owner: { kind: "task", key: "next" } }));
  assert.equal(next.slotId, second.slotId);
  const dirty = manager.store.slot(first.slotId)!;
  assert.equal(dirty.state, "quarantined");
  assert.equal(dirty.quarantineReason, "available slot has dirty or untracked work");
  assert.equal(dirty.quarantineCategory, "state");
  assert.equal(dirty.quarantinedAt, now);
  // Cleaning it later does not recover it: a dirty slot was someone's work, not a missed read.
  rmSync(`${first.path}/unfinished.txt`);
  await manager.reconcile();
  assert.equal(manager.store.slot(first.slotId)?.state, "quarantined");
});

test("acquire: a process that entered the reserved slot still quarantines it", async () => {
  const repository = repo("mission-quarantine-acquire-entered-");
  const script: WorktreeOccupancy[] = [];
  const { manager } = harness(2, {
    occupancy: async (paths) => {
      const next = script.shift() ?? { status: "known" as const, occupants: [] };
      return new Map(paths.map((path) => [path, next]));
    },
  });
  const lease = acquired(await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha,
    owner: { kind: "task", key: "first" } }));
  assert.equal((await manager.release(lease)).outcome, "released");
  script.push({ status: "known", occupants: [] }, { status: "known", occupants: [{
    pid: 4242, ppid: 1, startRaw: "now", startMs: 1, command: "codex", cwd: lease.path, knownOwner: null,
  }] });
  const result = await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha,
    owner: { kind: "task", key: "raced" } });
  assert.equal(result.outcome, "outcomeUnknown");
  const slot = manager.store.slot(lease.slotId)!;
  assert.equal(slot.state, "quarantined");
  assert.equal(slot.quarantineCategory, "state");
  assert.equal(slot.quarantineReason, "a process entered the available slot before reset");
});

// ---- review round 1 ------------------------------------------------------------------------

test("marker: a read that does not answer is told apart from an absent or malformed marker", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mission-marker-reading-")));
  try {
    assert.deepEqual(await observeWorktreePoolMarker(root), { kind: "absent" });
    await ensureWorktreePoolMarker(root, "pool-a");
    assert.deepEqual(await observeWorktreePoolMarker(root),
      { kind: "present", marker: { schemaVersion: 1, poolId: "pool-a" } });
    const marker = join(root, WORKTREE_POOL_MARKER);
    chmodSync(marker, 0o000);
    const denied = await observeWorktreePoolMarker(root);
    chmodSync(marker, 0o644);
    assert.equal(denied.kind, "unreadable", "a denied open says nothing about the marker's content");
    assert.match((denied as { reason: string }).reason, /EACCES/);
    writeFileSync(marker, "{}");
    assert.deepEqual(await observeWorktreePoolMarker(root), { kind: "invalid" });
    rmSync(marker);
    mkdirSync(marker);
    assert.deepEqual(await observeWorktreePoolMarker(root), { kind: "invalid" }, "a directory is not a marker");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconcile defers on an unreadable pool marker, and a later readable pass proceeds", async () => {
  const repository = repo("mission-quarantine-marker-unreadable-");
  let unreadable = true;
  let heldLease = "";
  const { manager } = harness(4, {
    ownerReferenced: async (reference) => reference.leaseId === heldLease,
    observeMarker: async (poolPath) => unreadable
      ? { kind: "unreadable", reason: "Error: EIO: i/o error, open marker" }
      : observeWorktreePoolMarker(poolPath),
  });
  const idle = acquired(await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha,
    owner: { kind: "task", key: "idle" } }));
  const held = acquired(await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha,
    owner: { kind: "manual", key: "held" } }));
  heldLease = held.leaseId;
  assert.equal((await manager.release(idle)).outcome, "released");
  const before = manager.store.slots().map((slot) => [slot.id, slot.state, slot.version]);

  for (let pass = 0; pass < 2; pass++) await manager.reconcile();
  assert.deepEqual(manager.store.slots().map((slot) => [slot.id, slot.state, slot.version]), before,
    "no slot, leased or idle, is quarantined for a marker read that did not answer");
  assert.ok(manager.store.slots().every((slot) => slot.quarantinedAt === null));
  assert.match(manager.store.pool(idle.poolId)?.reconciliationError ?? "", /pool marker could not be read: .*EIO/);

  unreadable = false;
  await manager.reconcile();
  assert.equal(manager.store.pool(idle.poolId)?.reconciliationError, null);
  assert.equal(manager.store.slot(idle.slotId)?.state, "available");
  assert.equal(manager.store.slot(held.slotId)?.state, "leased", "the referenced lease was never disturbed");
});

for (const marker of ["absent", "invalid"] as const) {
  test(`reconcile still quarantines the pool, unrecoverably, for an ${marker} marker`, async () => {
    const { manager, slot } = await releasedSlot(`mission-quarantine-marker-${marker}-`);
    const markerPath = join(manager.store.pool(slot.poolId)!.poolPath, WORKTREE_POOL_MARKER);
    if (marker === "absent") rmSync(markerPath);
    else writeFileSync(markerPath, JSON.stringify({ schemaVersion: 1, poolId: "another-pool" }));
    await manager.reconcile();
    const after = manager.store.slot(slot.id)!;
    assert.equal(after.state, "quarantined");
    assert.equal(after.quarantineCategory, "state");
    assert.equal(after.quarantineReason, "pool marker is missing, malformed, or belongs to another pool");
    assert.equal(quarantineRecoverable(after.quarantineCategory), false);
  });
}

test("acquire: a reservation whose cancellation loses its lease guard is quarantined as a transition", async () => {
  const repository = repo("mission-quarantine-cancel-lost-");
  let recheck: (() => void) | null = null;
  const { manager, script } = harness(1, {
    occupancy: async (paths) => {
      const step = script.shift() ?? "ok";
      // The recheck after the reservation: something else rewrites the row's lease, without
      // a version change, before the unanswered read comes back.
      if (step === "timeout") recheck?.();
      return new Map(paths.map((path): [string, WorktreeOccupancy] => [path,
        step === "timeout" ? { status: "unknown", reason: KILLED } : { status: "known", occupants: [] }]));
    },
  });
  const first = acquired(await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha,
    owner: { kind: "task", key: "first" } }));
  assert.equal((await manager.release(first)).outcome, "released");
  recheck = () => {
    db.prepare("UPDATE worktree_slots SET active_lease_id = 'someone-elses-lease' WHERE id = ?").run(first.slotId);
  };
  script.push("ok", "timeout");
  const now = Date.now();
  const result = await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha,
    owner: { kind: "task", key: "raced" } });
  assert.deepEqual(result, { outcome: "outcomeUnknown", reason: KILLED }, "nothing is granted");
  const slot = manager.store.slot(first.slotId)!;
  assert.equal(slot.state, "quarantined");
  assert.equal(slot.quarantineCategory, "transition", "an undo that could not be proven is not a missed read");
  assert.equal(slot.quarantineReason, "slot occupancy became unknown before reset");
  assert.equal(slot.lastError, KILLED);
  assert.ok(slot.quarantinedAt !== null && slot.quarantinedAt >= now);
  assert.equal(quarantineRecoverable(slot.quarantineCategory), false);
  await manager.reconcile();
  assert.equal(manager.store.slot(first.slotId)?.state, "quarantined", "reconcile does not recover a transition");
});

// ---- GitHub Inspector ec77ab05a806 ---------------------------------------------------------

test("inventory promises recovery only to an observation quarantine that holds no lease", async () => {
  const repository = repo("mission-quarantine-leased-observation-");
  let unreadableOwner = "";
  const { manager } = harness(4, {
    ownerReferenced: async (reference) => {
      if (reference.leaseId === unreadableOwner) throw new Error("database is locked");
      return false;
    },
  });
  const held = acquired(await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha,
    owner: { kind: "task", key: "held" } }));
  const idle = acquired(await manager.acquire({ repositoryPath: repository.clone, baseSha: repository.sha,
    owner: { kind: "task", key: "idle" } }));
  assert.equal((await manager.release(idle)).outcome, "released");
  manager.store.quarantine(idle.slotId, "observation", "slot process occupancy is unknown", KILLED, 1_000,
    manager.store.slot(idle.slotId)!.version);

  // The real path to a leased observation quarantine: the owner lookup throws on both attempts.
  unreadableOwner = held.leaseId;
  await manager.reconcile();
  const leasedSlot = manager.store.slot(held.slotId)!;
  assert.equal(leasedSlot.state, "quarantined");
  assert.equal(leasedSlot.quarantineCategory, "observation");
  assert.equal(leasedSlot.quarantineReason, "leased domain ownership is unknown");
  assert.equal(leasedSlot.activeLeaseId, held.leaseId, "quarantine keeps the lease it found");
  assert.equal(quarantineAutoRecoverable(leasedSlot), false);
  assert.equal(manager.store.slot(idle.slotId)?.state, "available", "the unleased one was re-proven");

  // Once the lookup answers, reconcile still cannot recover the leased one: the promise must match.
  unreadableOwner = "";
  await manager.reconcile();
  assert.equal(manager.store.slot(held.slotId)?.state, "quarantined");

  // And the inventory, which drives the Settings copy, says so.
  manager.store.quarantine(idle.slotId, "observation", "slot process occupancy is unknown", KILLED, 2_000,
    manager.store.slot(idle.slotId)!.version);
  const operations = new WorktreeOperationsService(manager, {
    legacy: new LegacyTreehouseService(db),
    tasks: { get: () => null, reclaim: async () => ({ ok: false, error: "unexpected task" }) },
    checks: new CheckLeaseManager(db, { manager, legacy: new LegacyTreehouseService(db) }),
    checkRecovery: async () => "unknown",
    notifyChanged: () => {},
    diskBytes: async () => null,
    claimVariablePresence: async () => [],
  });
  const slots = (await operations.inventory()).repositories.flatMap((pool) => pool.slots);
  assert.equal(slots.find((slot) => slot.id === held.slotId)?.quarantineRecoverable, false);
  assert.equal(slots.find((slot) => slot.id === idle.slotId)?.quarantineRecoverable, true);
});

test("a partial lease identity is enough to withhold the recovery promise", () => {
  const base = { quarantineCategory: "observation", activeLeaseId: null, activeOwnerKind: null, activeOwnerKey: null };
  assert.equal(quarantineAutoRecoverable(base), true);
  for (const field of ["activeLeaseId", "activeOwnerKind", "activeOwnerKey"] as const) {
    assert.equal(quarantineAutoRecoverable({ ...base, [field]: "dangling" }), false, field);
  }
  for (const category of ["state", "transition", null, "from-a-newer-build"]) {
    assert.equal(quarantineAutoRecoverable({ ...base, quarantineCategory: category }), false, String(category));
  }
});
