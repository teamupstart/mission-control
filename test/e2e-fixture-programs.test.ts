import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execPath } from "node:process";
import { join } from "node:path";
import { writeFakeAgents } from "../e2e/fixtures/fake-agents.ts";
import {
  conductorEngineerStatePath,
  readConductorEngineerRuns,
  writeFakeConductor,
} from "../e2e/fixtures/conductor.ts";

// What is at stake: two fixture PROGRAMS this change delivers as executable code, which no
// other layer can see.
//
// They are written to disk as template literals and run in child processes, so a coverage
// report over `e2e/fixtures/*.ts` cannot attribute a single one of their lines - what
// executes is the generated file, not the string that produced it. That is exactly why they
// need assertions of their own rather than a percentage: the browser suite runs them
// constantly and would only notice a break as some unrelated spec going red, days later and
// nowhere near the cause.
//
// Two claims carry the file:
//
//   1. The fake `jira` answers the read and BOTH write subcommands, and records what it was
//      asked. It is the blast dam that keeps a suite run off a real ticket - `jira issue move
//      MC-431 "Done"` transitions somebody's board - so "it is there and it answers" is a
//      thing to prove, not assume.
//   2. The fake engine's Engineer store is safe under concurrency. It is one JSON file that
//      several processes read-modify-write at once, and the lock around it is the whole
//      reason `conductor-loops.spec.ts` is deterministic. Its interesting states are a lost
//      update, a stale lock left by a dead holder, and a lock held by a LIVE one - and the
//      last is the one an earlier draft got wrong, by breaking it on a timer.
//
// Nothing here starts a browser, a daemon or a dashboard. These spawn the two generated
// programs directly, which is the only layer that can watch them behave.

// Resolved, because a child reports its cwd as the real path and macOS puts the temp dir
// behind a symlink - comparing the two spellings is the assertion failing for the wrong reason.
const home = realpathSync(mkdtempSync(join(tmpdir(), "mission-fixture-programs-")));
after(() => rmSync(home, { recursive: true, force: true }));

// ---- 1. the fake `jira`, and the writes it must absorb ----

const agents = writeFakeAgents(join(home, "agents"));
const recordDir = agents.recordDir;

/** Run the fake with a recording directory, and hand back what it printed. */
function jira(args: string[], cwd = home): { stdout: string; records: unknown[] } {
  const before = new Set(readdirSync(recordDir));
  const stdout = execFileSync(agents.bins.jira, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, MC_E2E_RECORD_DIR: recordDir },
  });
  const records = readdirSync(recordDir)
    .filter((name) => !before.has(name) && name.startsWith("jira-"))
    .map((name) => JSON.parse(readFileSync(join(recordDir, name), "utf8")) as unknown);
  return { stdout, records };
}

test("the fake jira answers a sweep with an empty, well-formed envelope", () => {
  // Not "prints nothing": the override is whole-codebase, so a Jira source's sweep reaches
  // this too, and output that is not JSON would turn a preflight into a parse error rather
  // than the healthy up-to-date filter every spec that ignores Jira already expects.
  const { stdout } = jira(["issue", "list", "--jql", "project = MC", "--paginate", "0:51", "--raw"]);
  assert.deepEqual(JSON.parse(stdout), { issues: [] });
});

test("the fake jira absorbs a write-back comment, and records exactly what it was asked", () => {
  const body = "Mission Control opened a pull request for this issue.\n\nhttps://example/pr/9";
  const { stdout, records } = jira(["issue", "comment", "add", "MC-431", body, "--no-input"]);
  assert.equal(stdout.trim(), "done");
  assert.equal(records.length, 1);
  const record = records[0] as { argv: string[]; cwd: string };
  // The argv is the assertion surface a spec would read, so the multi-line body has to
  // survive as ONE argument rather than being split.
  assert.deepEqual(record.argv, ["issue", "comment", "add", "MC-431", body, "--no-input"]);
  assert.equal(record.cwd, home);
});

test("the fake jira absorbs a transition, which is the write that would move a real issue", () => {
  const { stdout, records } = jira(["issue", "move", "MC-431", "Done"]);
  assert.equal(stdout.trim(), "done");
  assert.deepEqual((records[0] as { argv: string[] }).argv, ["issue", "move", "MC-431", "Done"]);
});

test("the fake jira answers a version probe, and is silent about anything else", () => {
  assert.match(jira(["version"]).stdout, /jira version .* \(fake\)/);
  // Unrecognised verbs exit 0 having printed nothing, so a caller that reaches one is not
  // handed a parse error about a command this fixture was never asked to model.
  const other = jira(["issue", "view", "MC-431"]);
  assert.equal(other.stdout, "");
});

test("the fake jira exists and is executable, which is what MISSION_JIRA_BIN points at", () => {
  assert.ok(existsSync(agents.bins.jira));
  assert.ok(agents.bins.jira.endsWith("fake-jira"));
});

// ---- 2. the fake engine's Engineer store, under concurrency ----

const conductorHome = join(home, "conductor");
mkdirSync(conductorHome, { recursive: true });
const conductor = writeFakeConductor(conductorHome);
const statePath = conductorEngineerStatePath(conductorHome);
const lockPath = `${statePath}.lock`;

/**
 * Release a hand-made lock the way a holder does: one rename, then delete.
 *
 * Not `rmSync` recursive. These tests release a lock while a creator is actively polling for
 * it, and a recursive remove empties the directory before it removes it - so the waiter's
 * publishing rename lands on the now-empty directory and the `rmdir` behind it fails with
 * ENOTEMPTY. Renaming the whole directory aside first is atomic, which is exactly why the
 * fixture itself retires locks that way.
 */
function releaseLock(): void {
  const aside = `${lockPath}.test-release-${Date.now()}`;
  try {
    renameSync(lockPath, aside);
  } catch {
    return; // already gone
  }
  rmSync(aside, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
}

function createArgs(correlationId: string): string[] {
  return [
    conductor.bin,
    "engineer",
    "run-create",
    "--repo-root",
    conductorHome,
    "--idea",
    `idea for ${correlationId}`,
    "--correlation-id",
    correlationId,
    "--attempt-key",
    `${correlationId}-1`,
  ];
}

const createEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  MC_E2E_CONDUCTOR_ENGINEER_STATE: statePath,
});

/** One reservation, run to completion. */
function runCreate(correlationId: string) {
  return spawnSync(execPath, createArgs(correlationId), {
    cwd: conductorHome,
    env: createEnv(),
    encoding: "utf8",
  });
}

/** One reservation, left running, so several can be in flight at once. */
function startCreate(correlationId: string, stallMs = 0) {
  const env = createEnv();
  // Makes the gap between reading a dead owner and acting on it wide enough to step into.
  if (stallMs > 0) env.MC_E2E_CONDUCTOR_LOCK_STALL_MS = String(stallMs);
  return spawn(execPath, createArgs(correlationId), { cwd: conductorHome, env });
}

/** The exit code of a started reservation. */
const exitOf = (kid: ReturnType<typeof startCreate>) =>
  new Promise<number>((resolve) => kid.on("exit", (code) => resolve(code ?? 0)));

// THE claim the lock exists for. Two Pipeline dispatches spawn two of these at once, each
// doing a read-modify-write of one file; unlocked, the second writer erases the run the first
// one just reserved, and every later verb about it answers "Unknown Engineer run".
test("concurrent run-create invocations both survive, with no lost update", async () => {
  rmSync(statePath, { force: true });
  const kids = ["alpha", "beta", "gamma", "delta"].map(startCreate);
  const codes = await Promise.all(kids.map(exitOf));
  assert.deepEqual(codes, [0, 0, 0, 0]);

  const runs = readConductorEngineerRuns(conductorHome);
  assert.equal(runs.length, 4, "a concurrent writer erased somebody else's Engineer run");
  assert.deepEqual(
    runs.map((run) => run.correlationId).sort(),
    ["alpha", "beta", "delta", "gamma"],
  );
  // Every run keeps its own identity rather than one overwriting another's.
  assert.equal(new Set(runs.map((run) => run.engineerRunId)).size, 4);
});

// Published with one rename, so a reader holding no lock - which is what the spec helpers do -
// can never observe a half-written file.
test("the store is published atomically, leaving no staging file behind", () => {
  rmSync(statePath, { force: true });
  assert.equal(runCreate("atomic").status, 0);
  assert.doesNotThrow(() => JSON.parse(readFileSync(statePath, "utf8")));
  const strays = readdirSync(conductorHome).filter((name) => name.includes(".writing-"));
  assert.deepEqual(strays, [], "a staging file survived the publish");
});

// The lock is released when the write lands, not when the process exits. Holding it to exit
// tied it to the parent draining stdout, and under load that queued every later invocation
// behind a process that had already finished its work.
test("the lock is given back, so the next invocation is not waiting on a finished one", () => {
  rmSync(statePath, { force: true });
  assert.equal(runCreate("first").status, 0);
  assert.equal(existsSync(lockPath), false, "the lock outlived the work it was taken for");
  assert.equal(runCreate("second").status, 0);
  assert.equal(readConductorEngineerRuns(conductorHome).length, 2);
});

// A holder that died leaves the directory behind. Recovering from that is safe BECAUSE it is
// not a guess: the owner names a pid, and that pid is gone.
test("a stale lock left by a dead holder is recovered", () => {
  rmSync(statePath, { force: true });
  mkdirSync(lockPath, { recursive: true });
  // A pid that has certainly exited: spawn something trivial and wait for it.
  const dead = spawnSync(execPath, ["-e", "0"]);
  assert.equal(dead.status, 0);
  writeFileSync(join(lockPath, "owner"), String(dead.pid));

  assert.equal(runCreate("after-a-dead-holder").status, 0);
  assert.equal(readConductorEngineerRuns(conductorHome).length, 1);
  assert.equal(existsSync(lockPath), false);
});

// THE regression this lock's second draft needed. That draft created the lock directory and
// stamped the owner afterwards, leaving a sliver where the lock existed with no owner - and a
// waiter, unable to tell that from a crash, reclaimed it after about a second. A creator
// descheduled in that sliver (this host runs several browser suites at once) would then have
// its live lock deleted and both processes would enter the read-modify-write section.
//
// The window is now closed by construction rather than timed: the lock is built complete in a
// private staging directory and published with one rename, so it is never observable without
// its owner. This watches for that directly, hammering the lock path while several creators
// contend, and it is the assertion that would fail if anyone reintroduced stamp-after-create.
test("the lock is never observable without its owner, so there is no window to reclaim", async () => {
  rmSync(statePath, { force: true });
  releaseLock();
  let unstamped = 0;
  let seen = 0;
  const offenders: string[] = [];
  // ONE directory read per observation, not an exists-then-exists pair. The pair is not
  // atomic: a holder retiring the lock between the two calls looks exactly like a lock that
  // never had an owner, and this test reported that false positive about once in eight runs
  // before the observation was tightened. `readdirSync` either sees the directory with its
  // contents or throws because it is gone - and it returns a list WITHOUT `owner` only if
  // `owner` was really unlinked first, which is the defect being watched for.
  // Counted as a run of CONSECUTIVE ownerless samples, not as single sightings, and the
  // distinction is the whole point of the measurement.
  //
  // The defect being watched for is a lock published before it was stamped: the directory
  // then sits ownerless for as long as the creator takes to write the stamp, which is many
  // samples at this interval. A directory being torn down is ownerless too, for one sample
  // at most, as `rmSync` unlinks the last entry a moment before the directory itself - and
  // that one is harmless, because a waiter reads a missing stamp as "wait", never as
  // "reclaim". Requiring two in a row keeps the defect and drops the flicker.
  //
  // A recovery is exempt outright: it captures the stamp atomically to elect itself, which is
  // how a dead holder's lock is taken over without deleting whatever happens to be at the
  // path, and its token sits in the same directory saying so.
  let run = 0;
  const watch = setInterval(() => {
    let entries: string[];
    try {
      entries = readdirSync(lockPath);
    } catch {
      run = 0;
      return; // absent, or retired between the syscall and now - neither is an observation
    }
    seen += 1;
    if (entries.includes("owner") || entries.some((e) => e.startsWith("recovering-"))) {
      run = 0;
      return;
    }
    run += 1;
    if (run === 2) {
      unstamped += 1;
      if (offenders.length < 5) offenders.push(entries.join(",") || "<empty>");
    }
  }, 1);

  // Several rounds, because the window this hunts for is a couple of syscalls wide. One round
  // of six caught a real one about once in sixteen tries; rounds of six repeated give the
  // sampler enough claim-and-release cycles to find it every time. Each round is fast - the
  // whole test is under a second when the invariant holds.
  for (let round = 0; round < 6; round += 1) {
    const kids = ["one", "two", "three", "four", "five", "six"].map((n) =>
      startCreate(`w${round}-${n}`),
    );
    await Promise.all(kids.map(exitOf));
  }
  clearInterval(watch);

  assert.equal(
    unstamped,
    0,
    `the lock stayed ownerless across consecutive samples ${unstamped} time(s) of ${seen}; saw [${offenders.join(" | ")}]`,
  );
  assert.equal(readConductorEngineerRuns(conductorHome).length, 36);
});

// The other half of the same rule: a lock this protocol did not publish - no owner inside it -
// is NOT reclaimed on a timer. Waiting is the safe direction, because reclaiming is exactly
// what deleted a live holder's lock before.
test("an ownerless lock is waited on rather than reclaimed after a delay", async () => {
  rmSync(statePath, { force: true });
  releaseLock();
  mkdirSync(lockPath, { recursive: true });
  // Not empty, so the publishing rename cannot succeed onto it either.
  writeFileSync(join(lockPath, "unrelated"), "not an owner stamp");

  const kid = startCreate("behind-an-ownerless-lock");
  const outcome = await Promise.race([
    exitOf(kid).then(() => "exited" as const),
    new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 1_500)),
  ]);
  assert.equal(outcome, "waiting", "an ownerless lock was reclaimed on a timer");
  assert.equal(existsSync(statePath), false, "a waiter wrote while the lock was still held");

  releaseLock();
  assert.equal(await exitOf(kid), 0);
  assert.equal(readConductorEngineerRuns(conductorHome).length, 1);
});

// The race that "see a dead owner, then delete the lock" allows, and the reason recovery
// elects on the owner stamp instead. Two waiters read the same dead owner; the first retires
// the stale lock, a third process claims the freshly free one, and the second - still acting
// on what it read a moment ago - deletes THAT lock, which is live. Both then enter the
// read-modify-write section and a run is lost.
//
// Driven by starting every creator against a lock that is already stale, so several of them
// are in the recovery path at once, and repeated so the window is actually met. The
// assertion is the one that matters: every reservation survives.
test("a stale lock does not let a late waiter remove the lock that replaced it", async () => {
  const dead = spawnSync(execPath, ["-e", "0"]);
  assert.equal(dead.status, 0);

  let expected = 0;
  rmSync(statePath, { force: true });
  for (let round = 0; round < 5; round += 1) {
    // Every round starts from a stale lock, so the creators race through recovery together.
    releaseLock();
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, "owner"), String(dead.pid));

    const kids = ["a", "b", "c", "d", "e", "f"].map((n) => startCreate(`stale${round}-${n}`));
    const codes = await Promise.all(kids.map(exitOf));
    assert.deepEqual(codes, [0, 0, 0, 0, 0, 0]);
    expected += kids.length;

    const runs = readConductorEngineerRuns(conductorHome);
    assert.equal(
      runs.length,
      expected,
      `round ${round}: a late waiter removed a live lock and a run was lost`,
    );
  }
  // And every one kept its own identity rather than one overwriting another's.
  const runs = readConductorEngineerRuns(conductorHome);
  assert.equal(new Set(runs.map((run) => run.engineerRunId)).size, expected);
});

// The reported race, made deterministic. A waiter reads a dead owner and is then descheduled;
// by the time it acts, the stale lock is gone and a DIFFERENT, live process holds the lock.
// Recovery that deletes "whatever is at the lock path now" removes that live lock, both
// processes enter the read-modify-write section, and a run is lost. Electing on the owner
// stamp instead means the late waiter captures a stamp that is not the pid it came about,
// puts it back, and removes nothing.
test("a waiter descheduled after reading a dead owner cannot remove the live lock that replaced it", async () => {
  const dead = spawnSync(execPath, ["-e", "0"]);
  assert.equal(dead.status, 0);
  rmSync(statePath, { force: true });
  releaseLock();

  // A stale lock for the waiter to read, then stall on.
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(join(lockPath, "owner"), String(dead.pid));
  const kid = startCreate("behind-a-replaced-lock", 1_200);

  // Let it read the dead owner, then stand in for the third process: the stale lock goes and
  // a live one - owned by this test, which is certainly running - takes its place.
  await new Promise((resolve) => setTimeout(resolve, 400));
  releaseLock();
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(join(lockPath, "owner"), String(process.pid));

  // Past the stall, the waiter acts on what it read. It must not touch this lock.
  const outcome = await Promise.race([
    exitOf(kid).then(() => "exited" as const),
    new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 2_000)),
  ]);
  assert.equal(outcome, "waiting", "the waiter removed a live lock and proceeded");
  assert.equal(existsSync(lockPath), true, "the live lock was removed");
  assert.equal(
    readFileSync(join(lockPath, "owner"), "utf8").trim(),
    String(process.pid),
    "the live lock's owner stamp was taken away",
  );
  assert.equal(existsSync(statePath), false, "a waiter wrote while another process held the lock");

  // Release it the way a real holder does, and the waiter proceeds normally.
  releaseLock();
  assert.equal(await exitOf(kid), 0);
  assert.equal(readConductorEngineerRuns(conductorHome).length, 1);
});

// PID REUSE, which is the last way a recovery could remove a live lock. The kernel recycles
// pids, so a recovery that removes a lock because its stamp names the dead pid it came about
// will remove a brand new live lock whose owner was handed that same pid. Every claim
// therefore stamps a token unique to it, and recovery insists on the whole incarnation.
//
// Both locks below carry the SAME pid and different incarnations, which is exactly the shape
// pid reuse produces, and it is what makes this test fail against a recovery that compares
// pids alone.
test("a recycled pid does not let a recovery remove the lock that replaced the dead one", async () => {
  const dead = spawnSync(execPath, ["-e", "0"]);
  assert.equal(dead.status, 0);
  rmSync(statePath, { force: true });
  releaseLock();

  // The stale lock the waiter will read and then stall on.
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(join(lockPath, "owner"), `${dead.pid}-incarnation-one`);
  const kid = startCreate("behind-a-recycled-pid", 1_200);

  // Stand in for the reuse: the stale lock goes, and a different claim by the same recycled
  // pid takes its place.
  await new Promise((resolve) => setTimeout(resolve, 400));
  releaseLock();
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(join(lockPath, "owner"), `${dead.pid}-incarnation-two`);

  const outcome = await Promise.race([
    exitOf(kid).then(() => "exited" as const),
    new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 2_000)),
  ]);
  assert.equal(outcome, "waiting", "a recovery removed a lock it had never inspected");
  assert.equal(
    readFileSync(join(lockPath, "owner"), "utf8").trim(),
    `${dead.pid}-incarnation-two`,
    "the replacing claim's stamp was taken away",
  );
  assert.equal(existsSync(statePath), false, "a waiter wrote while another claim held the lock");

  releaseLock();
  assert.equal(await exitOf(kid), 0);
  assert.equal(readConductorEngineerRuns(conductorHome).length, 1);
});

// A recovery that DIED holding the lock's stamp. It claims the lock by renaming `owner` aside
// to `recovering-<pid>`, which is what makes the election atomic and also what strands the
// lock if the recoverer never comes back: there is no owner to read, and a waiter that treats
// a missing stamp as "wait" waits for good. The token names its recoverer, so a later waiter
// can see the recoverer is gone and put the stamp back, returning the lock to an ordinary
// stale lock that the usual path recovers.
test("a recovery that died holding the stamp is put back rather than stranding the lock", async () => {
  const deadHolder = spawnSync(execPath, ["-e", "0"]);
  const deadRecoverer = spawnSync(execPath, ["-e", "0"]);
  assert.equal(deadHolder.status, 0);
  assert.equal(deadRecoverer.status, 0);
  rmSync(statePath, { force: true });
  releaseLock();

  // Exactly the state an abandoned recovery leaves: a token holding the original stamp, and
  // no `owner` anywhere.
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(
    join(lockPath, `recovering-${deadRecoverer.pid}`),
    `${deadHolder.pid}-incarnation-one`,
  );

  // Without the reclaim this hangs until the test times out.
  const kid = startCreate("behind-an-abandoned-recovery");
  assert.equal(await exitOf(kid), 0);
  assert.equal(readConductorEngineerRuns(conductorHome).length, 1);
  assert.equal(existsSync(lockPath), false, "the lock was left behind");
});

// A recoverer that is merely slow is not one that died, and its claim is left alone.
test("a live recovery's claim is waited on, not taken from it", async () => {
  const deadHolder = spawnSync(execPath, ["-e", "0"]);
  assert.equal(deadHolder.status, 0);
  rmSync(statePath, { force: true });
  releaseLock();

  // This process is alive, so it stands in for a recovery still working.
  mkdirSync(lockPath, { recursive: true });
  const token = join(lockPath, `recovering-${process.pid}`);
  writeFileSync(token, `${deadHolder.pid}-incarnation-one`);

  const kid = startCreate("behind-a-live-recovery");
  const outcome = await Promise.race([
    exitOf(kid).then(() => "exited" as const),
    new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 1_500)),
  ]);
  assert.equal(outcome, "waiting", "a live recovery's claim was taken from it");
  assert.equal(existsSync(token), true, "the live recovery's token was moved");
  assert.equal(existsSync(statePath), false, "a waiter wrote while a recovery held the stamp");

  releaseLock();
  assert.equal(await exitOf(kid), 0);
});

// A claim that loses the race leaves no litter behind for the next one to trip over.
test("a losing claim cleans up its own staging directory", async () => {
  rmSync(statePath, { force: true });
  const kids = ["s-one", "s-two", "s-three"].map(startCreate);
  await Promise.all(kids.map(exitOf));
  const strays = readdirSync(conductorHome).filter((name) => name.includes(".claim-"));
  assert.deepEqual(strays, [], "a staging directory survived a lost claim");
});

// The one an earlier draft got wrong. It broke any lock after ten seconds, so a holder that
// was merely SLOW - the whole browser suite contends for this host - had its lock taken from
// under it, both processes then wrote concurrently, and the first to exit deleted the
// other's lock. A live holder must be waited on, however long it takes.
test("a lock held by a LIVE process is waited on, never broken", async () => {
  rmSync(statePath, { force: true });
  mkdirSync(lockPath, { recursive: true });
  // This process is alive for the duration of the test, so it is the holder.
  writeFileSync(join(lockPath, "owner"), String(process.pid));

  const kid = startCreate("behind-a-live-holder");
  const exited = await Promise.race([
    new Promise<"exited">((resolve) => kid.on("exit", () => resolve("exited"))),
    new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 1_500)),
  ]);
  assert.equal(exited, "waiting", "a live holder's lock was broken");
  // And nothing was written behind its back.
  assert.equal(existsSync(statePath), false, "a waiter wrote while another process held the lock");

  // Give the lock back the way a real holder does, and the waiter proceeds.
  releaseLock();
  assert.equal(await exitOf(kid), 0);
  assert.equal(readConductorEngineerRuns(conductorHome).length, 1);
});
