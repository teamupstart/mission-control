import assert from "node:assert/strict";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { WorktreeClaimSchema, type WorktreeClaim } from "../src/shared/protocol.ts";
import type {
  PersonaExecutionView,
  PublishedWorkflowGraph,
  WorkflowCheckSlot,
  WorkflowCommandView,
  WorkflowContextSnapshot,
} from "../src/shared/workflow.ts";
import { emptyWorkflowCommandView } from "../src/shared/workflow.ts";
import type { LlmRunner, LlmRunnerId } from "../src/shared/llm.ts";
import { openDb } from "../src/server/db.ts";
import { CHECK_WORKTREES_DIR } from "../src/server/config.ts";
import { verifyPinnedBase } from "../src/server/dispatcher.ts";
import { Registry } from "../src/server/registry.ts";
import {
  CheckDependencyClaimError,
  CheckLeaseManager,
  CheckLeaseStore,
  type CheckClaimFailure,
} from "../src/server/workflows/check-lease.ts";
import {
  CheckRuntime,
  claimInputsChangedSinceMergeBase,
  type CheckAttemptRef,
  type ClaimInputsChanged,
} from "../src/server/workflows/check-runtime.ts";
import type { CheckSpawnOutcome } from "../src/server/workflows/check-supervisor.ts";
import {
  createCheckScheduler,
  runCheck,
  type CheckExecutionRequest,
  type CheckSlot,
} from "../src/server/workflows/checks.ts";
import { WorkflowEngine } from "../src/server/workflows/engine.ts";
import { WorkflowManager } from "../src/server/workflows/manager.ts";
import { WorkflowStore, workflowJson } from "../src/server/workflows/store.ts";
import {
  buildClaimEnvironment,
  changedFingerprintInputs,
  type ClaimStepRequest,
  type ClaimStepResult,
} from "../src/server/worktrees/claim.ts";
import { WorktreeManager, type WorktreeManagerDeps } from "../src/server/worktrees/manager.ts";
import type { WorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";
import { FIXTURE_RUN_INTENT } from "./helpers/workflow-run-intent.ts";

// Check attempts and the pool's dependency claim: a check lease runs the claim, the cold
// fallback runs it against its disposable tree, a failed claim never runs the Command, who owns
// the failure is decided against the merge base, the attempt gives up its check slot while it
// claims, and a run cancel stops the claim. Claim steps are fakes here: `worktree-claims.test.ts`
// already proves the real step runner, and these cases are about what a check does with it.

const db = openDb();
const leaseRows = new CheckLeaseStore(db);

afterEach(() => {
  db.exec(
    "DELETE FROM worktree_slots; DELETE FROM worktree_pools; DELETE FROM workflow_check_leases;",
  );
});

function claimOf(input: unknown): WorktreeClaim {
  return WorktreeClaimSchema.parse(input);
}

function emptyOccupancy(paths: readonly string[]): Promise<Map<string, WorktreeOccupancy>> {
  return Promise.resolve(new Map(paths.map((path) => [path, { status: "known", occupants: [] }])));
}

/** A repository whose `deps/` is ignored, with a lockfile the claim fingerprints. */
function repository(prefix: string): { origin: string; clone: string; sha: string } {
  const { origin, clone } = mkOriginAndClone(prefix);
  writeFileSync(join(origin, ".gitignore"), "deps/\n");
  writeFileSync(join(origin, "lock.txt"), "v1\n");
  gitIn(origin, "add", "-A");
  gitIn(origin, "commit", "-qm", "lockfile");
  gitIn(clone, "fetch", "-q", "origin");
  gitIn(clone, "reset", "-q", "--hard", "origin/main");
  return { origin, clone, sha: gitIn(clone, "rev-parse", "HEAD") };
}

/** A fake step runner: records where each step ran and answers with `answer`. */
function steps(answer: (request: ClaimStepRequest) => Promise<ClaimStepResult> | ClaimStepResult) {
  const ran: ClaimStepRequest[] = [];
  return {
    ran,
    runClaimStep: async (request: ClaimStepRequest) => {
      ran.push(request);
      return await answer(request);
    },
  };
}

const ok: ClaimStepResult = { outcome: "exited", code: 0, signal: null, tail: "", truncatedBytes: 0 };
const registryRefused: ClaimStepResult = {
  outcome: "exited",
  code: 1,
  signal: null,
  tail: "YN0035: 401 Unauthorized from the registry\n",
  truncatedBytes: 0,
};

/** A step that runs until it is stopped, and reports the stop. */
function untilStopped(started: () => void) {
  return (request: ClaimStepRequest) =>
    new Promise<ClaimStepResult>((resolve) => {
      started();
      const stop = () => resolve({ outcome: "stopped", tail: "stopped mid-install\n", truncatedBytes: 0 });
      if (request.signal.aborted) stop();
      else request.signal.addEventListener("abort", stop, { once: true });
    });
}

function worktrees(
  claim: WorktreeClaim | null,
  runClaimStep: WorktreeManagerDeps["runClaimStep"],
  enabled = true,
): WorktreeManager {
  return new WorktreeManager(db, {
    occupancy: emptyOccupancy,
    resolvePolicy: () => ({ enabled, maxSlots: 1, setupArgv: null, claim }),
    claimEnvironment: async (names) =>
      buildClaimEnvironment({ names, daemonEnv: process.env, daemonToken: "daemon-token", loginShell: {} }),
    runClaimStep,
  });
}

function checkLeases(manager: WorktreeManager): CheckLeaseManager {
  return new CheckLeaseManager(db, { manager, verifyBase: verifyPinnedBase });
}

let seq = 0;
function attempt(): { attemptId: string; submissionId: string; nodeId: string } {
  seq += 1;
  return { attemptId: `claim-check-${seq}`, submissionId: `claim-sub-${seq}`, nodeId: "gate" };
}

const LOCK_CLAIM = claimOf({ steps: [{ argv: ["yarn", "install"] }], fingerprintPaths: ["lock.txt"] });

// ---- check leases run the claim ----------------------------------------------------------

test("a check lease runs the pool's claim in its slot, and a matching fingerprint skips it", async () => {
  const { clone, sha } = repository("mission-check-claim-runs-");
  const fake = steps(() => ok);
  const leases = checkLeases(worktrees(LOCK_CLAIM, fake.runClaimStep));
  let starts = 0;

  const first = attempt();
  const path = await leases.acquireForAttempt({
    ...first,
    repoRoot: clone,
    headSha: sha,
    onClaimStart: () => { starts += 1; },
  });
  assert.equal(fake.ran.length, 1, "the check lease did not run the claim");
  assert.equal(fake.ran[0]!.cwd, path, "the claim ran somewhere other than the leased slot");
  assert.equal(starts, 1, "the attempt was not told its claim was starting");
  assert.equal(leaseRows.get(first.attemptId)?.provider, "mission");
  assert.deepEqual(await leases.releaseForAttempt(first.attemptId), { outcome: "returned" });

  const second = attempt();
  assert.equal(
    await leases.acquireForAttempt({
      ...second,
      repoRoot: clone,
      headSha: sha,
      onClaimStart: () => { starts += 1; },
    }),
    path,
  );
  assert.equal(fake.ran.length, 1, "a matching fingerprint must skip the steps");
  assert.equal(starts, 1, "a skipped claim must not release the attempt's check slot");
  assert.deepEqual(await leases.releaseForAttempt(second.attemptId), { outcome: "returned" });
});

test("a failed claim in a check lease hands the slot back and never yields a path", async () => {
  const { clone, sha } = repository("mission-check-claim-fails-");
  const fake = steps(() => registryRefused);
  const wm = worktrees(LOCK_CLAIM, fake.runClaimStep);
  const leases = checkLeases(wm);
  const ref = attempt();

  const error = await leases.acquireForAttempt({ ...ref, repoRoot: clone, headSha: sha }).then(
    () => assert.fail("a failed claim returned a path to run the Command in"),
    (err: unknown) => err,
  );
  assert.ok(error instanceof CheckDependencyClaimError, String(error));
  assert.equal(error.failure.warning.tail, registryRefused.tail);
  assert.match(error.failure.warning.reason, /exited with code 1/);
  assert.deepEqual(error.failure.fingerprintPaths, ["lock.txt"]);
  // Cleanup precedes classification: the row is gone and the slot is back in the pool, with
  // its fingerprint cleared so the next lease runs the claim again.
  assert.equal(leaseRows.get(ref.attemptId), null);
  assert.deepEqual(leases.pinnedPaths(), []);
  const [slot] = wm.store.slots();
  assert.equal(slot?.state, "available");
  assert.equal(slot?.depsState, "failed");
  assert.equal(slot?.depsFingerprint, null);
});

test("the cold check fallback runs the claim against its disposable tree", async () => {
  const { clone, sha } = repository("mission-check-claim-cold-");
  const fake = steps(() => ok);
  const leases = checkLeases(worktrees(LOCK_CLAIM, fake.runClaimStep, false));
  const ref = attempt();
  let starts = 0;

  const path = await leases.acquireForAttempt({
    ...ref,
    repoRoot: clone,
    headSha: sha,
    onClaimStart: () => { starts += 1; },
  });
  assert.equal(leaseRows.get(ref.attemptId)?.provider, "git");
  assert.ok(path.startsWith(realpathSync(CHECK_WORKTREES_DIR)), path);
  assert.equal(fake.ran.length, 1, "the cold fallback did not run the claim");
  assert.equal(fake.ran[0]!.cwd, path);
  assert.equal(starts, 1);
  assert.deepEqual(await leases.releaseForAttempt(ref.attemptId), { outcome: "returned" });
  assert.equal(existsSync(path), false);
});

test("a failed claim in the cold fallback removes its tree before reporting the failure", async () => {
  const { clone, sha } = repository("mission-check-claim-cold-fails-");
  const fake = steps(() => registryRefused);
  const leases = checkLeases(worktrees(LOCK_CLAIM, fake.runClaimStep, false));
  const ref = attempt();

  await assert.rejects(
    () => leases.acquireForAttempt({ ...ref, repoRoot: clone, headSha: sha }),
    (err: unknown) => err instanceof CheckDependencyClaimError && err.failure.warning.tail === registryRefused.tail,
  );
  assert.equal(fake.ran.length, 1);
  assert.equal(existsSync(fake.ran[0]!.cwd), false, "the disposable tree outlived its failed claim");
  assert.equal(leaseRows.get(ref.attemptId), null);
});

test("a claim that rewrites a tracked file in the cold fallback is never handed to the Command", async () => {
  const { clone, sha } = repository("mission-check-claim-cold-dirty-");
  const fake = steps((request) => {
    writeFileSync(join(request.cwd, "lock.txt"), "rewritten\n");
    return ok;
  });
  const leases = checkLeases(worktrees(LOCK_CLAIM, fake.runClaimStep, false));
  const ref = attempt();
  await assert.rejects(
    () => leases.acquireForAttempt({ ...ref, repoRoot: clone, headSha: sha }),
    (err: unknown) => !(err instanceof CheckDependencyClaimError) && /cleanliness/.test(String(err)),
  );
  assert.equal(existsSync(fake.ran[0]!.cwd), false);
  assert.equal(leaseRows.get(ref.attemptId), null);
});

test("a failed claim that also dirties the cold fallback's tree is still a dependency failure", async () => {
  const { clone, sha } = repository("mission-check-claim-cold-dirty-fails-");
  const fake = steps((request) => {
    writeFileSync(join(request.cwd, "lock.txt"), "half rewritten\n");
    return registryRefused;
  });
  const leases = checkLeases(worktrees(LOCK_CLAIM, fake.runClaimStep, false));
  const ref = attempt();
  await assert.rejects(
    () => leases.acquireForAttempt({ ...ref, repoRoot: clone, headSha: sha }),
    (err: unknown) => err instanceof CheckDependencyClaimError && err.failure.warning.tail === registryRefused.tail,
  );
  assert.equal(existsSync(fake.ran[0]!.cwd), false, "the dirty disposable tree outlived its failed claim");
  assert.equal(leaseRows.get(ref.attemptId), null);
});

test("the cold fallback fails closed when the repository's claim policy cannot be read", async () => {
  const { clone, sha } = repository("mission-check-claim-cold-policy-");
  const fake = steps(() => ok);
  const wm = new WorktreeManager(db, {
    occupancy: emptyOccupancy,
    // Native acquisition reads it first and refuses; the fallback's own lookup then fails too.
    resolvePolicy: () => {
      throw new Error("worktrees config is unreadable");
    },
    runClaimStep: fake.runClaimStep,
  });
  const leases = checkLeases(wm);
  const ref = attempt();
  await assert.rejects(
    () => leases.acquireForAttempt({ ...ref, repoRoot: clone, headSha: sha }),
    (err: unknown) => !(err instanceof CheckDependencyClaimError)
      && /dependency claim could not be looked up: Error: worktrees config is unreadable/.test(String(err)),
  );
  assert.deepEqual(fake.ran, [], "a claim ran without a policy");
  assert.equal(existsSync(join(realpathSync(CHECK_WORKTREES_DIR), ref.attemptId)), false, "the unproven tree was kept");
  assert.equal(leaseRows.get(ref.attemptId), null);
});

test("a repository the pool cannot identify still runs its claim in the cold fallback", async () => {
  // Relocated metadata: the clone's `.git` is a file naming a separate directory. The pool
  // refuses it, and the fallback finds the repository's claim through Git's common directory.
  const { origin } = repository("mission-check-claim-cold-relocated-");
  const root = realpathSync(join(origin, ".."));
  const metadata = join(root, "relocated-metadata");
  const relocated = join(root, "relocated-clone");
  gitIn(root, "clone", "-q", "--separate-git-dir", metadata, origin, relocated);
  const sha = gitIn(relocated, "rev-parse", "HEAD");
  const fake = steps(() => ok);
  const asked: string[] = [];
  const wm = new WorktreeManager(db, {
    occupancy: emptyOccupancy,
    resolvePolicy: (commonDirectory) => {
      asked.push(commonDirectory);
      return { enabled: true, maxSlots: 1, setupArgv: null, claim: LOCK_CLAIM };
    },
    claimEnvironment: async (names) =>
      buildClaimEnvironment({ names, daemonEnv: process.env, daemonToken: "daemon-token", loginShell: {} }),
    runClaimStep: fake.runClaimStep,
  });
  const leases = checkLeases(wm);
  const ref = attempt();
  const path = await leases.acquireForAttempt({ ...ref, repoRoot: relocated, headSha: sha });
  assert.equal(leaseRows.get(ref.attemptId)?.provider, "git");
  assert.deepEqual(asked, [realpathSync(metadata)]);
  assert.equal(fake.ran.length, 1, "the relocated repository's claim did not run");
  assert.equal(fake.ran[0]!.cwd, path);
  assert.deepEqual(await leases.releaseForAttempt(ref.attemptId), { outcome: "returned" });
});

for (const pooled of [true, false]) {
  test(`an attempt that asks for no claim runs none (${pooled ? "pool slot" : "cold fallback"})`, async () => {
    const { clone, sha } = repository(`mission-check-claim-none-${pooled}-`);
    const fake = steps(() => ok);
    const leases = checkLeases(worktrees(LOCK_CLAIM, fake.runClaimStep, pooled));
    const ref = attempt();
    let starts = 0;
    await leases.acquireForAttempt({
      ...ref,
      repoRoot: clone,
      headSha: sha,
      runClaim: false,
      onClaimStart: () => { starts += 1; },
    });
    assert.equal(leaseRows.get(ref.attemptId)?.provider, pooled ? "mission" : "git");
    assert.deepEqual(fake.ran, [], "a claim ran for an attempt that asked for none");
    assert.equal(starts, 0, "an attempt that runs no claim must keep its check slot");
    assert.deepEqual(await leases.releaseForAttempt(ref.attemptId), { outcome: "returned" });
  });
}

// ---- run cancel stops the claim ------------------------------------------------------------

for (const pooled of [true, false]) {
  const where = pooled ? "pool slot" : "cold fallback";

  test(`aborting an attempt's signal stops its running claim (${where})`, async () => {
    const { clone, sha } = repository(`mission-check-claim-stop-${pooled}-`);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const fake = steps(untilStopped(() => markStarted()));
    const leases = checkLeases(worktrees(LOCK_CLAIM, fake.runClaimStep, pooled));
    const ref = attempt();
    const cancel = new AbortController();
    const pending = leases.acquireForAttempt({ ...ref, repoRoot: clone, headSha: sha, signal: cancel.signal });
    await started;
    cancel.abort("cancelled");
    await assert.rejects(
      () => pending,
      (err: unknown) => err instanceof CheckDependencyClaimError && /stopped/.test(err.failure.warning.reason),
    );
    assert.equal(leaseRows.get(ref.attemptId), null);
  });

  test(`a cancel that lands before the claim registers still stops it (${where})`, async () => {
    // The window the cancel used to miss: the attempt is running, but its claim is not in the
    // registry yet because the lease is still resolving its commit. The abort lands there.
    const { clone, sha } = repository(`mission-check-claim-early-stop-${pooled}-`);
    const fake = steps(() => ok);
    const cancel = new AbortController();
    const leases = new CheckLeaseManager(db, {
      manager: worktrees(LOCK_CLAIM, fake.runClaimStep, pooled),
      verifyBase: async (repoRoot, headSha) => {
        const resolved = await verifyPinnedBase(repoRoot, headSha);
        cancel.abort("cancelled");
        return resolved;
      },
    });
    const ref = attempt();
    await assert.rejects(
      () => leases.acquireForAttempt({ ...ref, repoRoot: clone, headSha: sha, signal: cancel.signal }),
      (err: unknown) => err instanceof CheckDependencyClaimError
        && /stopped before it started/.test(err.failure.warning.reason),
    );
    assert.deepEqual(fake.ran, [], "a claim step ran for an attempt already cancelled");
    assert.equal(leaseRows.get(ref.attemptId), null);
  });
}

test("an attempt cancelled before it reaches its lease takes no worktree", async () => {
  const { clone, sha } = repository("mission-check-claim-cancelled-first-");
  const fake = steps(() => ok);
  const wm = worktrees(LOCK_CLAIM, fake.runClaimStep);
  const leases = checkLeases(wm);
  const ref = attempt();
  const cancel = new AbortController();
  cancel.abort("cancelled");
  await assert.rejects(
    () => leases.acquireForAttempt({ ...ref, repoRoot: clone, headSha: sha, signal: cancel.signal }),
    /was cancelled before it took a worktree/,
  );
  assert.deepEqual(fake.ran, []);
  assert.deepEqual(wm.store.slots(), [], "a slot was reserved for a cancelled attempt");
  assert.equal(leaseRows.get(ref.attemptId), null);
});

// ---- who owns a failed claim ---------------------------------------------------------------

test("fingerprint inputs are compared blob by blob, including added and removed paths", () => {
  const head = [
    { path: "yarn.lock", object: "b" },
    { path: "apps/web/package.json", object: "x" },
    { path: "src/index.ts", object: "changed" },
  ];
  const base = [
    { path: "yarn.lock", object: "a" },
    { path: "packages/ui/package.json", object: "y" },
    { path: "src/index.ts", object: "original" },
  ];
  const globs = ["yarn.lock", "apps/*/package.json", "packages/*/package.json"];
  assert.deepEqual(changedFingerprintInputs(globs, head, base), [
    "apps/web/package.json",
    "packages/ui/package.json",
    "yarn.lock",
  ]);
  assert.deepEqual(changedFingerprintInputs(globs, base, base), []);
  assert.deepEqual(changedFingerprintInputs([], head, base), []);
});

test("a change's fingerprint inputs are read against its merge base, not the base branch's tip", async () => {
  const { origin, clone } = repository("mission-check-claim-merge-base-");
  gitIn(clone, "checkout", "-qb", "feature");
  writeFileSync(join(clone, "src.txt"), "work\n");
  gitIn(clone, "add", "-A");
  gitIn(clone, "commit", "-qm", "work");
  const untouched = gitIn(clone, "rev-parse", "HEAD");
  // The base branch moves its lockfile after the branch was cut. That is not this change's.
  writeFileSync(join(origin, "lock.txt"), "v2 on main\n");
  gitIn(origin, "commit", "-qam", "main bumps the lockfile");
  gitIn(clone, "fetch", "-q", "origin");
  const read = (headSha: string, fingerprintPaths = ["lock.txt"]) =>
    claimInputsChangedSinceMergeBase({ repoRoot: clone, headSha, fingerprintPaths });

  assert.deepEqual(await read(untouched), { ok: true, changed: [] });
  writeFileSync(join(clone, "lock.txt"), "v1 plus a broken entry\n");
  gitIn(clone, "commit", "-qam", "break the lockfile");
  assert.deepEqual(await read(gitIn(clone, "rev-parse", "HEAD")), { ok: true, changed: ["lock.txt"] });
  const missing = await claimInputsChangedSinceMergeBase({
    repoRoot: clone,
    headSha: "0".repeat(40),
    fingerprintPaths: ["lock.txt"],
  });
  assert.equal(missing.ok, false);
});

const HEAD = "a".repeat(40);

function failure(fingerprintPaths: string[]): CheckClaimFailure {
  return {
    warning: {
      step: 1,
      stepCount: 2,
      argv: ["yarn", "install", "--immutable"],
      reason: "exited with code 1",
      tail: "YN0028: The lockfile would have been modified by this install\n",
      truncatedBytes: 7,
    },
    fingerprintPaths,
  };
}

/** A lease manager whose acquisition always ends in this failed claim. */
function failingLeases(claimFailure: CheckClaimFailure, onAcquire: () => void = () => {}): CheckLeaseManager {
  return {
    acquireForAttempt: async (input: { onClaimStart?: () => void }) => {
      onAcquire();
      input.onClaimStart?.();
      throw new CheckDependencyClaimError(claimFailure);
    },
    releaseForAttempt: async () => ({ outcome: "returned" }),
    handOffForReclaim: () => {},
    unresolvedLeaseForNode: () => false,
    processes: { record: () => {}, clear: () => {} },
  } as unknown as CheckLeaseManager;
}

function runtimeWith(
  leases: CheckLeaseManager,
  changed: ClaimInputsChanged | Error,
  asked: Array<{ fingerprintPaths: readonly string[] }> = [],
  supervised: string[][] = [],
): CheckRuntime {
  return new CheckRuntime(leases, {
    platform: () => ({ supported: true, note: "" }),
    resolveCommit: async () => HEAD,
    leaseStore: leaseRows,
    supervise: async (request) => {
      supervised.push([...request.command]);
      return {
        result: { kind: "exited", exitCode: 0, output: "", truncatedBytes: 0 },
        emptiness: "empty",
      } as CheckSpawnOutcome;
    },
    claimInputsChanged: async (input) => {
      asked.push({ fingerprintPaths: input.fingerprintPaths });
      if (changed instanceof Error) throw changed;
      return changed;
    },
  });
}

const REQUEST: CheckExecutionRequest = {
  slot: "test",
  command: ["npm", "test"],
  repoRoot: "/repo",
  workingSubpath: "",
  headSha: "abc",
};

/** The check through the ladder, with the run budget's reserve and release observed. */
async function throughLadder(runtime: CheckRuntime) {
  const budget = { reserved: 0, released: 0 };
  const result = await runCheck({
    slot: "test",
    command: { ...emptyWorkflowCommandView("test"), overrides: [{ repoRoot: "/repo", command: ["npm", "test"] }] },
    policy: { checksEnabled: true, repoAllowlist: ["/repo"] },
    reserveRun: () => {
      budget.reserved += 1;
      return { granted: true, spent: 0, release: () => { budget.released += 1; } };
    },
    cwd: "/repo",
    repoRoot: "/repo",
    headSha: "abc",
  }, { checkoutSubpath: async () => null, execute: runtime.executorFor({ attemptId: "a", submissionId: "s", nodeId: "gate" }) });
  return { result, budget };
}

test("a failed claim whose fingerprint inputs the change modified fails the check with the tail", async () => {
  const asked: Array<{ fingerprintPaths: readonly string[] }> = [];
  const supervised: string[][] = [];
  const runtime = runtimeWith(failingLeases(failure(["yarn.lock"])), { ok: true, changed: ["yarn.lock"] }, asked, supervised);
  const { result, budget } = await throughLadder(runtime);

  assert.equal(result.kind, "outcome");
  assert.ok(result.kind === "outcome");
  assert.equal(result.outcome.status, "failed");
  assert.equal(result.outcome.exitCode, null, "no Command ran, so no exit code is reported");
  assert.equal(result.outcome.output, failure([]).warning.tail);
  assert.match(result.outcome.note, /dependency claim failed at step 1 of 2 \(yarn install --immutable\)/);
  assert.match(result.outcome.note, /modified its inputs \(yarn\.lock\)/);
  assert.match(result.outcome.note, /test Command did not run/);
  assert.deepEqual(supervised, [], "the Command ran after a failed claim");
  assert.deepEqual(asked, [{ fingerprintPaths: ["yarn.lock"] }]);
  assert.deepEqual(budget, { reserved: 1, released: 1 });
});

const INFRASTRUCTURE_CASES: Array<[string, CheckClaimFailure, ClaimInputsChanged | Error, RegExp]> = [
  ["no fingerprint input changed", failure(["yarn.lock"]), { ok: true, changed: [] }, /none of its fingerprint inputs changed/],
  ["the pool has no fingerprint paths", failure([]), { ok: true, changed: ["never asked"] }, /lists no fingerprint paths/],
  ["the merge base cannot be read", failure(["yarn.lock"]), { ok: false, reason: "no shared history" }, /could not be read \(no shared history\)/],
  ["reading the merge base throws", failure(["yarn.lock"]), new Error("git exploded"), /could not be read \(git exploded\)/],
];
for (const [label, claimFailure, changed, why] of INFRASTRUCTURE_CASES) {
  test(`a failed claim is infrastructure with the budget handed back when ${label}`, async () => {
    const asked: Array<{ fingerprintPaths: readonly string[] }> = [];
    const supervised: string[][] = [];
    const runtime = runtimeWith(failingLeases(claimFailure), changed, asked, supervised);
    const { result, budget } = await throughLadder(runtime);

    assert.equal(result.kind, "infrastructure");
    assert.ok(result.kind === "infrastructure");
    assert.match(result.reason, why);
    assert.match(result.reason, /dependency claim failed at step 1 of 2/);
    assert.ok(result.reason.endsWith(`Claim output:\n${claimFailure.warning.tail}`), result.reason);
    assert.deepEqual(supervised, []);
    assert.deepEqual(budget, { reserved: 1, released: 1 });
    assert.equal(asked.length, claimFailure.fingerprintPaths.length === 0 ? 0 : 1);
  });
}

// ---- the check slot while claiming ---------------------------------------------------------

test("the scheduler lets a third check run while two hold released slots, and takes them back", async () => {
  const schedule = createCheckScheduler(2);
  const order: string[] = [];
  const gates: Array<() => void> = [];
  const claimer = (name: string) => schedule(async (slot?: CheckSlot) => {
    order.push(`${name}:start`);
    slot!.release();
    slot!.release(); // twice is a no-op, never a second slot handed out
    await new Promise<void>((resolve) => gates.push(resolve));
    await slot!.reacquire();
    order.push(`${name}:spawn`);
  });
  const a = claimer("a");
  const b = claimer("b");
  await new Promise((resolve) => setImmediate(resolve));
  let thirdRan = false;
  const c = schedule(async () => {
    thirdRan = true;
    order.push("c:ran");
  });
  await c;
  assert.equal(thirdRan, true, "a third check waited behind two claims");

  // With both slots occupied, a claimer taking its slot back waits for one to free.
  let held!: () => void;
  const holders = [0, 1].map(() => schedule(() => new Promise<void>((resolve) => {
    const prior = held;
    held = () => { prior?.(); resolve(); };
  })));
  await new Promise((resolve) => setImmediate(resolve));
  gates.shift()!();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(order.includes("a:spawn"), false, "a claimer spawned without a free slot");
  held();
  await Promise.all(holders);
  gates.shift()!();
  await Promise.all([a, b]);
  assert.deepEqual(order.filter((step) => step.endsWith(":spawn")).sort(), ["a:spawn", "b:spawn"]);
});

test("a check attempt gives up its slot while claiming and takes one back before spawn", async () => {
  const { clone, sha } = repository("mission-check-claim-slot-");
  const events: string[] = [];
  const fake = steps(async () => {
    events.push("claim");
    return ok;
  });
  const leases = checkLeases(worktrees(LOCK_CLAIM, fake.runClaimStep));
  const slot: CheckSlot = {
    release: () => { events.push("release"); },
    reacquire: async () => { events.push("reacquire"); },
  };
  const runtime = new CheckRuntime(leases, {
    platform: () => ({ supported: true, note: "" }),
    resolveCommit: async () => sha,
    leaseStore: leaseRows,
    supervise: async () => {
      events.push("spawn");
      return {
        result: { kind: "exited", exitCode: 0, output: "", truncatedBytes: 0 },
        emptiness: "empty",
      } as CheckSpawnOutcome;
    },
  });
  const ref: CheckAttemptRef = { ...attempt(), checkSlot: slot };
  const result = await runtime.executorFor(ref)({ ...REQUEST, repoRoot: clone, headSha: sha });
  assert.equal(result.kind, "exited");
  assert.deepEqual(events, ["release", "claim", "reacquire", "spawn"]);

  // A skipped claim never gives the slot up.
  events.length = 0;
  await runtime.executorFor({ ...attempt(), checkSlot: slot })({ ...REQUEST, repoRoot: clone, headSha: sha });
  assert.deepEqual(events, ["spawn"]);
});

test("a run cancelled while the attempt waits to take its slot back spawns nothing and returns the tree", async () => {
  const { clone, sha } = repository("mission-check-claim-reacquire-cancel-");
  const leases = checkLeases(worktrees(LOCK_CLAIM, steps(() => ok).runClaimStep));
  const cancel = new AbortController();
  let spawned = false;
  const runtime = new CheckRuntime(leases, {
    platform: () => ({ supported: true, note: "" }),
    resolveCommit: async () => sha,
    leaseStore: leaseRows,
    supervise: async () => {
      spawned = true;
      return {
        result: { kind: "exited", exitCode: 0, output: "", truncatedBytes: 0 },
        emptiness: "empty",
      } as CheckSpawnOutcome;
    },
  });
  const ref: CheckAttemptRef = {
    ...attempt(),
    signal: cancel.signal,
    checkSlot: { release: () => {}, reacquire: async () => { cancel.abort("cancelled"); } },
  };
  const result = await runtime.executorFor(ref)({ ...REQUEST, repoRoot: clone, headSha: sha });
  assert.equal(spawned, false, "the Command spawned for a cancelled run");
  assert.equal(result.kind, "infrastructure");
  assert.ok(result.kind === "infrastructure");
  assert.equal(result.ranNothing, true);
  assert.equal(leaseRows.get(ref.attemptId)?.cleanupState, "returned", "the leased tree was kept");
  assert.deepEqual(leases.pinnedPaths(), []);
});

test("a slow claim ends as a dependency failure, and claim time never counts against the Command", async () => {
  const { clone, sha } = repository("mission-check-claim-slow-");
  const CLAIM_MS = 300;
  const COMMAND_TIMEOUT_MS = 100;
  let succeed = true;
  const fake = steps(async () => {
    await new Promise((resolve) => setTimeout(resolve, CLAIM_MS));
    // The claim's own limit ended it: the step runner reports a timeout, as `runClaimStep` does.
    return succeed ? ok : { outcome: "timedOut", tail: "still resolving packages\n", truncatedBytes: 0 };
  });
  const leases = checkLeases(worktrees(claimOf({ steps: [{ argv: ["yarn", "install"] }] }), fake.runClaimStep));
  const supervised: number[] = [];
  const runtime = new CheckRuntime(leases, {
    platform: () => ({ supported: true, note: "" }),
    resolveCommit: async () => sha,
    leaseStore: leaseRows,
    timeoutMs: COMMAND_TIMEOUT_MS,
    supervise: async (request) => {
      supervised.push(request.timeoutMs ?? -1);
      return {
        result: { kind: "exited", exitCode: 0, output: "", truncatedBytes: 0 },
        emptiness: "empty",
      } as CheckSpawnOutcome;
    },
  });

  const started = Date.now();
  const passed = await runtime.executorFor(attempt())({ ...REQUEST, repoRoot: clone, headSha: sha });
  assert.ok(Date.now() - started >= CLAIM_MS, "the claim did not run before the Command");
  assert.equal(passed.kind, "exited", "a claim longer than the Command's timeout timed the Command out");
  // The whole timeout reaches the spawn: the supervisor starts it there, after the claim.
  assert.deepEqual(supervised, [COMMAND_TIMEOUT_MS]);

  succeed = false;
  const slow = await runtime.executorFor(attempt())({ ...REQUEST, repoRoot: clone, headSha: sha });
  assert.equal(slow.kind, "infrastructure");
  assert.ok(slow.kind === "infrastructure");
  assert.match(slow.reason, /dependency claim failed at step 1 of 1 \(yarn install\) timed out at the claim's 10-minute limit/);
  assert.doesNotMatch(slow.reason, /check timed out/i);
  assert.deepEqual(supervised, [COMMAND_TIMEOUT_MS], "the Command spawned after a failed claim");
});

// ---- the engine and run cancel -------------------------------------------------------------

const context: WorkflowContextSnapshot = {
  primaryGoal: { rawPrompt: "CLAIM", refined: null, sourceNoteKey: "note-1" },
  humanDecisions: [],
  constraints: [],
  acceptanceCriteria: [],
  priorPersonaFeedback: [],
  session: { agent: "claude", name: "work", cwd: "/repo", branch: "feature" },
  evidence: {
    headSha: "abc",
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
};

/** Session → one Check gate per Command → Join → End. */
const gatesGraph = (gates: readonly WorkflowCheckSlot[]): PublishedWorkflowGraph => ({
  nodes: [
    { id: "session", kind: "session", position: { x: 0, y: 0 } },
    ...gates.map((slot, index) => ({ id: slot, kind: "check" as const, slot, position: { x: 200, y: index * 100 } })),
    { id: "join", kind: "all_pass", position: { x: 450, y: 100 } },
    { id: "end", kind: "end", outcome: "Complete", position: { x: 700, y: 0 } },
  ],
  edges: [
    ...gates.flatMap((slot): PublishedWorkflowGraph["edges"] => [
      { id: `s-${slot}`, source: "session", sourcePort: "submitted", target: slot, targetPort: "activate" },
      { id: `${slot}-pass`, source: slot, sourcePort: "pass", target: "join", targetPort: "result" },
      { id: `${slot}-fail`, source: slot, sourcePort: "fail", target: "join", targetPort: "result" },
    ]),
    { id: "join-pass", source: "join", sourcePort: "pass", target: "end", targetPort: "terminal" },
    { id: "join-fail", source: "join", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
  ],
});

function seedRun(
  id: string,
  gates: readonly WorkflowCheckSlot[] = ["lint", "typecheck", "test"],
): InstanceType<typeof WorkflowStore> {
  const defaults = JSON.stringify({ triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 });
  db.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json, completion_policy_json,
       binding_defaults_json, draft_revision, current_version_id, archived_at, created_at, updated_at
     ) VALUES (?, ?, ?, '', '{"nodes":[],"edges":[]}', '{"kind":"none"}', ?, 1, ?, NULL, 1, 1)`,
  ).run(`workflow-${id}`, `Claims ${id}`, `claims-${id}`, defaults, `version-${id}`);
  db.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, binding_defaults_json, published_at
     ) VALUES (?, ?, 1, 1, ?, '{"kind":"none"}', ?, 1)`,
  ).run(`version-${id}`, `workflow-${id}`, JSON.stringify(gatesGraph(gates)), defaults);
  const store = new WorkflowStore();
  const binding = store.insertBinding({
    id: `binding-${id}`,
    workflowVersionId: `version-${id}`,
    noteKey: `note-${id}`,
    sessionId: `session-${id}`,
    sessionAgent: "claude",
    sessionName: id,
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 5,
    now: 1,
  });
  store.createInitialSubmission(
    { id: `run-${id}`, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: `manual:${id}`, now: 2 },
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

const noRunner = (id: LlmRunnerId): LlmRunner => ({
  id,
  label: id,
  runInThread: null,
  structuredOutput: null,
  sandbox: null,
  price: () => null,
  litter: null,
  killLiveRuns() {},
  async run() {
    throw new Error("no Persona in this graph");
  },
});

const passingExecution = (snapshot: { runner: LlmRunnerId | null; model: string | null }): PersonaExecutionView => ({
  runner: { id: snapshot.runner ?? "claude", source: "config", unknown: null },
  model: { id: snapshot.model ?? "fake-model", source: "config" },
});

const policy = () => ({
  liveEnabled: false,
  repoAllowlist: ["/repo"],
  defaultWorkflowId: null,
  kindWorkflowDefaults: {},
  retention: { rawEvidenceDays: 30, completedRunDays: 180, maxCompletedRuns: 1_000 },
  checksEnabled: true,
  skipPassedJudges: true,
});

const catalog = (slot: WorkflowCheckSlot): WorkflowCommandView => ({
  ...emptyWorkflowCommandView(slot),
  overrides: [{ repoRoot: "/repo", command: ["npm", "run", slot] }],
});

async function waitFor(check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("the engine hands each check attempt its slot, so a third check runs while two claim", async () => {
  const store = seedRun("third-check");
  const claiming = new Set<string>();
  const ran: string[] = [];
  const finishClaims: Array<() => void> = [];
  const engine = new WorkflowEngine(store, () => {}, {
    retryBaseMs: 1,
    runnerFor: noRunner,
    resolveExecution: passingExecution,
    workflowPolicy: policy,
    workflowCommand: catalog,
    checkSchedule: createCheckScheduler(2),
    checkDeps: (ref) => ({
      checkoutSubpath: async () => null,
      execute: async (request) => {
        // Two gates claim: they give their slot up and wait. The third never claims.
        if (request.slot !== "test") {
          assert.ok(ref.checkSlot, "the engine did not hand the attempt its check slot");
          ref.checkSlot.release();
          claiming.add(request.slot);
          await new Promise<void>((resolve) => finishClaims.push(resolve));
          await ref.checkSlot.reacquire();
        }
        ran.push(request.slot);
        return { kind: "exited", exitCode: 0, output: "", truncatedBytes: 0 };
      },
    }),
  });
  engine.start();
  try {
    engine.activateSubmission("submission-third-check");
    await waitFor(() => ran.includes("test"), "the third check to run while two claim");
    assert.deepEqual([...claiming].sort(), ["lint", "typecheck"]);
    assert.deepEqual(ran, ["test"]);
    for (const finish of finishClaims) finish();
    await waitFor(() => store.getRun("run-third-check")?.status === "completed", "the run to complete");
    assert.deepEqual([...ran].sort(), ["lint", "test", "typecheck"]);
  } finally {
    for (const finish of finishClaims) finish();
    await engine.stop();
  }
});

test("cancelling a run aborts its check attempts, including one whose claim has not started", async () => {
  // Two gates are mid-claim and wait on their signal. The third has not reached its claim yet:
  // it looks at its signal only after the cancel, as a claim that registers late would.
  const store = seedRun("cancel-claims");
  const outcomes = new Map<string, string>();
  const midClaim = new Set<string>();
  let reachClaim!: () => void;
  const lateClaimReached = new Promise<void>((resolve) => { reachClaim = resolve; });
  const manager = new WorkflowManager(new Registry(), store, {
    engine: {
      retryBaseMs: 1,
      runnerFor: noRunner,
      resolveExecution: passingExecution,
      workflowPolicy: policy,
      workflowCommand: catalog,
    },
    checkScheduler: createCheckScheduler(3),
    checkDeps: (ref) => ({
      checkoutSubpath: async () => null,
      execute: async (request) => {
        assert.ok(ref.signal, "the engine did not hand the attempt its cancel signal");
        const signal = ref.signal;
        if (request.slot === "test") {
          await lateClaimReached;
          outcomes.set(request.slot, signal.aborted ? "stopped before it started" : "ran");
        } else {
          midClaim.add(request.slot);
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          outcomes.set(request.slot, "stopped while running");
        }
        return { kind: "infrastructure", reason: "the dependency claim was stopped", ranNothing: true };
      },
    }),
  });
  const engine = manager.engine;
  engine.start();
  try {
    engine.activateSubmission("submission-cancel-claims");
    await waitFor(
      () => midClaim.size === 2
        && store.listAttempts("submission-cancel-claims").filter((item) => item.state === "running").length === 3,
      "two gates to be claiming and all three to be running",
    );
    const running = store.listAttempts("submission-cancel-claims")
      .filter((item) => item.state === "running")
      .map((item) => item.id);
    assert.equal(engine.stopCheckAttempts(["not-an-attempt"]), 0);
    assert.equal(manager.cancel("run-cancel-claims", "cancel-request").ok, true);
    reachClaim();
    await waitFor(() => outcomes.size === 3, "every gate to see the cancel");
    assert.deepEqual(Object.fromEntries([...outcomes].sort()), {
      lint: "stopped while running",
      test: "stopped before it started",
      typecheck: "stopped while running",
    });
    await waitFor(
      () => store.listAttempts("submission-cancel-claims")
        .filter((item) => running.includes(item.id))
        .every((item) => item.state === "cancelled"),
      "every gate to settle as cancelled",
    );
    assert.equal(store.getRun("run-cancel-claims")?.status, "cancelled");
    // Settled attempts leave nothing behind to abort.
    assert.equal(engine.stopCheckAttempts(running), 0);
  } finally {
    reachClaim();
    await engine.stop();
    await manager.stop();
  }
});

test("archiving a binding stops the claims of the run it cancels", async () => {
  const store = seedRun("archive-claims", ["lint"]);
  let stopped = false;
  let claiming = false;
  const manager = new WorkflowManager(new Registry(), store, {
    engine: {
      retryBaseMs: 1,
      runnerFor: noRunner,
      resolveExecution: passingExecution,
      workflowPolicy: policy,
      workflowCommand: catalog,
    },
    checkScheduler: createCheckScheduler(1),
    checkDeps: (ref) => ({
      checkoutSubpath: async () => null,
      execute: async () => {
        const signal = ref.signal!;
        claiming = true;
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        stopped = true;
        return { kind: "infrastructure", reason: "the dependency claim was stopped", ranNothing: true };
      },
    }),
  });
  const engine = manager.engine;
  engine.start();
  try {
    engine.activateSubmission("submission-archive-claims");
    await waitFor(() => claiming, "the gate to be claiming");
    assert.equal(manager.archiveBinding("binding-archive-claims").ok, true);
    await waitFor(() => stopped, "the claim to see the archive's cancel");
    assert.equal(store.getRun("run-archive-claims")?.status, "cancelled");
  } finally {
    await engine.stop();
    await manager.stop();
  }
});
