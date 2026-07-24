import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";

/**
 * What is at stake: a prerequisite that was cancelled or failed while the work it stood
 * for still needs doing strands every dependent in `ready: 0` - a `stopped` dependency
 * never satisfies. `reschedule` is the "run it again" way out (its twin being
 * `complete(..., satisfyDependents)`, the "it already landed" way out). It must put the
 * task back into a CLEAN backlog row so the relaunch is not poisoned by a stale outcome or
 * a dead branch, must re-enable it so the autopilot it was filed for can take it, and must
 * refuse a task that is done or still live rather than resurrecting settled work.
 *
 * HARNESS_HOME is set before importing anything that resolves it (openDb refuses the real
 * state dir under the test runner), the ui-config-store preamble.
 */

const home = mkdtempSync(join(tmpdir(), "mission-task-reschedule-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { backlogIndex, blockersFor, deadBlockersFor } = await import("../src/shared/backlog.ts");

after(() => rmSync(home, { recursive: true, force: true }));

function setup() {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  return { registry, tasks };
}

test("a cancelled task is put back into a clean, enabled backlog row", async () => {
  const { registry, tasks } = setup();
  registry.upsertTask(
    mkTask({
      id: "dead",
      status: "cancelled",
      enabled: false,
      outcome: "abandoned",
      outcomeUrl: "https://example.com/x",
      error: "stopped",
      completedAt: 999,
      dispatchedAt: 500,
    }),
  );

  const r = await tasks.reschedule("dead");
  assert.equal(r.ok, true);

  const back = registry.getTask("dead")!;
  assert.equal(back.status, "backlog");
  assert.equal(back.enabled, true, "re-enabled so the autopilot can actually take it");
  assert.equal(back.outcome, null);
  assert.equal(back.outcomeUrl, null);
  assert.equal(back.error, null);
  assert.equal(back.completedAt, null);
  assert.equal(back.dispatchedAt, null);
});

test("rescheduling turns a dependent's dead block into an ordinary wait", async () => {
  const { registry, tasks } = setup();
  registry.upsertTask(mkTask({ id: "dead", title: "Phase 2", status: "cancelled" }));
  registry.upsertTask(mkTask({ id: "dep", title: "Phase 5" }));
  const plan = {
    entries: [{ taskId: "dep", dependsOn: ["dead"], reason: null }],
    note: null,
    generatedAt: 0,
  };

  // Before: the dependent is DEAD-blocked - stuck forever until a human acts.
  const dep = registry.getTask("dep")!;
  assert.deepEqual(
    deadBlockersFor(dep, backlogIndex(registry.listTasks(), plan)).map((t) => t.id),
    ["dead"],
  );

  await tasks.reschedule("dead");

  // After: still blocked, but now WAITING on live work rather than stopped - the block
  // will clear when the rescheduled task runs, and there is nothing dead left to act on.
  const index = backlogIndex(registry.listTasks(), plan);
  const depAfter = registry.getTask("dep")!;
  assert.deepEqual(deadBlockersFor(depAfter, index), [], "no dead task left to resolve");
  const blockers = blockersFor(depAfter, plan, registry.listTasks());
  assert.equal(blockers.length, 1, "still gated by the prerequisite it must wait for");
  assert.equal(blockers[0]!.state, "waiting", "but now it is on its way, not stopped");
});

test("a failed task is reschedulable too", async () => {
  const { registry, tasks } = setup();
  registry.upsertTask(mkTask({ id: "f", status: "failed", error: "boom" }));
  const r = await tasks.reschedule("f");
  assert.equal(r.ok, true);
  assert.equal(registry.getTask("f")!.status, "backlog");
});

test("a done task is refused - its result is recorded, not re-run", async () => {
  const { registry, tasks } = setup();
  registry.upsertTask(mkTask({ id: "d", status: "done", outcome: "shipped" }));
  const r = await tasks.reschedule("d");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /done/);
  assert.equal(registry.getTask("d")!.status, "done", "left untouched");
});

test("a running task is refused - it is already on its way", async () => {
  const { registry, tasks } = setup();
  registry.upsertTask(mkTask({ id: "r", status: "running" }));
  const r = await tasks.reschedule("r");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /running/);
});

test("rescheduling a task that does not exist is a plain refusal", async () => {
  const { tasks } = setup();
  const r = await tasks.reschedule("nope");
  assert.equal(r.ok, false);
  assert.equal(r.error, "no such task");
});
