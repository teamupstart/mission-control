import assert from "node:assert/strict";
import test from "node:test";
import { describeFailure, listProcessesSnapshot } from "../src/server/discovery/processes.ts";
import { readProcCwdsSnapshot } from "../src/server/discovery/proc-cwd.ts";
import { stubRun, type run, type RunResult } from "../src/server/util/exec.ts";

/**
 * A refused worktree release has to say WHICH way the process listing failed.
 *
 * `unknownReason` is consumed by the destructive worktree path, which correctly treats it
 * as a refusal - so its text is the only thing an operator has when Clean up declines to
 * release a checkout. A killed child carries no stderr and a code coerced to 1, so the
 * previous "stderr, or exit code" rendering collapsed every death-by-signal into the bare
 * "exit 1", which names neither a cause nor an action.
 */
test("a killed process listing says it was killed, not `exit 1`", () => {
  assert.equal(
    describeFailure({ ...stubRun({ stdout: "", stderr: "", code: 1 }), outcomeUnknown: true }),
    "the process listing was killed before it answered (timed out, or stopped from outside)",
  );
});

test("a process listing killed at its timeout names the timeout, and one killed from outside the signal", () => {
  const killed = { ...stubRun({ stdout: "", stderr: "", code: 1 }), outcomeUnknown: true };
  assert.equal(
    describeFailure({ ...killed, timedOut: true, signal: "SIGTERM", timeoutMs: 4_000 }),
    "the process listing timed out after 4 s",
  );
  assert.equal(
    describeFailure({ ...killed, timedOut: false, signal: "SIGKILL", timeoutMs: 4_000 }),
    "the process listing was killed by SIGKILL",
  );
});

test("an over-large process listing says so, because retrying cannot produce less", () => {
  assert.equal(
    describeFailure({ ...stubRun({ stdout: "", stderr: "maxBuffer", code: 1 }), overflowed: true }),
    "the process listing was too large to buffer",
  );
});

test("a listing that reported its own failure keeps that report", () => {
  assert.equal(
    describeFailure(stubRun({ stdout: "", stderr: "ps: permission denied\n", code: 1 })),
    "ps: permission denied",
  );
});

test("a bare non-zero exit with nothing to say still names the code", () => {
  assert.equal(describeFailure(stubRun({ stdout: "", stderr: "", code: 3 })), "exit 3");
});

/** A command runner that records each call's binary and timeout and answers every one with `result`. */
function recordingRunner(result: RunResult = stubRun({ stdout: "", stderr: "", code: 0 })) {
  const calls: Array<[string, number | undefined]> = [];
  const runCommand: typeof run = async (bin, _args, opts) => {
    calls.push([bin, opts?.timeoutMs]);
    return result;
  };
  return { calls, runCommand };
}

// An observation read's one retry runs with double the timeout. The multiplication lives in the
// snapshots, so a fake dependency receiving `timeoutScale: 2` proves nothing about the `ps` and
// `lsof` runs.
test("a timeout scale multiplies the ps and cwd lsof timeouts, and no scale keeps the defaults", async () => {
  const { calls, runCommand } = recordingRunner();
  await listProcessesSnapshot(runCommand);
  await readProcCwdsSnapshot([11], undefined, runCommand);
  await listProcessesSnapshot(runCommand, { timeoutScale: 2 });
  await readProcCwdsSnapshot([11], { timeoutScale: 2 }, runCommand);
  assert.deepEqual(calls, [
    ["ps", 30_000], ["ps", 30_000], ["lsof", 30_000], ["ps", 60_000], ["ps", 60_000], ["lsof", 60_000],
  ]);
});

test("a cwd listing killed at its timeout names the timeout, never `exit 1`", async () => {
  const { runCommand } = recordingRunner({
    ...stubRun({ stdout: "", stderr: "", code: 1 }),
    outcomeUnknown: true,
    timedOut: true,
    signal: "SIGTERM",
    timeoutMs: 60_000,
  });
  const snapshot = await readProcCwdsSnapshot([11], undefined, runCommand);
  assert.equal(snapshot.unknownReason, "cwd listing failed: the cwd listing timed out after 60 s");
  assert.equal(snapshot.unanswered, true);
});

test("the snapshots mark an overflowed listing so a caller does not retry it", async () => {
  const { runCommand } = recordingRunner({
    ...stubRun({ stdout: "", stderr: "stdout maxBuffer length exceeded", code: 1 }),
    overflowed: true,
  });
  assert.equal((await listProcessesSnapshot(runCommand)).overflowed, true);
  assert.equal((await readProcCwdsSnapshot([11], undefined, runCommand)).overflowed, true);
});
