import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideOverlap,
  missedDecisionsFor,
  planHitCap,
  planMissedInstants,
  statusBlocksOverlap,
  terminalStatusFor,
} from "../src/server/schedules/policy.ts";
import { SCHEDULE_CATCHUP_CREATE_CAP } from "../src/shared/schedules.ts";
import type { TaskStatus } from "../src/shared/types.ts";

// What is at stake: these functions decide how many agent tasks a catch-up files, and
// each one costs money to run. The failure that matters is not a crash - it is a policy
// that quietly does something adjacent to what the operator picked: `coalesce-latest`
// filing fourteen tasks after a fortnight away, `skip` filing one, a cap that drops
// instants out of history rather than out of the task list. All of that is invisible
// until somebody counts, so it is pinned here.
//
// Pure by construction, so every case below is an ordinary function call: no clock, no
// database, no fixture that has to manufacture a fortnight of standby.

const HOUR = 3600_000;
const T0 = Date.parse("2026-07-23T09:00:00Z");

/** `n` hourly instants, oldest first - the shape `recurrence.between` returns. */
function hourly(n: number): number[] {
  return Array.from({ length: n }, (_, i) => T0 + i * HOUR);
}

test("coalesce-latest runs once, and every skipped instant names the run that covered it", () => {
  const instants = hourly(5);
  const plan = planMissedInstants(instants, "coalesce-latest");

  assert.equal(plan.length, 5);
  assert.deepEqual(
    plan.map((e) => e.decisionKind),
    ["coalesced", "coalesced", "coalesced", "coalesced", "create_task"],
  );
  // Every coalesced entry points at the single run, so history reads "this did not run,
  // and here is what stood in for it" rather than leaving four orphan rows.
  for (const entry of plan.slice(0, 4)) assert.equal(entry.coveredByIndex, 4);
  assert.equal(plan[4]?.coveredByIndex, null);
});

test("create-all under the cap creates every instant and coalesces none", () => {
  const plan = planMissedInstants(hourly(5), "create-all");
  assert.ok(plan.every((e) => e.decisionKind === "create_task"));
  assert.ok(plan.every((e) => e.coveredByIndex === null));
  assert.equal(planHitCap(plan, "create-all"), false);
});

test("create-all keeps the NEWEST cap instants and still accounts for the rest", () => {
  const plan = planMissedInstants(hourly(5), "create-all", 3);

  assert.deepEqual(
    plan.map((e) => e.decisionKind),
    ["coalesced", "coalesced", "create_task", "create_task", "create_task"],
  );
  // The two dropped instants are coalesced into the OLDEST surviving run - the first run
  // that actually happened after them - not into the newest. Pointing them at the newest
  // would claim a run four hours later stood in for work that the run two hours later
  // already did.
  assert.equal(plan[0]?.coveredByIndex, 2);
  assert.equal(plan[1]?.coveredByIndex, 2);
  assert.equal(planHitCap(plan, "create-all"), true);
});

test("the shipped cap is what a real fortnight of hourly standby meets", () => {
  // 400 hours away, hourly: without a cap this files 400 agent tasks in one tick.
  const plan = planMissedInstants(hourly(400), "create-all");
  const created = plan.filter((e) => e.decisionKind === "create_task");
  assert.equal(created.length, SCHEDULE_CATCHUP_CREATE_CAP);
  // Capped on TASKS, not on accounting: all 400 instants still reach the ledger.
  assert.equal(plan.length, 400);
  assert.equal(plan.filter((e) => e.decisionKind === "coalesced").length, 350);
});

test("skip records every crossed instant and covers none", () => {
  const plan = planMissedInstants(hourly(3), "skip");
  assert.ok(plan.every((e) => e.decisionKind === "skipped_policy"));
  // Nothing ran, so nothing can be pointed at. A skip that claimed coverage would be
  // saying a run happened.
  assert.ok(plan.every((e) => e.coveredByIndex === null));
  assert.equal(planHitCap(plan, "skip"), false);
});

test("a single due instant creates work under both creating policies", () => {
  for (const policy of ["coalesce-latest", "create-all"] as const) {
    const plan = planMissedInstants([T0], policy);
    assert.deepEqual(plan, [{ at: T0, decisionKind: "create_task", coveredByIndex: null }]);
  }
});

test("an empty window plans nothing at all", () => {
  for (const policy of ["coalesce-latest", "create-all", "skip"] as const) {
    assert.deepEqual(planMissedInstants([], policy), []);
  }
});

test("a cap of zero still leaves one run - a catch-up never files nothing by arithmetic", () => {
  // Defensive: the cap is a guardrail against too MUCH work, and a degenerate value must
  // not turn `create-all` into `skip` silently.
  const plan = planMissedInstants(hourly(3), "create-all", 0);
  assert.equal(plan.filter((e) => e.decisionKind === "create_task").length, 1);
});

test("the preview resolves coverage to instants, so nothing renders an array index", () => {
  const instants = hourly(3);
  const decisions = missedDecisionsFor(instants, "coalesce-latest");
  assert.deepEqual(decisions, [
    { at: instants[0], decisionKind: "coalesced", coveredBy: instants[2] },
    { at: instants[1], decisionKind: "coalesced", coveredBy: instants[2] },
    { at: instants[2], decisionKind: "create_task", coveredBy: null },
  ]);
});

test("skip-active blocks on a task in flight; allow ignores it entirely", () => {
  assert.deepEqual(decideOverlap("skip-active", "task-7"), {
    decisionKind: "skipped_overlap",
    blockingTaskId: "task-7",
  });
  assert.deepEqual(decideOverlap("skip-active", null), {
    decisionKind: "create_task",
    blockingTaskId: null,
  });
  // `allow` does not merely ignore the block - it records no blocking task, because
  // nothing was blocked.
  assert.deepEqual(decideOverlap("allow", "task-7"), {
    decisionKind: "create_task",
    blockingTaskId: null,
  });
  assert.deepEqual(decideOverlap("allow", null), {
    decisionKind: "create_task",
    blockingTaskId: null,
  });
});

test("exactly the three in-flight statuses block, and the three terminal ones do not", () => {
  const expected: Record<TaskStatus, boolean> = {
    backlog: true,
    dispatching: true,
    running: true,
    // A schedule whose last run failed still runs tomorrow. Treating `failed` as in
    // flight would park a recurring mission for good on one bad night.
    failed: false,
    done: false,
    cancelled: false,
  };
  for (const [status, blocks] of Object.entries(expected)) {
    assert.equal(statusBlocksOverlap(status as TaskStatus), blocks, status);
  }
});

test("every decision kind has a terminal status, and create_task is the one that differs", () => {
  assert.equal(terminalStatusFor("create_task"), "created");
  assert.equal(terminalStatusFor("coalesced"), "coalesced");
  assert.equal(terminalStatusFor("skipped_overlap"), "skipped_overlap");
  assert.equal(terminalStatusFor("skipped_policy"), "skipped_policy");
});
