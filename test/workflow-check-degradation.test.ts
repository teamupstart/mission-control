/**
 * The guarantee: dispatch and Workflow checks both preserve isolated-worktree execution when
 * `treehouse` is not installed. A check uses a detached git worktree pinned to the captured
 * commit, runs the configured command, records its real verdict, and removes the tree.
 *
 * This suite removes only `treehouse` from PATH while leaving real `git` and `node` reachable.
 * That makes the fallback an end-to-end production path rather than a fake provider. The one
 * fake pool below exists for the opposite boundary: a resolvable binary with no
 * `treehouse.toml`, where the adopted decision says dispatch uses git but checks still pool.
 */
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// A fresh state dir BEFORE anything that resolves it is imported - static imports hoist above
// assignments, so every module below arrives through a dynamic import (see db-isolation.test.ts).
const home = realpathSync(mkdtempSync(join(tmpdir(), "mission-check-degrade-")));
process.env.HARNESS_HOME = home;

const { openDb } = await import("../src/server/db.ts");
const { CheckLeaseManager, CheckLeaseStore } = await import("../src/server/workflows/check-lease.ts");
const { CheckRuntime } = await import("../src/server/workflows/check-runtime.ts");
const { pinLeasedWorktree, provisionWorktree, verifyPinnedBase } =
  await import("../src/server/dispatcher.ts");
const { checkRuntimeSupport } = await import("../src/server/workflows/check-identity.ts");
const { isTreehouseRepo } = await import("../src/server/pool.ts");
const { onPath, stubRun } = await import("../src/server/util/exec.ts");
const { CHECK_WORKTREES_DIR } = await import("../src/server/config.ts");

type TreehouseCli = import("../src/server/pool-lease.ts").TreehouseCli;

const db = openDb();
const leaseRows = new CheckLeaseStore(db);

/** A real process is started only by the case that gets that far; the rest are platform-free. */
const SUPPORTED = checkRuntimeSupport().supported;

const NO_PINS = () => ({ sessionCwds: [], taskWorktrees: [], checkLeasePaths: [] });

const liveRows = (): unknown[] =>
  db
    .prepare(
      `SELECT attempt_id, lease_path, cleanup_state FROM workflow_check_leases
        WHERE cleanup_state IN ('held', 'returning')`,
    )
    .all();

/**
 * The leak assertion, per case. A degradation path is exactly where a lease row gets stranded,
 * because the failure happens with the bookkeeping half-written.
 */
afterEach((t) => {
  const live = liveRows();
  db.exec("DELETE FROM workflow_check_leases");
  assert.deepEqual(live, [], `${t.name} ended still holding a check lease`);
});

const worktreesToPrune: { repoRoot: string; path: string }[] = [];

after(() => {
  for (const w of worktreesToPrune) {
    try {
      execFileSync("git", ["-C", w.repoRoot, "worktree", "remove", "--force", w.path], {
        stdio: "pipe",
      });
    } catch {
      // The temp tree is about to be deleted wholesale; a failed unregister costs nothing.
    }
  }
  rmSync(home, { recursive: true, force: true });
});

/**
 * PATH with every directory that actually holds a `treehouse` removed - not a PATH emptied
 * down to a hand-built bin dir.
 *
 * The difference is the whole validity of the suite. `provisionWorktree` resolves the binary by
 * spawning `/usr/bin/which`, the pool adapter spawns `treehouse` itself, and both arms run real
 * `git`. A test that stripped PATH wholesale would fail for want of `git` and prove nothing
 * about treehouse; this removes one binary and leaves the toolchain standing.
 */
function pathWithoutTreehouse(): string {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir && !existsSync(join(dir, "treehouse")))
    .join(delimiter);
}

async function withoutTreehouse<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.env.PATH;
  process.env.PATH = pathWithoutTreehouse();
  try {
    // Stated out loud, because a suite that silently still had treehouse on PATH would pass
    // every assertion below for the wrong reason on a developer's machine.
    assert.equal(onPath("treehouse"), false, "this suite is about a machine with no treehouse");
    assert.ok(onPath("git"), "git must stay reachable or the arms fail for the wrong reason");
    return await fn();
  } finally {
    process.env.PATH = original;
  }
}

async function withTreehouseShim<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.env.PATH;
  const bin = join(home, "treehouse-shim-bin");
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, "treehouse");
  if (!existsSync(shim)) symlinkSync(process.execPath, shim);
  process.env.PATH = [bin, pathWithoutTreehouse()].filter(Boolean).join(delimiter);
  try {
    assert.ok(onPath("treehouse"), "the adopted-split case needs a resolvable treehouse binary");
    return await fn();
  } finally {
    process.env.PATH = original;
  }
}

/**
 * A real repository that OPTED IN to the pool - `treehouse.toml` at the root is the opt-in
 * (`isTreehouseRepo`). This is the interesting machine: the repo asks for a pooled tree and the
 * binary that would hand one over is not installed.
 */
function mkRepo(name: string, opts: { treehouseToml?: boolean } = {}): { repo: string; head: string } {
  const repo = join(home, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString().trim();
  git("config", "user.email", "t@test");
  git("config", "user.name", "t");
  if (opts.treehouseToml !== false) {
    writeFileSync(join(repo, "treehouse.toml"), "max_trees = 4\nroot = \"\"\n");
  }
  writeFileSync(join(repo, "file.txt"), "first\n");
  git("add", "-A");
  git("commit", "-qm", "first");
  return { repo, head: git("rev-parse", "HEAD") };
}

/** An argv that would PASS. Any failure below is the harness's, never the command's. */
const PASSES = [process.execPath, "-e", "console.log('42 passing')"];
const REPORT_HEAD = [
  process.execPath,
  "-e",
  "console.log(require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD']).toString().trim())",
];

function runtimeFor(over: {
  platform?: () => { supported: boolean; note: string };
  cli?: TreehouseCli;
} = {}) {
  const leases = new CheckLeaseManager(db, {
    // The real provider probe and real pin. Unless a case supplies a fake pool, the absence
    // of the binary selects the real git provider.
    cli: over.cli,
    pin: pinLeasedWorktree,
    verifyBase: verifyPinnedBase,
  });
  return new CheckRuntime(leases, {
    leaseStore: leaseRows,
    timeoutMs: 30_000,
    ...(over.platform ? { platform: over.platform } : {}),
  });
}

let attemptSeq = 0;
function attemptRef(): { attemptId: string; submissionId: string; nodeId: string } {
  const n = attemptSeq++;
  return { attemptId: `degrade-att-${n}`, submissionId: `degrade-sub-${n}`, nodeId: "gate" };
}

// ---- dispatch degrades -----------------------------------------------------------------

test("dispatch still provisions an isolated tree with no treehouse installed", async () => {
  const { repo } = mkRepo("dispatch-degrades");
  assert.ok(isTreehouseRepo(repo), "the repo opted into the pool, so the pool arm is the one asked");

  const wt = await withoutTreehouse(() =>
    provisionWorktree(repo, "degrade-task", "slug", "abc123", NO_PINS),
  );
  worktreesToPrune.push({ repoRoot: repo, path: wt.path });

  assert.equal(wt.provider, "git", "the pool was unreachable, so the throwaway arm had to answer");
  assert.ok(existsSync(wt.path), "a fallback that returns a path must return one that exists");
  assert.notEqual(
    realpathSync(wt.path),
    realpathSync(repo),
    "the invariant survives degradation: this is not the shared checkout",
  );
});

// ---- checks degrade without declining the gate -----------------------------------------

/**
 * The regression. Same machine and repository as dispatch, with a command that reports the
 * commit it actually tested. A real verdict proves the gate did not silently decline, and
 * matching HEAD proves the cold tree kept the captured-commit contract.
 */
test("a check on the same machine runs in git and reports its real verdict", { skip: !SUPPORTED }, async () => {
  const { repo, head } = mkRepo("check-degrades");
  const ref = attemptRef();

  const outcome = await withoutTreehouse(() =>
    runtimeFor().executorFor(ref)({
      slot: "test",
      command: REPORT_HEAD,
      repoRoot: repo,
      workingSubpath: "",
      headSha: head,
    }),
  );

  assert.equal(outcome.kind, "exited", `the configured command reported ${outcome.kind}`);
  assert.equal(outcome.kind === "exited" && outcome.exitCode, 0);
  assert.equal(outcome.kind === "exited" ? outcome.output.trim() : "", head);

  const row = leaseRows.get(ref.attemptId);
  assert.equal(row?.provider, "git", "the acquire-time provider choice was not persisted");
  assert.equal(row?.cleanupState, "returned", "the git worktree did not reach a terminal row");
  assert.ok(row, "the check did not record its worktree lifecycle");
  assert.equal(existsSync(row.leasePath), false, "the returned git check tree still exists");
  const registered = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], {
    stdio: "pipe",
  }).toString();
  assert.doesNotMatch(registered, new RegExp(row.leasePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

/** The true decline stays distinct: an unsupported runtime records the gate as not run. */
test("an unsupported platform, by contrast, is recorded and passed", async () => {
  const { repo, head } = mkRepo("platform-declines");
  const runtime = runtimeFor({
    platform: () => ({ supported: false, note: "this daemon cannot run check commands" }),
  });

  const outcome = await runtime.executorFor(attemptRef())({
    slot: "test",
    command: PASSES,
    repoRoot: repo,
    workingSubpath: "",
    headSha: head,
  });

  assert.equal(
    outcome.kind,
    "unavailable",
    "a platform that cannot run checks declines by passing, and leases nothing",
  );
});

test("a git-provider row is released through git after treehouse appears", async () => {
  const { repo, head } = mkRepo("git-provider-stays-authoritative");
  let installed = false;
  let probes = 0;
  const leases = new CheckLeaseManager(db, {
    verifyBase: verifyPinnedBase,
    treehouseInstalled: async () => {
      probes++;
      return installed;
    },
  });
  const ref = attemptRef();
  const path = await leases.acquireForAttempt({
    ...ref,
    repoRoot: repo,
    headSha: head,
  });
  assert.equal(leaseRows.get(ref.attemptId)?.provider, "git");

  installed = true;
  assert.deepEqual(await leases.releaseForAttempt(ref.attemptId), { outcome: "returned" });
  assert.equal(probes, 1, "release re-probed the machine instead of reading the row");
  assert.equal(leaseRows.get(ref.attemptId)?.provider, "git");
  assert.equal(leaseRows.get(ref.attemptId)?.cleanupState, "returned");
  assert.equal(existsSync(path), false);
});

test("a git provider refuses to reuse an existing attempt path", async () => {
  const { repo, head } = mkRepo("git-provider-refuses-existing-path");
  const ref = attemptRef();
  const path = join(CHECK_WORKTREES_DIR, ref.attemptId);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "keep.txt"), "not this attempt's tree\n");
  const leases = new CheckLeaseManager(db, {
    verifyBase: verifyPinnedBase,
    treehouseInstalled: async () => false,
  });

  await assert.rejects(
    () => leases.acquireForAttempt({ ...ref, repoRoot: repo, headSha: head }),
    /refusing to reuse it/,
  );
  assert.equal(leaseRows.get(ref.attemptId), null);
  assert.ok(existsSync(join(path, "keep.txt")), "the provider altered a path it did not create");
});

// ---- the adopted split is deliberate ---------------------------------------------------

test(
  "adopted split: without treehouse.toml dispatch uses git while a check still uses the pool",
  { skip: !SUPPORTED },
  async () => {
    const { repo, head } = mkRepo("binary-only-check-gate", { treehouseToml: false });
    assert.equal(isTreehouseRepo(repo), false, "the fixture accidentally opted into dispatch pooling");

    const poolPath = join(home, "binary-only-pool-tree");
    execFileSync("git", ["-C", repo, "worktree", "add", "--detach", poolPath, head], { stdio: "pipe" });
    worktreesToPrune.push({ repoRoot: repo, path: poolPath });
    const holder = { value: null as string | null };
    const cli: TreehouseCli = {
      get: async (_repoRoot, nextHolder) => {
        holder.value = nextHolder;
        return stubRun({ stdout: `${poolPath}\n`, stderr: "", code: 0 });
      },
      status: async () =>
        stubRun({
          stdout: `1     leased       ${poolPath}  (held by ${holder.value})`,
          stderr: "",
          code: 0,
        }),
      return: async () => {
        holder.value = null;
        return stubRun({ stdout: "", stderr: "", code: 0 });
      },
    };

    await withTreehouseShim(async () => {
      // This split is the recorded decision. Checks ask only whether the binary resolves;
      // dispatch also asks whether the repository opted in through treehouse.toml.
      const dispatched = await provisionWorktree(
        repo,
        "binary-only-dispatch",
        "binary-only",
        "abc123",
        NO_PINS,
      );
      worktreesToPrune.push({ repoRoot: repo, path: dispatched.path });
      assert.equal(dispatched.provider, "git");

      const ref = attemptRef();
      const outcome = await runtimeFor({ cli }).executorFor(ref)({
        slot: "test",
        command: PASSES,
        repoRoot: repo,
        workingSubpath: "",
        headSha: head,
      });
      assert.equal(outcome.kind, "exited");
      assert.equal(outcome.kind === "exited" && outcome.exitCode, 0);
      assert.equal(leaseRows.get(ref.attemptId)?.provider, "treehouse");
      assert.equal(leaseRows.get(ref.attemptId)?.cleanupState, "returned");
    });
  },
);
