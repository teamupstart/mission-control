import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BACKLOG_MODEL,
  backlogModel,
  sanitizePlan,
} from "../src/server/foreman/backlog-plan.ts";
import type { BacklogReport } from "../src/server/foreman/backlog-plan.ts";
import {
  blockersFor,
  nextUpTaskId,
  planStale,
  readyBacklog,
} from "../src/shared/backlog.ts";
import type { BacklogPlan, Task } from "../src/shared/types.ts";
import { mkTask as baseTask } from "./helpers/session-fixture.ts";

// What stands between a plausible model reply and a deadlocked backlog.
//
// Every repair in `sanitizePlan` closes a failure that is SILENT: a cycle makes two
// cards sit blocked forever and they look exactly like cards correctly waiting their
// turn, and a missing entry leaves the plan permanently stale, which is an unbounded
// loop of model calls that produces nothing. Neither raises an error anywhere.
//
// The readiness half is here too, because the board and the scheduler read the plan
// through these same functions - so "the card says blocked" and "the machine won't
// take it" have to be the same sentence.

let seq = 0;
/** A backlog item with a distinct id and arrival order, over the shared task fixture. */
function mkTask(over: Partial<Task> = {}): Task {
  const n = ++seq;
  return baseTask({
    id: `t${n}`,
    title: `Task ${n}`,
    createdAt: 1000 + n,
    updatedAt: 1000 + n,
    ...over,
  });
}

const report = (tasks: BacklogReport["tasks"], note?: string): BacklogReport => ({ tasks, note });

/** Turn a sanitized plan into a stored one, so the shared readers can be pointed at it. */
function stored(input: ReturnType<typeof sanitizePlan>): BacklogPlan {
  return {
    entries: input.entries.map((e) => ({ ...e, reason: e.reason ?? null })),
    note: input.note ?? null,
    generatedAt: 0,
  };
}

// ---- sanitizePlan --------------------------------------------------------------------

test("a plain reply survives intact, order and edges as given", () => {
  const a = mkTask();
  const b = mkTask();
  const plan = sanitizePlan(
    report([
      { id: a.id, dependsOn: [], reason: "the schema" },
      { id: b.id, dependsOn: [a.id], reason: "needs the schema" },
    ]),
    [a, b],
  );
  assert.deepEqual(
    plan.entries.map((e) => [e.taskId, e.dependsOn]),
    [
      [a.id, []],
      [b.id, [a.id]],
    ],
  );
  assert.equal(plan.entries[0]!.reason, "the schema");
});

test("a task the model forgot is appended unblocked - a missing entry would replan forever", () => {
  const a = mkTask();
  const b = mkTask();
  const plan = sanitizePlan(report([{ id: a.id, dependsOn: [] }]), [a, b]);
  assert.deepEqual(plan.entries.map((e) => e.taskId), [a.id, b.id]);
  assert.deepEqual(plan.entries[1]!.dependsOn, []);
  // And the whole point: the plan now covers the backlog, so the worker stops replanning.
  assert.equal(planStale([a, b], stored(plan)), false);
});

test("a two-task cycle is broken rather than stored - both would block forever", () => {
  const a = mkTask();
  const b = mkTask();
  const plan = sanitizePlan(
    report([
      { id: a.id, dependsOn: [b.id] },
      { id: b.id, dependsOn: [a.id] },
    ]),
    [a, b],
  );
  const deps = new Map(plan.entries.map((e) => [e.taskId, e.dependsOn]));
  // Exactly one of the two edges survives - the cut is minimal, not a wipe - and the
  // one dropped is the model contradicting the sequence it just asked for.
  assert.equal((deps.get(a.id)?.length ?? 0) + (deps.get(b.id)?.length ?? 0), 1);
  assert.deepEqual(deps.get(a.id), []);
  assert.deepEqual(deps.get(b.id), [a.id]);
  // The head is schedulable, which is the property that matters.
  assert.equal(readyBacklog([a, b], stored(plan)).length, 1);
});

test("a genuine dependency SURVIVES being listed in priority order, not topological order", () => {
  // The prompt asks for a topological order and the model routinely answers by
  // priority. Judging edges by position in that array would silently delete the
  // dependency read, which is the one thing this feature exists to produce: the
  // route would launch before the migration it builds on.
  const route = mkTask();
  const migration = mkTask();
  const plan = sanitizePlan(
    report([
      { id: route.id, dependsOn: [migration.id] },
      { id: migration.id, dependsOn: [] },
    ]),
    [route, migration],
  );
  const deps = new Map(plan.entries.map((e) => [e.taskId, e.dependsOn]));
  assert.deepEqual(deps.get(route.id), [migration.id]);
  // And the stored order puts the dependency first, so the board reads the same way.
  assert.deepEqual(plan.entries.map((e) => e.taskId), [migration.id, route.id]);
  const ready = readyBacklog([route, migration], stored(plan));
  assert.deepEqual(ready.map((t) => t.id), [migration.id]);
});

test("a three-task cycle leaves something schedulable", () => {
  const a = mkTask();
  const b = mkTask();
  const c = mkTask();
  const plan = sanitizePlan(
    report([
      { id: a.id, dependsOn: [c.id] },
      { id: b.id, dependsOn: [a.id] },
      { id: c.id, dependsOn: [b.id] },
    ]),
    [a, b, c],
  );
  // One edge cut, two kept: the chain a -> b -> c still holds.
  assert.equal(plan.entries.reduce((n, e) => n + e.dependsOn.length, 0), 2);
  const ready = readyBacklog([a, b, c], stored(plan));
  assert.equal(ready.length, 1);
  assert.equal(ready[0]!.id, a.id);
});

test("an acyclic diamond keeps every edge, whatever order the model listed it in", () => {
  const base = mkTask();
  const left = mkTask();
  const right = mkTask();
  const top = mkTask();
  const plan = sanitizePlan(
    report([
      { id: top.id, dependsOn: [left.id, right.id] },
      { id: left.id, dependsOn: [base.id] },
      { id: right.id, dependsOn: [base.id] },
      { id: base.id, dependsOn: [] },
    ]),
    [base, left, right, top],
  );
  assert.equal(plan.entries.reduce((n, e) => n + e.dependsOn.length, 0), 4);
  // Stored in dependency order: every entry comes after everything it waits on.
  const at = new Map(plan.entries.map((e, i) => [e.taskId, i]));
  for (const e of plan.entries) {
    for (const dep of e.dependsOn) assert.ok(at.get(dep)! < at.get(e.taskId)!);
  }
  const ready = readyBacklog([base, left, right, top], stored(plan));
  assert.deepEqual(ready.map((t) => t.id), [base.id]);
});

test("a task depending on itself never starts, so the self-edge is dropped", () => {
  const a = mkTask();
  const plan = sanitizePlan(report([{ id: a.id, dependsOn: [a.id] }]), [a]);
  assert.deepEqual(plan.entries[0]!.dependsOn, []);
});

test("a dependency on an id nobody has heard of is dropped, not stored as unmeetable", () => {
  const a = mkTask();
  const plan = sanitizePlan(report([{ id: a.id, dependsOn: ["invented"] }]), [a]);
  assert.deepEqual(plan.entries[0]!.dependsOn, []);
});

test("an entry for a task that is not in the backlog is dropped", () => {
  const a = mkTask();
  const plan = sanitizePlan(
    report([{ id: "ghost", dependsOn: [] }, { id: a.id, dependsOn: [] }]),
    [a],
  );
  assert.deepEqual(plan.entries.map((e) => e.taskId), [a.id]);
});

test("a duplicated entry is stored once - a task cannot be two rows of the plan", () => {
  const a = mkTask();
  const b = mkTask();
  const plan = sanitizePlan(
    report([
      { id: a.id, dependsOn: [] },
      { id: b.id, dependsOn: [] },
      { id: a.id, dependsOn: [b.id] },
    ]),
    [a, b],
  );
  // The last mention of a task is the one believed, so `a` waits on `b` and the stored
  // order follows that rather than the position the id first appeared at.
  assert.equal(plan.entries.length, 2);
  assert.deepEqual(plan.entries.map((e) => e.taskId), [b.id, a.id]);
});

test("a repeated dependency cannot inflate a card's blocked count", () => {
  const a = mkTask();
  const b = mkTask();
  const plan = sanitizePlan(
    report([
      { id: a.id, dependsOn: [] },
      { id: b.id, dependsOn: [a.id, a.id] },
    ]),
    [a, b],
  );
  assert.deepEqual(plan.entries[1]!.dependsOn, [a.id]);
  assert.equal(blockersFor(b, stored(plan), [a, b]).length, 1);
});

test("blank prose becomes null rather than an empty chip", () => {
  const a = mkTask();
  const plan = sanitizePlan(report([{ id: a.id, dependsOn: [], reason: "   " }], "  "), [a]);
  assert.equal(plan.entries[0]!.reason, null);
  assert.equal(plan.note, null);
});

// ---- which model reads the backlog ----------------------------------------------------

test("a cleared backlogModel falls back instead of spawning the CLI with no model id", () => {
  const before = process.env.FOREMAN_BACKLOG_MODEL;
  delete process.env.FOREMAN_BACKLOG_MODEL;
  try {
    assert.equal(backlogModel({}), DEFAULT_BACKLOG_MODEL);
    // The config field is optional free text, so "" is a human who emptied the box.
    assert.equal(backlogModel({ backlogModel: "" }), DEFAULT_BACKLOG_MODEL);
    assert.equal(backlogModel({ backlogModel: "claude-opus-4-8" }), "claude-opus-4-8");
    process.env.FOREMAN_BACKLOG_MODEL = "from-env";
    assert.equal(backlogModel({ backlogModel: "" }), "from-env");
    assert.equal(backlogModel({ backlogModel: "claude-opus-4-8" }), "claude-opus-4-8");
  } finally {
    if (before === undefined) delete process.env.FOREMAN_BACKLOG_MODEL;
    else process.env.FOREMAN_BACKLOG_MODEL = before;
  }
});

// ---- blockersFor ---------------------------------------------------------------------

const planFor = (entries: Array<[string, string[]]>): BacklogPlan => ({
  entries: entries.map(([taskId, dependsOn]) => ({ taskId, dependsOn, reason: null })),
  note: null,
  generatedAt: 0,
});

test("a dependency still in the backlog reads as waiting", () => {
  const dep = mkTask();
  const t = mkTask();
  const [b] = blockersFor(t, planFor([[t.id, [dep.id]]]), [dep, t]);
  assert.equal(b?.state, "waiting");
  assert.equal(b?.title, dep.title);
});

test("a running dependency reads as waiting", () => {
  const dep = mkTask({ status: "running" });
  const t = mkTask();
  assert.equal(blockersFor(t, planFor([[t.id, [dep.id]]]), [dep, t])[0]?.state, "waiting");
});

test("a cancelled dependency reads as STOPPED - it needs you, not more patience", () => {
  const dep = mkTask({ status: "cancelled" });
  const t = mkTask();
  assert.equal(blockersFor(t, planFor([[t.id, [dep.id]]]), [dep, t])[0]?.state, "stopped");
});

test("a done dependency is not a blocker", () => {
  const dep = mkTask({ status: "done" });
  const t = mkTask();
  assert.deepEqual(blockersFor(t, planFor([[t.id, [dep.id]]]), [dep, t]), []);
});

test("a dependency whose task was DELETED clears - removing it is the escape hatch", () => {
  const t = mkTask();
  assert.deepEqual(blockersFor(t, planFor([[t.id, ["long-gone"]]]), [t]), []);
});

test("with no plan at all nothing is blocked - the board renders exactly as it did before", () => {
  const t = mkTask();
  assert.deepEqual(blockersFor(t, null, [t]), []);
  assert.equal(readyBacklog([t], null).length, 1);
});

// ---- ordering ------------------------------------------------------------------------

test("ready items come back in PLAN order, not creation order", () => {
  const first = mkTask();
  const second = mkTask();
  const ready = readyBacklog(
    [first, second],
    planFor([
      [second.id, []],
      [first.id, []],
    ]),
  );
  assert.deepEqual(ready.map((t) => t.id), [second.id, first.id]);
});

test("an item the plan does not name is scheduled after the ones it does, oldest first", () => {
  const planned = mkTask();
  const fresh = mkTask();
  const ready = readyBacklog([planned, fresh], planFor([[planned.id, []]]));
  assert.deepEqual(ready.map((t) => t.id), [planned.id, fresh.id]);
});

test("next up is the first READY item, skipping a blocked head", () => {
  const dep = mkTask();
  const blocked = mkTask();
  assert.equal(
    nextUpTaskId(
      [dep, blocked],
      planFor([
        [blocked.id, [dep.id]],
        [dep.id, []],
      ]),
    ),
    dep.id,
  );
});

test("next up is null when there is nothing schedulable", () => {
  const dead = mkTask({ status: "failed" });
  const t = mkTask();
  assert.equal(nextUpTaskId([dead, t], planFor([[t.id, [dead.id]]])), null);
});

// ---- staleness -----------------------------------------------------------------------

test("no plan at all is stale", () => {
  assert.equal(planStale([mkTask()], null), true);
});

test("an empty backlog is never stale, whatever the plan says", () => {
  assert.equal(planStale([mkTask({ status: "done" })], null), false);
});
