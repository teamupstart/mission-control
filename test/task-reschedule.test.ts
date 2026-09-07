import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";
import type { QueueManager } from "../src/server/queue.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { TaskArchiveGate } from "../src/server/tasks.ts";

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
const { buildApp } = await import("../src/server/routes.ts");
const { backlogIndex, blockersFor, deadBlockersFor } = await import("../src/shared/backlog.ts");

after(() => rmSync(home, { recursive: true, force: true }));

function setup() {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  return { registry, tasks };
}

/** Hold reschedule inside its real pre-teardown archive boundary without probing host terminals. */
function setupPausedCleanup() {
  const registry = new Registry();
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const archives: TaskArchiveGate = {
    ensureReady: async () => ({ ok: true }),
    settleBeforeCleanup: async () => {
      entered();
      await paused;
      return { ok: true };
    },
  };
  const tasks = new TaskManager(registry, undefined, undefined, undefined, archives);
  return { registry, tasks, entered: waiting, release };
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

test("rescheduling does not resurrect a task removed during resource teardown", async () => {
  const { registry, tasks, entered, release } = setupPausedCleanup();
  registry.upsertTask(mkTask({
    id: "removed-during-teardown",
    status: "failed",
  }));

  const pending = tasks.reschedule("removed-during-teardown");
  await entered;
  registry.removeTask("removed-during-teardown");
  release();
  const r = await pending;

  assert.deepEqual(r, { ok: false, error: "no such task" });
  assert.equal(registry.getTask("removed-during-teardown"), undefined);

  registry.upsertTask(mkTask({ id: "removed-during-teardown", status: "failed" }));
  assert.equal((await tasks.reschedule("removed-during-teardown")).ok, true);
});

test("a reschedule reservation refuses duplicate reschedules and every completion", async () => {
  const { registry, tasks, entered, release } = setupPausedCleanup();
  registry.upsertTask(mkTask({
    id: "resolving",
    status: "failed",
  }));

  const pending = tasks.reschedule("resolving");
  await entered;
  const duplicate = await tasks.reschedule("resolving");
  assert.deepEqual(duplicate, { ok: false, error: "task is being rescheduled" });
  // The stopped-only dead-blocker completion is refused...
  await assert.rejects(
    () => tasks.complete("resolving", "landed", undefined, true, true),
    /task is being rescheduled/,
  );
  // ...and so is an ORDINARY completion (Inspector round 1): otherwise a Mark done
  // mid-teardown would flip the row to done while reschedule tears its worktree out from
  // under it, leaving a done task pointing at reclaimed resources.
  await assert.rejects(
    () => tasks.complete("resolving", "landed elsewhere"),
    /task is being rescheduled/,
  );
  assert.equal(registry.getTask("resolving")!.status, "failed");

  release();
  assert.equal((await pending).ok, true);
  assert.equal(registry.getTask("resolving")!.status, "backlog");
});

test("rescheduling does not overwrite a status changed during resource teardown", async () => {
  const { registry, tasks, entered, release } = setupPausedCleanup();
  registry.upsertTask(mkTask({
    id: "completed-during-teardown",
    status: "failed",
  }));

  const pending = tasks.reschedule("completed-during-teardown");
  await entered;
  const current = registry.getTask("completed-during-teardown")!;
  registry.upsertTask({ ...current, status: "done", outcome: "finished elsewhere" });
  release();
  const r = await pending;

  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /task is done/);
  assert.equal(registry.getTask("completed-during-teardown")!.status, "done");
  assert.equal(registry.getTask("completed-during-teardown")!.outcome, "finished elsewhere");
});

test("the reschedule route validates an empty body before mutating", async () => {
  const { registry, tasks } = setup();
  registry.upsertTask(mkTask({ id: "wire", status: "cancelled" }));
  const app = buildApp(
    registry,
    {} as ReviewManager,
    tasks,
    {} as QueueManager,
  );

  const stray = await app.request("/api/tasks/wire/reschedule", {
    method: "POST",
    headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
    body: JSON.stringify({ force: true }),
  });
  assert.equal(stray.status, 400);
  assert.equal(registry.getTask("wire")!.status, "cancelled");

  const empty = await app.request("/api/tasks/wire/reschedule", {
    method: "POST",
    headers: { host: "127.0.0.1:7317" },
  });
  assert.equal(empty.status, 200);
  assert.equal(registry.getTask("wire")!.status, "backlog");
});
