/**
 * What is at stake: the two halves of this harness disagree about what to do when
 * `treehouse` is not installed, and only one of them degrades.
 *
 * `provisionWorktree` treats the pool as a FAST PATH over an invariant it keeps either way -
 * an agent never shares a working tree - so a machine with no `treehouse` still dispatches,
 * onto a throwaway `git worktree` (`dispatcher.ts`, the `hasBin(TREEHOUSE_BIN) &&
 * isTreehouseRepo(repoRoot)` gate). A Workflow check reaches the pool through
 * `CheckLeaseManager.acquireForAttempt`, which has no such gate anywhere upstream of it -
 * `dispatcher.ts:769` is the only `hasBin(TREEHOUSE_BIN)` in the codebase.
 *
 * So this file measures, rather than assumes, what a check DOES on that machine. The
 * distinction it turns on is the one the runtime already draws itself:
 *
 *   - `unavailable`  - the gate is recorded and PASSES, with a note saying why it did not run.
 *                      This is how an unsupported platform declines (`check-identity.ts`).
 *   - `infrastructure` - the gate did NOT pass. It reaches `handleInfrastructureFailure`,
 *                      finishes the attempt, and spends one of a bounded budget on a retry
 *                      that has no reason to succeed, because nothing about a missing binary
 *                      changes between attempts.
 *
 * Nothing here fakes the pool. Other check suites inject a `TreehouseCli` precisely so they
 * never need the binary; this one is about the binary's ABSENCE, so it removes it from PATH
 * and lets the real `defaultTreehouseCli` fail the way it fails in production. `git` and
 * `node` are deliberately left reachable - the claim is "no treehouse", not "no tools".
 */
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
const { onPath } = await import("../src/server/util/exec.ts");

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

/**
 * A real repository that OPTED IN to the pool - `treehouse.toml` at the root is the opt-in
 * (`isTreehouseRepo`). This is the interesting machine: the repo asks for a pooled tree and the
 * binary that would hand one over is not installed.
 */
function mkRepo(name: string): { repo: string; head: string } {
  const repo = join(home, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString().trim();
  git("config", "user.email", "t@test");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "treehouse.toml"), "max_trees = 4\nroot = \"\"\n");
  writeFileSync(join(repo, "file.txt"), "first\n");
  git("add", "-A");
  git("commit", "-qm", "first");
  return { repo, head: git("rev-parse", "HEAD") };
}

/** An argv that would PASS. Any failure below is the harness's, never the command's. */
const PASSES = [process.execPath, "-e", "console.log('42 passing')"];

function runtimeFor(over: { platform?: () => { supported: boolean; note: string } } = {}) {
  const leases = new CheckLeaseManager(db, {
    // The REAL pool adapter (`defaultTreehouseCli` by default) and the real pin, so the
    // absence of the binary is what the case actually exercises.
    pin: pinLeasedWorktree,
    verifyBase: verifyPinnedBase,
  });
  return new CheckRuntime(leases, { leaseStore: leaseRows, timeoutMs: 30_000, ...over });
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

// ---- the check does not ----------------------------------------------------------------

/**
 * The measurement. Same machine, same repository, and a command that would have exited 0.
 *
 * If this reports `unavailable`, checks degrade the way dispatch does and the asymmetry is
 * cosmetic. If it reports `infrastructure`, a configured gate cannot pass on this machine at
 * all - and it consumes an attempt from a bounded budget to learn that, every time.
 */
test("a check on the same machine cannot run at all", { skip: !SUPPORTED }, async () => {
  const { repo, head } = mkRepo("check-degrades");
  const ref = attemptRef();

  const outcome = await withoutTreehouse(() =>
    runtimeFor().executorFor(ref)({
      slot: "test",
      command: PASSES,
      repoRoot: repo,
      workingSubpath: "",
      headSha: head,
    }),
  );

  // Recorded as data first, so a change in this behaviour reads as a diff of the real kind
  // rather than as an opaque assertion failure.
  assert.equal(
    outcome.kind,
    "infrastructure",
    `a passing command on a treehouse-less machine reported ${outcome.kind}`,
  );
  const reason = outcome.kind === "infrastructure" ? outcome.reason : "";
  assert.match(reason, /could not be prepared/, "the runtime has to say the tree was the problem");
  assert.match(
    reason,
    /treehouse/,
    "and it has to name treehouse, or the operator cannot act on it",
  );
});

/**
 * The contrast that makes the previous case a finding rather than an opinion: the runtime
 * ALREADY has a "cannot run here, so record it and pass" outcome, and an unsupported platform
 * uses it. A missing pool binary is the same class of fact about the machine and does not.
 */
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
