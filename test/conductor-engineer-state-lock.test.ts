import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  conductorEngineerStatePath,
  writeFakeConductor,
} from "../e2e/fixtures/conductor.ts";

// The e2e fake provider CLI keeps its Engineer state in one json file, and every mutation is
// a read-modify-write from a SEPARATE short-lived process. Two of those at once used to
// clobber each other: both read the same state, both appended their own run, and the second
// write dropped the first. That is not a cosmetic fixture bug. Downstream it surfaced as a
// daemon error, because the reservation the first dispatch had been handed was no longer in
// the file, so refreshing its commission could not find the history and the dispatch failed
// with "the provider Engineer reservation history is not available ... Unknown Engineer run".
//
// The repair is an mkdir lock held across each critical section. These tests pin the two
// properties that repair has to keep, because both fail silently rather than loudly:
//
//   1. Concurrent reservations both survive. A lost write is invisible until a dispatch that
//      depended on it fails somewhere else entirely.
//   2. The lock is ALWAYS released. A stranded lock costs the next Engineer call the full
//      ten-second break-in timeout, which reads as an unrelated slow test rather than as a
//      fixture that leaked a lock.
//
// Run against the real generated binary rather than an imported function, because the file
// under test is a template literal that becomes a standalone script - the concurrency only
// exists once it is two processes, and a unit test of the source string could not see it.

const home = mkdtempSync(join(tmpdir(), "mission-engineer-lock-"));
const fake = writeFakeConductor(home);
const statePath = conductorEngineerStatePath(home);
const lockPath = `${statePath}.lock`;

after(() => rmSync(home, { recursive: true, force: true }));

/** The environment the daemon gives the fake, reduced to what the Engineer paths read. */
const env = {
  ...process.env,
  MC_E2E_CONDUCTOR_ENGINEER_STATE: statePath,
  MC_E2E_CONDUCTOR_ENGINEER_MODE: "supported",
};

function engineer(
  args: string[],
  extraEnv: Record<string, string> = {},
): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [fake.bin, ...args], {
      env: { ...env, ...extraEnv },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? "", status: e.status ?? -1 };
  }
}

function runs(): Array<{ engineerRunId: string; attemptKey: string }> {
  if (!existsSync(statePath)) return [];
  return (JSON.parse(readFileSync(statePath, "utf8")) as {
    runs: Array<{ engineerRunId: string; attemptKey: string }>;
  }).runs;
}

test("an unknown run releases the lock, so the next Engineer call is not stalled", () => {
  // Reserve one run so there is a state file, then ask about a run that does not exist. That
  // path sets an exit code and falls through rather than exiting, which is exactly what lets
  // the lock's release run - and an exit hook covers it even if some future branch does not.
  engineer([
    "engineer", "run-create",
    "--repo-root", home,
    "--idea", "Lock release",
    "--correlation-id", "corr-lock-release",
    "--attempt-key", "attempt-1",
  ]);

  const unknown = engineer([
    "engineer", "run-cancel",
    "--run-id", "engineer-e2e-does-not-exist-1",
  ]);
  assert.equal(unknown.status, 4, "an unknown run is a refusal, not a crash");
  assert.equal(existsSync(lockPath), false, "the lock must not outlive the process that took it");

  // The real assertion: the NEXT call is immediate. A stranded lock would make this wait out
  // the ten-second break-in deadline before it could proceed, so a generous ceiling still
  // separates the two outcomes by orders of magnitude.
  const started = Date.now();
  const after = engineer([
    "engineer", "run-create",
    "--repo-root", home,
    "--idea", "Lock release",
    "--correlation-id", "corr-lock-release",
    "--attempt-key", "attempt-2",
  ]);
  const elapsed = Date.now() - started;
  assert.equal(after.status, 0);
  assert.ok(elapsed < 5_000, `the next call waited ${elapsed}ms, which means the lock was stranded`);
  assert.equal(existsSync(lockPath), false);
});

// The defect the lock exists for, reproduced the only way it can be: two processes at once.
test("concurrent reservations for one correlation both survive", () => {
  rmSync(statePath, { force: true });
  rmSync(lockPath, { recursive: true, force: true });

  // Genuinely concurrent, which means ASYNC spawn. An `execFileSync` pair inside two promises
  // runs one after the other and can never reproduce the race - a version of this test that
  // did exactly that passed against the unlocked fixture, proving only that it was not
  // testing anything.
  const start = (attemptKey: string): Promise<number> =>
    new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [
          fake.bin,
          "engineer", "run-create",
          "--repo-root", home,
          "--idea", "Concurrent reservations",
          "--correlation-id", "corr-concurrent",
          "--attempt-key", attemptKey,
        ],
        { env, stdio: "ignore" },
      );
      child.on("close", (code) => resolve(code ?? -1));
    });

  return Promise.all([start("attempt-a"), start("attempt-b")]).then((codes) => {
    assert.deepEqual(codes, [0, 0], "both reservations should succeed");
    const stored = runs();
    assert.equal(stored.length, 2, "one reservation was clobbered by the other's write");
    // Distinct ids, because the attempt number is derived from the lineage each process reads.
    // Two runs numbered 1 is the exact signature of the lost write this lock prevents.
    assert.equal(new Set(stored.map((r) => r.engineerRunId)).size, 2);
    assert.deepEqual(
      stored.map((r) => r.attemptKey).sort(),
      ["attempt-a", "attempt-b"],
    );
  });
});

// The break-in path, which is the part that had to be got right rather than merely present.
//
// An earlier version broke in on the WAITER's own deadline and released unconditionally.
// That reintroduces the race the lock exists to prevent, one stall removed: a holder whose
// section overran would have its lock deleted by a waiter, then delete whichever lock existed
// when it finished, letting a third contender in. The lock is owned instead - a token inside
// the directory - so a break-in only takes an abandoned lock and a release only removes one
// it still holds.
test("a fresh lock is waited for, and only an abandoned one is broken", () => {
  rmSync(statePath, { force: true });
  rmSync(lockPath, { recursive: true, force: true });
  // Short windows so this probes the boundary rather than sitting out the real one. A lock
  // counts as abandoned after 3s here; a contender gives up after 0.4s.
  const windows = {
    MC_E2E_CONDUCTOR_LOCK_STALE_MS: "3000",
    MC_E2E_CONDUCTOR_LOCK_WAIT_MS: "400",
  };

  // A lock a live holder could plausibly be inside: its owner file is NEW. A contender must
  // refuse it rather than break in, and must say so rather than corrupt the file.
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(`${lockPath}/owner`, "someone-else");
  const blocked = engineer([
    "engineer", "run-create", "--repo-root", home, "--idea", "Owned lock",
    "--correlation-id", "corr-owned", "--attempt-key", "attempt-1",
  ], windows);
  assert.notEqual(blocked.status, 0, "a fresh lock held by somebody else must not be taken");
  assert.equal(existsSync(lockPath), true, "and it must still belong to its owner afterwards");
  assert.deepEqual(runs(), [], "nothing may be written while another process holds the lock");
  assert.equal(
    readFileSync(`${lockPath}/owner`, "utf8"),
    "someone-else",
    "the waiter must not have overwritten the owner's token",
  );

  // The same lock, now ABANDONED. Waiting past the staleness window is what makes it so, and
  // a contender may then take it - otherwise one killed process wedges every later call.
  const waited = Date.now() + 3_200;
  while (Date.now() < waited) { /* let the lock age past MC_E2E_CONDUCTOR_LOCK_STALE_MS */ }
  const after = engineer([
    "engineer", "run-create", "--repo-root", home, "--idea", "Owned lock",
    "--correlation-id", "corr-owned", "--attempt-key", "attempt-1",
  ], windows);
  assert.equal(after.status, 0, "an abandoned lock must not wedge every later call");
  assert.equal(runs().length, 1);
  assert.equal(existsSync(lockPath), false, "and the taker releases what it acquired");
});

// The race the second review round found: the stale CHECK and the stale DELETE are not one
// operation, so two waiters can both decide a lock is abandoned, the first can remove it and
// acquire a fresh one, and the second can then delete THAT - handing a third contender a
// lock somebody is inside.
//
// Racing two processes cannot pin this down: winning the damaging interleaving is a coin
// flip, and a test that flips it passes against the broken code most of the time. A version
// of this that spawned two contenders did exactly that. So this pins the MECHANISM that
// removes the race instead, which is deterministic: recovery is serialised behind its own
// atomic mkdir, and a waiter that cannot take that breaker must leave the lock alone rather
// than delete it on an observation somebody else is already acting on.
test("a waiter cannot break a stale lock while another is already recovering it", () => {
  rmSync(statePath, { force: true });
  rmSync(lockPath, { recursive: true, force: true });
  rmSync(`${lockPath}.breaker`, { recursive: true, force: true });

  // An abandoned lock, plus the breaker another waiter would be holding mid-recovery.
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(`${lockPath}/owner`, "dead-process");
  mkdirSync(`${lockPath}.breaker`, { recursive: true });

  const res = engineer([
    "engineer", "run-create", "--repo-root", home, "--idea", "Serialised recovery",
    "--correlation-id", "corr-serialised", "--attempt-key", "attempt-1",
  ], { MC_E2E_CONDUCTOR_LOCK_STALE_MS: "1", MC_E2E_CONDUCTOR_LOCK_WAIT_MS: "700" });

  // Stale by every measure, and still not taken: the recovery slot was occupied, so this
  // waiter had no business deleting anything.
  assert.notEqual(res.status, 0, "recovery must not proceed while another waiter holds it");
  assert.equal(existsSync(lockPath), true, "the lock under recovery must survive");
  assert.equal(
    readFileSync(`${lockPath}/owner`, "utf8"),
    "dead-process",
    "and it must still carry the owner the other waiter observed",
  );
  assert.deepEqual(runs(), [], "nothing may be written without the lock");

  // With the recovery slot free, the same abandoned lock is recoverable.
  rmSync(`${lockPath}.breaker`, { recursive: true, force: true });
  const after = engineer([
    "engineer", "run-create", "--repo-root", home, "--idea", "Serialised recovery",
    "--correlation-id", "corr-serialised", "--attempt-key", "attempt-1",
  ], { MC_E2E_CONDUCTOR_LOCK_STALE_MS: "1", MC_E2E_CONDUCTOR_LOCK_WAIT_MS: "700" });
  assert.equal(after.status, 0, "an abandoned lock must still be recoverable");
  assert.equal(runs().length, 1);
  assert.equal(existsSync(lockPath), false);
  assert.equal(existsSync(`${lockPath}.breaker`), false, "the recovery slot must be released");
});

// A mistyped window must cost the default, not the loop: every comparison against NaN is
// false, so a NaN wait deadline never expires and a NaN staleness window never triggers.
test("a non-numeric lock window falls back instead of spinning forever", () => {
  rmSync(statePath, { force: true });
  rmSync(lockPath, { recursive: true, force: true });
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(`${lockPath}/owner`, "someone-else");

  const started = Date.now();
  const res = engineer([
    "engineer", "run-create", "--repo-root", home, "--idea", "Bad window",
    "--correlation-id", "corr-bad-window", "--attempt-key", "attempt-1",
  ], { MC_E2E_CONDUCTOR_LOCK_WAIT_MS: "not-a-number", MC_E2E_CONDUCTOR_LOCK_STALE_MS: "3000" });
  const elapsed = Date.now() - started;

  // The property at stake is that the loop still TERMINATES. With a NaN wait deadline it
  // never would: the staleness comparison and the deadline comparison are both false against
  // NaN, so nothing ends the spin. Falling back to the default leaves the 3s staleness window
  // in charge, so the lock ages out and the call proceeds.
  assert.equal(res.status, 0, "the call must finish rather than spin on a NaN window");
  assert.ok(elapsed < 20_000, `waited ${elapsed}ms, which suggests an unbounded spin`);
  assert.equal(runs().length, 1, "and it must actually do its work once it gets in");
  rmSync(lockPath, { recursive: true, force: true });
});
