import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry } from "../../src/server/registry.ts";
import { TaskManager } from "../helpers/task-manager-fixture.ts";
import { mkTask } from "../helpers/session-fixture.ts";
import { taskOwesWorktreeReturn } from "../../src/server/db.ts";

let manager: TaskManager;
let registry: Registry;
let settled = false;

test("a test may finish with an in-flight return owned by its fixture", async () => {
  registry = new Registry();
  manager = new TaskManager(registry, undefined, undefined, undefined, undefined, {
    occupancy: async (paths) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      settled = true;
      return new Map(paths.map((path) => [path, { status: "unknown", reason: "fixture" }]));
    },
  });
  registry.applyDiscovery([]);
  registry.upsertTask(mkTask({ id: "pending", sessionId: null, status: "running", worktreePath: "/fixture/one" }));
  await manager.complete("pending", "finished");
  assert.equal(manager.pendingCleanupJobs, 1);
  // Intentionally no manual teardown: the shared fixture must own it on every test exit.
});

test("the next test starts after the prior manager drains and detaches", async (t) => {
  assert.equal(settled, true);
  assert.equal(manager.pendingCleanupJobs, 0);
  assert.equal(registry.listenerCount("event"), 0);
  assert.equal(taskOwesWorktreeReturn(registry.getTask("pending")!), true);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  // Retained rows are deliberately loaded again. Default fixture evidence must refuse
  // cleanup without consulting the operator's real process table, even across retries.
  for (let index = 0; index < 3; index++) {
    const nextRegistry = new Registry();
    const next = new TaskManager(nextRegistry);
    nextRegistry.applyDiscovery([]);
    await next.settleWorktreeReturns();
    t.mock.timers.tick(30_001);
    await next.sweepMissionSessionClosures();
    await next.settleWorktreeReturns();
    assert.equal(taskOwesWorktreeReturn(nextRegistry.getTask("pending")!), true);
  }
});
