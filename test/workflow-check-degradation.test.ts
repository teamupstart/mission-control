/**
 * The guarantee: dispatch and Workflow checks both preserve isolated-worktree execution when
 * native allocation positively refuses before reservation. A check uses a detached Git
 * worktree pinned to the captured commit, runs the configured command, records its real
 * verdict, and removes the tree.
 */
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
const { CHECK_WORKTREES_DIR } = await import("../src/server/config.ts");
const { setWorktreesConfig } = await import("../src/server/worktrees/config.ts");
const { WorktreeManager } = await import("../src/server/worktrees/manager.ts");

const db = openDb();
const leaseRows = new CheckLeaseStore(db);
setWorktreesConfig({ enabled: false });

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
  setWorktreesConfig({ enabled: false });
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
 * A real repository. Native worktrees are default-on, while this suite explicitly disables
 * them to exercise the single allowed disposable Git degradation.
 */
function mkRepo(name: string): { repo: string; head: string } {
  const repo = join(home, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString().trim();
  git("config", "user.email", "t@test");
  git("config", "user.name", "t");
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
} = {}) {
  const leases = new CheckLeaseManager(db, {
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

test("dispatch keeps isolation when native allocation is disabled", async () => {
  const { repo, head } = mkRepo("dispatch-degrades");
  const wt = await provisionWorktree(
    repo,
    "degrade-task",
    "slug",
    "abc123",
    NO_PINS,
    head,
    0,
    new WorktreeManager(db),
  );
  worktreesToPrune.push({ repoRoot: repo, path: wt.path });

  assert.equal(wt.provider, "git", "the positive native refusal did not reach Git degradation");
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
test("a check with native allocation disabled runs in git and reports its real verdict", { skip: !SUPPORTED }, async () => {
  const { repo, head } = mkRepo("check-degrades");
  const ref = attemptRef();

  const outcome = await runtimeFor().executorFor(ref)({
    slot: "test",
    command: REPORT_HEAD,
    repoRoot: repo,
    workingSubpath: "",
    headSha: head,
  });

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

test("a Git row remains provider-authoritative after native allocation is enabled", async () => {
  const { repo, head } = mkRepo("git-provider-stays-authoritative");
  const leases = new CheckLeaseManager(db, {
    verifyBase: verifyPinnedBase,
  });
  const ref = attemptRef();
  const path = await leases.acquireForAttempt({
    ...ref,
    repoRoot: repo,
    headSha: head,
  });
  assert.equal(leaseRows.get(ref.attemptId)?.provider, "git");

  setWorktreesConfig({ enabled: true });
  assert.deepEqual(await leases.releaseForAttempt(ref.attemptId), { outcome: "returned" });
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
  });

  await assert.rejects(
    () => leases.acquireForAttempt({ ...ref, repoRoot: repo, headSha: head }),
    /refusing to reuse it/,
  );
  assert.equal(leaseRows.get(ref.attemptId), null);
  assert.ok(existsSync(join(path, "keep.txt")), "the provider altered a path it did not create");
});
