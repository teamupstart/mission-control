import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask as baseTask } from "./helpers/session-fixture.ts";
import type { Task } from "../src/shared/types.ts";

// The destructive half of the `tmux_session` -> `home_name` migration. `reconcileOnStartup`
// runs `git worktree remove --force` when it decides an agent's home is gone, so the one
// thing it must never do is read a MISSING home name as "gone". Across the rename an
// unmigrated or unreadable value reads as absent, and the daemon cannot tell that apart from
// a task that genuinely never got a home - so an absent name fails SAFE: the worktree is
// kept and the task is surfaced for the operator, rather than reclaimed by omission.
//
// This is the deterministic half (a null home short-circuits before `homeAlive`, which
// terminal-home.test.ts covers for the resolvable cases). The reconcile runs from the
// TaskManager constructor over whatever the registry already holds.

const home = mkdtempSync(join(tmpdir(), "mission-reconcile-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const mkTask = (over: Partial<Task> = {}): Task => baseTask({ ...over });

/** Build a registry holding `t`, then let a fresh TaskManager reconcile it on construction. */
async function reconciled(t: Task): Promise<InstanceType<typeof Registry>> {
  const r = new Registry();
  r.upsertTask(t);
  // The constructor iterates listTasks() and reconciles each resource-holding one.
  new TaskManager(r);
  // A null-home task short-circuits before any await, so the reconcile settles synchronously;
  // drain the microtask queue anyway so this does not depend on that staying true.
  await new Promise((res) => setImmediate(res));
  return r;
}

test("a running task with no home name keeps its worktree - never reclaimed", async () => {
  const r = await reconciled(
    mkTask({ id: "run-1", status: "running", homeName: null, worktreePath: "/wt/run-1", sessionId: "s1" }),
  );
  const t = r.getTask("run-1")!;
  // Not reclaimed: worktreePath intact, status untouched. A wrong `false` here would have
  // force-removed /wt/run-1 and blanked these fields.
  assert.equal(t.worktreePath, "/wt/run-1");
  assert.equal(t.status, "running");
});

test("a dispatching task with no home name is surfaced but its worktree is kept", async () => {
  const r = await reconciled(
    mkTask({ id: "disp-1", status: "dispatching", homeName: null, worktreePath: "/wt/disp-1" }),
  );
  const t = r.getTask("disp-1")!;
  // Surfaced, not reclaimed: it fails with actionable guidance and KEEPS its tree, so the
  // operator can Focus or Cancel rather than finding the checkout already gone.
  assert.equal(t.status, "failed");
  assert.match(t.error ?? "", /Focus or Cancel/i);
  assert.equal(t.worktreePath, "/wt/disp-1");
});
