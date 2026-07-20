import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What stands between a growing backlog and an autopilot that silently stops scheduling.
//
// The dependency read's cost scales with the backlog - the model writes one entry per
// task - so a FIXED wall-clock cap is not a tuning value, it is an expiry date. When the
// backlog outgrew the old 90s constant the failure was total and silent: every read timed
// out, so no plan was ever stored, so `planStale` stayed true, so `decideBacklogTick`
// answered `plan` on every tick and never reached a dispatch. The operator saw two dozen
// ready items, an idle fleet, and no error anywhere.
//
// So the budget is asserted at a REALISTIC backlog size against the wall clock that
// backlog actually needed, not just for internal consistency - a scaling rule that still
// came out under the measured cost would reproduce the same standstill. The last case
// drives the real `planBacklog` against a fake `claude` to prove the computed value
// reaches the spawn, since a budget nothing applies is the same outage.

// Pinned before importing anything that reads it: `claude-cli.ts` resolves CLAUDE_BIN at
// module load, so a test cannot swap binaries afterwards.
const home = mkdtempSync(join(tmpdir(), "mission-backlog-budget-"));
process.env.HARNESS_HOME = home;
process.env.MISSION_HOME = home;

const bin = mkdtempSync(join(tmpdir(), "fake-claude-budget-"));
const fake = join(bin, "claude.sh");
// Sleeps, then answers a valid plan for the two ids the case below asks about. The sleep
// is what makes the budget observable: under it the run returns a plan, over it the run
// is killed and reported as a failure.
writeFileSync(
  fake,
  `#!/bin/sh
cat > /dev/null
sleep 2
printf %s '{"result":"{\\"tasks\\":[{\\"id\\":\\"a\\",\\"dependsOn\\":[]},{\\"id\\":\\"b\\",\\"dependsOn\\":[\\"a\\"]}]}"}'
`,
);
chmodSync(fake, 0o755);
process.env.MISSION_CLAUDE_BIN = fake;

const { backlogTimeoutMs, BACKLOG_BASE_MS, BACKLOG_PER_TASK_MS, BACKLOG_CEILING_MS, planBacklog } =
  await import("../src/server/foreman/backlog-plan.ts");
const { PLANNABLE_LIMIT } = await import("../src/shared/backlog.ts");
const { mkTask } = await import("./helpers/session-fixture.ts");

after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

/** Keep the env override out of the way of the cases that test the scaling itself. */
function withoutOverride<T>(fn: () => T): T {
  const had = process.env.FOREMAN_BACKLOG_TIMEOUT_MS;
  delete process.env.FOREMAN_BACKLOG_TIMEOUT_MS;
  try {
    return fn();
  } finally {
    if (had !== undefined) process.env.FOREMAN_BACKLOG_TIMEOUT_MS = had;
  }
}

/**
 * The backlog that broke this, and what it cost.
 *
 * 24 items, timed end to end against the real CLI at 267s and again at 305s. The SLOW
 * one is what the budget has to clear, and with room - the spread between two runs of
 * the same prompt is the whole reason this is not a tight fit - or the outage this file
 * exists for comes straight back.
 */
const MEASURED_ITEMS = 24;
const MEASURED_WALL_CLOCK_MS = 305_000;

test("the budget for a real backlog clears what that backlog actually costs", () => {
  withoutOverride(() => {
    const budget = backlogTimeoutMs(MEASURED_ITEMS);
    assert.ok(
      budget > MEASURED_WALL_CLOCK_MS,
      `a ${MEASURED_ITEMS}-item read measured ${MEASURED_WALL_CLOCK_MS}ms; budget is ${budget}ms`,
    );
    // The regression in one line: the old fixed cap could not have covered this.
    assert.ok(budget > 90_000);
  });
});

test("the budget grows with the backlog, because the reply does", () => {
  withoutOverride(() => {
    assert.equal(backlogTimeoutMs(0), BACKLOG_BASE_MS);
    assert.equal(backlogTimeoutMs(2), BACKLOG_BASE_MS + 2 * BACKLOG_PER_TASK_MS);
    assert.ok(backlogTimeoutMs(20) > backlogTimeoutMs(10));
  });
});

test("the budget stops at the ceiling, so one read cannot own the worker's loop", () => {
  withoutOverride(() => {
    assert.equal(backlogTimeoutMs(PLANNABLE_LIMIT), BACKLOG_CEILING_MS);
    assert.equal(backlogTimeoutMs(100_000), BACKLOG_CEILING_MS);
  });
});

test("an operator's explicit cap wins flat, and does not grow with the backlog", () => {
  process.env.FOREMAN_BACKLOG_TIMEOUT_MS = "45000";
  try {
    assert.equal(backlogTimeoutMs(1), 45_000);
    assert.equal(backlogTimeoutMs(400), 45_000);
  } finally {
    delete process.env.FOREMAN_BACKLOG_TIMEOUT_MS;
  }
});

// A garbage value must not silently become a zero-length budget, which would time every
// read out instantly - the same standstill by a different door.
test("an unusable override is ignored rather than becoming a zero budget", () => {
  for (const bad of ["", "0", "-1", "abc"]) {
    process.env.FOREMAN_BACKLOG_TIMEOUT_MS = bad;
    try {
      assert.equal(backlogTimeoutMs(2), BACKLOG_BASE_MS + 2 * BACKLOG_PER_TASK_MS, `for "${bad}"`);
    } finally {
      delete process.env.FOREMAN_BACKLOG_TIMEOUT_MS;
    }
  }
});

const twoItems = [
  mkTask({ id: "a", title: "A", intent: "first" }),
  mkTask({ id: "b", title: "B", intent: "second" }),
];

test("the computed budget reaches the spawn: under it the plan lands", async () => {
  process.env.FOREMAN_BACKLOG_TIMEOUT_MS = "20000";
  try {
    const r = await planBacklog(twoItems, "claude-sonnet-5");
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.deepEqual(
      r.plan.entries.map((e) => e.taskId),
      ["a", "b"],
    );
  } finally {
    delete process.env.FOREMAN_BACKLOG_TIMEOUT_MS;
  }
});

test("the computed budget reaches the spawn: over it the read is reported as failed", async () => {
  process.env.FOREMAN_BACKLOG_TIMEOUT_MS = "300";
  try {
    const r = await planBacklog(twoItems, "claude-sonnet-5");
    assert.equal(r.kind, "failed");
    if (r.kind !== "failed") return;
    // Reported as a value, never thrown: the worker counts it toward serial mode.
    assert.match(r.reason, /timed out/);
  } finally {
    delete process.env.FOREMAN_BACKLOG_TIMEOUT_MS;
  }
});
