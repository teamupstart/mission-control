import assert from "node:assert/strict";
import test from "node:test";
import { describeFailure } from "../src/server/discovery/processes.ts";
import { stubRun } from "../src/server/util/exec.ts";

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
