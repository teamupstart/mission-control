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
      worktreeLeaseId: null,
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

test("startup cleanup stays one-deep per repository without delaying disjoint repositories", async () => {
  const registry = new Registry();
  for (let index = 0; index < 8; index += 1) {
    registry.upsertTask(mkTask({
      id: `startup-cleanup-${index}`,
      title: `Startup cleanup ${index}`,
      repoRoot: "/repo/startup-convoy",
      status: "done",
      provider: "treehouse",
      worktreePath: `/pool/startup-convoy/${index}`,
      createdAt: 10_000 + index,
      updatedAt: 10_000 + index,
      completedAt: 10_000 + index,
    }));
  }
  registry.upsertTask(mkTask({
    id: "startup-cleanup-disjoint",
    repoRoot: "/repo/disjoint",
    status: "done",
    provider: "treehouse",
    worktreePath: "/pool/disjoint/1",
  }));

  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let activeSameRepo = 0;
  let maxActiveSameRepo = 0;
  let disjointStarted = false;
  const teardown: NonNullable<ConstructorParameters<typeof TaskManager>[5]>["teardown"] = async (
    task,
    _legacy,
    priority,
  ) => {
    assert.equal(priority, "background");
    if (task.repoRoot === "/repo/disjoint") {
      disjointStarted = true;
      return;
    }
    activeSameRepo += 1;
    maxActiveSameRepo = Math.max(maxActiveSameRepo, activeSameRepo);
    if (task.worktreePath === "/pool/startup-convoy/0") await firstMayFinish;
    activeSameRepo -= 1;
  };

  new TaskManager(
    registry,
    undefined,
    { taskLiveness: () => false } as never,
    undefined,
    undefined,
    { teardown },
  );
  await eventually(() => activeSameRepo === 1 && disjointStarted, "startup cleanup did not begin");
  assert.equal(maxActiveSameRepo, 1);
  releaseFirst();
  await eventually(
    () => registry.listTasks().filter((task) => task.id.startsWith("startup-cleanup-")).every(
      (task) => task.worktreePath === null,
    ),
    "startup cleanup did not drain",
  );
  assert.equal(maxActiveSameRepo, 1);
});
