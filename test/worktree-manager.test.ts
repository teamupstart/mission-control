import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { WorktreeProvider } from "../src/shared/types.ts";
import {
  WorktreesConfigPatchSchema,
  WorktreesConfigSchema,
} from "../src/shared/protocol.ts";
import { openDb } from "../src/server/db.ts";
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
import type { RunResult } from "../src/server/util/exec.ts";
import { worktreeRepositoryIdentity } from "../src/server/util/git.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";

const db = openDb();

afterEach(() => {
  db.exec("DELETE FROM worktree_slots; DELETE FROM worktree_pools; DELETE FROM app_config WHERE key = 'worktrees';");
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

  for (const unknownProbe of ["rev-parse", "status"]) {
    const inspected = await new NativeWorktreeGit(async (_bin, args) => {
      if (args.includes(unknownProbe)) return unknown(unknownProbe === "rev-parse" ? `${sha}\n` : "");
      return known(unknownProbe === "status" ? `${sha}\n` : "");
    }).inspect(clone);
    assertUnknown(inspected, unknownProbe === "rev-parse" ? /git rev-parse HEAD/ : /git status/);
  }

  const added = await new NativeWorktreeGit(async () => unknown()).add(
    identity,
    join(identity.poolPath, "unknown-add"),
    sha,
  );
  assertUnknown(added, /git worktree add/);

  const fetched = await new NativeWorktreeGit(async () => unknown()).fetchDefaultSha(identity);
  assertUnknown(fetched, /git fetch origin/);

  const resolved = await new NativeWorktreeGit(async (_bin, args) =>
    args.includes("fetch") ? known() : unknown(`${sha}\n`)
  ).fetchDefaultSha(identity);
  assertUnknown(resolved, /git rev-parse origin\//);

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
  assert.equal(acquired.length, 2);
  assert.equal(new Set(acquired.map((result) => result.lease.path)).size, 2);
  assert.equal(results.filter((result) => result.outcome === "notAcquired").length, 1);
  for (const result of acquired) {
    assert.equal(result.lease.provider, "mission");
    assert.equal(gitIn(result.lease.path, "rev-parse", "HEAD"), sha);
    await m.release(result.lease);
  }
});

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
  const second = lease(await acquire(m, clone, sha, "task-cache-2"));
  assert.equal(second.path, first.path);
  assert.equal(existsSync(cache), true);
  await m.release(second);
});

test("operator setup runs only for a new slot and setup failure quarantines it", async () => {
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

test("release rechecks occupancy after fetch before it records a reset intent", async () => {
  const { clone, sha } = repository("mission-native-release-race-");
  let occupancyReads = 0;
  const m = manager({
    occupancy: async (paths) => {
      occupancyReads++;
      const occupied = occupancyReads === 2;
      return new Map(paths.map((path) => [
        path,
        {
          status: "known" as const,
          occupants: occupied
            ? [{ pid: 91, ppid: 1, startRaw: "now", startMs: 1, command: "node", cwd: path, knownOwner: null }]
            : [],
        },
      ]));
    },
  });
  const held = lease(await acquire(m, clone, sha, "task-race"));
  // Acquisition consumed no occupancy read for a brand-new path. Release reads once,
  // fetches, then refuses the process that appeared in its fresh destructive check.
  const released = await m.release(held);
  assert.equal(released.outcome, "refused");
  if (released.outcome === "refused") assert.match(released.reason, /occupy/);
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
