import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the state dir BEFORE any value import that can resolve it - static imports are
// hoisted above this line, so the server module below must load dynamically.
const home = mkdtempSync(join(tmpdir(), "mission-inspector-timeout-"));
process.env.HARNESS_HOME = join(home, "state");

const { TIMEOUT_MS, REPLY_TIMEOUT_MS } = await import("../src/server/inspector/worker.ts");

after(() => rmSync(home, { recursive: true, force: true }));

// What is at stake: a review wire set BELOW the job it wraps does not degrade, it
// inverts. `runClaudeText` kills the run at the deadline, `noteFailure` books a
// `persistent` failure, `headSha` never advances, and the PR climbs a doubling backoff
// toward a six-hour park - so the Inspector pays for a nearly-finished review, throws it
// away, and then looks at that PR less and less often. The ledger says only "claude -p
// timed out", which reads as a hung subprocess rather than a deadline that was never
// survivable. Every open PR on this repo sat in that state.
//
// The floor below is measured, not guessed: one 10.7KB five-file diff took 225s / 13
// turns on Opus and 272s / 23 turns on Sonnet, from a 44.6KB prompt. A wire under that is
// not a timeout, it is a guarantee of failure - so these tests pin the ceiling above the
// worst measurement with room, and would fail on a tidy-up back toward 180s.

/** The slowest measured review of a SMALL diff. A real ceiling has to clear this. */
const MEASURED_WORST_MS = 272_000;

test("the review wire clears the slowest measured review", () => {
  assert.ok(
    TIMEOUT_MS > MEASURED_WORST_MS,
    `review timeout ${TIMEOUT_MS}ms is at or under the ${MEASURED_WORST_MS}ms a small diff measured`,
  );
});

test("the review wire leaves headroom, not just a hair", () => {
  // A diff bigger than the one measured costs more, and the point of the ceiling is to
  // catch a run that has genuinely hung - not to race an ordinary review. Nothing waits
  // on this: one PR is reviewed at a time and the sweep is 90s, so headroom is cheap and
  // a re-review that never happens is not.
  assert.ok(TIMEOUT_MS >= 2 * MEASURED_WORST_MS);
});

test("a follow-up reply gets its own, tighter wire - and still clears the floor", () => {
  // A reply answers one thread rather than judging a whole diff, so it may be tighter.
  // But it carries the same diff, the same three tools and the same repo to read, so it
  // cannot go back to being a fraction of the review's: that is the shape of the bug this
  // file exists for, one wire down.
  assert.ok(REPLY_TIMEOUT_MS < TIMEOUT_MS);
  assert.ok(REPLY_TIMEOUT_MS > MEASURED_WORST_MS / 2);
});
