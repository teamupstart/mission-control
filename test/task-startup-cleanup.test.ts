import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "mission-startup-cleanup-"));
process.env.HARNESS_HOME = home;

const { Registry } = await import("../src/server/registry.ts");
const {
  INTERRUPTED_BEFORE_PROVISION_ERROR,
  TaskManager,
} = await import("../src/server/tasks.ts");
const { teardownWorktree } = await import("../src/server/dispatcher.ts");
const { withPoolLock } = await import("../src/server/pool-lease.ts");

after(() => rmSync(home, { recursive: true, force: true }));

async function eventually(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test("a restart returns a resource-free dispatch with stale branch metadata to the backlog", async () => {
  const registry = new Registry();
  registry.upsertTask(mkTask({
    id: "interrupted-before-provision",
    title: "Retry the interrupted dispatch",
    status: "dispatching",
    dispatchedAt: 900,
    branch: "harness/stale-primary-metadata",
    baseSha: "a".repeat(40),
    extraRepos: [{
      repoRoot: "/repo/attached",
      worktreePath: null,
      branch: "harness/stale-attached-metadata",
      provider: null,
      baseSha: "b".repeat(40),
      prUrl: null,
      prState: null,
      mergedAt: null,
    }],
  }));

  new TaskManager(registry);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const recovered = registry.getTask("interrupted-before-provision")!;
  assert.equal(recovered.status, "backlog");
  assert.equal(recovered.error, INTERRUPTED_BEFORE_PROVISION_ERROR);
  assert.equal(recovered.dispatchedAt, null, "the next launch gets its own dispatch boundary");
  assert.equal(recovered.worktreePath, null);
  assert.equal(recovered.provider, null);
  assert.equal(recovered.homeName, null);
  assert.equal(recovered.terminalResourceId, null);
  assert.equal(recovered.sessionId, null);
  assert.equal(recovered.branch, "harness/stale-primary-metadata");
  assert.equal(recovered.extraRepos[0]?.branch, "harness/stale-attached-metadata");
});

test("foreground acquisition passes cleanup already waiting in the background lane", async () => {
  const repoRoot = "/repo/pool-priority";
  const order: string[] = [];
  let releaseActive!: () => void;
  let markActive!: () => void;
  const activeMayFinish = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
  const activeStarted = new Promise<void>((resolve) => {
    markActive = resolve;
  });

  const activeCleanup = withPoolLock(repoRoot, async () => {
    order.push("active-cleanup");
    markActive();
    await activeMayFinish;
  }, "background");
  await activeStarted;
  const queuedCleanup = withPoolLock(repoRoot, async () => {
    order.push("queued-cleanup");
  }, "background");
  const acquisition = withPoolLock(repoRoot, async () => {
    order.push("acquisition");
  });

  releaseActive();
  await Promise.all([activeCleanup, queuedCleanup, acquisition]);

  assert.deepEqual(order, ["active-cleanup", "acquisition", "queued-cleanup"]);
});

test("large startup cleanup stays one-deep per repo and yields its next lock turn to acquisition", async () => {
  const registry = new Registry();
  const repoRoot = "/repo/startup-convoy";
  const taskCount = 40;
  for (let index = 0; index < taskCount; index += 1) {
    registry.upsertTask(mkTask({
      id: `startup-cleanup-${index}`,
      title: `Startup cleanup ${index}`,
      repoRoot,
      status: "done",
      provider: "treehouse",
      worktreePath: `/pool/startup-convoy/${index}`,
      branch: `tree-${index}`,
      createdAt: 10_000 + index,
      updatedAt: 10_000 + index,
      completedAt: 10_000 + index,
    }));
  }

  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const order: string[] = [];
  let teardownCalls = 0;
  let activeCleanups = 0;
  let maxActiveCleanups = 0;
  const startupTeardown: typeof teardownWorktree = async (task, _cli, priority) => {
    teardownCalls += 1;
    assert.equal(priority, "background", "startup returns must enter the background lane");
    await withPoolLock(task.repoRoot, async () => {
      activeCleanups += 1;
      maxActiveCleanups = Math.max(maxActiveCleanups, activeCleanups);
      order.push(`cleanup-start:${task.worktreePath}`);
      if (task.worktreePath === "/pool/startup-convoy/0") await firstMayFinish;
      order.push(`cleanup-end:${task.worktreePath}`);
      activeCleanups -= 1;
    }, priority);
  };
  const supervisor = {
    taskLiveness: () => false,
  } as never;

  new TaskManager(
    registry,
    undefined,
    supervisor,
    undefined,
    undefined,
    { teardown: startupTeardown },
  );
  await eventually(() => teardownCalls > 0, "the first startup cleanup never began");
  assert.equal(
    teardownCalls,
    1,
    "the remaining 39 returns must stay outside the pool lock queue",
  );

  const acquisition = withPoolLock(repoRoot, async () => {
    order.push("acquire");
  });
  releaseFirst();
  await acquisition;
  await eventually(
    () => registry.listTasks().filter((task) => task.id.startsWith("startup-cleanup-")).every(
      (task) => task.worktreePath === null,
    ),
    "startup cleanup did not drain",
  );

  assert.equal(maxActiveCleanups, 1);
  assert.ok(
    order.indexOf("acquire") < order.indexOf("cleanup-start:/pool/startup-convoy/1"),
    `acquisition did not pass queued background cleanup: ${order.join(", ")}`,
  );
  assert.equal(teardownCalls, taskCount);
});
