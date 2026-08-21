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
  // The convoy bound, now measured on the shape restart still tears down on the spot: a task
  // holding only a dead terminal home. A home is not a checkout - there is no Git-visible
  // state in it for the retention clock to observe and no local work in it to protect - so it
  // keeps the immediate reclaim it always had, and it is the honest way to exercise the
  // repository-keyed queue that automatic retention cleanup now shares.
  const registry = new Registry();
  for (let index = 0; index < 8; index += 1) {
    registry.upsertTask(mkTask({
      id: `startup-cleanup-${index}`,
      title: `Startup cleanup ${index}`,
      repoRoot: "/repo/startup-convoy",
      status: "done",
      homeName: `convoy-home-${index}`,
      terminalResourceId: `convoy-res-${index}`,
      createdAt: 10_000 + index,
      updatedAt: 10_000 + index,
      completedAt: 10_000 + index,
    }));
  }
  registry.upsertTask(mkTask({
    id: "startup-cleanup-disjoint",
    repoRoot: "/repo/disjoint",
    status: "done",
    homeName: "disjoint-home",
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
    if (task.homeName === "convoy-home-0") await firstMayFinish;
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
      (task) => task.homeName === null,
    ),
    "startup cleanup did not drain",
  );
  assert.equal(maxActiveSameRepo, 1);
});

test("startup reconciliation holds the cleanup reservation an operator would take", async () => {
  // Re-reading the task inside the queued job is necessary but not sufficient. This job can
  // stop a terminal home and release leases, and an operator pressing Remove, Cancel or Clean
  // up takes the in-process reservation and proceeds - so without the startup job taking it
  // too, both could stop the same home and hand the same lease back twice. Asserted through
  // the operator's own refusal rather than by reading the reservation set.
  const registry = new Registry();
  registry.upsertTask(mkTask({
    id: "startup-reserved",
    repoRoot: "/repo/reserved",
    status: "done",
    homeName: "reserved-home",
    terminalResourceId: "reserved-res",
  }));

  let releaseTeardown!: () => void;
  const mayFinish = new Promise<void>((resolve) => {
    releaseTeardown = resolve;
  });
  let teardownEntered!: () => void;
  const started = new Promise<void>((resolve) => {
    teardownEntered = resolve;
  });
  const teardown: NonNullable<ConstructorParameters<typeof TaskManager>[5]>["teardown"] = async () => {
    teardownEntered();
    await mayFinish;
  };

  const manager = new TaskManager(
    registry,
    undefined,
    { taskLiveness: () => false } as never,
    undefined,
    undefined,
    { teardown },
  );
  await started;

  const refused = await manager.reclaim("startup-reserved");
  assert.equal(refused.ok, false, "an operator reclaim must not run alongside the startup job");
  assert.match(String(refused.error), /already being cleaned up/);

  releaseTeardown();
  await eventually(
    () => registry.getTask("startup-reserved")?.homeName === null,
    "startup reconciliation did not finish",
  );

  // And the reservation is given back afterwards, so the task is operable again rather than
  // wedged shut by the job that finished with it.
  const after = await manager.reclaim("startup-reserved");
  assert.notEqual(
    String(after.error ?? ""),
    "this task's resources are already being cleaned up",
    "the reservation outlived the job that took it",
  );
});

test("a dead agent's checkout is retained on restart, not freed on the spot", async () => {
  // The behaviour change this phase exists for. Before it, a proven-dead terminal home meant
  // `git worktree remove --force` during boot - so a machine reboot destroyed staged work, an
  // afternoon of untracked notes and unpushed commits, and did it before anybody could look.
  // Now the task SETTLES honestly and keeps every resource fact, and the 30-day clock decides.
  const registry = new Registry();
  registry.upsertTask(mkTask({
    id: "restart-retains",
    status: "running",
    dispatchedAt: 5_000,
    repoRoot: "/repo/retained",
    worktreePath: "/pool/retained/1",
    provider: "treehouse",
    homeName: "retained-home",
    terminalResourceId: "retained-res",
    sessionId: "proc:dead",
    extraRepos: [{
      repoRoot: "/repo/attached",
      worktreePath: "/pool/attached/1",
      branch: "b",
      provider: "git",
      worktreeLeaseId: null,
      baseSha: null,
      prUrl: null,
      prState: null,
      mergedAt: null,
    }],
  }));

  let tornDown = 0;
  new TaskManager(
    registry,
    undefined,
    { taskLiveness: () => false } as never,
    undefined,
    undefined,
    { teardown: async () => { tornDown += 1; } },
  );
  await eventually(
    () => registry.getTask("restart-retains")?.status === "failed",
    "the task was never settled",
  );
  const settled = registry.getTask("restart-retains")!;
  assert.equal(tornDown, 0, "restart tore a checkout down");
  assert.equal(settled.error, "the agent's session did not survive a restart");
  assert.equal(settled.worktreePath, "/pool/retained/1", "the primary checkout is retained");
  assert.equal(settled.provider, "treehouse", "its provider is retained, so teardown stays exact");
  assert.equal(settled.extraRepos[0]?.worktreePath, "/pool/attached/1");
  assert.equal(settled.homeName, "retained-home", "terminal ownership is retained for cleanup");
  assert.equal(settled.terminalResourceId, "retained-res");
  // The one fact restart may clear, and only because reconciliation just proved it gone.
  assert.equal(settled.sessionId, null);
});

test("an attached-only survivor is reconciled and settled rather than left invisible", async () => {
  // A multi-repo teardown that released the primary and failed on the second repository leaves
  // a terminal task with a null primary path and a real checkout still on disk. Reading the
  // primary alone meant nothing reconciled that survivor on restart at all.
  const registry = new Registry();
  registry.upsertTask(mkTask({
    id: "restart-attached-only",
    status: "running",
    dispatchedAt: 6_000,
    repoRoot: "/repo/primary-gone",
    worktreePath: null,
    provider: null,
    homeName: null,
    sessionId: "proc:dead-2",
    extraRepos: [{
      repoRoot: "/repo/attached-survivor",
      worktreePath: "/pool/attached-survivor/1",
      branch: "b",
      provider: "git",
      worktreeLeaseId: null,
      baseSha: null,
      prUrl: null,
      prState: null,
      mergedAt: null,
    }],
  }));

  let tornDown = 0;
  new TaskManager(
    registry,
    undefined,
    { taskLiveness: () => false } as never,
    undefined,
    undefined,
    { teardown: async () => { tornDown += 1; } },
  );
  await eventually(
    () => registry.getTask("restart-attached-only")?.status === "failed",
    "the attached-only survivor was never reconciled",
  );
  assert.equal(tornDown, 0);
  assert.equal(
    registry.getTask("restart-attached-only")?.extraRepos[0]?.worktreePath,
    "/pool/attached-survivor/1",
  );
});

test("live or unknown ownership is left completely alone", async () => {
  const registry = new Registry();
  registry.upsertTask(mkTask({
    id: "restart-alive",
    status: "running",
    dispatchedAt: 7_000,
    worktreePath: "/pool/alive/1",
    provider: "treehouse",
    homeName: "alive-home",
    sessionId: "proc:alive",
  }));
  let tornDown = 0;
  new TaskManager(
    registry,
    undefined,
    { taskLiveness: () => true } as never,
    undefined,
    undefined,
    { teardown: async () => { tornDown += 1; } },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const task = registry.getTask("restart-alive")!;
  assert.equal(tornDown, 0);
  assert.equal(task.status, "running");
  assert.equal(task.sessionId, "proc:alive", "a live session's binding is never cleared");
});
