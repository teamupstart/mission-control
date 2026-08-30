import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { WorktreeProvider } from "../src/shared/types.ts";
import {
  WorktreesConfigPatchSchema,
  WorktreesConfigSchema,
} from "../src/shared/protocol.ts";
import { openDb, upsertTask } from "../src/server/db.ts";
import {
  getWorktreesConfig,
  resolveWorktreePolicy,
  setWorktreesConfig,
} from "../src/server/worktrees/config.ts";
import {
  WorktreeManager,
  worktreeSweepIntervalMs,
  type NativeWorktreeLease,
  type WorktreeManagerDeps,
} from "../src/server/worktrees/manager.ts";
import { NativeWorktreeGit, type GitResult } from "../src/server/worktrees/git.ts";
import type { WorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";
import { nativeWorktreeOwnerReferenced } from "../src/server/worktrees/owners.ts";
import type { RunResult } from "../src/server/util/exec.ts";
import { worktreeRepositoryIdentity } from "../src/server/util/git.ts";
import {
  provisionWorktree,
  teardownWorktree,
  worktreeSlotPath,
} from "../src/server/dispatcher.ts";
import {
  CheckLeaseManager,
  CheckLeaseStore,
} from "../src/server/workflows/check-lease.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";
import { mkTask } from "./helpers/session-fixture.ts";

const db = openDb();

afterEach(() => {
  db.exec(
    "DELETE FROM workflow_check_leases; DELETE FROM worktree_slots; " +
      "DELETE FROM worktree_pools; DELETE FROM task_repos; DELETE FROM tasks; " +
      "DELETE FROM app_config WHERE key = 'worktrees';",
  );
});

function emptyOccupancy(paths: readonly string[]): Promise<Map<string, WorktreeOccupancy>> {
  return Promise.resolve(new Map(paths.map((path) => [path, { status: "known", occupants: [] }])));
}

function manager(deps: Partial<WorktreeManagerDeps> = {}): WorktreeManager {
  return new WorktreeManager(db, { occupancy: emptyOccupancy, ...deps });
}

function repository(prefix: string): { clone: string; sha: string } {
  const { clone } = mkOriginAndClone(prefix);
  return { clone, sha: gitIn(clone, "rev-parse", "HEAD") };
}

function acquire(m: WorktreeManager, clone: string, sha: string, key: string) {
  return m.acquire({ repositoryPath: clone, baseSha: sha, owner: { kind: "task", key } });
}

function lease(result: Awaited<ReturnType<typeof acquire>>): NativeWorktreeLease {
  assert.equal(result.outcome, "acquired");
  return (result as { outcome: "acquired"; lease: NativeWorktreeLease }).lease;
}

test("the provider vocabulary appends mission without changing historical values", () => {
  const providers: WorktreeProvider[] = ["treehouse", "git", "mission"];
  assert.deepEqual(providers, ["treehouse", "git", "mission"]);
});

test("native sweep cadence has an off switch and avoids timer overflow", () => {
  assert.equal(worktreeSweepIntervalMs(undefined), 300_000);
  assert.equal(worktreeSweepIntervalMs("0"), null);
  assert.equal(worktreeSweepIntervalMs("-1"), null);
  assert.equal(worktreeSweepIntervalMs("5"), 30_000);
  assert.equal(worktreeSweepIntervalMs("nope"), 300_000);
  assert.equal(worktreeSweepIntervalMs("99999999999"), 604_800_000);
});

test("maintenance reclaims domain leases even when no native pool exists", async () => {
  const runtime = manager() as unknown as {
    reclaimDomainLeases: () => Promise<void>;
    runMaintenance(): Promise<void>;
  };
  let calls = 0;
  runtime.reclaimDomainLeases = async () => {
    calls += 1;
  };

  await runtime.runMaintenance();

  assert.equal(calls, 1);
});

test("worktree config defaults on, is bounded, and merges repository patches", () => {
  assert.deepEqual(getWorktreesConfig(), { enabled: true, maxSlots: 16, repositories: {} });
  assert.throws(() => WorktreesConfigSchema.parse({ maxSlots: 0 }));
  assert.throws(() => WorktreesConfigSchema.parse({ maxSlots: 129 }));
  assert.throws(() =>
    WorktreesConfigSchema.parse({
      repositories: { "/repo/.git": { setupArgv: Array.from({ length: 33 }, () => "arg") } },
    }),
  );
  assert.throws(() =>
    WorktreesConfigSchema.parse({ repositories: { "/repo/.git": { setupArgv: ["x".repeat(4097)] } } }),
  );

  setWorktreesConfig(
    WorktreesConfigPatchSchema.parse({
      repositories: {
        "/one/.git": { enabled: false, maxSlots: 4, setupArgv: ["npm", "install"] },
      },
    }),
  );
  const next = setWorktreesConfig(
    WorktreesConfigPatchSchema.parse({
      maxSlots: 24,
      repositories: { "/two/.git": { maxSlots: 7 } },
    }),
  );
  assert.deepEqual(next.repositories["/one/.git"], {
    enabled: false,
    maxSlots: 4,
    setupArgv: ["npm", "install"],
  });
  assert.deepEqual(resolveWorktreePolicy("/one/.git", next), {
    enabled: false,
    maxSlots: 4,
    setupArgv: ["npm", "install"],
  });
  assert.deepEqual(resolveWorktreePolicy("/unknown/.git", next), {
    enabled: true,
    maxSlots: 24,
    setupArgv: null,
  });

  const cleared = setWorktreesConfig(
    WorktreesConfigPatchSchema.parse({
      repositories: { "/one/.git": { setupArgv: null } },
    }),
  );
  assert.deepEqual(cleared.repositories["/one/.git"], { enabled: false, maxSlots: 4 });
});

test("native Git operations fail closed when a subprocess outcome is unknown", async () => {
  const { clone, sha } = repository("mission-native-git-unknown-");
  const identity = worktreeRepositoryIdentity(clone);
  assert.ok(identity);

  const known = (stdout = ""): RunResult => ({
    stdout,
    stderr: "",
    code: 0,
    outcomeUnknown: false,
    overflowed: false,
  });
  const unknown = (stdout = ""): RunResult => ({
    stdout,
    stderr: "child disappeared after producing output",
    code: 0,
    outcomeUnknown: true,
    overflowed: false,
  });
  const assertUnknown = (result: GitResult<unknown>, step: RegExp) => {
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.outcomeUnknown, true);
      assert.match(result.reason, step);
    }
  };

  const listed = await new NativeWorktreeGit(async () =>
    unknown(`worktree ${clone}\nHEAD ${sha}\ndetached\n`)
  ).list(identity);
  assertUnknown(listed, /git worktree list/);

  const inspectSteps: Record<string, RegExp> = {
    "rev-parse": /git rev-parse HEAD/,
    status: /git status/,
    // A detached-HEAD probe that never answered is not "detached". It gates the lease, so
    // it fails the whole inspection rather than defaulting either way.
    "symbolic-ref": /git symbolic-ref HEAD/,
  };
  for (const [unknownProbe, step] of Object.entries(inspectSteps)) {
    const inspected = await new NativeWorktreeGit(async (_bin, args) => {
      if (args.includes(unknownProbe)) return unknown(unknownProbe === "rev-parse" ? `${sha}\n` : "");
      return known(unknownProbe === "rev-parse" ? "" : `${sha}\n`);
    }).inspect(clone);
    assertUnknown(inspected, step);
  }

  const added = await new NativeWorktreeGit(async () => unknown()).add(
    identity,
    join(identity.poolPath, "unknown-add"),
    sha,
  );
  assertUnknown(added, /git worktree add/);

  const fetched = await new NativeWorktreeGit(async () => unknown()).fetchDefaultSha(identity);
  assertUnknown(fetched, /git fetch origin/);

  // Return asks the REMOTE which branch it currently calls default, so an ls-remote that
  // died is an unknown default rather than a licence to reuse the cached `origin/HEAD`.
  const symref = await new NativeWorktreeGit(async (_bin, args) =>
    args.includes("fetch") ? known() : unknown(`${sha}\n`)
  ).fetchDefaultSha(identity);
  assertUnknown(symref, /git ls-remote --symref origin HEAD/);

  const resolved = await new NativeWorktreeGit(async (_bin, args) => {
    if (args.includes("fetch")) return known();
    if (args.includes("ls-remote")) return known(`ref: refs/heads/main\tHEAD\n${sha}\tHEAD\n`);
    return unknown(`${sha}\n`);
  }).fetchDefaultSha(identity);
  assertUnknown(resolved, /git rev-parse refs\/remotes\/origin\/main/);

  const observed = await new NativeWorktreeGit(async () => unknown(`${sha}\n`))
    .observedDefaultSha(identity);
  assertUnknown(observed, /git rev-parse origin\//);

  const merged = await new NativeWorktreeGit(async () => unknown()).mergedInto(clone, sha);
  assertUnknown(merged, /git merge-base --is-ancestor/);
});

test("concurrent acquires receive different exact slots and respect capacity", async () => {
  const { clone, sha } = repository("mission-native-concurrent-");
  const m = manager({
    resolvePolicy: () => ({ enabled: true, maxSlots: 2, setupArgv: null }),
  });
  const results = await Promise.all([
    acquire(m, clone, sha, "task-1"),
    acquire(m, clone, sha, "task-2"),
    acquire(m, clone, sha, "task-3"),
  ]);
  const acquired = results.filter((result) => result.outcome === "acquired");
  // The refusals are named in the message, not just counted. This case failed once under a
  // loaded full-suite run with a bare `1 !== 2`, which says nothing about WHY a second slot
  // was not handed out - a genuine capacity refusal, a quarantined slot and a git subprocess
  // that fell over under load are three different bugs and that assertion could not tell
  // them apart. The assertion itself is unchanged; only its diagnosis is.
  assert.equal(
    acquired.length,
    2,
    `expected two of three concurrent acquires to win a slot, got: ${JSON.stringify(
      results.map((result) => (result.outcome === "acquired" ? "acquired" : [result.outcome, result.reason])),
    )}`,
  );
  assert.equal(new Set(acquired.map((result) => result.lease.path)).size, 2);
  assert.equal(results.filter((result) => result.outcome === "notAcquired").length, 1);
  for (const result of acquired) {
    assert.equal(result.lease.provider, "mission");
    assert.equal(gitIn(result.lease.path, "rev-parse", "HEAD"), sha);
    await m.release(result.lease);
  }
});

test("task acquisition uses native identity, degrades at capacity, and reuses a released slot", async () => {
  const { clone, sha } = repository("mission-native-task-consumer-");
  const m = manager({
    resolvePolicy: () => ({ enabled: true, maxSlots: 1, setupArgv: null }),
  });
  const first = await provisionWorktree(clone, "task-native-1", "native", "native", sha, 0, m);
  assert.equal(first.provider, "mission");
  assert.ok(first.leaseId);
  assert.equal(first.branch, null, "a detached native checkout must not invent a harness branch");
  assert.equal(gitIn(first.path, "rev-parse", "HEAD"), sha);
  m.settleDomainLease(first.leaseId!);

  const fallback = await provisionWorktree(clone, "task-native-2", "fallback", "fallba", sha, 0, m);
  assert.equal(fallback.provider, "git", "a positive capacity refusal should degrade once to Git");
  assert.equal(fallback.leaseId, null);
  assert.equal(gitIn(fallback.path, "rev-parse", "HEAD"), sha);

  await teardownWorktree({
    taskId: "task-native-1",
    repoRoot: clone,
    worktreePath: first.path,
    branch: first.branch,
    provider: first.provider,
    worktreeLeaseId: first.leaseId,
    homeName: null,
  }, undefined, undefined, m);
  await teardownWorktree({
    taskId: "task-native-1",
    repoRoot: clone,
    worktreePath: first.path,
    branch: first.branch,
    provider: first.provider,
    worktreeLeaseId: first.leaseId,
    homeName: null,
  }, undefined, undefined, m);
  await teardownWorktree({
    taskId: "task-native-2",
    repoRoot: clone,
    worktreePath: fallback.path,
    branch: fallback.branch,
    provider: fallback.provider,
    worktreeLeaseId: fallback.leaseId,
    homeName: null,
  });

  const reused = await provisionWorktree(clone, "task-native-3", "reuse", "reuse1", sha, 0, m);
  assert.equal(reused.provider, "mission");
  assert.equal(reused.path, first.path, "native cleanup should retain and reuse the warm slot");
  await teardownWorktree({
    taskId: "task-native-3",
    repoRoot: clone,
    worktreePath: reused.path,
    branch: reused.branch,
    provider: reused.provider,
    worktreeLeaseId: reused.leaseId,
    homeName: null,
  }, undefined, undefined, m);
});

test("a manual release revalidates cleanliness inside the conditional return", async () => {
  const { clone, sha } = repository("mission-native-manual-clean-");
  const m = manager();
  const result = await m.acquire({
    repositoryPath: clone,
    baseSha: sha,
    owner: { kind: "manual", key: "manual-clean" },
  });
  assert.equal(result.outcome, "acquired");
  if (result.outcome !== "acquired") return;

  const untracked = join(result.lease.path, "manual-change.txt");
  writeFileSync(untracked, "keep me\n");
  assert.deepEqual(
    await m.release(result.lease, { ownerAuthorized: true, requireClean: true }),
    { outcome: "refused", reason: "manual worktree is dirty" },
  );
  assert.equal(m.lookupLease({ leaseId: result.lease.leaseId }).state, "active");

  unlinkSync(untracked);
  assert.equal(
    (await m.release(result.lease, { ownerAuthorized: true, requireClean: true })).outcome,
    "released",
  );
});

test("workflow checks persist and reclaim the exact native lease without changing attempt state", async () => {
  const { clone, sha } = repository("mission-native-check-consumer-");
  const m = manager({
    resolvePolicy: () => ({ enabled: true, maxSlots: 1, setupArgv: null }),
  });
  const leases = new CheckLeaseManager(db, { manager: m });
  const rows = new CheckLeaseStore(db);
  const path = await leases.acquireForAttempt({
    attemptId: "native-check-1",
    submissionId: "submission-native",
    nodeId: "gate",
    repoRoot: clone,
    headSha: sha,
  });
  const held = rows.get("native-check-1");
  assert.equal(held?.provider, "mission");
  assert.ok(held?.leaseId);
  assert.equal(held?.holderToken, held?.leaseId);
  assert.equal(gitIn(path, "rev-parse", "HEAD"), sha);

  assert.deepEqual(await leases.releaseForAttempt("native-check-1"), { outcome: "returned" });
  assert.equal(rows.get("native-check-1")?.cleanupState, "returned");
  assert.ok(existsSync(path), "native check cleanup should retain the warm slot directory");

  const reused = await leases.acquireForAttempt({
    attemptId: "native-check-2",
    submissionId: "submission-native",
    nodeId: "gate",
    repoRoot: clone,
    headSha: sha,
  });
  assert.equal(reused, path);
  assert.notEqual(rows.get("native-check-2")?.leaseId, held?.leaseId);
  assert.deepEqual(await leases.releaseForAttempt("native-check-2"), { outcome: "returned" });
});

test("a released slot stays unavailable until its exact task row clears the lease identity", async () => {
  const { clone, sha } = repository("mission-native-task-reference-");
  const m = manager({
    ownerReferenced: async (reference) => nativeWorktreeOwnerReferenced(reference, db),
    resolvePolicy: () => ({ enabled: true, maxSlots: 1, setupArgv: null }),
  });
  const first = lease(await acquire(m, clone, sha, "task-domain-owner:0"));
  upsertTask(mkTask({
    id: "task-domain-owner",
    repoRoot: clone,
    worktreePath: first.path,
    provider: "mission",
    worktreeLeaseId: first.leaseId,
    baseSha: sha,
    status: "running",
  }));

  assert.equal((await m.release(first, { ownerAuthorized: true })).outcome, "released");
  const blocked = await acquire(m, clone, sha, "task-waiting:0");
  assert.equal(blocked.outcome, "notAcquired");
  assert.match(blocked.outcome === "notAcquired" ? blocked.reason : "", /capacity 1/);

  upsertTask(mkTask({ id: "task-domain-owner", repoRoot: clone }));
  const next = lease(await acquire(m, clone, sha, "task-waiting:0"));
  assert.equal(next.path, first.path);
  assert.equal((await m.release(next, { ownerAuthorized: true })).outcome, "released");
});

test("an ambiguous native acquisition never creates a disposable task or check tree", async () => {
  const { clone, sha } = repository("mission-native-consumer-unknown-");
  let ids = 0;
  const unknown = manager({
    resolvePolicy: () => ({ enabled: true, maxSlots: 1, setupArgv: null }),
    randomId: () => {
      ids++;
      if (ids === 3) throw new Error("reservation result was lost");
      return `unknown-${ids}`;
    },
  });
  await assert.rejects(
    () => provisionWorktree(clone, "task-unknown", "unknown", "unknow", sha, 0, unknown),
    /acquisition outcome is unknown/,
  );
  assert.equal(existsSync(worktreeSlotPath("task-unknown", 0)), false);

  ids = 0;
  const checkUnknown = manager({
    resolvePolicy: () => ({ enabled: true, maxSlots: 1, setupArgv: null }),
    randomId: () => {
      ids++;
      if (ids === 3) throw new Error("reservation result was lost");
      return `check-unknown-${ids}`;
    },
  });
  const leases = new CheckLeaseManager(db, { manager: checkUnknown });
  await assert.rejects(
    () => leases.acquireForAttempt({
      attemptId: "check-unknown",
      submissionId: "submission-unknown",
      nodeId: "gate",
      repoRoot: clone,
      headSha: sha,
    }),
    /reservation result was lost/,
  );
  assert.equal(new CheckLeaseStore(db).get("check-unknown"), null);
});

/**
 * How long the slot-independence test waits before it concludes the lock is broken.
 *
 * Chosen to be unreachable by an honest run rather than to be tight: the two operations it
 * guards take under a second on an idle machine, and a few seconds on a loaded one. Nothing
 * is asserted about this number - it only decides when to stop waiting and start blaming.
 */
const DEADLOCK_ESCAPE_MS = 60_000;

// The deadline here is a deadlock backstop, not a speed limit. It sits far above
// DEADLOCK_ESCAPE_MS so the escape hatch below always wins the race and reports the
// meaningful assertion; only a hang that survives an opened gate ever reaches this.
test(
  "a slow release fetch does not block another slot acquisition or release",
  { timeout: 120_000 },
  async () => {
    const { clone, sha } = repository("mission-native-slot-concurrency-");
    let fetchCalls = 0;
    let announceSlowFetch!: () => void;
    let openGate!: () => void;
    // Read after the two independent operations settle, so "they did not wait for it" is
    // asserted against the gate's actual state rather than against a stopwatch.
    let gateOpen = false;
    const finishSlowFetch = (): void => {
      gateOpen = true;
      openGate();
    };
    const slowFetchStarted = new Promise<void>((resolve) => {
      announceSlowFetch = resolve;
    });
    const slowFetchGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    class SlowFirstFetchGit extends NativeWorktreeGit {
      override async fetchDefaultSha(): Promise<GitResult<string>> {
        fetchCalls++;
        if (fetchCalls === 1) {
          announceSlowFetch();
          await slowFetchGate;
        }
        return { ok: true, value: sha };
      }
    }
    const m = manager({
      git: new SlowFirstFetchGit(),
      resolvePolicy: () => ({ enabled: true, maxSlots: 3, setupArgv: null }),
    });
    const first = lease(await acquire(m, clone, sha, "task-slow-release"));
    const second = lease(await acquire(m, clone, sha, "task-parallel-release"));
    const firstRelease = m.release(first);
    await slowFetchStarted;

    const thirdAcquire = acquire(m, clone, sha, "task-parallel-acquire");
    const secondRelease = m.release(second);

    // Awaited with NO deadline of their own, which is the point. The claim is that neither
    // of these waits on the first slot's gated fetch, and the honest proof is that both
    // finish while that gate is still shut - not that both finish inside some number of
    // milliseconds. A wall-clock race reports a busy machine as a broken lock: this
    // repository's own suite runs several files at once, and a release that does real work
    // in a temp git repository can lose that race while being perfectly independent.
    //
    // A broken lock would leave both awaits hanging on a gate nobody opens, so the escape
    // hatch opens it for them after a delay no honest run needs. That converts the
    // regression from a bare timeout - which a slow machine produces too, and which names
    // neither the claim nor the cause - into the `gateOpen` assertion below, which says
    // exactly what broke. The delay bounds only how long we wait before concluding deadlock;
    // it is never the pass/fail boundary, because a run that takes longer than expected
    // still finds the gate shut and still passes.
    const escape = setTimeout(finishSlowFetch, DEADLOCK_ESCAPE_MS);
    // Never let a pending backstop hold the worker open once the test is done with it.
    escape.unref?.();
    let thirdResult;
    let secondReleased;
    try {
      thirdResult = await thirdAcquire;
      secondReleased = await secondRelease;
    } finally {
      clearTimeout(escape);
    }
    assert.equal(gateOpen, false, "both finished before the slow fetch was ever released");

    finishSlowFetch();
    const firstReleased = await firstRelease;
    assert.equal(firstReleased.outcome, "released");
    assert.equal(secondReleased.outcome, "released");
    const third = lease(thirdResult);
    assert.equal((await m.release(third)).outcome, "released");
  },
);

test("conditional release is idempotent and stale identity cannot release a re-lease", async () => {
  const { clone, sha } = repository("mission-native-release-");
  const m = manager({
    resolvePolicy: () => ({ enabled: true, maxSlots: 1, setupArgv: null }),
  });
  const first = lease(await acquire(m, clone, sha, "task-first"));
  assert.deepEqual(await m.release(first), { outcome: "released" });
  assert.deepEqual(await m.release(first), { outcome: "alreadyReleased" });

  const second = lease(await acquire(m, clone, sha, "task-second"));
  assert.equal(second.slotId, first.slotId, "capacity one must re-lease the same slot");
  assert.equal((await m.release(first)).outcome, "refused", "a stale lease ID cannot release the new owner");
  assert.equal(
    (await m.release({ ...second, owner: { kind: "task", key: "wrong-owner" } })).outcome,
    "refused",
  );
  assert.equal((await m.release({ ...second, slotVersion: second.slotVersion - 1 })).outcome, "refused");
  assert.deepEqual(await m.release(second), { outcome: "released" });
});

test("an exact active lease can be released after a transient observation quarantines it", async () => {
  const { clone, sha } = repository("mission-native-quarantined-release-");
  const m = manager();
  const held = lease(await acquire(m, clone, sha, "task-quarantined"));
  const quarantined = m.store.quarantine(
    held.slotId,
    "slot process occupancy is unknown",
    "cwd listing failed: exit 1",
    Date.now(),
    held.slotVersion,
  );
  assert.equal(quarantined?.state, "quarantined");

  const current = m.lookupLease({
    leaseId: held.leaseId,
    path: held.path,
    owner: held.owner,
  });
  assert.equal(current.state, "active");
  if (current.state !== "active") return;
  assert.deepEqual(
    await m.release(current.lease, { ownerAuthorized: true }),
    { outcome: "released" },
  );
  assert.equal(m.store.slot(held.slotId)?.state, "available");
});

test("reset removes nonignored work while preserving ignored warm caches", async () => {
  const { origin, clone } = mkOriginAndClone("mission-native-reset-");
  writeFileSync(join(origin, ".gitignore"), "node_modules/\n");
  gitIn(origin, "add", ".gitignore");
  gitIn(origin, "commit", "-qm", "ignore warm cache");
  gitIn(clone, "fetch", "-q", "origin");
  gitIn(clone, "reset", "-q", "--hard", "origin/main");
  const sha = gitIn(clone, "rev-parse", "HEAD");
  const m = manager({ resolvePolicy: () => ({ enabled: true, maxSlots: 1, setupArgv: null }) });
  const first = lease(await acquire(m, clone, sha, "task-cache-1"));
  const cache = join(first.path, "node_modules", "cache.txt");
  const scratch = join(first.path, "scratch.txt");
  mkdirSync(join(first.path, "node_modules"), { recursive: true });
  writeFileSync(cache, "warm\n");
  writeFileSync(scratch, "discard\n");

  assert.equal((await m.release(first)).outcome, "released");
  assert.equal(existsSync(cache), true, "git clean -fd must preserve ignored caches");
  assert.equal(existsSync(scratch), false, "nonignored untracked work is removed on release");
  assert.equal(detachedOnDisk(first.path), true, "a returned slot holds no branch");
  const second = lease(await acquire(m, clone, sha, "task-cache-2"));
  assert.equal(second.path, first.path);
  assert.equal(existsSync(cache), true);
  assert.equal(detachedOnDisk(second.path), true, "…and neither does the reused one");
  await m.release(second);
});

test("operator setup runs only for a new slot and failure or uncertainty quarantines it", async () => {
  const successRepo = repository("mission-native-setup-ok-");
  const setupCalls: Array<{ argv: readonly string[]; cwd: string }> = [];
  const success = manager({
    resolvePolicy: () => ({ enabled: true, maxSlots: 1, setupArgv: ["npm", "install"] }),
    runSetup: async (argv, cwd) => {
      setupCalls.push({ argv, cwd });
      return { ok: true, reason: null, outcomeUnknown: false };
    },
  });
  const first = lease(await acquire(success, successRepo.clone, successRepo.sha, "task-setup-1"));
  await success.release(first);
  const second = lease(await acquire(success, successRepo.clone, successRepo.sha, "task-setup-2"));
  assert.equal(setupCalls.length, 1, "a reused slot does not rerun setup");
  assert.deepEqual(setupCalls[0]!.argv, ["npm", "install"]);
  assert.equal(setupCalls[0]!.cwd, first.path);
  await success.release(second);

  const failedRepo = repository("mission-native-setup-fail-");
  const failed = manager({
    resolvePolicy: () => ({ enabled: true, maxSlots: 1, setupArgv: ["false"] }),
    runSetup: async () => ({ ok: false, reason: "setup refused", outcomeUnknown: false }),
  });
  const result = await acquire(failed, failedRepo.clone, failedRepo.sha, "task-setup-fail");
  assert.deepEqual(result, { outcome: "outcomeUnknown", reason: "setup refused" });
  assert.equal(failed.store.slots().some((slot) => slot.state === "quarantined"), true);

  const unknownRepo = repository("mission-native-setup-unknown-");
  const unknown = manager({
    resolvePolicy: () => ({ enabled: true, maxSlots: 1, setupArgv: ["unknown"] }),
    runSetup: async () => ({ ok: true, reason: null, outcomeUnknown: true }),
  });
  const unknownResult = await acquire(
    unknown,
    unknownRepo.clone,
    unknownRepo.sha,
    "task-setup-unknown",
  );
  assert.deepEqual(unknownResult, {
    outcome: "outcomeUnknown",
    reason: "setup outcome could not be proven",
  });
  assert.equal(unknown.store.slots().some((slot) => slot.state === "quarantined"), true);
});

test("repository files cannot opt a native slot into setup execution", async () => {
  const fixture = repository("mission-native-repo-setup-");
  writeFileSync(join(fixture.clone, ".mission-control-worktree-setup"), "false\n");
  gitIn(fixture.clone, "add", ".mission-control-worktree-setup");
  gitIn(fixture.clone, "commit", "-qm", "repository setup must stay inert");
  fixture.sha = gitIn(fixture.clone, "rev-parse", "HEAD");
  let setupCalls = 0;
  const m = manager({
    resolvePolicy: () => ({ enabled: true, maxSlots: 1, setupArgv: null }),
    runSetup: async () => {
      setupCalls++;
      return { ok: true, reason: null, outcomeUnknown: false };
    },
  });
  const held = lease(await acquire(m, fixture.clone, fixture.sha, "task-no-repo-setup"));
  assert.equal(setupCalls, 0);
  assert.equal((await m.release(held)).outcome, "released");
});

test("a domain reference or process occupancy refuses release before reset", async () => {
  const { clone, sha } = repository("mission-native-release-refuse-");
  let referenced = true;
  let occupied = false;
  const m = manager({
    ownerReferenced: async () => referenced,
    occupancy: async (paths) =>
      new Map(paths.map((path) => [
        path,
        {
          status: "known" as const,
          occupants: occupied
            ? [{ pid: 42, ppid: 1, startRaw: "now", startMs: 1, command: "node", cwd: path, knownOwner: null }]
            : [],
        },
      ])),
  });
  // Acquisition has no prior domain row, so switch the reference on only after it succeeds.
  referenced = false;
  const held = lease(await acquire(m, clone, sha, "task-ref"));
  referenced = true;
  assert.match((await m.release(held) as { reason: string }).reason, /domain owner/);
  referenced = false;
  occupied = true;
  assert.match((await m.release(held) as { reason: string }).reason, /occupy/);
  occupied = false;
  assert.equal((await m.release(held)).outcome, "released");
});

test("release rechecks occupancy after target validation before recording reset intent", async () => {
  const { clone, sha } = repository("mission-native-release-race-");
  let targetValidationStarted = false;
  class OccupiedDuringValidationGit extends NativeWorktreeGit {
    resetCalls = 0;

    override async list(identity: NonNullable<ReturnType<typeof worktreeRepositoryIdentity>>) {
      targetValidationStarted = true;
      return super.list(identity);
    }

    override async reset(path: string, commit: string) {
      this.resetCalls++;
      return super.reset(path, commit);
    }
  }
  const git = new OccupiedDuringValidationGit();
  const m = manager({
    git,
    occupancy: async (paths) => {
      return new Map(paths.map((path) => [
        path,
        {
          status: "known" as const,
          occupants: targetValidationStarted
            ? [{ pid: 91, ppid: 1, startRaw: "now", startMs: 1, command: "node", cwd: path, knownOwner: null }]
            : [],
        },
      ]));
    },
  });
  const held = lease(await acquire(m, clone, sha, "task-race"));
  const released = await m.release(held);
  assert.equal(released.outcome, "refused");
  if (released.outcome === "refused") assert.match(released.reason, /occupy/);
  assert.equal(git.resetCalls, 0);
  assert.equal(m.store.slot(held.slotId)?.state, "leased");
});

test("release refuses a corrupted slot path without resetting that checkout", async () => {
  const { clone, sha } = repository("mission-native-release-path-");
  const m = manager();
  const held = lease(await acquire(m, clone, sha, "task-path"));
  const scratch = join(clone, "operator-work.txt");
  writeFileSync(scratch, "preserve me\n");
  db.prepare(`UPDATE worktree_slots SET path = ? WHERE id = ?`).run(clone, held.slotId);

  const released = await m.release({ ...held, path: clone });
  assert.equal(released.outcome, "refused");
  assert.equal(existsSync(scratch), true, "an unmarked checkout must never be reset");
  assert.equal(m.store.slot(held.slotId)?.state, "leased");
});

test("release revalidates a physical registered slot after fetch before reset", async () => {
  const { clone, sha } = repository("mission-native-release-link-race-");
  const scratch = join(clone, "operator-work.txt");
  writeFileSync(scratch, "preserve me\n");
  class SwapAfterFetchGit extends NativeWorktreeGit {
    slotPath = "";
    resetCalls = 0;

    override async fetchDefaultSha(identity: NonNullable<ReturnType<typeof worktreeRepositoryIdentity>>) {
      const result = await super.fetchDefaultSha(identity);
      if (result.ok) {
        renameSync(this.slotPath, `${this.slotPath}-registered`);
        symlinkSync(clone, this.slotPath, "dir");
      }
      return result;
    }

    override async reset(path: string, commit: string) {
      this.resetCalls++;
      return super.reset(path, commit);
    }
  }
  const git = new SwapAfterFetchGit();
  const m = manager({ git });
  const held = lease(await acquire(m, clone, sha, "task-path-race"));
  git.slotPath = held.path;

  const released = await m.release(held);
  assert.equal(released.outcome, "refused");
  if (released.outcome === "refused") assert.match(released.reason, /physical directory/);
  assert.equal(git.resetCalls, 0);
  assert.equal(existsSync(scratch), true, "a symlink target must never be reset");
  assert.equal(m.store.slot(held.slotId)?.state, "leased");

  unlinkSync(held.path);
  renameSync(`${held.path}-registered`, held.path);
});

test("acquisition refuses a symlinked slot parent before Git writes through it", async () => {
  const fixture = repository("mission-native-slot-link-");
  const poolsDirectory = join(fixture.clone, "..", "native-pools");
  const identity = worktreeRepositoryIdentity(fixture.clone, poolsDirectory);
  assert.ok(identity);
  const foreign = join(fixture.clone, "..", "foreign-directory");
  mkdirSync(identity.poolPath, { recursive: true });
  mkdirSync(foreign);
  symlinkSync(foreign, join(identity.poolPath, "1"));
  const m = manager({ poolsDirectory });

  const result = await acquire(m, fixture.clone, fixture.sha, "task-slot-link");
  assert.equal(result.outcome, "outcomeUnknown");
  if (result.outcome === "outcomeUnknown") assert.match(result.reason, /exact physical directory/);
  assert.equal(existsSync(join(foreign, identity.repositoryName)), false);
  assert.equal(m.store.slots().some((slot) => slot.state === "quarantined"), true);
});

test("exceptions after reservation return outcomeUnknown and leave a reconcilable intent", async () => {
  class ThrowingAddGit extends NativeWorktreeGit {
    override async add(): Promise<never> {
      throw new Error("git add transport vanished");
    }
  }
  const addRepo = repository("mission-native-add-throw-");
  const addManager = manager({ git: new ThrowingAddGit() });
  const addResult = await acquire(addManager, addRepo.clone, addRepo.sha, "task-add-throw");
  assert.equal(addResult.outcome, "outcomeUnknown");
  assert.equal(addManager.store.slots().at(-1)?.state, "quarantined");

  const reserveRepo = repository("mission-native-reserve-throw-");
  const reserveManager = manager();
  const reserve = reserveManager.store.reserveNew.bind(reserveManager.store);
  reserveManager.store.reserveNew = (input) => {
    reserve(input);
    throw new Error("database reply lost after reserve commit");
  };
  const reserveResult = await acquire(
    reserveManager,
    reserveRepo.clone,
    reserveRepo.sha,
    "task-reserve-throw",
  );
  assert.equal(reserveResult.outcome, "outcomeUnknown");
  assert.equal(reserveManager.store.slots().some((slot) => slot.state === "provisioning"), true);
});

test("unknown Git add, lease commit, and return reset outcomes quarantine instead of falling back", async () => {
  class AddUnknownGit extends NativeWorktreeGit {
    override async add() {
      return { ok: false as const, reason: "git add timed out", outcomeUnknown: true };
    }
  }
  const addRepo = repository("mission-native-add-unknown-");
  const addManager = manager({ git: new AddUnknownGit() });
  assert.deepEqual(await acquire(addManager, addRepo.clone, addRepo.sha, "task-add-unknown"), {
    outcome: "outcomeUnknown",
    reason: "git add timed out",
  });
  assert.equal(addManager.store.slots().at(-1)?.state, "quarantined");

  const commitRepo = repository("mission-native-commit-unknown-");
  const commitManager = manager();
  commitManager.store.finalizeLease = () => null;
  assert.deepEqual(
    await acquire(commitManager, commitRepo.clone, commitRepo.sha, "task-commit-unknown"),
    { outcome: "outcomeUnknown", reason: "lease commit could not be proven" },
  );
  assert.equal(commitManager.store.slots().at(-1)?.state, "quarantined");

  class ReturnUnknownGit extends NativeWorktreeGit {
    failReset = false;
    override async reset(path: string, commit: string) {
      return this.failReset
        ? { ok: false as const, reason: "reset timed out", outcomeUnknown: true }
        : super.reset(path, commit);
    }
  }
  const returnRepo = repository("mission-native-return-unknown-");
  const git = new ReturnUnknownGit();
  const returnManager = manager({ git });
  const held = lease(await acquire(returnManager, returnRepo.clone, returnRepo.sha, "task-return-unknown"));
  git.failReset = true;
  assert.deepEqual(await returnManager.release(held), {
    outcome: "outcomeUnknown",
    reason: "reset timed out",
  });
  assert.equal(returnManager.store.slot(held.slotId)?.state, "quarantined");
});

// ---- a slot never crosses a task boundary holding a branch -------------------------------
//
// The incident this closes: a scheduled task was leased a warm slot that was still standing
// on the previous occupant's `codex/…` branch. Every check the allocator ran passed - the
// path, the repository, the exact commit, a clean tree - because none of them asked which
// branch, and the reset that made the tree clean moved that branch's tip rather than
// letting go of its name. The agent then renamed the branch it thought was its own, the
// registry correctly read one feature branch becoming another as a work-episode takeover,
// and the task was unbound and cancelled eleven seconds later.

/** `git symbolic-ref --quiet HEAD` as a boolean: true when no branch is checked out. */
function detachedOnDisk(path: string): boolean {
  try {
    execFileSync("git", ["-C", path, "symbolic-ref", "--quiet", "HEAD"], { stdio: "pipe" });
    return false;
  } catch {
    return true;
  }
}

/**
 * The allocator as it shipped before this rule: a reset that hard-resets and cleans without
 * ever letting go of the branch, and an inspection with nothing to say about it.
 *
 * Used to MANUFACTURE the bad state rather than to assert it - a slot left branch-attached
 * in a warm pool by an older build is the population this change has to repair on contact,
 * and the only honest way to produce one is to run the code that produced them.
 */
class PreDetachGit extends NativeWorktreeGit {
  override async reset(path: string, commit: string): Promise<GitResult<void>> {
    gitIn(path, "reset", "--hard", commit);
    gitIn(path, "clean", "-fd");
    return { ok: true, value: undefined };
  }
  override async inspect(path: string) {
    const inspected = await super.inspect(path);
    return inspected.ok ? { ...inspected, value: { ...inspected.value, detached: true } } : inspected;
  }
}

test("a reused slot attached to the previous occupant's branch is leased detached", async () => {
  const { clone } = mkOriginAndClone("mission-native-detach-");
  const sha = gitIn(clone, "rev-parse", "HEAD");
  const m = manager({ resolvePolicy: () => ({ enabled: true, maxSlots: 1, setupArgv: null }) });
  const first = lease(await acquire(m, clone, sha, "task-attached-1"));

  // The shape a finished agent leaves behind: a real feature branch, with a commit on it,
  // tracking a real upstream.
  gitIn(first.path, "checkout", "-qb", "codex/settings-status-hermetic-path");
  writeFileSync(join(first.path, "work.txt"), "shipped\n");
  gitIn(first.path, "add", "-A");
  gitIn(first.path, "commit", "-qm", "the previous occupant's work");
  gitIn(first.path, "push", "-q", "-u", "origin", "codex/settings-status-hermetic-path");
  const branchSha = gitIn(first.path, "rev-parse", "codex/settings-status-hermetic-path");

  assert.equal((await m.release(first)).outcome, "released");
  // Return hands the slot back holding no name at all.
  assert.equal(detachedOnDisk(first.path), true);
  // …and the branch it was holding is still exactly where it was. The commits under that
  // name are somebody's finished work and its pull request is keyed on it; releasing the
  // checkout is not licence to move or delete the ref.
  assert.equal(gitIn(clone, "rev-parse", "codex/settings-status-hermetic-path"), branchSha);

  // The next task takes the same physical slot and starts with no branch, which is what
  // makes its first real branch the SAME work episode rather than a takeover of somebody
  // else's.
  const wt = await provisionWorktree(clone, "task-attached-2", "slug", "abc123", sha, 0, m);
  assert.equal(wt.path, first.path);
  assert.equal(wt.provider, "mission");
  assert.equal(wt.branch, null);
  assert.equal(gitIn(wt.path, "rev-parse", "HEAD"), sha);
  assert.equal(detachedOnDisk(wt.path), true);
  assert.equal(gitIn(clone, "rev-parse", "codex/settings-status-hermetic-path"), branchSha);
});

test("a warm slot left attached by an older build is repaired on its next acquisition", async () => {
  const { origin, clone } = mkOriginAndClone("mission-native-legacy-attached-");
  writeFileSync(join(origin, ".gitignore"), "node_modules/\n");
  gitIn(origin, "add", ".gitignore");
  gitIn(origin, "commit", "-qm", "ignore warm cache");
  gitIn(clone, "fetch", "-q", "origin");
  gitIn(clone, "reset", "-q", "--hard", "origin/main");
  const sha = gitIn(clone, "rev-parse", "HEAD");
  const policy = { resolvePolicy: () => ({ enabled: true, maxSlots: 1, setupArgv: null }) };

  const old = manager({ ...policy, git: new PreDetachGit() });
  const first = lease(await acquire(old, clone, sha, "task-legacy-1"));
  gitIn(first.path, "checkout", "-qb", "harness/left-behind");
  mkdirSync(join(first.path, "node_modules"), { recursive: true });
  writeFileSync(join(first.path, "node_modules", "cache.txt"), "warm\n");
  assert.equal((await old.release(first)).outcome, "released");
  // The population this repairs: available, clean, at the right commit, and attached.
  assert.equal(detachedOnDisk(first.path), false, "sanity: the old build left it attached");

  // A current build takes the same slot out of the same pool.
  const now = manager(policy);
  const second = lease(await acquire(now, clone, sha, "task-legacy-2"));
  assert.equal(second.path, first.path);
  assert.equal(detachedOnDisk(second.path), true);
  assert.equal(gitIn(second.path, "rev-parse", "HEAD"), sha);
  // Repaired without re-paying for the install the pool exists to keep.
  assert.equal(existsSync(join(second.path, "node_modules", "cache.txt")), true);
  // The name the older build left behind is still a ref, not collateral of the repair.
  assert.match(gitIn(clone, "rev-parse", "--verify", "harness/left-behind"), /^[0-9a-f]{40}$/);
});

test("an attached or unprovable HEAD quarantines the slot instead of leasing it", async () => {
  const attachedRepo = repository("mission-native-attached-gate-");
  const attached = manager({
    resolvePolicy: () => ({ enabled: true, maxSlots: 1, setupArgv: null }),
    git: new (class extends NativeWorktreeGit {
      override async inspect(path: string) {
        const inspected = await super.inspect(path);
        return inspected.ok
          ? { ...inspected, value: { ...inspected.value, detached: false } }
          : inspected;
      }
    })(),
  });
  const refused = await acquire(attached, attachedRepo.clone, attachedRepo.sha, "task-gate-1");
  assert.equal(refused.outcome, "outcomeUnknown");
  assert.match(
    refused.outcome === "outcomeUnknown" ? refused.reason : "",
    /detached-HEAD verification/,
  );
  // Not merely refused - held, so nothing hands the same slot to the next caller. `reset`
  // reporting success is never enough on its own; this inspection is the durable proof.
  assert.equal(attached.store.slots().every((slot) => slot.state === "quarantined"), true);

  // The other half: a detached-state probe that never answered is not "detached".
  const unknownRepo = repository("mission-native-unprovable-head-");
  const unknown = manager({
    resolvePolicy: () => ({ enabled: true, maxSlots: 1, setupArgv: null }),
    git: new (class extends NativeWorktreeGit {
      override async inspect() {
        return {
          ok: false as const,
          reason: "git symbolic-ref HEAD failed: child disappeared",
          outcomeUnknown: true,
        };
      }
    })(),
  });
  const unproven = await acquire(unknown, unknownRepo.clone, unknownRepo.sha, "task-gate-2");
  assert.equal(unproven.outcome, "outcomeUnknown");
  assert.equal(unknown.store.slots().every((slot) => slot.state === "quarantined"), true);
});

test("Return cannot mark a slot available while it still holds a branch", async () => {
  const { clone } = mkOriginAndClone("mission-native-return-gate-");
  const sha = gitIn(clone, "rev-parse", "HEAD");
  // A reset that resets and cleans without detaching - the pre-change allocator - meeting
  // the current Return verification. The two gates are independent on purpose: either one
  // alone would let an attached slot sit in the warm pool looking perfectly available.
  const m = manager({
    resolvePolicy: () => ({ enabled: true, maxSlots: 1, setupArgv: null }),
    git: new (class extends NativeWorktreeGit {
      override async reset(path: string, commit: string): Promise<GitResult<void>> {
        gitIn(path, "reset", "--hard", commit);
        gitIn(path, "clean", "-fd");
        return { ok: true, value: undefined };
      }
    })(),
  });
  const held = lease(await acquire(m, clone, sha, "task-return-gate"));
  gitIn(held.path, "checkout", "-qb", "harness/still-attached");

  const released = await m.release(held);
  assert.equal(released.outcome, "outcomeUnknown");
  assert.equal(m.store.slots().every((slot) => slot.state === "quarantined"), true);
});
