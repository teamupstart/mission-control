import { test } from "node:test";
import assert from "node:assert/strict";
import { backlogIndex, deadBlockersFor } from "../src/shared/backlog.ts";
import type { BacklogPlan, Task, TaskDependency } from "../src/shared/types.ts";
import { mkTask } from "./helpers/session-fixture.ts";

/**
 * What is at stake: a backlog item stranded behind a cancelled prerequisite sits in
 * `ready: 0` forever, and the row that DECLARED the dead edge is not always the one an
 * operator is looking at - the whole chain downstream inherits the stall. `deadBlockersFor`
 * is what lets every dependent name the dead root and offer the way out.
 *
 * The two facts that make it correct rather than "any cancelled task upstream" are pinned
 * here: it sees THROUGH a chain of still-backlogged prerequisites, and it STOPS the moment
 * the chain reaches one that is merely on its way (running/dispatching) - because that one
 * launched despite whatever it once waited on, so its history no longer gates anyone.
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

test("a directly cancelled prerequisite is the dead blocker", () => {
  const dead = mkTask({ id: "dead", status: "cancelled" });
  const dependent = mkTask({ id: "dep" });
  const index = backlogIndex([dead, dependent], plan([["dep", ["dead"]]]));
  assert.deepEqual(idsOf(deadBlockersFor(dependent, index)), ["dead"]);
});

test("a failed prerequisite counts the same as a cancelled one", () => {
  const dead = mkTask({ id: "dead", status: "failed" });
  const dependent = mkTask({ id: "dep" });
  const index = backlogIndex([dead, dependent], plan([["dep", ["dead"]]]));
  assert.deepEqual(idsOf(deadBlockersFor(dependent, index)), ["dead"]);
});

test("it sees a dead root through a chain of still-backlogged prerequisites", () => {
  // dep -> mid (backlog) -> dead (cancelled). `blockersIn` on `dep` names only `mid`;
  // this must surface `dead`, the thing an operator can actually act on.
  const dead = mkTask({ id: "dead", status: "cancelled" });
  const mid = mkTask({ id: "mid", status: "backlog" });
  const dependent = mkTask({ id: "dep" });
  const index = backlogIndex(
    [dead, mid, dependent],
    plan([
      ["dep", ["mid"]],
      ["mid", ["dead"]],
    ]),
  );
  assert.deepEqual(idsOf(deadBlockersFor(dependent, index)), ["dead"]);
});

test("it stops at a prerequisite that is running - that one launched despite its past", () => {
  // dep -> mid (RUNNING) -> dead (cancelled). `mid` is on its way; whatever it once
  // waited on no longer gates `dep`, so `dead` must NOT be reported.
  const dead = mkTask({ id: "dead", status: "cancelled" });
  const mid = mkTask({ id: "mid", status: "running" });
  const dependent = mkTask({ id: "dep" });
  const index = backlogIndex(
    [dead, mid, dependent],
    plan([
      ["dep", ["mid"]],
      ["mid", ["dead"]],
    ]),
  );
  assert.deepEqual(deadBlockersFor(dependent, index), []);
});

test("a done prerequisite is satisfied, not dead", () => {
  const done = mkTask({ id: "done", status: "done" });
  const dependent = mkTask({ id: "dep" });
  const index = backlogIndex([done, dependent], plan([["dep", ["done"]]]));
  assert.deepEqual(deadBlockersFor(dependent, index), []);
});

test("a prerequisite GONE from the task list is nothing to act on", () => {
  // The planner may name a task the human has since deleted. `blockersIn` treats a missing
  // inferred edge as satisfied, so there is no dead task to offer - and none is invented.
  const dependent = mkTask({ id: "dep" });
  const index = backlogIndex([dependent], plan([["dep", ["ghost"]]]));
  assert.deepEqual(deadBlockersFor(dependent, index), []);
});

test("the same dead root reached by two paths is reported once", () => {
  // dep -> a (backlog) -> dead, and dep -> b (backlog) -> dead.
  const dead = mkTask({ id: "dead", status: "cancelled" });
  const a = mkTask({ id: "a", status: "backlog" });
  const b = mkTask({ id: "b", status: "backlog" });
  const dependent = mkTask({ id: "dep" });
  const index = backlogIndex(
    [dead, a, b, dependent],
    plan([
      ["dep", ["a", "b"]],
      ["a", ["dead"]],
      ["b", ["dead"]],
    ]),
  );
  assert.deepEqual(idsOf(deadBlockersFor(dependent, index)), ["dead"]);
});

test("a cycle among live prerequisites does not hang the walk", () => {
  // a <-> b both backlog, plus a real dead edge. The visited guard has to let the walk
  // terminate and still report `dead`.
  const dead = mkTask({ id: "dead", status: "cancelled" });
  const a = mkTask({ id: "a", status: "backlog" });
  const b = mkTask({ id: "b", status: "backlog" });
  const dependent = mkTask({ id: "dep" });
  const index = backlogIndex(
    [dead, a, b, dependent],
    plan([
      ["dep", ["a"]],
      ["a", ["b"]],
      ["b", ["a", "dead"]],
    ]),
  );
  assert.deepEqual(idsOf(deadBlockersFor(dependent, index)), ["dead"]);
});

test("a disabled prerequisite is not itself dead, but a dead root above it still shows", () => {
  // `mid` is parked (backlog + disabled): that is a toggle, not a dead task, so it is not
  // collected - but the cancelled task above it is what the operator ultimately has to fix.
  const dead = mkTask({ id: "dead", status: "cancelled" });
  const mid = mkTask({ id: "mid", status: "backlog", enabled: false });
  const dependent = mkTask({ id: "dep" });
  const index = backlogIndex(
    [dead, mid, dependent],
    plan([
      ["dep", ["mid"]],
      ["mid", ["dead"]],
    ]),
  );
  assert.deepEqual(idsOf(deadBlockersFor(dependent, index)), ["dead"]);
});

test("a declared operator edge to a cancelled task is a dead blocker too", () => {
  // Not every edge is Foreman's: an operator-declared dependency to a cancelled task is
  // just as stuck, and is found with no plan at all.
  const dead = mkTask({ id: "dead", status: "cancelled" });
  const dependent = mkTask({ id: "dep", dependencies: [taskEdge("dead")] });
  const index = backlogIndex([dead, dependent], null);
  assert.deepEqual(idsOf(deadBlockersFor(dependent, index)), ["dead"]);
});

test("a declared edge already satisfied does not resurrect its cancelled target", () => {
  // Once the operator stamps the edge satisfied (the `complete(..., satisfyDependents)`
  // override), it no longer gates - so a cancelled target behind a satisfied edge is not
  // reported, matching what actually schedules.
  const dead = mkTask({ id: "dead", status: "cancelled" });
  const dependent = mkTask({ id: "dep", dependencies: [taskEdge("dead", 5000)] });
  const index = backlogIndex([dead, dependent], null);
  assert.deepEqual(deadBlockersFor(dependent, index), []);
});
