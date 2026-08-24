import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BACKLOG_MODEL,
  backlogModel,
  sanitizePlan,
} from "../src/server/foreman/backlog-plan.ts";
import type { BacklogReport } from "../src/server/foreman/backlog-plan.ts";
import {
  PLANNABLE_LIMIT,
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

/** An unmet operator-declared dependency on `taskId`, in the shape the task row carries. */
const dep = (taskId: string): Task["dependencies"][number] => ({
  type: "task",
  taskId,
  title: taskId,
  sessionId: null,
  episodeId: null,
  agentSessionId: null,
  branch: null,
  prUrl: null,
  selectedAt: null,
  satisfiedAt: null,
});

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

test("a model edge can never reverse an operator-declared dependency", () => {
  const foundation = mkTask();
  const followup = mkTask({
    dependencies: [
      {
        type: "task",
        taskId: foundation.id,
        title: foundation.title,
        sessionId: null,
        episodeId: null,
        agentSessionId: null,
        branch: null,
        prUrl: null,
        selectedAt: null,
        satisfiedAt: null,
      },
    ],
  });
  const plan = sanitizePlan(
    report([
      // The model got it backwards. Its edge must be removed; the declared edge is
      // enforced from the task row and also determines the readout order.
      { id: foundation.id, dependsOn: [followup.id] },
      { id: followup.id, dependsOn: [] },
    ]),
    [foundation, followup],
  );
  assert.deepEqual(plan.entries.map((entry) => [entry.taskId, entry.dependsOn]), [
    [foundation.id, []],
    [followup.id, []],
  ]);

  // A stored plan can be older than an operator edit. The shared reader applies the
  // same rule immediately, before Foreman ever has a reason to replan.
  const staleReverse = planFor([
    [foundation.id, [followup.id]],
    [followup.id, []],
  ]);
  assert.deepEqual(readyBacklog([foundation, followup], staleReverse).map((task) => task.id), [
    foundation.id,
  ]);
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

// ---- a backlog longer than one plan can cover -----------------------------------------

test("a plan of the head satisfies staleness, so an oversized backlog cannot replan forever", () => {
  // The read is one call over the head, and the tail is left unplanned on purpose. What
  // must NOT happen is the plan being stale the moment it is written: staleness is
  // coverage, so if it asked about the tail too it could never be satisfied and the
  // worker would replan every tick, forever, scheduling nothing.
  const backlog = Array.from({ length: PLANNABLE_LIMIT + 20 }, () => mkTask());
  const head = backlog.slice(0, PLANNABLE_LIMIT);
  const plan = sanitizePlan(report(head.map((t) => ({ id: t.id, dependsOn: [] }))), head);
  assert.equal(plan.entries.length, head.length);
  assert.equal(planStale(backlog, stored(plan)), false);
  // The unread tail is still schedulable, oldest first, behind everything the plan names.
  const ready = readyBacklog(backlog, stored(plan));
  assert.equal(ready.length, backlog.length);
  assert.equal(ready[PLANNABLE_LIMIT]!.id, backlog[PLANNABLE_LIMIT]!.id);
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

test("a pre-provision failure waits for manual retry instead of becoming ready or a dead blocker", () => {
  const prerequisite = mkTask({
    status: "backlog",
    error: "git fetch origin failed: Permission denied (publickey)",
  });
  const dependent = mkTask();
  const plan = planFor([[dependent.id, [prerequisite.id]]]);

  assert.equal(blockersFor(dependent, plan, [prerequisite, dependent])[0]?.state, "waiting");
  assert.deepEqual(
    readyBacklog([prerequisite, dependent], plan).map((task) => task.id),
    [],
    "the failed prerequisite stays manually retryable without entering autopilot",
  );
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

test("a terminally failed dependency still reads as STOPPED", () => {
  const dep = mkTask({ status: "failed" });
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

test("an operator-declared ship dependency blocks without a Foreman plan until its merge is recorded", () => {
  const dep = mkTask({ status: "running" });
  const t = mkTask({
    dependencies: [
      {
        type: "task",
        taskId: dep.id,
        title: dep.title,
        sessionId: null,
        episodeId: null,
        agentSessionId: null,
        branch: null,
        prUrl: null,
        selectedAt: null,
        satisfiedAt: null,
      },
    ],
  });
  const [blocker] = blockersFor(t, null, [dep, t]);
  assert.equal(blocker?.source, "declared");
  assert.equal(blocker?.state, "waiting");
  assert.deepEqual(readyBacklog([dep, t], null), []);

  const satisfied = { ...t, dependencies: [{ ...t.dependencies[0]!, satisfiedAt: 123 }] };
  assert.deepEqual(readyBacklog([dep, satisfied], null).map((task) => task.id), [t.id]);
});

test("a completed scout remains blocked without a merged PR", () => {
  const scout = mkTask({ kind: "scout", status: "done" });
  const t = mkTask({
    dependencies: [
      {
        type: "task",
        taskId: scout.id,
        title: scout.title,
        sessionId: null,
        episodeId: null,
        agentSessionId: null,
        branch: null,
        prUrl: null,
        selectedAt: null,
        satisfiedAt: null,
      },
    ],
  });
  assert.equal(blockersFor(t, null, [scout, t]).length, 1);
  assert.deepEqual(readyBacklog([scout, t], null), []);
});

// ---- ordering ------------------------------------------------------------------------

test("ready items come back in the OPERATOR's order, whatever the plan says", () => {
  // The behaviour change at the heart of manual ordering. `readyBacklog` used to walk
  // `plan.entries` first, so for any item the plan covered a model decided what Foreman
  // took next. Now the plan supplies edges and the rank supplies position - and this
  // fixture is one where the two disagree, so a surviving plan-walk fails here.
  const first = mkTask({ backlogRank: 1024 });
  const second = mkTask({ backlogRank: 2048 });
  const ready = readyBacklog(
    [first, second],
    planFor([
      [second.id, []],
      [first.id, []],
    ]),
  );
  assert.deepEqual(ready.map((t) => t.id), [first.id, second.id]);
});

test("an item the plan does not name sits at its rank, not in a tail", () => {
  // There is no "unplanned tail" any more: an item the plan has never seen is unblocked
  // and sits exactly where the operator put it, which here is ABOVE the planned one.
  const planned = mkTask({ backlogRank: 2048 });
  const fresh = mkTask({ backlogRank: 1024 });
  const ready = readyBacklog([planned, fresh], planFor([[planned.id, []]]));
  assert.deepEqual(ready.map((t) => t.id), [fresh.id, planned.id]);
});

test("every ready item has zero unmet edges, so no ready pair can be ordered by a dependency", () => {
  // THE INVARIANT THE WHOLE PHASE RESTS ON, pinned as a property rather than left as a
  // comment. Dropping the plan-walk is safe precisely because a ready item has no unmet
  // edge - so an edge from one ready item to another is impossible by construction, the
  // ready set has no internal edges, and ANY total order over it is dependency-safe.
  //
  // Asserted over a table of backlogs and plans rather than one example, because a single
  // fixture would only prove the filter works for that fixture.
  const cases: Array<{ name: string; tasks: Task[]; plan: BacklogPlan | null }> = [];

  const chainA = mkTask({ backlogRank: 4096 });
  const chainB = mkTask({ backlogRank: 1024 });
  const chainC = mkTask({ backlogRank: 2048 });
  cases.push({
    name: "a chain listed against the operator's order",
    tasks: [chainA, chainB, chainC],
    plan: planFor([
      [chainC.id, [chainB.id]],
      [chainB.id, [chainA.id]],
      [chainA.id, []],
    ]),
  });

  const diamondTop = mkTask({ backlogRank: 3072 });
  const diamondL = mkTask({ backlogRank: 1024 });
  const diamondR = mkTask({ backlogRank: 2048 });
  const diamondBottom = mkTask({ backlogRank: 512 });
  cases.push({
    name: "a diamond whose sink is ranked first",
    tasks: [diamondTop, diamondL, diamondR, diamondBottom],
    plan: planFor([
      [diamondTop.id, []],
      [diamondL.id, [diamondTop.id]],
      [diamondR.id, [diamondTop.id]],
      [diamondBottom.id, [diamondL.id, diamondR.id]],
    ]),
  });

  const loneA = mkTask({ backlogRank: 2048 });
  const loneB = mkTask({ backlogRank: 1024 });
  cases.push({ name: "no plan at all", tasks: [loneA, loneB], plan: null });

  const declared = mkTask({ backlogRank: 1024 });
  const dependent = mkTask({
    backlogRank: 512,
    dependencies: [dep(declared.id)],
  });
  cases.push({
    name: "an operator-declared edge against the rank",
    tasks: [declared, dependent],
    plan: null,
  });

  for (const { name, tasks, plan } of cases) {
    const ready = readyBacklog(tasks, plan);
    const readyIds = new Set(ready.map((t) => t.id));
    for (const task of ready) {
      assert.deepEqual(
        blockersFor(task, plan, tasks),
        [],
        `${name}: ${task.id} is ready with an unmet blocker`,
      );
    }
    // The consequence, stated separately because it is the claim the plan-walk removal
    // actually rests on: no ready item names another ready item as a prerequisite.
    for (const task of ready) {
      for (const blocker of blockersFor(task, plan, tasks)) {
        assert.ok(!readyIds.has(blocker.taskId), `${name}: a ready pair carries an edge`);
      }
    }
    // And the list is genuinely in rank order, not accidentally in plan order.
    assert.deepEqual(
      ready.map((t) => t.id),
      [...ready].sort((a, b) => (a.backlogRank ?? 0) - (b.backlogRank ?? 0)).map((t) => t.id),
      `${name}: the ready list is not in rank order`,
    );
  }
});

test("a reorder does not make the plan stale, so moving a card costs no model call", () => {
  // Why rank lives on the task row and not in the stored plan. `planStale` is COVERAGE -
  // does every plannable item have an entry - and a rank change touches neither the set of
  // items nor the set of entries.
  const a = mkTask({ backlogRank: 1024 });
  const b = mkTask({ backlogRank: 2048 });
  const plan = planFor([
    [a.id, []],
    [b.id, []],
  ]);
  assert.equal(planStale([a, b], plan), false);
  // The same two tasks with their ranks swapped - which is exactly what a reorder writes.
  const moved = [{ ...a, backlogRank: 4096 }, b];
  assert.equal(planStale(moved, plan), false);
  assert.deepEqual(readyBacklog(moved, plan).map((t) => t.id), [b.id, a.id]);
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
