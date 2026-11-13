import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { openDb } from "../src/server/db.ts";
import {
  WorktreeManager,
  type NativeWorktreeLease,
  type WorktreeManagerDeps,
} from "../src/server/worktrees/manager.ts";
import { NativeWorktreeGit, type WorktreeGit } from "../src/server/worktrees/git.ts";
import { run, type RunResult } from "../src/server/util/exec.ts";
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
  ownerReferenced?: WorktreeManagerDeps["ownerReferenced"];
} = {}): WorktreeManager {
  const referenced = options.referenced ?? new Set<string>();
  const deps: Partial<WorktreeManagerDeps> = {
    ownerReferenced: options.ownerReferenced ?? (async (reference) => referenced.has(reference.leaseId)),
    pause: async () => {},
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

/** What `run` reports for a child it killed at its timeout. */
function timedOut(timeoutMs: number | undefined): RunResult {
  return {
    stdout: "",
    stderr: "",
    code: 1,
    outcomeUnknown: true,
    overflowed: false,
    timedOut: true,
    signal: "SIGTERM",
    timeoutMs,
  };
}

test("a Git read killed at its timeout on both attempts records both, never `exit 1`", async () => {
  const repository = repo("mission-reconcile-git-timeout-");
  const referenced = new Set<string>();
  let failStatus = false;
  const statusTimeouts: Array<number | undefined> = [];
  const pauses: number[] = [];
  const git = new NativeWorktreeGit(
    async (bin, args, opts) => {
      if (failStatus && args.includes("status")) {
        statusTimeouts.push(opts?.timeoutMs);
        return timedOut(opts?.timeoutMs);
      }
      return run(bin, args, opts);
    },
    async (ms) => {
      pauses.push(ms);
    },
  );
  const manager = harness({ referenced, git });
  const lease = acquired(
    await manager.acquire({
      repositoryPath: repository.clone,
      baseSha: repository.sha,
      owner: { kind: "task", key: "task-git-timeout" },
    }),
  );
  referenced.add(lease.leaseId);
  failStatus = true;

  await manager.reconcile();
  assert.deepEqual(statusTimeouts, [15_000, 30_000], "the retry runs with double the timeout");
  assert.deepEqual(pauses, [2_000], "2 s after the first failure");
  const slot = manager.store.slot(lease.slotId)!;
  // A slot whose Git state is still unknown after the retry is quarantined, as before.
  assert.equal(slot.state, "quarantined");
  assert.equal(slot.quarantineReason, "slot Git state is unknown");
  assert.equal(slot.lastError, "git status timed out after 15 s, and after 30 s on retry");
});

test("a worktree listing that fails once and then succeeds changes nothing", async () => {
  const repository = repo("mission-reconcile-list-retry-");
  const referenced = new Set<string>();
  let failNextList = false;
  let lists = 0;
  const git = new NativeWorktreeGit(
    async (bin, args, opts) => {
      if (args.includes("list")) {
        lists++;
        if (failNextList) {
          failNextList = false;
          return timedOut(opts?.timeoutMs);
        }
      }
      return run(bin, args, opts);
    },
    async () => {},
  );
  const manager = harness({ referenced, git });
  const lease = acquired(
    await manager.acquire({
      repositoryPath: repository.clone,
      baseSha: repository.sha,
      owner: { kind: "task", key: "task-list-retry" },
    }),
  );
  referenced.add(lease.leaseId);
  const before = manager.store.slot(lease.slotId)!;
  lists = 0;
  failNextList = true;

  await manager.reconcile();
  assert.equal(lists, 2, "the failed listing was read once more");
  const after = manager.store.slot(lease.slotId)!;
  assert.equal(after.state, "leased");
  assert.equal(after.quarantineReason, null);
  assert.equal(after.lastError, before.lastError);
  assert.equal(after.activeLeaseId, lease.leaseId);
});

test("an owner lookup that throws once is retried before it counts as unknown", async () => {
  const repository = repo("mission-reconcile-owner-retry-");
  let leaseId = "";
  let throws = 1;
  const pauses: number[] = [];
  const manager = new WorktreeManager(db, {
    resolvePolicy: () => ({ enabled: true, maxSlots: 16, setupArgv: null }),
    occupancy: async (paths) => new Map(paths.map((path) => [path, { status: "known" as const, occupants: [] }])),
    ownerReferenced: async (reference) => {
      if (reference.leaseId !== leaseId) return false;
      if (throws-- > 0) throw new Error("database is locked");
      return true;
    },
    pause: async (ms) => {
      pauses.push(ms);
    },
  });
  const lease = acquired(
    await manager.acquire({
      repositoryPath: repository.clone,
      baseSha: repository.sha,
      owner: { kind: "task", key: "task-owner-retry:0" },
    }),
  );
  leaseId = lease.leaseId;

  await manager.reconcile();
  assert.deepEqual(pauses, [2_000]);
  // The retry proved the owner still references the lease, so the slot keeps it.
  const slot = manager.store.slot(lease.slotId)!;
  assert.equal(slot.state, "leased");
  assert.equal(slot.quarantineReason, null);
  assert.equal(slot.activeLeaseId, lease.leaseId);
});

test("a Git read that exits with its own error is answered at once, without a retry", async () => {
  const repository = repo("mission-reconcile-git-definite-");
  let failStatus = false;
  let statusReads = 0;
  const git = new NativeWorktreeGit(
    async (bin, args, opts) => {
      if (failStatus && args.includes("status")) {
        statusReads++;
        return { stdout: "", stderr: "fatal: index file corrupt\n", code: 128, outcomeUnknown: false, overflowed: false };
      }
      return run(bin, args, opts);
    },
    async () => assert.fail("a Git that reported its own exit would say the same again"),
  );
  const manager = harness({ git });
  const lease = acquired(
    await manager.acquire({
      repositoryPath: repository.clone,
      baseSha: repository.sha,
      owner: { kind: "task", key: "task-git-definite" },
    }),
  );
  failStatus = true;
  const inspected = await git.inspect(lease.path);
  assert.equal(statusReads, 1);
  assert.deepEqual(inspected, { ok: false, reason: "git status failed: fatal: index file corrupt", outcomeUnknown: false });
});


test("reconciliation recovers a process-failure quarantine before safe prune", async () => {
  const repository = repo("mission-reconcile-recovery-");
  const occupancy = new Map<string, WorktreeOccupancy>();
  const manager = harness({ occupancy });
  const lease = acquired(await manager.acquire({
    repositoryPath: repository.clone, baseSha: repository.sha,
    owner: { kind: "task", key: "recovery" },
  }));
  assert.equal((await manager.release(lease)).outcome, "released");
  occupancy.set(lease.path, { status: "unknown", reason: "cwd listing omitted a ps-listed PID" });
  await manager.reconcile();
  const before = manager.store.slot(lease.slotId)!;
  assert.equal(before.state, "quarantined");
  assert.equal((await manager.planMaintenance())[0]?.safe, false);

  occupancy.delete(lease.path);
  // A new manager proves that recovery does not depend on in-memory quarantine history.
  const restarted = harness({ occupancy });
  await restarted.reconcilePoolById(lease.poolId);
  const after = restarted.store.slot(lease.slotId)!;
  assert.equal(after.state, "available");
  assert.equal(after.version, before.version + 1);
  assert.equal(after.quarantineReason, null);
  assert.equal(after.lastError, null);
  assert.equal(after.lastReleasedLeaseId, lease.leaseId);
  assert.equal(after.lastUsedAt, before.lastUsedAt);
  assert.equal(gitIn(lease.path, "rev-parse", "HEAD"), before.currentHeadSha);
  assert.equal((await restarted.planMaintenance())[0]?.safe, true);
  assert.equal((await restarted.release(lease)).outcome, "alreadyReleased");
  await restarted.reconcile();
  assert.equal(restarted.store.slot(lease.slotId)?.version, after.version);
});


for (const blocker of [
  "active lease", "partial active identity", "partial released identity", "referenced owner",
  "unknown owner", "dirty", "unmerged", "unknown merge", "unknown default", "unknown Git",
  "occupied", "unknown occupancy", "late occupancy", "missing path", "missing registration",
  "locked registration", "foreign repository", "wrong path", "wrong pool", "wrong marker", "version race",
] as const) {
  test(`quarantine recovery protects ${blocker}`, async () => {
    const repository = repo("mission-reconcile-protected-");
    const refs = new Set<string>();
    const occupancy = new Map<string, WorktreeOccupancy>();
    const git = new NativeWorktreeGit();
    let ownerUnknown = false;
    const manager = harness({ referenced: refs, occupancy, git, ownerReferenced: async (reference) => {
      if (ownerUnknown) throw new Error("owner unavailable");
      return refs.has(reference.leaseId);
    } });
    const lease = acquired(await manager.acquire({
      repositoryPath: repository.clone, baseSha: repository.sha,
      owner: { kind: "task", key: "protected" },
    }));
    if (blocker !== "active lease") assert.equal((await manager.release(lease)).outcome, "released");
    const slot = manager.store.slot(lease.slotId)!;
    manager.store.quarantine(slot.id, "slot process occupancy is unknown", "process-list timeout", Date.now(), slot.version);
    const original = manager.store.slot(slot.id)!;
    const occupied: WorktreeOccupancy = { status: "known", occupants: [{
      pid: 99, ppid: 1, startRaw: "fixture", startMs: 1, command: "helper", cwd: lease.path, knownOwner: null,
    }] };
    switch (blocker) {
      case "active lease": break;
      case "partial active identity":
        db.prepare("UPDATE worktree_slots SET active_owner_key = 'dangling' WHERE id = ?").run(slot.id); break;
      case "partial released identity":
        db.prepare("UPDATE worktree_slots SET last_released_owner_key = NULL WHERE id = ?").run(slot.id); break;
      case "referenced owner": refs.add(lease.leaseId); break;
      case "unknown owner":
        ownerUnknown = true; break;
      case "dirty": writeFileSync(`${lease.path}/keep.txt`, "unfinished\n"); break;
      case "unmerged": gitIn(lease.path, "commit", "--allow-empty", "-qm", "unmerged work"); break;
      case "unknown merge": git.mergedInto = async () => ({ ok: false, reason: "merge timed out", outcomeUnknown: true }); break;
      case "unknown default": git.observedDefaultSha = async () => ({ ok: false, reason: "default unknown", outcomeUnknown: true }); break;
      case "unknown Git": git.inspect = async () => { throw new Error("inspection unavailable"); }; break;
      case "occupied": occupancy.set(lease.path, occupied); break;
      case "unknown occupancy": occupancy.set(lease.path, { status: "unknown", reason: "scan unavailable" }); break;
      case "late occupancy": {
        const mergedInto = git.mergedInto.bind(git);
        git.mergedInto = async (...args) => { occupancy.set(lease.path, occupied); return mergedInto(...args); };
        break;
      }
      case "missing path": rmSync(lease.path, { recursive: true, force: true }); break;
      case "missing registration": {
        const list = git.list.bind(git);
        git.list = async (identity) => {
          const result = await list(identity);
          return result.ok ? { ok: true, value: result.value.filter((entry) => entry.path !== lease.path) } : result;
        };
        break;
      }
      case "locked registration": gitIn(repository.clone, "worktree", "lock", lease.path); break;
      case "foreign repository": {
        const inspect = git.inspect.bind(git);
        git.inspect = async (path) => {
          const result = await inspect(path);
          return result.ok ? { ok: true, value: { ...result.value, commonDirectory: "/foreign/.git" } } : result;
        };
        break;
      }
      case "wrong path": db.prepare("UPDATE worktree_slots SET path = ? WHERE id = ?").run(repository.clone, slot.id); break;
      case "wrong pool": db.prepare("UPDATE worktree_pools SET git_common_dir = '/foreign/.git' WHERE id = ?").run(lease.poolId); break;
      case "wrong marker": writeFileSync(`${manager.store.pool(lease.poolId)!.poolPath}/.mission-control-worktree-pool`, "{}"); break;
      case "version race": {
        const mergedInto = git.mergedInto.bind(git);
        git.mergedInto = async (...args) => {
          db.prepare("UPDATE worktree_slots SET version = version + 1 WHERE id = ?").run(slot.id);
          return mergedInto(...args);
        };
        break;
      }
    }
    await manager.reconcile();
    const after = manager.store.slot(slot.id)!;
    assert.equal(after.state, "quarantined");
    assert.equal(after.quarantineReason, original.quarantineReason);
    assert.equal(after.lastError, original.lastError);
    if (blocker !== "version race") assert.equal(after.version, original.version);
    assert.equal((await manager.planMaintenance()).find((entry) => entry.slotId === slot.id)?.safe, false);
    if (blocker !== "missing path") assert.equal(existsSync(lease.path), true);
  });
}

for (const change of ["HEAD", "dirty work", "unknown inspection", "thrown inspection", "repository", "path"] as const) {
  test(`quarantine recovery rejects late ${change} changes after merge proof`, async () => {
    const repository = repo("mission-reconcile-final-proof-");
    const git = new NativeWorktreeGit();
    const manager = harness({ git });
    const lease = acquired(await manager.acquire({
      repositoryPath: repository.clone, baseSha: repository.sha,
      owner: { kind: "task", key: "final-proof" },
    }));
    assert.equal((await manager.release(lease)).outcome, "released");
    const slot = manager.store.slot(lease.slotId)!;
    manager.store.quarantine(slot.id, "slot process occupancy is unknown", "process-list timeout", Date.now(), slot.version);
    const quarantined = manager.store.slot(slot.id)!;
    const mergedInto = git.mergedInto.bind(git);
    git.mergedInto = async (...args) => {
      const result = await mergedInto(...args);
      assert.deepEqual(result, { ok: true, value: true }, "the original HEAD passes the merge proof");
      switch (change) {
        case "HEAD": gitIn(lease.path, "commit", "--allow-empty", "-qm", "late unmerged commit"); break;
        case "dirty work": writeFileSync(`${lease.path}/late.txt`, "preserve this work\n"); break;
        case "unknown inspection":
          git.inspect = async () => ({ ok: false, reason: "final inspection timed out", outcomeUnknown: true }); break;
        case "thrown inspection": git.inspect = async () => { throw new Error("final inspection unavailable"); }; break;
        case "repository":
        case "path": {
          const inspect = git.inspect.bind(git);
          git.inspect = async (path) => {
            const observed = await inspect(path);
            if (!observed.ok) return observed;
            return { ok: true, value: { ...observed.value, ...(change === "repository"
              ? { commonDirectory: "/foreign/.git" }
              : { path: repository.clone }) } };
          };
          break;
        }
      }
      return result;
    };

    await manager.reconcile();
    const after = manager.store.slot(slot.id)!;
    assert.equal(after.state, "quarantined");
    assert.equal(after.version, quarantined.version);
    assert.equal(after.quarantineReason, quarantined.quarantineReason);
    assert.equal(after.lastError, quarantined.lastError);
    assert.ok(manager.store.pool(lease.poolId)?.reconciliationError, "the final proof failure is reported");
    assert.equal(existsSync(lease.path), true);
    if (change === "HEAD") assert.notEqual(gitIn(lease.path, "rev-parse", "HEAD"), repository.sha);
    if (change === "dirty work") assert.equal(existsSync(`${lease.path}/late.txt`), true);
  });
}
