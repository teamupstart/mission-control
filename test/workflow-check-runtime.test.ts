/**
 * What is at stake: until this change a configured, authorized check gate reported "Not run"
 * and PASSED, because the execution runtime it reaches was null in production. So the whole
 * file is about one claim - the gate now runs the operator's command, in the right tree, at
 * the right commit, and a non-zero exit really does fail the submission.
 *
 * Nothing here mocks the part that matters. The command is a real process with a real exit
 * code, the worktree it runs in is a real linked `git worktree` pinned by the real
 * `pinLeasedWorktree`, and the commit is verified by the real `verifyPinnedBase`. Only the
 * `treehouse` binary is faked, because a test that needed a pool installed would be a test
 * that never ran in CI - and the fake is a pool that behaves like one, so the identity rules
 * are exercised against something that actually changes.
 */
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublishedWorkflowGraph, WorkflowContextSnapshot } from "../src/shared/workflow.ts";
import { emptyWorkflowCommandView } from "../src/shared/workflow.ts";

// A fresh state dir BEFORE anything that resolves it is imported - static imports hoist above
// assignments, so every module below arrives through a dynamic import (see db-isolation.test.ts).
// `realpathSync` because $TMPDIR is a symlink into /private on macOS and every path this
// subsystem stores is canonicalized.
const home = realpathSync(mkdtempSync(join(tmpdir(), "mission-check-runtime-")));
process.env.HARNESS_HOME = home;

const { openDb } = await import("../src/server/db.ts");
const { CheckLeaseManager, CheckLeaseStore } = await import("../src/server/workflows/check-lease.ts");
const { CheckRuntime } = await import("../src/server/workflows/check-runtime.ts");
const { WorkflowStore, workflowJson } = await import("../src/server/workflows/store.ts");
const { WorkflowEngine } = await import("../src/server/workflows/engine.ts");
const { checkHolderToken, isCheckHolder, installCheckLeasePins } =
  await import("../src/server/pool-lease.ts");
const { parsePoolStatus } = await import("../src/server/pool.ts");
const { pinLeasedWorktree, verifyPinnedBase } = await import("../src/server/dispatcher.ts");
const { processStartIdentity, checkRuntimeSupport } = await import("../src/server/workflows/check-identity.ts");
const { onPath, stubRun } = await import("../src/server/util/exec.ts");

type TreehouseCli = import("../src/server/pool-lease.ts").TreehouseCli;
type CheckSpawnOutcome = import("../src/server/workflows/check-supervisor.ts").CheckSpawnOutcome;

const db = openDb();
const leaseRows = new CheckLeaseStore(db);
const TREEHOUSE_PRESENT = async () => true;

/**
 * Every case here starts a real process, and a platform that cannot read a process start
 * identity declines checks by design. Rather than pretend, the suite says so out loud.
 */
const SUPPORTED = checkRuntimeSupport().supported;

const liveRows = (): unknown[] =>
  db
    .prepare(
      `SELECT attempt_id, lease_path, cleanup_state FROM workflow_check_leases
        WHERE cleanup_state IN ('held', 'returning')`,
    )
    .all();

/** The leak assertion, per test - the cheapest guard against the worst failure mode here. */
afterEach((t) => {
  const live = liveRows();
  db.exec("DELETE FROM workflow_check_leases");
  assert.deepEqual(live, [], `${t.name} ended still holding a check lease`);
});

after(() => {
  assert.deepEqual(liveRows(), [], "the suite ended still holding a check lease");
  // The other half: the developer's REAL pool. Every case drives a fake subprocess, so a tree
  // held by a check token there could only come from a call that escaped the fake.
  if (onPath("treehouse")) {
    try {
      const out = execFileSync("treehouse", ["status"], { cwd: process.cwd(), stdio: "pipe" }).toString();
      assert.deepEqual(
        parsePoolStatus(out).filter((t) => isCheckHolder(t.holder)),
        [],
        "a real pooled worktree is still held by a check token",
      );
    } catch {
      // An unreadable pool is not evidence of anything, either way.
    }
  }
  installCheckLeasePins(null);
  for (const w of worktreesToPrune) {
    try {
      execFileSync("git", ["-C", w.repoRoot, "worktree", "remove", "--force", w.path], { stdio: "pipe" });
    } catch {
      // The temp tree is about to be deleted wholesale; a failed unregister costs nothing.
    }
  }
  rmSync(home, { recursive: true, force: true });
});

// ---- a real repository, and a fake pool of real worktrees over it ----------

const worktreesToPrune: { repoRoot: string; path: string }[] = [];
let seq = 0;

/** A real git repository with one commit and a nested package, so a subpath has somewhere to go. */
function gitRepo(): { repoRoot: string; headSha: string } {
  const repoRoot = realpathSync(mkdtempSync(join(home, `repo-${seq++}-`)));
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", repoRoot, ...args], { stdio: "pipe" }).toString();
  execFileSync("git", ["init", "-q", "-b", "main", repoRoot], { stdio: "pipe" });
  git("config", "user.email", "checks@example.com");
  git("config", "user.name", "Check Fixture");
  git("config", "commit.gpgsign", "false");
  mkdirSync(join(repoRoot, "packages", "web"), { recursive: true });
  writeFileSync(join(repoRoot, "packages", "web", "marker.txt"), "web\n");
  writeFileSync(join(repoRoot, "root.txt"), "root\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  return { repoRoot, headSha: git("rev-parse", "HEAD").trim() };
}

interface FakeTree {
  name: string;
  path: string;
  state: "available" | "leased";
  holder: string | null;
}

interface CliCall {
  cmd: "status" | "get" | "return";
  path?: string;
  holder?: string;
  force?: boolean;
}

/**
 * A pool of REAL linked worktrees of `repoRoot`, handed out the way treehouse hands trees out.
 *
 * Real worktrees rather than bare directories because the pin is real: `pinLeasedWorktree`
 * refuses a tree it cannot prove belongs to the repository, and then hard-resets it to the
 * captured commit. Faking that away would leave the single most important claim in this file -
 * that the command runs against the commit the run captured, in the tree the pool handed over -
 * resting on nothing.
 */
function fakePool(repoRoot: string, slots: number) {
  const trees: FakeTree[] = [];
  for (let i = 1; i <= slots; i++) {
    const path = join(home, `pool-${seq++}-${i}`);
    execFileSync("git", ["-C", repoRoot, "worktree", "add", "-q", "--detach", path, "HEAD"], {
      stdio: "pipe",
    });
    worktreesToPrune.push({ repoRoot, path });
    trees.push({ name: String(i), path: realpathSync(path), state: "available", holder: null });
  }
  const calls: CliCall[] = [];
  const dry = { get: false };
  const failReturn = { value: false };
  const render = (): string =>
    trees
      .map((t) => `${t.name}     ${t.state}       ${t.path}${t.holder ? `  (held by ${t.holder})` : ""}`)
      .join("\n");
  const cli: TreehouseCli = {
    status: async () => {
      calls.push({ cmd: "status" });
      return stubRun({ stdout: render(), stderr: "", code: 0 });
    },
    get: async (_repoRoot, holder) => {
      calls.push({ cmd: "get", holder });
      const free = dry.get ? undefined : trees.find((t) => t.state === "available");
      if (!free) return stubRun({ stdout: "", stderr: "no trees available", code: 1 });
      free.state = "leased";
      free.holder = holder;
      return stubRun({ stdout: `${free.path}\n`, stderr: "", code: 0 });
    },
    return: async ({ path, force }) => {
      calls.push({ cmd: "return", path, force });
      if (failReturn.value) return stubRun({ stdout: "", stderr: "tree is busy", code: 1 });
      const t = trees.find((x) => realpathSync(x.path) === realpathSync(path));
      if (t) {
        t.state = "available";
        t.holder = null;
      }
      return stubRun({ stdout: "", stderr: "", code: 0 });
    },
  };
  return { cli, trees, calls, dry, failReturn };
}

interface Fixture {
  repoRoot: string;
  headSha: string;
  pool: ReturnType<typeof fakePool>;
  leases: InstanceType<typeof CheckLeaseManager>;
  runtime: InstanceType<typeof CheckRuntime>;
}

/** Timings the ladder is driven with here: the same shape, in test time rather than build time. */
const TEARDOWN = { graceMs: 300, confirmMs: 3_000, pollMs: 20 };

function fixture(over: { slots?: number } = {}): Fixture {
  const { repoRoot, headSha } = gitRepo();
  const pool = fakePool(repoRoot, over.slots ?? 2);
  const leases = new CheckLeaseManager(db, {
    cli: pool.cli,
    // The REAL pin and the REAL commit verification. This is what makes "pinned to the
    // captured commit" a property of the test rather than a claim in a comment.
    pin: pinLeasedWorktree,
    verifyBase: verifyPinnedBase,
    treehouseInstalled: TREEHOUSE_PRESENT,
  });
  const runtime = new CheckRuntime(leases, { leaseStore: leaseRows, teardown: TEARDOWN, timeoutMs: 30_000 });
  return { repoRoot, headSha, pool, leases, runtime };
}

let attemptSeq = 0;
function attemptRef(): { attemptId: string; submissionId: string; nodeId: string } {
  const n = attemptSeq++;
  return { attemptId: `att-${n}`, submissionId: `sub-${n}`, nodeId: "gate" };
}

/** An argv that prints where it is standing. No shell anywhere: `node -e` is the whole command. */
const REPORT_CWD = [process.execPath, "-e", "console.log(process.cwd())"];
const PASSES = [process.execPath, "-e", "console.log('42 passing')"];
const FAILS = [process.execPath, "-e", "console.error('src/x.ts(1,1): error TS2345'); process.exit(3)"];

function run(
  f: Fixture,
  over: {
    command?: string[];
    workingSubpath?: string;
    headSha?: string | null;
    ref?: { attemptId: string; submissionId: string; nodeId: string };
  } = {},
) {
  const ref = over.ref ?? attemptRef();
  return {
    ref,
    result: f.runtime.executorFor(ref)({
      slot: "test",
      command: over.command ?? PASSES,
      repoRoot: f.repoRoot,
      workingSubpath: over.workingSubpath ?? "",
      headSha: over.headSha === undefined ? f.headSha : over.headSha,
    }),
  };
}

// ---- the gate actually runs ------------------------------------------------

test("a failing command fails with its own output, and its tree goes back", { skip: !SUPPORTED }, async () => {
  const f = fixture();
  const { ref, result } = run(f, { command: FAILS });
  const outcome = await result;

  assert.equal(outcome.kind, "exited");
  assert.equal(outcome.kind === "exited" && outcome.exitCode, 3);
  assert.match(outcome.kind === "exited" ? outcome.output : "", /error TS2345/);
  // The lease is back, terminally, and treehouse was asked to take it.
  assert.equal(leaseRows.get(ref.attemptId)?.cleanupState, "returned");
  assert.ok(f.pool.calls.some((c) => c.cmd === "return"), "no return was issued");
  assert.deepEqual(f.pool.trees.filter((t) => t.state === "leased"), []);
  assert.equal(f.leases.unresolvedLeaseForNode(ref.submissionId, ref.nodeId), false);
});

test("a passing command passes, and its tree goes back too", { skip: !SUPPORTED }, async () => {
  const f = fixture();
  const { ref, result } = run(f, { command: PASSES });
  const outcome = await result;

  assert.equal(outcome.kind, "exited");
  assert.equal(outcome.kind === "exited" && outcome.exitCode, 0);
  assert.match(outcome.kind === "exited" ? outcome.output : "", /42 passing/);
  assert.equal(leaseRows.get(ref.attemptId)?.cleanupState, "returned");
  assert.deepEqual(f.pool.trees.filter((t) => t.state === "leased"), []);
});

/**
 * THE assertion of this phase.
 *
 * The tempting shortcut is to run the command in the binding's `sessionRepoRoot`, and on the
 * ordinary dispatch shape that names the shared main repository behind a linked worktree - so
 * the gate would test an unrelated checkout and report the answer as if it were about this
 * submission. A wrong verdict, not a crash, which is the worst shape available here.
 */
test("the command runs in the LEASED worktree, never in the session's repository", { skip: !SUPPORTED }, async () => {
  const f = fixture();
  const { ref, result } = run(f, { command: REPORT_CWD });
  const outcome = await result;

  assert.equal(outcome.kind, "exited");
  const where = outcome.kind === "exited" ? outcome.output.trim() : "";
  const leased = leaseRows.get(ref.attemptId)!.leasePath;
  assert.equal(where, leased, "the command did not run in the tree it was handed");
  assert.notEqual(where, f.repoRoot, "the command ran in the session's own repository");
  assert.ok(
    f.pool.trees.some((t) => t.path === leased),
    "the directory it ran in was not one the pool handed over",
  );
  // And that tree was stamped with a holder the shared reaper structurally cannot collect.
  assert.equal(leaseRows.get(ref.attemptId)?.holderToken, checkHolderToken(ref.attemptId));
});

test("a nested working subpath runs where it was configured", { skip: !SUPPORTED }, async () => {
  const f = fixture();
  const { ref, result } = run(f, { command: REPORT_CWD, workingSubpath: "packages/web" });
  const outcome = await result;

  assert.equal(outcome.kind, "exited");
  const leased = leaseRows.get(ref.attemptId)!.leasePath;
  assert.equal(
    outcome.kind === "exited" ? outcome.output.trim() : "",
    join(leased, "packages", "web"),
    "a monorepo package's command ran at the top of the tree instead of in its own directory",
  );
});

// ---- the failures that must never become verdicts --------------------------

test("a null head sha is infrastructure and leases nothing", async () => {
  const f = fixture();
  const { ref, result } = run(f, { headSha: null });
  const outcome = await result;

  // NOT `unavailable`, which would PASS the gate. There is nothing to pin a worktree to.
  assert.equal(outcome.kind, "infrastructure");
  assert.match(outcome.kind === "infrastructure" ? outcome.reason : "", /captured no commit/);
  assert.equal(leaseRows.get(ref.attemptId), null, "a lease row was written with nothing to pin");
  assert.deepEqual(f.pool.calls, [], "the pool was asked for a tree with no commit to pin it to");
});

test("a dry pool is infrastructure, never a failed verdict", async () => {
  const f = fixture();
  f.pool.dry.get = true;
  const { ref, result } = run(f);
  const outcome = await result;

  assert.equal(outcome.kind, "infrastructure");
  assert.match(outcome.kind === "infrastructure" ? outcome.reason : "", /could not be prepared/);
  assert.equal(leaseRows.get(ref.attemptId), null);
});

/**
 * The shape production actually produces, and the reason this file exists rather than a diff
 * review: evidence capture records `git rev-parse --short HEAD`, so every real submission
 * carries an ABBREVIATED commit - while a pin refuses anything shorter than 40 hex characters,
 * deliberately. Wired without the resolve step, every check on every real submission failed as
 * infrastructure before it leased anything, and the gate went on never running.
 *
 * Found end to end on a real repository, not here. This is the case that keeps it fixed.
 */
test("an abbreviated captured commit still pins the worktree", { skip: !SUPPORTED }, async () => {
  const f = fixture();
  const short = f.headSha.slice(0, 7);
  assert.notEqual(short, f.headSha);
  const ref = attemptRef();
  const outcome = await f.runtime.executorFor(ref)({
    slot: "typecheck",
    command: [process.execPath, "-e", "console.log(require('node:child_process').execSync('git rev-parse HEAD').toString().trim())"],
    repoRoot: f.repoRoot,
    workingSubpath: "",
    headSha: short,
  });

  assert.equal(outcome.kind, "exited");
  assert.equal(outcome.kind === "exited" && outcome.exitCode, 0);
  // The tree really is standing on the commit the capture named, resolved rather than guessed.
  assert.equal(outcome.kind === "exited" ? outcome.output.trim() : "", f.headSha);
  assert.equal(leaseRows.get(ref.attemptId)?.cleanupState, "returned");
});

/**
 * `git rev-parse` resolves REVISION EXPRESSIONS, not just object ids, and the resolve step
 * added above shells out to it. So a captured `headSha` of `HEAD~1`, or a branch name, would
 * answer with a real commit - just not the one the submission captured - and the check would
 * run against the wrong tree and report the answer as if it were about this submission. That is
 * the wrong-verdict-rather-than-a-crash failure this whole unit exists to avoid, arriving
 * through the door opened to fix a different one.
 */
test("a revision expression is refused rather than resolved", { skip: !SUPPORTED }, async () => {
  for (const expression of ["HEAD", "HEAD~1", "main", "@{yesterday}", "refs/heads/main"]) {
    const f = fixture();
    const ref = attemptRef();
    const outcome = await f.runtime.executorFor(ref)({
      slot: "typecheck",
      command: PASSES,
      repoRoot: f.repoRoot,
      workingSubpath: "",
      headSha: expression,
    });

    assert.equal(outcome.kind, "infrastructure", `${expression} was accepted as a commit`);
    assert.match(outcome.kind === "infrastructure" ? outcome.reason : "", /is not a commit id/);
    // And it is refused BEFORE the pool is asked: an unidentifiable commit costs no slot.
    assert.deepEqual(f.pool.calls, [], `${expression} reached the pool`);
    assert.equal(leaseRows.get(ref.attemptId), null);
  }
});

/**
 * The hazard a hex-prefix rule does NOT close, measured rather than assumed: git prefers a
 * REFNAME over an abbreviated object id of the same spelling. A branch literally named `04a6ee7`
 * wins over the commit whose id starts with `04a6ee7` - git warns on stderr and answers anyway.
 *
 * Reachable in practice, because branch names in this product are generated: a `harness/<slug>`
 * scheme that ever emitted a short hex slug would do it.
 *
 * The assertion is that resolution does not consult refs AT ALL, which is stronger than
 * catching the cases where a ref points somewhere obviously wrong - and it has to be, because a
 * ref pointing at a different commit that happens to share the prefix would defeat any
 * after-the-fact comparison. So this asserts the leased worktree stands on the OBJECT the
 * prefix names, while a ref of that exact spelling points somewhere else entirely.
 */
test("a ref cannot decide which commit an abbreviation pins", { skip: !SUPPORTED }, async () => {
  const f = fixture();
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", f.repoRoot, ...args], { stdio: "pipe" }).toString();
  // A second commit, so there are two to confuse. The branch is named after the SECOND commit's
  // prefix but points at the FIRST, which is what makes a wrong answer detectable.
  const first = f.headSha;
  writeFileSync(join(f.repoRoot, "second.txt"), "second\n");
  git("add", "-A");
  git("commit", "-qm", "second");
  const second = git("rev-parse", "HEAD").trim();
  const prefix = second.slice(0, 7);
  git("update-ref", `refs/heads/${prefix}`, first);
  // The premise, asserted rather than trusted: plain `rev-parse` really does hand back the
  // BRANCH's commit here. Everything below is about not going through that door.
  assert.equal(git("rev-parse", "--verify", "--quiet", `${prefix}^{commit}`).trim(), first);

  const ref = attemptRef();
  const outcome = await f.runtime.executorFor(ref)({
    slot: "typecheck",
    command: [process.execPath, "-e", "console.log(require('node:child_process').execSync('git rev-parse HEAD').toString().trim())"],
    repoRoot: f.repoRoot,
    workingSubpath: "",
    headSha: prefix,
  });

  assert.equal(outcome.kind, "exited");
  assert.equal(
    outcome.kind === "exited" ? outcome.output.trim() : "",
    second,
    "the check ran against the ref's commit instead of the object the abbreviation names",
  );
  assert.notEqual(outcome.kind === "exited" ? outcome.output.trim() : "", first);
});

/**
 * An abbreviation that names more than one commit is refused rather than guessed at.
 *
 * The fixture is deterministic rather than brute-forced: with the author and committer identity
 * and date pinned, `commit-tree` output is a pure function of its inputs, so these two messages
 * over the empty tree collide on `186c` on any machine. Searching for the pair took 672 commits
 * and 15 seconds once; reproducing it takes two calls.
 */
test("an ambiguous abbreviated commit is refused rather than guessed", { skip: !SUPPORTED }, async () => {
  const f = fixture();
  const fixedIdentity = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@e",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@e",
    GIT_AUTHOR_DATE: "100000000 +0000",
    GIT_COMMITTER_DATE: "100000000 +0000",
  };
  const git = (args: string[]): string =>
    execFileSync("git", ["-C", f.repoRoot, ...args], { stdio: "pipe", env: fixedIdentity }).toString().trim();
  // The empty tree, whose id is the same in every git repository there has ever been.
  const emptyTree = execFileSync("git", ["-C", f.repoRoot, "hash-object", "-t", "tree", "-w", "--stdin"], {
    input: "",
    stdio: ["pipe", "pipe", "pipe"],
  }).toString().trim();
  assert.equal(emptyTree, "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  const a = git(["commit-tree", emptyTree, "-m", "collide-166"]);
  const b = git(["commit-tree", emptyTree, "-m", "collide-291"]);
  assert.equal(a.slice(0, 4), "186c", "the pinned-identity collision fixture no longer reproduces");
  assert.equal(b.slice(0, 4), "186c", "the pinned-identity collision fixture no longer reproduces");
  assert.notEqual(a, b);

  const ref = attemptRef();
  const outcome = await f.runtime.executorFor(ref)({
    slot: "typecheck",
    command: PASSES,
    repoRoot: f.repoRoot,
    workingSubpath: "",
    headSha: "186c",
  });

  assert.equal(outcome.kind, "infrastructure", "an ambiguous abbreviation picked a commit anyway");
  assert.match(outcome.kind === "infrastructure" ? outcome.reason : "", /ambiguous/);
  assert.equal(leaseRows.get(ref.attemptId), null, "an unidentifiable commit must cost no pool slot");
});

/**
 * The mirror of the case above, and it comes out the OTHER way - which is why the resolve step
 * short-circuits a full id instead of round-tripping it through git.
 *
 * A ref can shadow an ABBREVIATED object id (proven above). It cannot shadow a full 40-character
 * one: git ignores such a ref by construction and says so in its own warning - *"Git normally
 * never creates a ref that ends with 40 hex characters because it will be ignored when you just
 * specify 40-hex."* Measured through the whole path rather than read: `rev-parse`, the
 * `reset --hard` inside the leased worktree, and `verifyPinnedBase` all answer with the object.
 *
 * This test exists because that asymmetry is the entire argument for treating the two lengths
 * differently, and an argument nothing executes is an argument that quietly stops being true.
 * If a future git ever let a 40-hex ref win, this fails - and `verifyPinnedBase`'s
 * `resolved !== baseSha` and `verifyHeadIs` would each still refuse the pin before any command
 * ran, so the failure would be a blocked run rather than a verdict about the wrong tree.
 */
test("a ref named like a full commit id cannot shadow it", { skip: !SUPPORTED }, async () => {
  const f = fixture();
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", f.repoRoot, ...args], { stdio: "pipe" }).toString();
  const first = f.headSha;
  writeFileSync(join(f.repoRoot, "second.txt"), "second\n");
  git("add", "-A");
  git("commit", "-qm", "second");
  const second = git("rev-parse", "HEAD").trim();
  // A ref named EXACTLY the second commit's full id, pointing at the first.
  git("update-ref", `refs/heads/${second}`, first);

  const ref = attemptRef();
  const outcome = await f.runtime.executorFor(ref)({
    slot: "typecheck",
    command: [process.execPath, "-e", "console.log(require('node:child_process').execSync('git rev-parse HEAD').toString().trim())"],
    repoRoot: f.repoRoot,
    workingSubpath: "",
    headSha: second,
  });

  assert.equal(outcome.kind, "exited");
  assert.equal(
    outcome.kind === "exited" ? outcome.output.trim() : "",
    second,
    "the leased worktree stood on the ref's commit instead of the captured one",
  );
  assert.notEqual(outcome.kind === "exited" ? outcome.output.trim() : "", first);
  assert.equal(leaseRows.get(ref.attemptId)?.cleanupState, "returned");
});

test("a commit this repository does not have is infrastructure, and costs no pool slot", async () => {
  const f = fixture();
  const { ref, result } = run(f, { headSha: "b".repeat(40) });
  const outcome = await result;

  assert.equal(outcome.kind, "infrastructure");
  assert.equal(leaseRows.get(ref.attemptId), null);
  assert.deepEqual(
    f.pool.calls.filter((c) => c.cmd === "get"),
    [],
    "the commit must be verified before a tree is taken, not after",
  );
});

// ---- cleanup precedes classification ---------------------------------------

/**
 * A supervisor stand-in, so the tri-state emptiness can be forced. Everything else in this
 * file uses the real one; these cases are about what the executor does with an answer it
 * cannot otherwise produce on demand.
 *
 * It still keeps the real one's ORDERING - identity persisted through Contract P before it
 * claims a supervisor exists - because the sentinel that leaves behind is load-bearing
 * downstream: a row that never released its gate is proof no branch code ran, and recovery
 * returns such a tree on ownership alone. A stub that skipped the `record` would report a
 * live group and a sentinel row in the same breath, and the case would pass for the wrong
 * reason.
 */
function fixedSupervisor(outcome: CheckSpawnOutcome): typeof import("../src/server/workflows/check-supervisor.ts").runSupervisedCheck {
  return async (request, deps) => {
    if (outcome.supervisor) {
      deps.registry.record(request.attemptId, outcome.supervisor.pid, outcome.supervisor.identity);
    }
    return outcome;
  };
}

test("test commands get twenty minutes while typecheck keeps ten", async () => {
  const { repoRoot, headSha } = gitRepo();
  const pool = fakePool(repoRoot, 1);
  const leases = new CheckLeaseManager(db, {
    cli: pool.cli,
    pin: pinLeasedWorktree,
    verifyBase: verifyPinnedBase,
    treehouseInstalled: TREEHOUSE_PRESENT,
  });
  const timeouts: number[] = [];
  const runtime = new CheckRuntime(leases, {
    leaseStore: leaseRows,
    platform: () => ({ supported: true }),
    supervise: async (request) => {
      timeouts.push(request.timeoutMs ?? -1);
      return {
        result: { kind: "exited", exitCode: 0, output: "ok\n", truncatedBytes: 0 },
        emptiness: "empty",
        supervisor: null,
      };
    },
  });

  for (const slot of ["test", "typecheck"] as const) {
    const outcome = await runtime.executorFor(attemptRef())({
      slot,
      command: PASSES,
      repoRoot,
      workingSubpath: "",
      headSha,
    });
    assert.equal(outcome.kind, "exited");
  }

  assert.deepEqual(timeouts, [20 * 60_000, 10 * 60_000]);
});

test("an infrastructure result is not returned until the lease is resolved", async () => {
  const { repoRoot, headSha } = gitRepo();
  const pool = fakePool(repoRoot, 2);
  const leases = new CheckLeaseManager(db, {
    cli: pool.cli,
    pin: pinLeasedWorktree,
    verifyBase: verifyPinnedBase,
    treehouseInstalled: TREEHOUSE_PRESENT,
  });
  const runtime = new CheckRuntime(leases, {
    leaseStore: leaseRows,
    supervise: fixedSupervisor({
      result: { kind: "infrastructure", reason: "the check command was killed by SIGKILL" },
      emptiness: "empty",
      supervisor: null,
    }),
  });
  const ref = attemptRef();
  const outcome = await runtime.executorFor(ref)({
    slot: "test",
    command: PASSES,
    repoRoot,
    workingSubpath: "",
    headSha,
  });

  // Read at the moment the result surfaces: the retry the engine is about to schedule must
  // not be able to take a second tree behind this one.
  assert.equal(outcome.kind, "infrastructure");
  assert.equal(leaseRows.get(ref.attemptId)?.cleanupState, "returned");
  assert.equal(leases.unresolvedLeaseForNode(ref.submissionId, ref.nodeId), false);
  assert.deepEqual(pool.trees.filter((t) => t.state === "leased"), []);
});

/**
 * The case where a PASSING command must still not produce a verdict.
 *
 * A cleanup failure is an infrastructure failure and outranks whatever the command said. The
 * shape that makes it matter is exactly this one: exit 0 with a process group left behind. Let
 * the exit code through and the node completes, the graph advances, the run finishes green -
 * and a pooled worktree is held with nothing anywhere saying so, because the retry gate that
 * would have said so is only ever reached through the infrastructure path.
 */
test("a group that cannot be proven empty withholds the verdict and keeps its lease", async () => {
  const { repoRoot, headSha } = gitRepo();
  const pool = fakePool(repoRoot, 2);
  const leases = new CheckLeaseManager(db, {
    cli: pool.cli,
    pin: pinLeasedWorktree,
    verifyBase: verifyPinnedBase,
    treehouseInstalled: TREEHOUSE_PRESENT,
  });
  const runtime = new CheckRuntime(leases, {
    leaseStore: leaseRows,
    supervise: fixedSupervisor({
      // The command answered, and answered WELL; its process group did not go away. Two
      // different questions, and only the second may authorise handing the tree back.
      result: { kind: "exited", exitCode: 0, output: "ok\n", truncatedBytes: 0 },
      emptiness: "not-empty",
      supervisor: { pid: 424242, identity: "made-up" },
    }),
  });
  const ref = attemptRef();
  const outcome = await runtime.executorFor(ref)({
    slot: "test",
    command: PASSES,
    repoRoot,
    workingSubpath: "",
    headSha,
  });

  // Infrastructure, NOT a pass. A gate whose worktree is unaccounted for has not been shown to
  // have run against the commit it claims.
  assert.equal(outcome.kind, "infrastructure");
  const reason = outcome.kind === "infrastructure" ? outcome.reason : "";
  assert.match(reason, /could not be proven empty/);
  // The command's own outcome is carried rather than dropped: "passed then cleanup broke" and
  // "failed then cleanup broke" need different things done about them.
  assert.match(reason, /exited 0/);
  // The tree stays ours. No return was issued and the row is still live.
  assert.deepEqual(pool.calls.filter((c) => c.cmd === "return"), []);
  assert.equal(leaseRows.get(ref.attemptId)?.cleanupState, "held");
  assert.equal(leases.unresolvedLeaseForNode(ref.submissionId, ref.nodeId), true);
  // And the claim was handed off, so reclamation stops treating it as a check still running.
  // Proven by the reclamation pass now acting on it: with the group unprovable it keeps the
  // lease, and with it provably gone it hands the tree back.
  await leases.reclaimLeaked(async () => "unknown");
  assert.equal(leaseRows.get(ref.attemptId)?.cleanupState, "held");
  await leases.reclaimLeaked(async () => "empty");
  assert.equal(leaseRows.get(ref.attemptId)?.cleanupState, "returned");
  assert.deepEqual(pool.trees.filter((t) => t.state === "leased"), []);
});

/**
 * The other cleanup failure, and the one whose danger is easiest to miss: the return itself
 * failed, so the tree is still ours and still `returning`. The command may have run perfectly.
 */
test("a worktree that could not be handed back withholds the verdict too", async () => {
  const { repoRoot, headSha } = gitRepo();
  const pool = fakePool(repoRoot, 2);
  pool.failReturn.value = true;
  // A clock this test can move, because a failed return backs off before it is retried and the
  // point below is that the retry eventually lands - not that it lands immediately.
  const clock = { now: Date.now() };
  const leases = new CheckLeaseManager(db, {
    cli: pool.cli,
    pin: pinLeasedWorktree,
    verifyBase: verifyPinnedBase,
    treehouseInstalled: TREEHOUSE_PRESENT,
    now: () => clock.now,
  });
  const runtime = new CheckRuntime(leases, {
    leaseStore: leaseRows,
    supervise: fixedSupervisor({
      result: { kind: "exited", exitCode: 0, output: "ok\n", truncatedBytes: 0 },
      emptiness: "empty",
      supervisor: { pid: 424244, identity: "made-up" },
    }),
  });
  const ref = attemptRef();
  const outcome = await runtime.executorFor(ref)({
    slot: "test",
    command: PASSES,
    repoRoot,
    workingSubpath: "",
    headSha,
  });

  assert.equal(outcome.kind, "infrastructure");
  assert.match(outcome.kind === "infrastructure" ? outcome.reason : "", /could not be handed back/);
  // `returning` means AUTHORISED and failed: the row and the pin are retained and reclamation
  // retries, and no second lease is possible for this attempt in the meantime.
  assert.equal(leaseRows.get(ref.attemptId)?.cleanupState, "returning");
  assert.equal(leases.unresolvedLeaseForNode(ref.submissionId, ref.nodeId), true);

  // Still in backoff: a failed return is retried on a schedule, not on the next tick.
  pool.failReturn.value = false;
  await leases.reclaimLeaked(async () => "empty");
  assert.equal(leaseRows.get(ref.attemptId)?.cleanupState, "returning");

  clock.now += 120_000;
  await leases.reclaimLeaked(async () => "empty");
  assert.equal(leaseRows.get(ref.attemptId)?.cleanupState, "returned");
  assert.deepEqual(pool.trees.filter((t) => t.state === "leased"), []);
});

// ---- startup recovery is wired ---------------------------------------------

test("startup recovery returns a lease whose group is provably gone", { skip: !SUPPORTED }, async () => {
  const f = fixture();
  const ref = attemptRef();
  const leasePath = await f.leases.acquireForAttempt({ ...ref, repoRoot: f.repoRoot, headSha: f.headSha });

  // A NON-sentinel row - a supervisor really was recorded - whose process is long gone. The
  // refusing default would keep this forever, so a return happening at all is what proves the
  // injection exists.
  const dead = spawn(process.execPath, ["-e", ""], { detached: true, stdio: "ignore" });
  const deadPid = dead.pid!;
  const identity = processStartIdentity(deadPid) ?? "gone";
  await new Promise<void>((resolve) => dead.once("exit", () => resolve()));
  dead.unref();
  f.leases.processes.record(ref.attemptId, deadPid, identity);
  assert.notEqual(leaseRows.get(ref.attemptId)?.supervisorPid, 0);

  // A fresh manager over the same table, which is what a restart is.
  const restarted = new CheckLeaseManager(db, {
    cli: f.pool.cli,
    pin: pinLeasedWorktree,
    verifyBase: verifyPinnedBase,
  });
  const restartedRuntime = new CheckRuntime(restarted, { leaseStore: leaseRows, teardown: TEARDOWN });
  await restarted.reconcileOnStartup(restartedRuntime.groupRecovery);

  assert.equal(leaseRows.get(ref.attemptId)?.cleanupState, "returned");
  assert.ok(
    f.pool.calls.some((c) => c.cmd === "return" && realpathSync(c.path!) === leasePath),
    "the reconciled tree was never handed back",
  );
});

test("startup recovery keeps a lease whose group it may not signal", { skip: !SUPPORTED }, async () => {
  const f = fixture();
  const ref = attemptRef();
  await f.leases.acquireForAttempt({ ...ref, repoRoot: f.repoRoot, headSha: f.headSha });

  // A live process group recorded under a WRONG identity: exactly the recycled-pid shape the
  // rule exists for. It may not be signalled, it still answers, so the answer is "unknown" -
  // and unknown keeps the tree rather than hard-resetting something that may be writing in it.
  const alive = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    detached: true,
    stdio: "ignore",
  });
  const alivePid = alive.pid!;
  alive.unref();
  f.leases.processes.record(ref.attemptId, alivePid, "an-identity-this-process-does-not-have");
  const before = f.pool.calls.filter((c) => c.cmd === "return").length;

  const restarted = new CheckLeaseManager(db, {
    cli: f.pool.cli,
    pin: pinLeasedWorktree,
    verifyBase: verifyPinnedBase,
  });
  const restartedRuntime = new CheckRuntime(restarted, { leaseStore: leaseRows, teardown: TEARDOWN });
  await restarted.reconcileOnStartup(restartedRuntime.groupRecovery);

  assert.equal(leaseRows.get(ref.attemptId)?.cleanupState, "held", "an unprovable group lost its lease");
  assert.equal(f.pool.calls.filter((c) => c.cmd === "return").length, before, "a return was issued anyway");
  // And nothing was signalled: the process a mismatched identity protects is still there.
  assert.doesNotThrow(() => process.kill(alivePid, 0), "a process we could not identify was signalled");

  process.kill(-alivePid, "SIGKILL");
  // Cleaned up by hand, because the point of the case is that the product refused to.
  await f.leases.releaseForAttempt(ref.attemptId);
});

// ---- the retry gate, composed with the engine ------------------------------

const checkGraph: PublishedWorkflowGraph = {
  nodes: [
    { id: "session", kind: "session", position: { x: 0, y: 0 } },
    { id: "gate", kind: "check", slot: "test", position: { x: 200, y: 0 } },
    { id: "end", kind: "end", outcome: "Complete", position: { x: 400, y: 0 } },
  ],
  edges: [
    { id: "s-gate", source: "session", sourcePort: "submitted", target: "gate", targetPort: "activate" },
    { id: "gate-pass", source: "gate", sourcePort: "pass", target: "end", targetPort: "terminal" },
    { id: "gate-fail", source: "gate", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
  ],
};

/**
 * The captured commit is the REAL one, because the engine reads the check's `headSha` out of
 * this snapshot and the lease manager verifies it against the repository before it leases. A
 * placeholder here would refuse at that check, and the run would block for a reason that has
 * nothing to do with what the case is about.
 */
const contextAt = (headSha: string): WorkflowContextSnapshot => ({
  primaryGoal: { rawPrompt: "Ship it", refined: null, sourceNoteKey: "note" },
  humanDecisions: [],
  constraints: [],
  acceptanceCriteria: [],
  priorPersonaFeedback: [],
  session: { agent: "claude", name: "work", cwd: "/repo", branch: "feature" },
  evidence: {
    headSha,
    diffFingerprint: "diff",
    diff: "patch",
    diffTruncated: false,
    workingTreeDirty: false,
    workingTreeStatus: [],
    workingTreeStatusTruncated: false,
    transcript: [],
    transcriptAnchor: null,
    transcriptTruncated: false,
    standards: [],
    standardsTruncated: false,
  },
  compaction: { status: "fallback", runner: null, model: null, error: null },
});

function seedCheckRun(
  id: string,
  repoRoot: string,
  headSha: string,
): InstanceType<typeof WorkflowStore> {
  const context = contextAt(headSha);
  const defaults = JSON.stringify({ triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 });
  db.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json, completion_policy_json,
       binding_defaults_json, draft_revision, current_version_id, archived_at, created_at, updated_at
     ) VALUES (?, ?, ?, '', '{"nodes":[],"edges":[]}', '{"kind":"none"}', ?, 1, ?, NULL, 1, 1)`,
  ).run(`workflow-${id}`, `Review ${id}`, `review-${id}`, defaults, `version-${id}`);
  db.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, binding_defaults_json, published_at
     ) VALUES (?, ?, 1, 1, ?, '{"kind":"none"}', ?, 1)`,
  ).run(`version-${id}`, `workflow-${id}`, JSON.stringify(checkGraph), defaults);
  const store = new WorkflowStore();
  const binding = store.insertBinding({
    id: `binding-${id}`,
    workflowVersionId: `version-${id}`,
    noteKey: `note-${id}`,
    sessionId: `session-${id}`,
    sessionAgent: "claude",
    sessionName: id,
    sessionCwd: repoRoot,
    sessionRepoRoot: repoRoot,
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 5,
    now: 1,
  });
  store.createInitialSubmission(
    { id: `run-${id}`, binding, triggerSource: "manual", triggerKey: `manual:${id}`, now: 2 },
    { id: `submission-${id}`, triggerSource: "manual", triggerKey: `manual:${id}`, context: {}, evidence: {}, now: 2 },
  );
  store.updateSubmissionCapture(`submission-${id}`, {
    context: workflowJson(context),
    evidence: workflowJson(context.evidence),
    fingerprint: `fingerprint-${id}`,
    status: "running",
  }, 3);
  return store;
}

async function waitFor(check: () => boolean, message: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * The defect this gate exists for is invisible without this test, because the happy path and
 * the broken path both end with "the check eventually finished".
 *
 * A retry is a FRESH attempt id, so it carries a fresh holder token and the pool has other
 * slots to give it - nothing about leasing would stop a second build starting while the first
 * attempt's group may still be writing into the first tree.
 *
 * The command here exits ZERO, deliberately. That is the shape the gate has to survive: if a
 * clean exit could carry a verdict past a stranded lease, this node would complete, the run
 * would go green, and the gate below would never be consulted at all - it is only ever reached
 * through the infrastructure path.
 */
test("an unresolved lease blocks the retry instead of taking a second tree", async () => {
  const { repoRoot, headSha } = gitRepo();
  const pool = fakePool(repoRoot, 3);
  const leases = new CheckLeaseManager(db, {
    cli: pool.cli,
    pin: pinLeasedWorktree,
    verifyBase: verifyPinnedBase,
    treehouseInstalled: TREEHOUSE_PRESENT,
  });
  const runtime = new CheckRuntime(leases, {
    leaseStore: leaseRows,
    supervise: fixedSupervisor({
      result: { kind: "exited", exitCode: 0, output: "ok\n", truncatedBytes: 0 },
      emptiness: "unknown",
      supervisor: { pid: 424243, identity: "made-up" },
    }),
  });
  const store = seedCheckRun("gate-block", repoRoot, headSha);
  const engine = new WorkflowEngine(store, () => {}, {
    retryBaseMs: 1,
    workflowPolicy: () => ({
      liveEnabled: false,
      repoAllowlist: [repoRoot],
      defaultWorkflowId: null,
      retention: { rawEvidenceDays: 30, completedRunDays: 180, maxCompletedRuns: 1_000 },
      checksEnabled: true,
    }),
    workflowCommand: (slot) => ({
      ...emptyWorkflowCommandView(slot),
      overrides: slot === "test" ? [{ repoRoot, command: PASSES }] : [],
    }),
    checkDeps: (attempt) => ({ execute: runtime.executorFor(attempt) }),
    unresolvedCheckLease: (submissionId, nodeId) => leases.unresolvedLeaseForNode(submissionId, nodeId),
  });
  engine.start();
  engine.activateSubmission("submission-gate-block");
  await waitFor(
    () => store.getRun("run-gate-block")?.status === "blocked",
    "the run never blocked on the unresolved lease",
  );
  await engine.stop();

  assert.equal(store.getRun("run-gate-block")?.currentPhase, "check_cleanup_unresolved");
  // The clean exit did NOT become a passing gate. Had it, the run would have completed rather
  // than blocked, and the stranded worktree would have gone unmentioned.
  assert.notEqual(store.getRun("run-gate-block")?.status, "completed");
  // No second attempt, and therefore no second tree.
  const attempts = store.listAttempts("submission-gate-block").filter((a) => a.nodeId === "gate");
  assert.equal(attempts.length, 1, "a retry was created behind an unresolved lease");
  assert.equal(attempts[0]?.state, "error", "a cleanup failure must not finish as a verdict");
  assert.equal(pool.calls.filter((c) => c.cmd === "get").length, 1, "a second pooled worktree was taken");
  assert.deepEqual(
    store.listEvents("run-gate-block").filter((e) => e.kind === "persona_retry_scheduled"),
    [],
    "the run scheduled a retry it had just refused",
  );
  assert.equal(
    store.listEvents("run-gate-block").filter((e) => e.kind === "check_cleanup_unresolved").length,
    1,
    "the block must be on the event log, not only in the phase",
  );

  // It is self-clearing, not terminal: reclamation proves the group gone and the tree goes home.
  await leases.reclaimLeaked(async () => "empty");
  assert.equal(leases.unresolvedLeaseForNode("submission-gate-block", "gate"), false);
  assert.deepEqual(pool.trees.filter((t) => t.state === "leased"), []);

  // And "self-clearing" has to mean the RUN clears, not just the lease. This assertion is the
  // one this test was missing: the tree went home, the fault was gone, and the run stayed
  // blocked forever because nothing continued it.
  engine.resumeClearedCheckCleanup();
  const resumed = store.getRun("run-gate-block");
  assert.equal(resumed?.status, "running", "the run stayed blocked after its cleanup resolved");
  assert.equal(resumed?.currentPhase, "persona_review");
  // The submission has to come back with it: a running run over a failed submission is
  // invisible to `listRunnableAttempts`, so the run would look alive and never execute.
  assert.equal(store.getSubmission("submission-gate-block")?.status, "running");
  // The retry the block withheld now exists - the SECOND attempt of the same node, carrying
  // the first one's fingerprint rather than a fresh review of different evidence.
  const afterResume = store.listAttempts("submission-gate-block").filter((a) => a.nodeId === "gate");
  assert.deepEqual(afterResume.map((a) => a.attempt), [1, 2]);
  assert.equal(afterResume[1]?.state, "retry_wait");
  assert.equal(afterResume[1]?.inputFingerprint, afterResume[0]?.inputFingerprint);
  assert.equal(
    store.listEvents("run-gate-block").filter((e) => e.kind === "check_cleanup_resolved").length,
    1,
    "the resume must be on the event log, not only in the phase",
  );

  // The sweep runs on a timer, so it will see this run again the moment before the retry
  // executes. A second pass must not grant a third attempt or a second resume event.
  engine.resumeClearedCheckCleanup();
  assert.deepEqual(
    store.listAttempts("submission-gate-block").filter((a) => a.nodeId === "gate").map((a) => a.attempt),
    [1, 2],
    "a second sweep granted an extra attempt",
  );
  assert.equal(
    store.listEvents("run-gate-block").filter((e) => e.kind === "check_cleanup_resolved").length,
    1,
  );
  store.cancelRun("run-gate-block", "test_cleanup", 99);
});
