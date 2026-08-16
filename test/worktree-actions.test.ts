import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/server/db.ts";
import { Registry } from "../src/server/registry.ts";
import { TaskManager } from "../src/server/tasks.ts";
import { stubRun } from "../src/server/util/exec.ts";
import { WorktreeManager } from "../src/server/worktrees/manager.ts";
import { WorktreeOperationsService } from "../src/server/worktrees/operations.ts";
import { CheckLeaseManager } from "../src/server/workflows/check-lease.ts";
import {
  LegacyTreehouseAdapter,
  LegacyTreehouseService,
} from "../src/server/worktrees/legacy-treehouse.ts";
import type { WorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";
import { mkTask } from "./helpers/session-fixture.ts";

type Run = typeof import("../src/server/util/exec.ts").run;

const db = openDb();
const changed: number[] = [];
const occupancy = (paths: readonly string[]): Promise<Map<string, WorktreeOccupancy>> =>
  Promise.resolve(new Map(paths.map((path) => [path, { status: "known", occupants: [] }])));
const manager = new WorktreeManager(db, {
  occupancy,
  resolvePolicy: () => ({ enabled: true, maxSlots: 2, setupArgv: null }),
  publishChanged: () => changed.push(Date.now()),
});
const checks = new CheckLeaseManager(db, { manager, legacy: new LegacyTreehouseService(db) });
const operations = new WorktreeOperationsService(manager, {
  legacy: new LegacyTreehouseService(db),
  tasks: { get: () => null, reclaim: async () => ({ ok: false, error: "unexpected task" }) },
  checks,
  checkRecovery: async () => "unknown",
  notifyChanged: () => changed.push(Date.now()),
  diskBytes: async () => 1024,
});

after(() => db.exec("DELETE FROM task_repos; DELETE FROM tasks; DELETE FROM worktree_slots; DELETE FROM worktree_pools; DELETE FROM app_config WHERE key = 'worktrees';"));

test("preview tokens bind exact state, require acknowledgements, and are single use", async () => {
  const { clone } = mkOriginAndClone("mission-worktree-action-");
  const acquired = await manager.acquire({
    repositoryPath: clone,
    baseSha: gitIn(clone, "rev-parse", "HEAD"),
    owner: { kind: "manual", key: "manual-action" },
  });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;

  const dirtyPath = join(acquired.lease.path, "keep-me.txt");
  writeFileSync(dirtyPath, "uncommitted\n");
  const preview = await operations.preview({ action: "return", slotId: acquired.lease.slotId });
  assert.equal(preview.allowed, true, preview.blockers.join("; "));
  assert.deepEqual(preview.requiredAcknowledgements, ["dirty"]);
  await assert.rejects(
    operations.execute(preview.token, []),
    (error: unknown) => error instanceof Error && /missing acknowledgement/.test(error.message),
  );
  await assert.rejects(
    operations.execute(preview.token, ["dirty"]),
    (error: unknown) => error instanceof Error && /expired|valid/.test(error.message),
    "a refused execute still consumes the token",
  );

  const overAcknowledged = await operations.preview({ action: "return", slotId: acquired.lease.slotId });
  await assert.rejects(
    operations.execute(overAcknowledged.token, ["dirty", "unlanded"]),
    (error: unknown) => error instanceof Error && /unexpected acknowledgement/.test(error.message),
    "an acknowledgement the preview did not require cannot become a later destructive override",
  );

  const accepted = await operations.preview({ action: "return", slotId: acquired.lease.slotId });
  assert.deepEqual(await operations.execute(accepted.token, ["dirty"]), {
    ok: true,
    action: "return",
    message: "Worktree returned to warm capacity.",
  });
  assert.equal(manager.lookupLease({ leaseId: acquired.lease.leaseId }).state, "released");
  assert.equal(changed.length > 0, true);
  assert.equal(existsSync(dirtyPath), false, "fixture file was removed by the manager reset");
});

test("safe prune removes only a fixed clean, merged, unreferenced candidate", async () => {
  const { clone } = mkOriginAndClone("mission-worktree-prune-");
  const acquired = await manager.acquire({
    repositoryPath: clone,
    baseSha: gitIn(clone, "rev-parse", "HEAD"),
    owner: { kind: "manual", key: "manual-prune" },
  });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  assert.equal((await manager.release(acquired.lease, { ownerAuthorized: true, requireClean: true })).outcome, "released");

  const preview = await operations.preview({ action: "prune", poolId: acquired.lease.poolId, mode: "safe" });
  assert.equal(preview.allowed, true);
  assert.equal(preview.affected.some((target) => target.id === acquired.lease.slotId), true);
  await operations.execute(preview.token, []);
  assert.equal(manager.store.slot(acquired.lease.slotId), null);
});

test("pool Destroy binds a fixed slot set and emits one completed-action invalidation", async () => {
  const { clone } = mkOriginAndClone("mission-worktree-pool-destroy-");
  const head = gitIn(clone, "rev-parse", "HEAD");
  const first = await manager.acquire({ repositoryPath: clone, baseSha: head, owner: { kind: "manual", key: "pool-destroy-1" } });
  const second = await manager.acquire({ repositoryPath: clone, baseSha: head, owner: { kind: "manual", key: "pool-destroy-2" } });
  assert.equal(first.outcome, "acquired");
  assert.equal(second.outcome, "acquired");
  if (first.outcome !== "acquired" || second.outcome !== "acquired") return;
  await manager.release(first.lease, { ownerAuthorized: true, requireClean: true });
  await manager.release(second.lease, { ownerAuthorized: true, requireClean: true });

  const preview = await operations.preview({
    action: "destroy",
    target: { kind: "pool", poolId: first.lease.poolId },
  });
  assert.equal(preview.allowed, true);
  assert.deepEqual(new Set(preview.affected.map((target) => target.id)), new Set([first.lease.slotId, second.lease.slotId]));
  const before = changed.length;
  await operations.execute(preview.token, []);
  assert.equal(changed.length, before + 1);
  assert.equal(manager.store.slot(first.lease.slotId), null);
  assert.equal(manager.store.slot(second.lease.slotId), null);
});

test("a changed slot version invalidates the preview before any action runs", async () => {
  const { clone } = mkOriginAndClone("mission-worktree-stale-");
  const acquired = await manager.acquire({
    repositoryPath: clone,
    baseSha: gitIn(clone, "rev-parse", "HEAD"),
    owner: { kind: "manual", key: "manual-stale" },
  });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  const preview = await operations.preview({ action: "return", slotId: acquired.lease.slotId });
  manager.store.updateObserved(acquired.lease.slotId, acquired.lease.baseSha, "new observation", Date.now());
  await assert.rejects(
    operations.execute(preview.token, []),
    (error: unknown) => error instanceof Error && /changed after preview/.test(error.message),
  );
});

test("task and check slots delegate cleanup to their domain owners", async () => {
  const taskRepo = mkOriginAndClone("mission-worktree-task-action-").clone;
  const taskLease = await manager.acquire({
    repositoryPath: taskRepo,
    baseSha: gitIn(taskRepo, "rev-parse", "HEAD"),
    owner: { kind: "task", key: "task-settings:0" },
  });
  assert.equal(taskLease.outcome, "acquired");
  if (taskLease.outcome !== "acquired") return;
  let taskReclaimed = false;
  const delegated = new WorktreeOperationsService(manager, {
    legacy: new LegacyTreehouseService(db),
    tasks: {
      get: (id) => id === "task-settings" ? { id, title: "Settings task" } : null,
      reclaim: async (id) => {
        taskReclaimed = id === "task-settings";
        const released = await manager.release(taskLease.lease, { ownerAuthorized: true });
        return { ok: released.outcome === "released", ...("reason" in released ? { error: released.reason } : {}) };
      },
    },
    checks,
    checkRecovery: async () => "empty",
    notifyChanged: () => changed.push(Date.now()),
    diskBytes: async () => 0,
  });
  const taskPreview = await delegated.preview({ action: "return", slotId: taskLease.lease.slotId });
  assert.equal(taskPreview.allowed, true);
  await delegated.execute(taskPreview.token, []);
  assert.equal(taskReclaimed, true);

  const checkRepo = mkOriginAndClone("mission-worktree-check-action-").clone;
  const attemptId = "check-settings";
  await checks.acquireForAttempt({
    attemptId,
    submissionId: "submission-settings",
    nodeId: "node-settings",
    repoRoot: checkRepo,
    headSha: gitIn(checkRepo, "rev-parse", "HEAD"),
  });
  const checkSlot = (await manager.status()).flatMap((pool) => pool.slots)
    .find((slot) => slot.slot.activeOwnerKind === "check" && slot.slot.activeOwnerKey === attemptId)!;
  const active = await delegated.preview({ action: "return", slotId: checkSlot.slot.id });
  assert.equal(active.allowed, false);
  assert.match(active.blockers.join(" "), /still active/);

  checks.handOffForReclaim(attemptId);
  const recoverable = await delegated.preview({ action: "return", slotId: checkSlot.slot.id });
  assert.equal(recoverable.allowed, true);
  await delegated.execute(recoverable.token, []);
  assert.equal(checks.unresolvedLeaseForNode("submission-settings", "node-settings"), false);
});

test("legacy task Return reaches the exact conditional adapter through TaskManager", async () => {
  const registry = new Registry();
  const repoRoot = "/repo/settings-legacy-task";
  const path = "/treehouse/settings-legacy-task/repo";
  const leaseId = "settings-legacy-lease";
  const calls: string[][] = [];
  let returned = false;
  const execute: Run = async (_bin, args) => {
    calls.push([...args]);
    if (args[0] === "--version") {
      return stubRun({ stdout: "v2.1.1\n", stderr: "", code: 0 });
    }
    if (args[0] === "status" && args[1] === "--json") {
      return stubRun({
        stdout: JSON.stringify(returned ? [] : [{
          name: "1",
          path,
          status: "leased",
          lease_id: leaseId,
          lease_holder: "mission-control",
          leased_at: "2026-08-16T12:00:00Z",
          processes: [],
        }]),
        stderr: "",
        code: 0,
      });
    }
    if (args[0] === "return") {
      returned = true;
      return stubRun({ stdout: "", stderr: "", code: 0 });
    }
    assert.fail(`unexpected Treehouse command: ${args.join(" ")}`);
  };
  const legacy = new LegacyTreehouseService(db, {
    adapter: new LegacyTreehouseAdapter({ execute, present: () => true }),
    occupancy,
    git: {
      inspect: async (target) => ({
        ok: true as const,
        value: {
          path: target,
          head: "a".repeat(40),
          dirty: false,
          commonDirectory: repoRoot,
        },
      }),
    },
  });
  const tasks = new TaskManager(
    registry,
    undefined,
    undefined,
    undefined,
    undefined,
    {},
    manager,
    legacy,
  );
  registry.upsertTask(mkTask({
    id: "settings-legacy-task",
    title: "Drain the exact legacy task",
    repoRoot,
    status: "done",
    provider: "treehouse",
    worktreePath: path,
    worktreeLeaseId: leaseId,
    completedAt: 1,
  }));
  const delegated = new WorktreeOperationsService(manager, {
    legacy,
    tasks: {
      get: (id) => {
        const task = registry.getTask(id);
        return task ? { id: task.id, title: task.title } : null;
      },
      reclaim: (id) => tasks.reclaim(id),
    },
    checks,
    checkRecovery: async () => "unknown",
    notifyChanged: () => changed.push(Date.now()),
    diskBytes: async () => 0,
  });

  const preview = await delegated.preview({
    action: "legacyReturn",
    owner: { kind: "task", id: "settings-legacy-task", position: 0 },
  });
  assert.equal(preview.allowed, true, preview.blockers.join("; "));
  assert.deepEqual(await delegated.execute(preview.token, []), {
    ok: true,
    action: "legacyReturn",
    message: "Exact legacy lease returned through its domain owner.",
  });
  assert.deepEqual(
    calls.find((args) => args[0] === "return"),
    ["return", "--force", "--if-lease-id", leaseId, "--if-lease-holder", "mission-control", path],
  );
  assert.equal(calls.filter((args) => args[0] === "return").length, 1);
  assert.equal(registry.getTask("settings-legacy-task")?.provider, null);
  assert.equal(registry.getTask("settings-legacy-task")?.worktreePath, null);
  assert.equal(registry.getTask("settings-legacy-task")?.worktreeLeaseId, null);
});
