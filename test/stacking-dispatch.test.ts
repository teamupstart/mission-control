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

test("a stacked dispatch pins the parent head and records what it was cut on", async () => {
  const { registry, tasks, launches } = harness(async () => ({ ok: true, baseSha: PIN, fields: STACKED }));
  const task = backlogTask(tasks);
  const outcome = await tasks.dispatch(task.id);
  assert.equal(outcome.ok, true);
  assert.deepEqual(launches, [{ id: task.id, baseSha: PIN }]);
  const stored = registry.getTask(task.id)!;
  assert.deepEqual(
    { p: stored.stackParentTaskId, b: stored.stackBaseBranch, s: stored.stackBaseSha, u: stored.stackPrUrl },
    { p: "parent", b: "feat/parent", s: PIN, u: STACKED.stackPrUrl },
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
