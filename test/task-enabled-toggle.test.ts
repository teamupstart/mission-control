import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { QueueManager } from "../src/server/queue.ts";
import type { Task } from "../src/shared/types.ts";

// Throwaway state dir, set before anything opens the DB - see tasks-db.test.ts.
const home = mkdtempSync(join(tmpdir(), "mission-task-enabled-"));
process.env.HARNESS_HOME = home;
const db = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { buildApp } = await import("../src/server/routes.ts");

after(() => rmSync(home, { recursive: true, force: true }));

/**
 * The backlog's enable/disable toggle, from the wire down to the column.
 *
 * Three things are at stake here and none of them is the flag itself.
 *
 * It has to SURVIVE. A hold that a daemon restart quietly forgets is worse than no hold
 * at all: the operator parked the item, closed the laptop, and the autopilot launched it
 * overnight anyway. That is what the column and its default exist for, and the default
 * has to be the OTHER way for rows written before the column existed - a migration that
 * backfilled 0 would park every operator's whole backlog on upgrade, with the autopilot
 * going silent and nothing on screen saying why.
 *
 * It has to be GUARDED like a provisioning field, not exempted like annotation. There is
 * no scheduling decision left to take about a task whose agent is already running, so a
 * patch that answered 200 to "disable this" would tell a caller they had paused
 * something they had not.
 *
 * And it must not become a refusal of the OPERATOR. The toggle speaks for the machine:
 * the button you press yourself still launches a parked item, the same way it launches
 * one the planner thinks is waiting its turn.
 */

function setup(over: Partial<Task> = {}) {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  registry.upsertTask(mkTask({ id: "t1", status: "backlog", ...over }));
  const app = buildApp(registry, {} as unknown as ReviewManager, tasks, {} as unknown as QueueManager);
  const patch = async (body: unknown): Promise<Response> =>
    app.request("/api/tasks/t1/update", {
      method: "POST",
      headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { registry, tasks, app, patch };
}

// ---- persistence ---------------------------------------------------------------------

test("a parked task is still parked after a restart", () => {
  db.upsertTask(mkTask({ id: "persist-off", enabled: false }));
  assert.equal(db.getTask("persist-off")!.enabled, false);
  // Re-read through a fresh Registry, which is what a restart actually does.
  assert.equal(new Registry().getTask("persist-off")!.enabled, false);

  db.upsertTask({ ...db.getTask("persist-off")!, enabled: true });
  assert.equal(db.getTask("persist-off")!.enabled, true);
});

test("a row written before the column existed is schedulable, not parked", () => {
  // The migration's DEFAULT 1 is the whole point, so it is exercised the way an upgrade
  // hits it: a row inserted without naming the column at all.
  const d = db.openDb();
  d.prepare(
    `INSERT INTO tasks (id, title, intent, kind, agent, repo_root, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("legacy-1", "Filed before the toggle", "do the thing", "ship", "claude", "/repo", "backlog", 1, 1);
  assert.equal(db.getTask("legacy-1")!.enabled, true);
});

// ---- the wire ------------------------------------------------------------------------

test("the toggle round-trips through the update route", async () => {
  const { registry, patch } = setup();
  assert.equal(registry.getTask("t1")!.enabled, true);

  const off = await patch({ enabled: false });
  assert.equal(off.status, 200);
  assert.equal(registry.getTask("t1")!.enabled, false);

  const on = await patch({ enabled: true });
  assert.equal(on.status, 200);
  assert.equal(registry.getTask("t1")!.enabled, true);
});

test("an omitted key leaves the toggle alone", async () => {
  // Every other field on this patch merges over the stored row, and this one has to as
  // well: the dispatch modal restates the whole task on save, and the board's priority
  // picker restates none of it - neither may un-park an item as a side effect.
  const { registry, patch } = setup({ enabled: false });
  assert.equal((await patch({ priority: "high" })).status, 200);
  assert.equal(registry.getTask("t1")!.enabled, false);
  assert.equal(registry.getTask("t1")!.priority, "high");
});

test("disabling a task that already left the backlog is refused, not silently accepted", async () => {
  const { registry, patch } = setup({ status: "running" });
  const res = await patch({ enabled: false });
  assert.equal(res.status, 409);
  assert.equal(registry.getTask("t1")!.enabled, true);
});

test("priority stays annotation - a running task can still be retriaged", async () => {
  // The counterpart to the case above, pinned together so the split cannot quietly
  // widen: adding `enabled` to the guarded set must not drag priority in with it.
  const { registry, patch } = setup({ status: "running" });
  assert.equal((await patch({ priority: "blocker" })).status, 200);
  assert.equal(registry.getTask("t1")!.priority, "blocker");
});

test("a non-boolean is refused by the schema, not coerced", async () => {
  const { registry, patch } = setup();
  assert.equal((await patch({ enabled: "no" })).status, 400);
  assert.equal(registry.getTask("t1")!.enabled, true);
});

// ---- the hold is on the machine, not on you ------------------------------------------

test("a task created through the manager is schedulable", () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const created = tasks.create({
    repoRoot: "/repo",
    intent: "do the thing",
    title: "Explicit title, so nothing is titled asynchronously",
    kind: "ship",
    agent: "claude",
    backlog: true,
  });
  assert.equal(created.enabled, true);
});

test("a parked task carries no dependency blocker of its own", () => {
  // What stops the autopilot is `readyBacklog`, not a synthetic blocker - and the
  // difference is visible here, on the check every manual dispatch path runs. Modelling
  // the hold as a blocker would have refused the operator's own button too.
  const { tasks } = setup({ enabled: false });
  assert.deepEqual(tasks.dependencyBlockers(tasks.get("t1")!), []);
});

test("a stale worker cannot dispatch or assign a parked task without an override", async () => {
  const { registry, tasks, app } = setup({ enabled: false });
  let dispatched = 0;
  const inner = tasks as unknown as { dispatcher: { dispatch(id: string): Promise<void> } };
  inner.dispatcher.dispatch = async () => {
    dispatched++;
  };
  const post = (body: unknown): Promise<Response> =>
    app.request("/api/tasks/t1/dispatch", {
      method: "POST",
      headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const legacyDispatch = await post({});
  assert.equal(legacyDispatch.status, 409);
  assert.match((await legacyDispatch.json() as { error: string }).error, /toggle.*off.*override/);
  assert.equal(dispatched, 0);
  assert.equal(registry.getTask("t1")!.status, "backlog");

  const legacyAssign = await app.request("/api/tasks/t1/assign", {
    method: "POST",
    headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "legacy-worker-session" }),
  });
  assert.equal(legacyAssign.status, 409);
  assert.match((await legacyAssign.json() as { error: string }).error, /toggle.*off.*override/);

  const manual = await post({ overrideDisabled: true });
  assert.equal(manual.status, 200);
  assert.equal(dispatched, 1);
});

test("an enabled backlog task needs no disabled-toggle override", async () => {
  const { tasks, app } = setup();
  let dispatched = 0;
  const inner = tasks as unknown as { dispatcher: { dispatch(id: string): Promise<void> } };
  inner.dispatcher.dispatch = async () => {
    dispatched++;
  };

  const response = await app.request("/api/tasks/t1/dispatch", {
    method: "POST",
    headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 200);
  assert.equal(dispatched, 1);
});
