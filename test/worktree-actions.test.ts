import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/server/db.ts";
import { Registry } from "../src/server/registry.ts";
import { TaskManager } from "../src/server/tasks.ts";
import { stubRun } from "../src/server/util/exec.ts";
import { worktreeRepositoryIdentity } from "../src/server/util/git.ts";
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
  const secondaryRepo = mkOriginAndClone("mission-worktree-task-secondary-").clone;
  const secondaryLease = await manager.acquire({
    repositoryPath: secondaryRepo,
    baseSha: gitIn(secondaryRepo, "rev-parse", "HEAD"),
    owner: { kind: "task", key: "task-settings:1" },
  });
  assert.equal(secondaryLease.outcome, "acquired");
  if (secondaryLease.outcome !== "acquired") return;
  writeFileSync(join(secondaryLease.lease.path, "secondary-draft.txt"), "keep this visible\n");
  let taskReclaims = 0;
  const delegated = new WorktreeOperationsService(manager, {
    legacy: new LegacyTreehouseService(db),
    tasks: {
      get: (id) => id === "task-settings"
        ? {
            id,
            title: "Settings task",
            resources: [{
              position: 0,
              repoRoot: taskRepo,
              path: taskLease.lease.path,
              provider: "mission",
              leaseId: taskLease.lease.leaseId,
              branch: null,
            }, {
              position: 1,
              repoRoot: secondaryRepo,
              path: secondaryLease.lease.path,
              provider: "mission",
              leaseId: secondaryLease.lease.leaseId,
              branch: null,
            }],
          }
        : null,
      reclaim: async (id) => {
        if (id === "task-settings") taskReclaims += 1;
        const released = await Promise.all([
          manager.release(taskLease.lease, { ownerAuthorized: true }),
          manager.release(secondaryLease.lease, { ownerAuthorized: true }),
        ]);
        const failure = released.find((result) => result.outcome !== "released");
        return { ok: !failure, ...(failure && "reason" in failure ? { error: failure.reason } : {}) };
      },
    },
    checks,
    checkRecovery: async () => "empty",
    notifyChanged: () => changed.push(Date.now()),
    diskBytes: async () => 0,
  });
  const taskPreview = await delegated.preview({ action: "return", slotId: taskLease.lease.slotId });
  assert.equal(taskPreview.allowed, true);
  assert.deepEqual(
    new Set(taskPreview.affected.map((target) => target.id)),
    new Set([taskLease.lease.slotId, secondaryLease.lease.slotId]),
    "TaskManager's full multi-repository cleanup scope is present in the preview",
  );
  assert.deepEqual(taskPreview.requiredAcknowledgements, ["dirty"]);
  await delegated.execute(taskPreview.token, ["dirty"]);
  assert.equal(taskReclaims, 1, "one task reclaim owns every affected repository");

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

test("task previews bind attached disposable Git risks outside native inventory", async () => {
  const primaryRepo = mkOriginAndClone("mission-worktree-task-git-primary-").clone;
  const gitRepo = mkOriginAndClone("mission-worktree-task-git-secondary-").clone;
  const gitPath = join(gitRepo, "..", "task-git-secondary-worktree");
  const gitIdentity = worktreeRepositoryIdentity(gitRepo);
  assert.ok(gitIdentity);
  let gitDirty = true;
  const occupied = {
    pid: 42,
    ppid: 1,
    startRaw: "task-git-process",
    startMs: 1,
    command: "agent helper",
    cwd: gitPath,
    knownOwner: "task-settings-git",
  };
  const taskOccupancy = (paths: readonly string[]): Promise<Map<string, WorktreeOccupancy>> =>
    Promise.resolve(new Map(paths.map((path) => [
      path,
      { status: "known" as const, occupants: path === gitPath ? [occupied] : [] },
    ])));
  const taskManager = new WorktreeManager(db, {
    occupancy: taskOccupancy,
    resolvePolicy: () => ({ enabled: true, maxSlots: 2, setupArgv: null }),
  });
  const primary = await taskManager.acquire({
    repositoryPath: primaryRepo,
    baseSha: gitIn(primaryRepo, "rev-parse", "HEAD"),
    owner: { kind: "task", key: "task-settings-git:0" },
  });
  assert.equal(primary.outcome, "acquired");
  if (primary.outcome !== "acquired") return;
  let reclaimed = false;
  const delegated = new WorktreeOperationsService(taskManager, {
    legacy: new LegacyTreehouseService(db),
    tasks: {
      get: (id) => id === "task-settings-git"
        ? {
            id,
            title: "Task with disposable secondary",
            resources: [{
              position: 0,
              repoRoot: primaryRepo,
              path: primary.lease.path,
              provider: "mission",
              leaseId: primary.lease.leaseId,
              branch: null,
            }, {
              position: 1,
              repoRoot: gitRepo,
              path: gitPath,
              provider: "git",
              leaseId: null,
              branch: "harness/task-settings-git",
            }],
          }
        : null,
      reclaim: async () => {
        reclaimed = true;
        return { ok: true };
      },
    },
    checks,
    checkRecovery: async () => "unknown",
    notifyChanged: () => changed.push(Date.now()),
    diskBytes: async () => 0,
    occupancy: taskOccupancy,
    git: {
      inspect: async (path) => ({
        ok: true,
        value: {
          path,
          head: "a".repeat(40),
          dirty: gitDirty,
          commonDirectory: gitIdentity.gitCommonDirectory,
          detached: true,
        },
      }),
      observedDefaultSha: async () => ({ ok: true, value: "b".repeat(40) }),
      mergedInto: async () => ({ ok: true, value: false }),
    },
  });

  const preview = await delegated.preview({ action: "return", slotId: primary.lease.slotId });
  assert.equal(preview.allowed, true, preview.blockers.join("; "));
  assert.equal(preview.affected.some((target) => target.provider === "git" && target.path === gitPath), true);
  assert.deepEqual(new Set(preview.requiredAcknowledgements), new Set(["dirty", "unlanded"]));
  assert.equal(preview.risks.some((entry) => entry.key === "occupied"), true);
  assert.match(preview.consequences.join(" "), /1 process\(es\).*TaskManager stops its owned agent/);

  gitDirty = false;
  await assert.rejects(
    delegated.execute(preview.token, ["dirty", "unlanded"]),
    (error: unknown) => error instanceof Error && /changed after preview/.test(error.message),
    "a disposable secondary's Git change invalidates the task-wide token",
  );
  assert.equal(reclaimed, false);
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
          detached: true,
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
        if (!task || !task.worktreePath) return null;
        return {
          id: task.id,
          title: task.title,
          resources: [{
            position: 0,
            repoRoot: task.repoRoot,
            path: task.worktreePath,
            provider: task.provider,
            leaseId: task.worktreeLeaseId,
            branch: task.branch,
          }],
        };
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
  const changedBeforeExecute = changed.length;
  assert.deepEqual(await delegated.execute(preview.token, []), {
    ok: true,
    action: "legacyReturn",
    message: "Exact legacy lease returned through its domain owner.",
  });
  assert.equal(changed.length, changedBeforeExecute + 1, "legacy-only success invalidates every open panel once");
  assert.deepEqual(
    calls.find((args) => args[0] === "return"),
    ["return", "--force", "--if-lease-id", leaseId, "--if-lease-holder", "mission-control", path],
  );
  assert.equal(calls.filter((args) => args[0] === "return").length, 1);
  assert.equal(registry.getTask("settings-legacy-task")?.provider, null);
  assert.equal(registry.getTask("settings-legacy-task")?.worktreePath, null);
  assert.equal(registry.getTask("settings-legacy-task")?.worktreeLeaseId, null);
});
