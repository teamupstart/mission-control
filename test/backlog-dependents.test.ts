import { test } from "node:test";
import assert from "node:assert/strict";
import { backlogIndex, dependentsIn } from "../src/shared/backlog.ts";
import type { BacklogPlan, Task, TaskDependency } from "../src/shared/types.ts";
import { mkTask } from "./helpers/session-fixture.ts";

/**
 * What is at stake: the Backlog drawer's planner tells an operator that launching the top
 * task "unblocks 2 tasks", and that claim is an argument for pressing a button that starts
 * unattended work. It has to mean exactly one thing - two rows in this same panel lose a
 * blocker when this one finishes - and it can only mean that if it is the inverse of the
 * function that decides those rows are blocked at all.
 *
 * So `dependentsIn` is built on `blockersIn` rather than on a second read of
 * `entry.dependsOn` and `task.dependencies`. The two tests that prove the difference are
 * the reversal (a plan edge the read-time repair discards must not be counted here either)
 * and the satisfied declared edge.
 */

function plan(edges: Array<[string, string[]]>): BacklogPlan {
  return {
    entries: edges.map(([taskId, dependsOn]) => ({ taskId, dependsOn, reason: null })),
    note: null,
    generatedAt: 0,
  };
}

function taskEdge(taskId: string, satisfiedAt: number | null = null): TaskDependency {
  return {
    type: "task",
    taskId,
    title: taskId,
    sessionId: null,
    episodeId: null,
    agentSessionId: null,
    branch: null,
    prUrl: null,
    selectedAt: null,
    satisfiedAt,
  };
}

const idsOf = (tasks: Task[]): string[] => tasks.map((t) => t.id).sort();

/** `dependentsIn` over one task list and one plan, for the whole file. */
function dependents(id: string, tasks: Task[], p: BacklogPlan | null): string[] {
  const task = tasks.find((t) => t.id === id)!;
  return idsOf(dependentsIn(task, tasks, backlogIndex(tasks, p)));
}

test("an inferred plan edge pointing at a task makes its source a dependent", () => {
  const base = mkTask({ id: "base" });
  const dependent = mkTask({ id: "dep" });
  assert.deepEqual(dependents("base", [base, dependent], plan([["dep", ["base"]]])), ["dep"]);
  // And the direction is not symmetric: nothing waits on the dependent.
  assert.deepEqual(dependents("dep", [base, dependent], plan([["dep", ["base"]]])), []);
});

test("an operator's declared edge counts, with or without a plan", () => {
  const base = mkTask({ id: "base" });
  const dependent = mkTask({ id: "dep", dependencies: [taskEdge("base")] });
  assert.deepEqual(dependents("base", [base, dependent], null), ["dep"]);
});

test("a declared edge already satisfied releases nothing further", () => {
  const base = mkTask({ id: "base" });
  const dependent = mkTask({ id: "dep", dependencies: [taskEdge("base", 5)] });
  assert.deepEqual(dependents("base", [base, dependent], null), []);
});

test("a plan edge the read-time repair discards is not counted either", () => {
  // The operator declared dep -> base; a stale plan claims the reverse, base -> dep.
  // `blockersIn` drops that inferred edge (a model cannot reverse an operator's fact), so
  // "base unblocks dep" is the only true statement and "dep unblocks base" must not appear
  // beside it - a planner that printed both would be arguing for launching either one.
  const base = mkTask({ id: "base" });
  const dependent = mkTask({ id: "dep", dependencies: [taskEdge("base")] });
  const stale = plan([["base", ["dep"]], ["dep", ["base"]]]);
  assert.deepEqual(dependents("base", [base, dependent], stale), ["dep"]);
  assert.deepEqual(dependents("dep", [base, dependent], stale), []);
});

test("a parked dependent still counts - the switch is a hold, not a dependency", () => {
  const base = mkTask({ id: "base" });
  const parked = mkTask({ id: "parked", enabled: false });
  assert.deepEqual(dependents("base", [base, parked], plan([["parked", ["base"]]])), ["parked"]);
});

test("only backlog items count: a dependent that already launched is on its way", () => {
  const base = mkTask({ id: "base" });
  const running = mkTask({ id: "running", status: "running" });
  const done = mkTask({ id: "done", status: "done" });
  const queued = mkTask({ id: "queued" });
  const tasks = [base, running, done, queued];
  const p = plan([["running", ["base"]], ["done", ["base"]], ["queued", ["base"]]]);
  assert.deepEqual(dependents("base", tasks, p), ["queued"]);
});

test("a task never unblocks itself, whatever a plan claims", () => {
  const solo = mkTask({ id: "solo" });
  assert.deepEqual(dependents("solo", [solo], plan([["solo", ["solo"]]])), []);
});

test("two dependents on one prerequisite are both reported", () => {
  const base = mkTask({ id: "base" });
  const a = mkTask({ id: "a" });
  const b = mkTask({ id: "b", dependencies: [taskEdge("base")] });
  assert.deepEqual(dependents("base", [base, a, b], plan([["a", ["base"]]])), ["a", "b"]);
});
