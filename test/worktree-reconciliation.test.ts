import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { openDb } from "../src/server/db.ts";
import {
  WorktreeManager,
  type NativeWorktreeLease,
  type WorktreeManagerDeps,
} from "../src/server/worktrees/manager.ts";
import { NativeWorktreeGit, type WorktreeGit } from "../src/server/worktrees/git.ts";
import type { WorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";

const db = openDb();

afterEach(() => {
  db.exec("DELETE FROM worktree_slots; DELETE FROM worktree_pools; DELETE FROM app_config WHERE key = 'worktrees';");
});

function repo(prefix: string): { clone: string; sha: string } {
  const { clone } = mkOriginAndClone(prefix);
  return { clone, sha: gitIn(clone, "rev-parse", "HEAD") };
}

function acquired(
  result: Awaited<ReturnType<WorktreeManager["acquire"]>>,
): NativeWorktreeLease {
  assert.equal(result.outcome, "acquired");
  return (result as { outcome: "acquired"; lease: NativeWorktreeLease }).lease;
}

function harness(options: {
  referenced?: Set<string>;
  occupancy?: Map<string, WorktreeOccupancy>;
  policy?: () => { enabled: boolean; maxSlots: number; setupArgv: readonly string[] | null };
  git?: WorktreeGit;
} = {}): WorktreeManager {
  const referenced = options.referenced ?? new Set<string>();
  const deps: Partial<WorktreeManagerDeps> = {
    ownerReferenced: async (reference) => referenced.has(reference.leaseId),
    resolvePolicy: options.policy ?? (() => ({ enabled: true, maxSlots: 16, setupArgv: null })),
    occupancy: async (paths) =>
      new Map(
        paths.map((path) => [
          path,
          options.occupancy?.get(path) ?? { status: "known" as const, occupants: [] },
        ]),
      ),
    ...(options.git ? { git: options.git } : {}),
  };
  return new WorktreeManager(db, deps);
}

test("startup preserves a referenced active lease even when it is dirty and occupied", async () => {
  const repository = repo("mission-reconcile-live-");
  const referenced = new Set<string>();
  const occupancy = new Map<string, WorktreeOccupancy>();
  const manager = harness({ referenced, occupancy });
  const lease = acquired(
    await manager.acquire({
      repositoryPath: repository.clone,
      baseSha: repository.sha,
      owner: { kind: "task", key: "task-live" },
    }),
  );
  referenced.add(lease.leaseId);
  writeFileSync(`${lease.path}/in-progress.txt`, "work\n");
  occupancy.set(lease.path, {
    status: "known",
    occupants: [
      {
        pid: 77,
        ppid: 1,
        startRaw: "now",
        startMs: 1,
        command: "codex",
        cwd: lease.path,
        knownOwner: "terminal:session-live",
      },
    ],
  });

  await manager.reconcile();
  assert.equal(manager.store.slot(lease.slotId)?.state, "leased");
  assert.equal(manager.store.slot(lease.slotId)?.currentHeadSha, repository.sha);
});

test("startup quarantines stale leases, interrupted provisioning, and unknown occupancy", async () => {
  const staleRepo = repo("mission-reconcile-stale-");
  const stale = harness();
  const staleLease = acquired(
    await stale.acquire({
      repositoryPath: staleRepo.clone,
      baseSha: staleRepo.sha,
      owner: { kind: "task", key: "task-stale" },
    }),
  );
  await stale.reconcile();
  assert.equal(stale.store.slot(staleLease.slotId)?.state, "quarantined");
  assert.match(stale.store.slot(staleLease.slotId)?.quarantineReason ?? "", /no matching domain owner/);

  const interruptedRepo = repo("mission-reconcile-provisioning-");
  const refs = new Set<string>();
  const interrupted = harness({ referenced: refs });
  const interruptedLease = acquired(
    await interrupted.acquire({
      repositoryPath: interruptedRepo.clone,
      baseSha: interruptedRepo.sha,
      owner: { kind: "check", key: "attempt-1" },
    }),
  );
  refs.add(interruptedLease.leaseId);
  db.prepare(`UPDATE worktree_slots SET state = 'provisioning' WHERE id = ?`).run(
    interruptedLease.slotId,
  );
  await interrupted.reconcile();
  assert.equal(interrupted.store.slot(interruptedLease.slotId)?.state, "quarantined");
  assert.match(
    interrupted.store.slot(interruptedLease.slotId)?.quarantineReason ?? "",
    /interrupted provisioning/,
  );

  const unknownRepo = repo("mission-reconcile-unknown-");
  const occupancy = new Map<string, WorktreeOccupancy>();
  const unknown = harness({ occupancy });
  const unknownLease = acquired(
    await unknown.acquire({
      repositoryPath: unknownRepo.clone,
      baseSha: unknownRepo.sha,
      owner: { kind: "manual", key: "manual-1" },
    }),
  );
  occupancy.set(unknownLease.path, { status: "unknown", reason: "lsof timed out" });
  await unknown.reconcile();
  assert.equal(unknown.store.slot(unknownLease.slotId)?.state, "quarantined");
  assert.match(unknown.store.slot(unknownLease.slotId)?.lastError ?? "", /lsof timed out/);
});

test("startup completes only a returning intent whose reset result is positively proven", async () => {
  const repository = repo("mission-reconcile-returning-");
  const referenced = new Set<string>();
  const manager = harness({
    referenced,
    policy: () => ({ enabled: true, maxSlots: 1, setupArgv: null }),
  });
  const lease = acquired(
    await manager.acquire({
      repositoryPath: repository.clone,
      baseSha: repository.sha,
      owner: { kind: "task", key: "task-returning" },
    }),
  );
  const returning = manager.store.markReturning(
    lease.slotId,
    lease.slotVersion,
    repository.sha,
    Date.now(),
  );
  assert.ok(returning);
  referenced.add(lease.leaseId);

  await manager.reconcile();
  const available = manager.store.slot(lease.slotId)!;
  assert.equal(available.state, "available");
  assert.equal(available.lastReleasedLeaseId, lease.leaseId);
  assert.equal(available.lastReleasedOwnerKind, "task");
  assert.equal(available.lastReleasedOwnerKey, "task-returning");

  // The caller can retry after its domain row failed to clear and still prove completion.
  assert.deepEqual(await manager.release(lease), { outcome: "alreadyReleased" });
  const blocked = await manager.acquire({
    repositoryPath: repository.clone,
    baseSha: repository.sha,
    owner: { kind: "task", key: "task-next" },
  });
  assert.equal(blocked.outcome, "notAcquired");
  assert.equal(manager.store.slot(lease.slotId)?.state, "available");

  referenced.delete(lease.leaseId);
  const next = acquired(
    await manager.acquire({
      repositoryPath: repository.clone,
      baseSha: repository.sha,
      owner: { kind: "task", key: "task-next" },
    }),
  );
  assert.equal(next.slotId, lease.slotId);
  assert.equal((await manager.release(next)).outcome, "released");
});

test("startup keeps safe available/quarantined states and rejects dirty availability", async () => {
  const safeRepo = repo("mission-reconcile-available-");
  const safe = harness();
  const lease = acquired(
    await safe.acquire({
      repositoryPath: safeRepo.clone,
      baseSha: safeRepo.sha,
      owner: { kind: "task", key: "task-available" },
    }),
  );
  assert.equal((await safe.release(lease)).outcome, "released");
  await safe.reconcile();
  assert.equal(safe.store.slot(lease.slotId)?.state, "available");

  writeFileSync(`${lease.path}/scratch.txt`, "not safe\n");
  await safe.reconcile();
  const quarantined = safe.store.slot(lease.slotId)!;
  assert.equal(quarantined.state, "quarantined");
  const version = quarantined.version;
  await safe.reconcile();
  assert.equal(safe.store.slot(lease.slotId)?.state, "quarantined");
  assert.equal(safe.store.slot(lease.slotId)?.version, version, "quarantine is not repeatedly transitioned");
});

test("startup removes only a pruning intent whose path and registration are both absent", async () => {
  const repository = repo("mission-reconcile-pruning-");
  const manager = harness();
  const lease = acquired(
    await manager.acquire({
      repositoryPath: repository.clone,
      baseSha: repository.sha,
      owner: { kind: "task", key: "task-prune" },
    }),
  );
  db.prepare(`UPDATE worktree_slots SET state = 'pruning', version = version + 1 WHERE id = ?`).run(
    lease.slotId,
  );
  gitIn(repository.clone, "worktree", "remove", "--force", lease.path);
  await manager.reconcile();
  assert.equal(manager.store.slot(lease.slotId), null);
});

test("startup quarantines incomplete active identity instead of treating it as absent", async () => {
  const repository = repo("mission-reconcile-incomplete-identity-");
  const manager = harness();
  const lease = acquired(
    await manager.acquire({
      repositoryPath: repository.clone,
      baseSha: repository.sha,
      owner: { kind: "task", key: "task-incomplete" },
    }),
  );
  assert.equal((await manager.release(lease)).outcome, "released");
  db.prepare(`UPDATE worktree_slots SET active_lease_id = 'dangling' WHERE id = ?`).run(lease.slotId);

  await manager.reconcile();
  assert.equal(manager.store.slot(lease.slotId)?.state, "quarantined");
  assert.match(manager.store.slot(lease.slotId)?.quarantineReason ?? "", /incomplete active/);
});

test("maintenance planning requires the exact native pool marker", async () => {
  const repository = repo("mission-maintenance-marker-");
  const manager = harness();
  const lease = acquired(
    await manager.acquire({
      repositoryPath: repository.clone,
      baseSha: repository.sha,
      owner: { kind: "task", key: "task-marker" },
    }),
  );
  assert.equal((await manager.release(lease)).outcome, "released");
  const pool = manager.store.poolForSlot(lease.slotId)!;
  writeFileSync(
    `${pool.poolPath}/.mission-control-worktree-pool`,
    '{"schemaVersion":1,"poolId":"somebody-else"}\n',
  );

  const plan = await manager.planMaintenance();
  assert.equal(plan[0]?.safe, false);
  assert.match(plan[0]?.reason ?? "", /marker/);
});

test("maintenance planning reads the observed remote default without fetching", async () => {
  const repository = repo("mission-maintenance-read-only-");
  class TrackingGit extends NativeWorktreeGit {
    fetchCalls = 0;
    observedCalls = 0;

    override async fetchDefaultSha(identity: Parameters<WorktreeGit["fetchDefaultSha"]>[0]) {
      this.fetchCalls++;
      return super.fetchDefaultSha(identity);
    }

    override async observedDefaultSha(identity: Parameters<WorktreeGit["observedDefaultSha"]>[0]) {
      this.observedCalls++;
      return super.observedDefaultSha(identity);
    }
  }
  const git = new TrackingGit();
  const manager = harness({ git });
  const lease = acquired(
    await manager.acquire({
      repositoryPath: repository.clone,
      baseSha: repository.sha,
      owner: { kind: "task", key: "task-read-only-plan" },
    }),
  );
  assert.equal((await manager.release(lease)).outcome, "released");
  const fetchCallsBeforePlan = git.fetchCalls;
  const observedCallsBeforePlan = git.observedCalls;

  const plan = await manager.planMaintenance();
  assert.equal(plan[0]?.safe, true);
  assert.equal(git.fetchCalls, fetchCallsBeforePlan, "preview planning must not fetch");
  assert.equal(git.observedCalls, observedCallsBeforePlan + 1);
});

test("maintenance planning refuses every unsafe class and identifies safe right-size work", async () => {
  const repository = repo("mission-maintenance-plan-");
  const referenced = new Set<string>();
  const occupancy = new Map<string, WorktreeOccupancy>();
  let maxSlots = 7;
  const manager = harness({
    referenced,
    occupancy,
    policy: () => ({ enabled: true, maxSlots, setupArgv: null }),
  });
  const leases: NativeWorktreeLease[] = [];
  for (let index = 0; index < 7; index++) {
    leases.push(
      acquired(
        await manager.acquire({
          repositoryPath: repository.clone,
          baseSha: repository.sha,
          owner: { kind: "task", key: `task-${index}` },
        }),
      ),
    );
  }
  // Keep one leased. Return the others, then make each one unsafe in a distinct way.
  for (const lease of leases.slice(0, 6)) assert.equal((await manager.release(lease)).outcome, "released");
  referenced.add(leases[1]!.leaseId);
  writeFileSync(`${leases[2]!.path}/dirty.txt`, "dirty\n");
  occupancy.set(leases[3]!.path, {
    status: "known",
    occupants: [{
      pid: 81,
      ppid: 1,
      startRaw: "now",
      startMs: 1,
      command: "node",
      cwd: leases[3]!.path,
      knownOwner: null,
    }],
  });
  writeFileSync(`${leases[4]!.path}/keep.txt`, "base\nunmerged\n");
  gitIn(leases[4]!.path, "add", "keep.txt");
  gitIn(leases[4]!.path, "commit", "-qm", "unmerged local work");
  occupancy.set(leases[5]!.path, { status: "unknown", reason: "cwd scan failed" });
  maxSlots = 1;

  const plan = await manager.planMaintenance();
  const bySlot = new Map(plan.map((candidate) => [candidate.slotId, candidate]));
  assert.equal(bySlot.get(leases[0]!.slotId)?.safe, true);
  assert.match(bySlot.get(leases[1]!.slotId)?.reason ?? "", /domain ownership/);
  assert.match(bySlot.get(leases[2]!.slotId)?.reason ?? "", /cleanliness/);
  assert.match(bySlot.get(leases[3]!.slotId)?.reason ?? "", /occupied/);
  assert.match(bySlot.get(leases[4]!.slotId)?.reason ?? "", /not merged/);
  assert.match(bySlot.get(leases[5]!.slotId)?.reason ?? "", /cwd scan failed/);
  assert.match(bySlot.get(leases[6]!.slotId)?.reason ?? "", /leased/);
  assert.equal(plan.filter((candidate) => candidate.rightSize).length, 6);
});
