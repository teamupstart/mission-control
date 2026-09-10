import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

function engineer(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [fake.bin, ...args], {
      env,
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
