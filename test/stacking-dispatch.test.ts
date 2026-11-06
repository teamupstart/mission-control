import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StackedDispatchPlan } from "../src/server/stacking/readiness.ts";
import type { Task } from "../src/shared/types.ts";

// The task manager's half of a stacked start: a stack-released dispatch is pinned to the
// prerequisite's head through the existing `baseSha` option and records what it was cut on;
// every other dispatch records that it was NOT stacked; a refusal starts nothing; and an
// existing agent is never handed a stacked task.

const home = mkdtempSync(join(tmpdir(), "mission-stacking-dispatch-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
after(() => rmSync(home, { recursive: true, force: true }));

const PIN = "a".repeat(40);
const STACKED = {
  stackParentTaskId: "parent",
  stackBaseBranch: "feat/parent",
  stackBaseSha: PIN,
  stackPrUrl: "https://github.com/acme/repo/pull/7",
};

function harness(plan: (task: Task) => Promise<StackedDispatchPlan | null>) {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const launches: { id: string; baseSha: string | undefined }[] = [];
  const seam = tasks as unknown as {
    dispatcher: { dispatch: (id: string, options?: { baseSha?: string }) => Promise<unknown> };
    stackReadiness: { planStackedDispatch: typeof plan; schedule(): void; stop(): void; reconcile(): void };
  };
  seam.dispatcher = {
    dispatch: async (id, options) => {
      launches.push({ id, baseSha: options?.baseSha });
      return { ok: true };
    },
  };
  seam.stackReadiness = { planStackedDispatch: plan, schedule() {}, stop() {}, reconcile() {} };
  return { registry, tasks, launches };
}

function backlogTask(tasks: InstanceType<typeof TaskManager>): Task {
  return tasks.create({
    repoRoot: "/repo", intent: "phase two", title: "Phase 2", kind: "ship", agent: "claude", backlog: true,
  });
}

type TaskEdge = Extract<Task["dependencies"][number], { type: "task" }>;

/** A stamped edge to `parentId`, as readiness writes it once the parent's PR is open. */
function stampedEdge(parentId: string, over: Partial<TaskEdge> = {}): TaskEdge {
  return {
    type: "task", taskId: parentId, title: "Phase 1", sessionId: null, episodeId: null, agentSessionId: null,
    branch: null, prUrl: null, selectedAt: 1, satisfiedAt: null, mode: "stack",
    stackReadyAt: 1, stackBaseBranch: STACKED.stackBaseBranch, stackBaseSha: PIN, stackPrUrl: STACKED.stackPrUrl, ...over,
  };
}

/**
 * A running parent and a backlog child whose edge to it is stamped - the only task a stacked
 * plan is ever made for - and the fields a plan for it pins.
 */
function stackedChild(registry: InstanceType<typeof Registry>, tasks: InstanceType<typeof TaskManager>) {
  const parent = tasks.create({
    repoRoot: "/repo", intent: "phase one", title: "Phase 1", kind: "ship", agent: "claude", backlog: true,
  });
  registry.upsertTask({ ...registry.getTask(parent.id)!, status: "running" });
  const child = backlogTask(tasks);
  registry.upsertTask({ ...registry.getTask(child.id)!, dependencies: [stampedEdge(parent.id)] });
  return { parent, child: registry.getTask(child.id)!, fields: { ...STACKED, stackParentTaskId: parent.id } };
}

test("a stacked dispatch pins the parent head and records what it was cut on", async () => {
  let fields = STACKED;
  const { registry, tasks, launches } = harness(async () => ({ ok: true, baseSha: PIN, fields }));
  const { parent, child: task, fields: pinned } = stackedChild(registry, tasks);
  fields = pinned;
  const outcome = await tasks.dispatch(task.id);
  assert.equal(outcome.ok, true);
  assert.deepEqual(launches, [{ id: task.id, baseSha: PIN }]);
  const stored = registry.getTask(task.id)!;
  assert.deepEqual(
    { p: stored.stackParentTaskId, b: stored.stackBaseBranch, s: stored.stackBaseSha, u: stored.stackPrUrl },
    { p: parent.id, b: "feat/parent", s: PIN, u: STACKED.stackPrUrl },
  );
});

test("an unstacked dispatch after a stacked one writes null to all four fields", async () => {
  const { registry, tasks, launches } = harness(async () => null);
  const task = backlogTask(tasks);
  // The previous episode was stacked (a rescheduled task keeps its row).
  registry.upsertTask({ ...registry.getTask(task.id)!, ...STACKED });
  const outcome = await tasks.dispatch(task.id);
  assert.equal(outcome.ok, true);
  assert.deepEqual(launches, [{ id: task.id, baseSha: undefined }]);
  const stored = registry.getTask(task.id)!;
  assert.deepEqual(
    [stored.stackParentTaskId, stored.stackBaseBranch, stored.stackBaseSha, stored.stackPrUrl],
    [null, null, null, null],
  );
});

test("a refused stacked dispatch starts nothing and says why", async () => {
  const { tasks, launches } = harness(async () => ({ ok: false, error: "#7 became a draft" }));
  const task = backlogTask(tasks);
  const outcome = await tasks.dispatch(task.id);
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && "error" in outcome ? outcome.error : null, "#7 became a draft");
  assert.deepEqual(launches, []);
});

test("a stacked task cannot take a second, caller-pinned base", async () => {
  const { tasks, launches } = harness(async () => ({ ok: true, baseSha: PIN, fields: STACKED }));
  const task = backlogTask(tasks);
  const outcome = await tasks.dispatch(task.id, { baseSha: "b".repeat(40) });
  assert.equal(outcome.ok, false);
  assert.deepEqual(launches, []);
});

test("an existing agent is never handed a task that starts on a stack", async () => {
  const { registry, tasks } = harness(async () => null);
  const parent = tasks.create({
    repoRoot: "/repo", intent: "phase one", title: "Phase 1", kind: "ship", agent: "claude", backlog: true,
  });
  registry.upsertTask({ ...registry.getTask(parent.id)!, status: "running" });
  const child = backlogTask(tasks);
  registry.upsertTask({
    ...registry.getTask(child.id)!,
    dependencies: [{
      type: "task", taskId: parent.id, title: "Phase 1", sessionId: null, episodeId: null, agentSessionId: null,
      branch: null, prUrl: null, selectedAt: 1, satisfiedAt: null,
      stackReadyAt: 5, stackBaseBranch: "feat/parent", stackBaseSha: PIN, stackPrUrl: STACKED.stackPrUrl,
    }],
  });
  assert.deepEqual(tasks.dependencyBlockers(registry.getTask(child.id)!), [], "precondition: released to start");
  const refused = await tasks.assign(child.id, "no-such-session");
  assert.equal(refused.ok, false);
  assert.match(!refused.ok ? refused.error ?? "" : "", /stacked on its prerequisite's pull request/);
});

test("a second dispatch of a stacked task while its parent-head check awaits GitHub is refused, and one task is provisioned", async () => {
  // The revalidation is held open, as a slow GitHub read would hold it.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let checks = 0;
  let fields = STACKED;
  const { registry, tasks, launches } = harness(async () => {
    checks += 1;
    await held;
    return { ok: true, baseSha: PIN, fields };
  });
  const stacked = stackedChild(registry, tasks);
  fields = stacked.fields;
  const task = stacked.child;

  const first = tasks.dispatch(task.id);
  // Let the first call reach the awaited check before the second arrives.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(checks, 1, "the first dispatch is awaiting the parent-head check");
  const secondCall = tasks.dispatch(task.id);
  // Bounded: without the guard the second call would wait on the same held check instead.
  const second = await Promise.race([
    secondCall,
    new Promise<"still waiting">((resolve) => setTimeout(() => resolve("still waiting"), 1_000)),
  ]);
  assert.notEqual(second, "still waiting", "the second dispatch is answered at once, not queued behind the first");
  assert.equal(second !== "still waiting" && second.ok, false);
  assert.equal(second !== "still waiting" && !second.ok && second.error, "task is already being dispatched");
  assert.equal(checks, 1, "the refused call never starts a second check");
  assert.deepEqual(launches, [], "nothing is provisioned while the check is open");

  release();
  const outcome = await first;
  await secondCall;
  assert.equal(outcome.ok, true);
  assert.deepEqual(launches, [{ id: task.id, baseSha: PIN }], "exactly one task is provisioned, pinned to the parent head");
});

// ---- Inspector review 9: the plan's parent is checked against the task as it is now --------

for (const [name, edit] of [
  ["removed", (_parentId: string, _otherId: string) => []],
  ["replaced by another prerequisite", (_parentId: string, otherId: string) => [stampedEdge(otherId, { title: "Other", stackPrUrl: "https://github.com/acme/repo/pull/9" })]],
  ["switched to After merge", (parentId: string) => [stampedEdge(parentId, { mode: "merge" })]],
] as const) {
  test(`a stacked dependency ${name} while the parent-head check awaits GitHub is not launched on the old parent`, async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let fields = STACKED;
    const { registry, tasks, launches } = harness(async () => {
      await held;
      return { ok: true, baseSha: PIN, fields };
    });
    const stacked = stackedChild(registry, tasks);
    fields = stacked.fields;
    const other = tasks.create({ repoRoot: "/repo", intent: "other", title: "Other", kind: "ship", agent: "claude", backlog: true });
    registry.upsertTask({ ...registry.getTask(other.id)!, status: "running" });

    const pending = tasks.dispatch(stacked.child.id);
    await new Promise((resolve) => setImmediate(resolve));
    // The operator edits the child's dependencies while GitHub answers.
    registry.upsertTask({ ...registry.getTask(stacked.child.id)!, dependencies: edit(stacked.parent.id, other.id) });
    release();
    const outcome = await pending;

    assert.equal(outcome.ok, false, "the edited task is not launched on the plan made before the edit");
    assert.equal(!outcome.ok && outcome.error, "task changed while it was being dispatched");
    assert.deepEqual(launches, [], "nothing is provisioned");
    const stored = registry.getTask(stacked.child.id)!;
    assert.equal(stored.stackParentTaskId ?? null, null, "no lineage is recorded to a parent it no longer stacks on");
    assert.equal(stored.stackBaseSha ?? null, null);
  });
}

test("a dependency stamped while an unstacked dispatch's check awaits GitHub is not started on the default branch", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const { registry, tasks, launches } = harness(async () => {
    await held;
    return null;
  });
  const stacked = stackedChild(registry, tasks);
  // Dispatched before the edge was stamped: the plan says "not stacked".
  registry.upsertTask({ ...registry.getTask(stacked.child.id)!, dependencies: [] });
  const pending = tasks.dispatch(stacked.child.id);
  await new Promise((resolve) => setImmediate(resolve));
  registry.upsertTask({ ...registry.getTask(stacked.child.id)!, dependencies: [stampedEdge(stacked.parent.id)] });
  release();
  const outcome = await pending;
  assert.equal(outcome.ok, false);
  assert.deepEqual(launches, [], "a task that now starts on a stack is not launched unpinned");
});

// ---- Inspector review 10: a stamp moved to a new head while the plan was made -------------

test("a parent that pushes while the dispatch's check awaits GitHub is checked again and the child starts on the new head", async () => {
  const NEWER = "b".repeat(40);
  let plans = 0;
  let parentId = "";
  let fields = STACKED;
  const { registry, tasks, launches } = harness(async (task) => {
    plans += 1;
    if (plans === 1) {
      // While this plan awaits GitHub, the parent pushes and readiness restamps the edge.
      const edge = task.dependencies[0] as TaskEdge;
      registry.upsertTask({ ...registry.getTask(task.id)!, dependencies: [{ ...edge, stackBaseSha: NEWER }] });
      return { ok: true, baseSha: PIN, fields };
    }
    return { ok: true, baseSha: NEWER, fields: { ...fields, stackParentTaskId: parentId, stackBaseSha: NEWER } };
  });
  const stacked = stackedChild(registry, tasks);
  parentId = stacked.parent.id;
  fields = stacked.fields;

  const outcome = await tasks.dispatch(stacked.child.id);
  assert.equal(outcome.ok, true);
  assert.equal(plans, 2, "the moved stamp sends the dispatch back to the parent-head check once");
  assert.deepEqual(launches, [{ id: stacked.child.id, baseSha: NEWER }], "the child starts on the parent's latest head, not the superseded one");
  assert.equal(registry.getTask(stacked.child.id)!.stackBaseSha, NEWER, "and records that head as what it was cut on");
});

test("a parent that keeps pushing on every check is refused after the last attempt, with nothing provisioned", async () => {
  let plans = 0;
  let fields = STACKED;
  const { registry, tasks, launches } = harness(async (task) => {
    plans += 1;
    const edge = task.dependencies[0] as TaskEdge;
    registry.upsertTask({ ...registry.getTask(task.id)!, dependencies: [{ ...edge, stackBaseSha: String(plans).repeat(40) }] });
    return { ok: true, baseSha: PIN, fields };
  });
  const stacked = stackedChild(registry, tasks);
  fields = stacked.fields;

  const outcome = await tasks.dispatch(stacked.child.id);
  assert.equal(outcome.ok, false);
  assert.match(!outcome.ok ? outcome.error : "", /kept moving while this task was being dispatched/);
  assert.equal(plans, 3, "bounded: three checks, not a loop");
  assert.deepEqual(launches, []);
  assert.equal(registry.getTask(stacked.child.id)!.stackBaseSha ?? null, null, "no lineage is recorded");
});
