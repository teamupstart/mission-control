import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask as baseTask } from "./helpers/session-fixture.ts";
import type { QueueManager } from "../src/server/queue.ts";
import type { ReviewManager } from "../src/server/reviews.ts";

const home = mkdtempSync(join(tmpdir(), "mission-task-complete-satisfies-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { blockersFor, readyBacklog } = await import("../src/shared/backlog.ts");
const { CompleteTaskSchema } = await import("../src/shared/protocol.ts");

after(() => rmSync(home, { recursive: true, force: true }));

/**
 * The operator's escape hatch out of a permanently blocked dependency graph.
 *
 * A declared dependency is satisfied by one thing: a MERGED PR. That is deliberate -
 * a dependent task cuts a fresh worktree from the default branch, so unmerged
 * prerequisite work is genuinely not in its base, and "the row says done" is weaker
 * evidence than "the code is on main". Two tests pin that (`backlog-plan.test.ts`'s
 * completed scout, `task-dependencies.test.ts`'s scout waiting for its merge) and they
 * must keep passing.
 *
 * But work that will NEVER produce a merged PR could then satisfy nothing at all, and
 * `blockersIn` says declared blockers cannot be manually overridden - so such a graph
 * had no exit. Found as a 17-item backlog with `ready: 0`, every chain rooted in a task
 * the operator cancelled after killing its session; marking the roots done moved their
 * chips from "stopped" to "waiting" and freed nothing.
 *
 * So the fix is ADDITIVE, and the shape is the point: an explicit, defaulted-off flag,
 * not a status rule. The first test below is the one that matters most - it pins that
 * the old call signature still means exactly what it meant, which is what lets the merge
 * guard stay the default for every caller that has not opted out of it.
 */

function setup(): {
  registry: InstanceType<typeof Registry>;
  tasks: InstanceType<typeof TaskManager>;
} {
  const registry = new Registry();
  return { registry, tasks: new TaskManager(registry) };
}

/** `root` <- `dependent`, with an unsatisfied operator-declared edge between them. */
function chain(registry: InstanceType<typeof Registry>): void {
  registry.upsertTask(baseTask({ id: "root", title: "Prerequisite", status: "running" }));
  registry.upsertTask(baseTask({
    id: "dependent",
    title: "Dependent",
    dependencies: [{
      type: "task",
      taskId: "root",
      title: "Prerequisite",
      sessionId: null,
      episodeId: null,
      agentSessionId: null,
      branch: null,
      prUrl: null,
      selectedAt: 1000,
      satisfiedAt: null,
    }],
  }));
}

// ---- the default is unchanged ----------------------------------------------------------

test("completing without the flag leaves the declared edge open, exactly as before", () => {
  const { registry, tasks } = setup();
  chain(registry);
  tasks.complete("root", "done by hand");
  const dependent = registry.getTask("dependent")!;
  assert.equal(dependent.dependencies[0]?.satisfiedAt, null);
  assert.equal(blockersFor(dependent, null, registry.listTasks()).length, 1);
  assert.deepEqual(readyBacklog(registry.listTasks(), null), []);
});

test("satisfyDependents defaults to false on the wire", () => {
  // The schema default is what makes every existing client keep the merge guard, so it
  // is pinned here rather than left to be read off the zod chain.
  assert.equal(CompleteTaskSchema.parse({ outcome: "x" }).satisfyDependents, false);
  assert.equal(CompleteTaskSchema.parse({ outcome: "x" }).requireStopped, false);
});

// ---- the opt-in exit --------------------------------------------------------------------

test("completing WITH the flag closes the declared edge and frees the dependent", () => {
  const { registry, tasks } = setup();
  chain(registry);
  tasks.complete("root", "landed via another PR", undefined, true);
  const dependent = registry.getTask("dependent")!;
  assert.equal(typeof dependent.dependencies[0]?.satisfiedAt, "number");
  assert.deepEqual(blockersFor(dependent, null, registry.listTasks()), []);
  assert.deepEqual(
    readyBacklog(registry.listTasks(), null).map((t) => t.id),
    ["dependent"],
  );
});

test("the stamp is on the EDGE, so it survives the completed row being pruned", () => {
  // `TaskDependency.satisfiedAt` is persisted for exactly this reason: terminal rows are
  // eventually dropped from the registry, and a completion readable only from the
  // target's status would silently re-block every dependent when it goes.
  const { registry, tasks } = setup();
  chain(registry);
  tasks.complete("root", "landed", undefined, true);
  registry.removeTask("root");
  const dependent = registry.getTask("dependent")!;
  assert.deepEqual(blockersFor(dependent, null, registry.listTasks()), []);
});

test("it closes every edge aimed at the task, not just the first", () => {
  const { registry, tasks } = setup();
  chain(registry);
  registry.upsertTask(baseTask({
    id: "second",
    title: "Second dependent",
    dependencies: [{
      type: "task",
      taskId: "root",
      title: "Prerequisite",
      sessionId: null,
      episodeId: null,
      agentSessionId: null,
      branch: null,
      prUrl: null,
      selectedAt: 1000,
      satisfiedAt: null,
    }],
  }));
  tasks.complete("root", "landed", undefined, true);
  for (const id of ["dependent", "second"]) {
    assert.equal(typeof registry.getTask(id)!.dependencies[0]?.satisfiedAt, "number", id);
  }
});

test("edges aimed at OTHER tasks are untouched", () => {
  const { registry, tasks } = setup();
  chain(registry);
  registry.upsertTask(baseTask({ id: "other", title: "Other", status: "running" }));
  registry.upsertTask(baseTask({
    id: "unrelated",
    title: "Unrelated dependent",
    dependencies: [{
      type: "task",
      taskId: "other",
      title: "Other",
      sessionId: null,
      episodeId: null,
      agentSessionId: null,
      branch: null,
      prUrl: null,
      selectedAt: 1000,
      satisfiedAt: null,
    }],
  }));
  tasks.complete("root", "landed", undefined, true);
  assert.equal(registry.getTask("unrelated")!.dependencies[0]?.satisfiedAt, null);
});

test("an already-satisfied edge keeps its original timestamp", () => {
  // Re-stamping would move a merge's recorded moment to whenever somebody pressed
  // Complete, which is the one thing the persisted field is supposed to preserve.
  const { registry, tasks } = setup();
  chain(registry);
  const dependent = registry.getTask("dependent")!;
  registry.upsertTask({
    ...dependent,
    dependencies: [{ ...dependent.dependencies[0]!, satisfiedAt: 42 }],
  });
  tasks.complete("root", "landed", undefined, true);
  assert.equal(registry.getTask("dependent")!.dependencies[0]?.satisfiedAt, 42);
});

test("a blocked-dependent completion refuses a task that is no longer stopped", async () => {
  const { registry, tasks } = setup();
  chain(registry);
  const app = buildApp(
    registry,
    {} as ReviewManager,
    tasks,
    {} as QueueManager,
  );

  const response = await app.request("/api/tasks/root/complete", {
    method: "POST",
    headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
    body: JSON.stringify({
      outcome: "landed elsewhere",
      satisfyDependents: true,
      requireStopped: true,
    }),
  });

  assert.equal(response.status, 409);
  assert.equal(registry.getTask("root")!.status, "running");
  assert.equal(registry.getTask("dependent")!.dependencies[0]!.satisfiedAt, null);
});
