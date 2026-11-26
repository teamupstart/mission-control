import { SEVEN_DAY_WORKTREE_CLEANUP_FLAG_ID } from "../src/shared/feature-flag-registry.ts";
import { reserveWorktreeCleanup } from "../src/server/worktrees/use-reservation.ts";
import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";
import { gitIn, mkLinkedWorktree, mkOriginAndClone } from "./helpers/git-fixture.ts";
import type { Task } from "../src/shared/types.ts";
import type { TaskManagerStartupDeps } from "../src/server/tasks.ts";
import type { WorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";

const home = mkdtempSync(join(tmpdir(), "mission-task-return-"));
process.env.MISSION_HOME = home;
const { buildApp } = await import("../src/server/routes.ts");
const { disposableWorktreeCensus } = await import("../src/server/worktrees/disposable-census.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { worktreeSlotPath, teardownWorktree } = await import("../src/server/dispatcher.ts");
const { run } = await import("../src/server/util/exec.ts");
const { worktreeReturnBlocker } = await import("../src/server/git/worktree-return-safety.ts");
const { reserveWorktreeUse } = await import("../src/server/worktrees/use-reservation.ts");
const { reserveSessionTransfer, updateSessionTransfer } = await import("../src/server/session-transfers/store.ts");
const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
const { getWorktreesConfig, setWorktreesConfig } = await import("../src/server/worktrees/config.ts");
const { CheckLeaseStore } = await import("../src/server/workflows/check-lease.ts");
const { setSdkSessionStatus, upsertSdkSession } = await import("../src/server/sdk/store.ts");
const {
  getTaskSessionClosure, getTaskWorktreeRetention, openDb, closeDb,
  taskOwesWorktreeReturn, recordTaskWorktreeObservation,
} = await import("../src/server/db.ts");
const {
  TaskWorktreeRetentionObserver, defaultRetentionObserverDeps, defaultRetentionCleanupDeps,
  createDaemonRetentionObserver, taskResourceGeneration, SEVEN_DAY_RETENTION_MS: WEEK, backgroundWorktreeRetentionStatus,
} = await import("../src/server/task-worktree-retention.ts");
after(() => rmSync(home, { recursive: true, force: true }));

const DAY = WEEK / 7;
let sequence = 0;

function checkout(t: TestContext, id: string, position = 0) {
  const { root, clone, origin } = mkOriginAndClone("mission-background-return-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = worktreeSlotPath(id, position);
  mkdirSync(dirname(path), { recursive: true });
  const branch = `harness/${id}`;
  return { origin, repoRoot: clone, worktreePath: mkLinkedWorktree(clone, branch, path),
    branch, provider: "git" as const, worktreeLeaseId: null, baseSha: null,
    prUrl: null, prState: null, mergedAt: null };
}

function world(t: TestContext, opts: {
  status?: Task["status"];
  multiRepo?: boolean;
  deps?: TaskManagerStartupDeps;
  archiveError?: () => boolean;
} = {}) {
  const id = `return-task-${++sequence}`;
  const primary = checkout(t, id);
  const secondary = opts.multiRepo ? checkout(t, id, 1) : null;
  const state = {
    now: 1_900_000_000_000,
    occupancy: { status: "known", occupants: [] } as WorktreeOccupancy,
    stops: 0,
    stopRequests: 0,
  };
  const setup = (observe = true) => {
    const registry = new Registry();
    const supervisor = {
      requestStop: () => { state.stopRequests++; return true; },
      stop: async () => { state.stops++; },
      handleFor: (id: string) => {
        const session = registry.getSession(id);
        return session && session.state !== "exited" ? {} : null;
      },
      taskLiveness: () => null,
    };
    const manager = new TaskManager(registry, undefined, supervisor as never, undefined, {
      ensureReady: async () => ({ ok: true }),
      settleBeforeCleanup: async () => opts.archiveError?.() ? { ok: false, error: "archive unavailable" } : { ok: true },
    }, {
      occupancy: async (paths) => new Map(paths.map((path) => [path, state.occupancy])),
      ...opts.deps,
    });
    const observer = new TaskWorktreeRetentionObserver({
      ...defaultRetentionObserverDeps,
      listTasks: () => registry.listTasks().filter((row) => row.id === id),
      now: () => state.now,
      retentionMs: () => WEEK,
      departure: {
        useBlocker: (task) => manager.backgroundWorktreeUseBlocker(task),
        occupancyBlocker: (task) => manager.backgroundWorktreeOccupancyBlocker(task),
      },
      cleanup: {
        ...defaultRetentionCleanupDeps,
        reclaim: (request) => manager.enqueueRetentionCleanup(request),
        refreshSummary: (taskId) => registry.refreshTaskAutomaticCleanup(taskId),
      },
    });
    const addSession = (id: string, cwd = primary.worktreePath) =>
      registry.registerSdkSession({ id: `sdk:${id}`, agent: "claude", name: id, cwd, initialState: "idle" });
    const exit = (id: string) => {
      registry.applyDriverEvent(id, { kind: "exited", reason: "test stop", resumable: false });
    };
    if (observe) registry.applyDiscovery([]);
    return { registry, manager, observer, addSession, exit, supervisor };
  };

  const first = setup();
  const task = mkTask({ ...primary, id, status: opts.status ?? "done",
    sessionId: null, homeName: null, extraRepos: secondary ? [secondary] : [] });
  first.registry.upsertTask(task);
  return {
    ...first, state, task, primary, secondary, setup,
    row: () => getTaskWorktreeRetention(id),
    path: primary.worktreePath,
  };
}

test("completion closes the agent but waits for linger, the other attached user and seven days", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const w = world(t, { status: "running", multiRepo: true });
  const owner = w.addSession("completion-owner");
  const other = w.addSession("attached-idle", join(w.secondary!.worktreePath, "packages", "test"));
  w.registry.upsertTask({ ...w.task, sessionId: owner.id });
  await w.manager.complete(w.task.id, "shipped");
  assert.equal(w.registry.getTask(w.task.id)?.status, "done");
  assert.ok(getTaskSessionClosure(w.task.id));
  assert.ok(taskOwesWorktreeReturn(w.registry.getTask(w.task.id)!));
  await w.manager.sweepMissionSessionClosures();
  assert.equal(w.state.stops, 1);
  w.exit(owner.id);
  assert.equal(w.registry.getSession(owner.id)?.state, "exited");
  await w.observer.runPass();
  assert.equal(w.row()?.unownedSince, null);
  t.mock.timers.tick(8_000);
  await w.manager.sweepMissionSessionClosures();
  await w.observer.runPass();
  assert.equal(w.row()?.unownedSince, null, "idle subdirectory user on an attachment protects the task");
  w.exit(other.id);
  t.mock.timers.tick(8_000);
  await w.manager.settleWorktreeReturns();
  await w.observer.runPass();
  assert.equal(getTaskSessionClosure(w.task.id), null);
  assert.equal(taskOwesWorktreeReturn(w.registry.getTask(w.task.id)!), false, "retention adopted the return intent");
  assert.equal(w.row()?.cleanupDueAt, w.state.now + WEEK);
  w.state.now += WEEK - 1;
  await w.observer.runPass();
  assert.ok(existsSync(w.path));
  assert.ok(existsSync(w.secondary!.worktreePath));
  w.state.now++;
  await w.observer.runPass();
  assert.equal(existsSync(w.path), false);
  assert.equal(existsSync(w.secondary!.worktreePath), false);
  assert.equal(w.registry.getTask(w.task.id)?.outcome, "shipped");
  assert.equal(w.row(), null);
});

test("Kill retains the checkout across eviction and daemon restart", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const w = world(t, { status: "running" });
  const session = w.addSession("killed-session");
  w.registry.upsertTask({ ...w.task, sessionId: session.id });
  const app = buildApp({
    registry: w.registry, tasks: w.manager, sdkSessions: w.supervisor as never, queues: {} as never, reviews: {} as never,
  });
  const killed = await app.request(`/api/sessions/${session.id}/kill`, {
    method: "POST", headers: { host: "127.0.0.1:7317" },
  });
  assert.equal(killed.status, 200);
  // Accepted stop leaves the active task untouched until the runtime exits.
  assert.equal(w.registry.getSession(session.id)?.state, "idle");
  await w.observer.runPass();
  assert.equal(w.row(), null);
  w.exit(session.id);
  t.mock.timers.tick(8_000);
  await w.manager.settleWorktreeReturns();
  assert.equal(w.registry.getTask(w.task.id)?.status, "failed");
  assert.ok(existsSync(w.path));
  await w.observer.runPass();
  const deadline = w.state.now + WEEK;
  assert.equal(w.row()?.cleanupDueAt, deadline);
  await w.manager.stop();
  closeDb();
  w.state.now += 6 * DAY;

  const restarted = w.setup(false);
  assert.equal(restarted.manager.backgroundWorktreeUseBlocker(w.task), "session discovery has not completed");
  restarted.registry.applyDiscovery([]);
  await restarted.manager.settleWorktreeReturns();
  await restarted.observer.runPass();
  assert.equal(w.row()?.cleanupDueAt, deadline);
  assert.ok(existsSync(w.path));
  w.state.now = deadline;
  await restarted.observer.runPass();
  assert.equal(existsSync(w.path), false);
});

test("unrequested session loss grants the checkout a full seven days after eviction", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const w = world(t, { status: "running" });
  const session = w.addSession("lost-session");
  w.registry.upsertTask({ ...w.task, sessionId: session.id });
  await w.observer.runPass();
  assert.equal(w.row(), null);

  w.registry.applyDriverEvent(session.id, { kind: "exited", reason: "driver connection lost", resumable: false });
  assert.equal(w.registry.getSession(session.id)?.state, "exited");
  t.mock.timers.tick(8_000);
  await w.manager.settleWorktreeReturns();
  assert.equal(w.registry.getSession(session.id), undefined);
  assert.equal(w.registry.getTask(w.task.id)?.status, "failed");

  await w.observer.runPass();
  const deadline = w.state.now + WEEK;
  assert.equal(w.row()?.cleanupDueAt, deadline);
  w.state.now = deadline - 1;
  assert.deepEqual((await w.observer.runPass()).cleanups, {});
  assert.equal(w.row()?.lastAttemptAt, null);
  assert.ok(existsSync(w.path));

  w.state.now = deadline;
  assert.deepEqual((await w.observer.runPass()).cleanups, { reclaimed: 1 });
  assert.equal(existsSync(w.path), false);
  assert.equal(w.state.stopRequests, 0);
  assert.equal(w.state.stops, 0);
});

test("legacy clocks cannot backdate departure and reattachment between sweeps revokes the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const w = world(t);
  recordTaskWorktreeObservation({
    taskId: w.task.id, generation: taskResourceGeneration(w.task), fingerprint: "old",
    now: w.state.now - 40 * DAY, retentionMs: 30 * DAY,
  });
  assert.equal(w.row()?.unownedSince, null);
  await w.observer.runPass();
  assert.equal(w.row()?.cleanupDueAt, w.state.now + WEEK);
  w.state.now += 6 * DAY;
  const session = w.addSession("reattached");
  assert.equal(w.row()?.unownedSince, null, "upsert immediately invalidates the old deadline");
  w.exit(session.id);
  t.mock.timers.tick(8_000);
  await w.observer.runPass();
  assert.equal(w.row()?.cleanupDueAt, w.state.now + WEEK);
  w.state.now += DAY;
  await w.observer.runPass();
  assert.ok(existsSync(w.path));
});

test("hidden discoveries, launch reservations, dormant SDK owners and check leases protect paths", async (t) => {
  const w = world(t);
  w.registry.applyDiscovery([], [], new Set([join(w.path, "hidden")]));
  await w.observer.runPass();
  assert.match(w.row()?.lastError ?? "", /tracked session/);
  w.registry.applyDiscovery([]);
  using launch = reserveWorktreeUse([join(w.path, "launch")]);
  assert.ok(launch);
  await w.observer.runPass();
  assert.match(w.row()?.lastError ?? "", /reserved/);
  launch[Symbol.dispose]();

  upsertSdkSession({ id: "hibernated-reservation", agent: "claude", cwd: w.path, taskId: w.task.id,
    agentSessionId: null, model: null, effort: null, permissionMode: null, status: "hibernated", turnInProgress: false });
  await w.observer.runPass();
  assert.match(w.row()?.lastError ?? "", /embedded session/);
  openDb().prepare("DELETE FROM sdk_sessions WHERE id = ?").run("hibernated-reservation");
  const checks = new CheckLeaseStore();
  checks.insertHeld({ attemptId: "check-reservation", submissionId: "test", nodeId: "test",
    repoRoot: w.primary.repoRoot, leasePath: w.path, holderToken: "check", provider: "git", now: w.state.now });
  await w.observer.runPass();
  assert.match(w.row()?.lastError ?? "", /workflow check/);
  checks.delete("check-reservation");
  const transfer = reserveSessionTransfer({
    sourceSessionId: "sdk:transferring", taskId: null, noteKey: "retention-transfer",
    facts: {
      agent: "claude", nativeId: "test", sourceName: "Resume", sourceRuntime: "sdk",
      sourceEpisodeId: null, cwd: join(w.path, "resume"), repoRoot: w.primary.repoRoot,
      taskIdentity: null, taskEpisodeId: null, bindings: [], leaseRoot: home, leaseId: "transfer",
      backend: null, home: null, sourceStopped: false, stopStarted: false,
      sourceProcess: null, launchAt: null, launchOutcome: "not_started", canEnd: false,
    },
  });
  await w.observer.runPass();
  assert.match(w.row()?.lastError ?? "", /session transfer/);
  updateSessionTransfer(transfer, { state: "aborted" });
  await w.observer.runPass();
  assert.equal(w.row()?.cleanupDueAt, w.state.now + WEEK);
});

test("an unbound SDK grant protects a checkout through restart and exited card linger", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const w = world(t);
  await w.observer.runPass();
  const id = "sdk:unbound-additional-checkout";
  upsertSdkSession({
    id, agent: "claude", cwd: w.primary.repoRoot, extraDirs: [join(w.path, "packages", "app")],
    taskId: null, agentSessionId: null, model: null, effort: null, permissionMode: null,
    status: "starting", turnInProgress: false,
  });
  w.addSession("unbound-additional-checkout", w.primary.repoRoot);
  assert.equal(w.row()?.unownedSince, null, "registration revokes an existing clock");
  await w.manager.stop();
  closeDb();
  w.state.now += WEEK;

  const restarted = w.setup();
  await restarted.observer.runPass();
  assert.match(w.row()?.lastError ?? "", /embedded session/);
  restarted.addSession("unbound-additional-checkout", w.primary.repoRoot);
  setSdkSessionStatus(id, "exited");
  restarted.exit(id);
  await restarted.observer.runPass();
  assert.equal(w.row()?.unownedSince, null, "the exited card still holds its additional checkout");
  t.mock.timers.tick(8_000);
  await restarted.observer.runPass();
  assert.equal(w.row()?.cleanupDueAt, w.state.now + WEEK);
  assert.ok(existsSync(w.path));
});

test("retention preserves a due checkout when an SDK grant is unreadable", async (t) => {
  const w = world(t);
  await w.observer.runPass();
  const id = "sdk:unreadable-retention-grant";
  upsertSdkSession({
    id, agent: "claude", cwd: w.primary.repoRoot, taskId: null, agentSessionId: "unknown-grant",
    model: null, effort: null, permissionMode: null, status: "suspended", turnInProgress: false,
  });
  t.after(() => { openDb().prepare("DELETE FROM sdk_sessions WHERE id = ?").run(id); });
  openDb().prepare("UPDATE sdk_sessions SET extra_dirs_json = ? WHERE id = ?").run("{", id);
  w.state.now += WEEK;
  const pass = await w.observer.runPass();
  assert.deepEqual(pass.cleanups, {});
  assert.equal(w.row()?.unownedSince, null);
  assert.match(w.row()?.lastError ?? "", /embedded session/);
  assert.ok(existsSync(w.path));
});

test("task dispatch refuses a checkout reserved by cleanup", async (t) => {
  const w = world(t, { status: "failed" });
  const before = w.registry.getTask(w.task.id);
  using cleanup = reserveWorktreeCleanup([w.path]);
  assert.ok(cleanup);
  const result = await w.manager.dispatch(w.task.id);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /automatic cleanup currently owns a task checkout/);
  assert.deepEqual(w.registry.getTask(w.task.id), before);
});

for (const flag of ["assume-unchanged", "skip-worktree"] as const) {
  test(`automatic return retains a published checkout with a hidden index change (${flag})`, async (t) => {
    const w = world(t);
    gitIn(w.path, "push", "origin", w.primary.branch);
    assert.equal(gitIn(w.path, "rev-parse", "HEAD"), gitIn(w.path, "rev-parse", `origin/${w.primary.branch}`));
    gitIn(w.path, "update-index", `--${flag}`, "keep.txt");
    writeFileSync(join(w.path, "keep.txt"), "local work hidden from status");
    assert.equal(gitIn(w.path, "status", "--porcelain"), "");
    await w.observer.runPass();
    w.state.now += WEEK;
    await w.observer.runPass();
    assert.ok(existsSync(w.path));
    assert.equal(w.registry.getTask(w.task.id)?.worktreePath, w.path);
    assert.match(w.row()?.lastError ?? "", /index has hidden changes/);
  });
}

test("a provider reset refuses ignored data created during the final occupancy scan", async (t) => {
  let inProvider = false;
  let reset = false;
  const w = world(t, { deps: {
    occupancy: async (paths) => {
      if (inProvider) writeFileSync(join(w.path, "private-cache"), "keep this file");
      return new Map(paths.map((path) => [path, { status: "known", occupants: [] }]));
    },
    teardown: async (_task, _legacy, _priority, _manager, guard) => {
      inProvider = true;
      const blocked = await guard!(w.path);
      if (blocked) throw new Error(blocked);
      reset = true;
    },
  } });
  writeFileSync(join(w.path, ".gitignore"), "private-cache\n");
  gitIn(w.path, "add", ".gitignore");
  gitIn(w.path, "commit", "-m", "ignore private cache");
  gitIn(w.path, "push", "origin", w.primary.branch);
  await w.observer.runPass();
  w.state.now += WEEK;
  await w.observer.runPass();
  assert.equal(inProvider, true);
  assert.equal(reset, false);
  assert.ok(existsSync(join(w.path, "private-cache")));
  assert.match(w.row()?.lastError ?? "", /ignored work/);
});

test("a provider reset refuses an unpublished HEAD created during the final occupancy scan", async (t) => {
  let inProvider = false;
  let reset = false;
  let unpublishedHead: string | undefined;
  const w = world(t, { deps: {
    occupancy: async (paths) => {
      if (inProvider) {
        writeFileSync(join(w.path, "keep.txt"), "unpublished work");
        gitIn(w.path, "commit", "-am", "unpublished work during occupancy");
        unpublishedHead = gitIn(w.path, "rev-parse", "HEAD");
        assert.equal(gitIn(w.path, "status", "--porcelain"), "");
      }
      return new Map(paths.map((path) => [path, { status: "known", occupants: [] }]));
    },
    teardown: async (_task, _legacy, _priority, _manager, guard) => {
      inProvider = true;
      const blocked = await guard!(w.path);
      if (blocked) throw new Error(blocked);
      reset = true;
    },
  } });
  await w.observer.runPass();
  w.state.now += WEEK;
  await w.observer.runPass();
  assert.ok(unpublishedHead);
  assert.equal(reset, false);
  assert.equal(gitIn(w.path, "rev-parse", "HEAD"), unpublishedHead);
  assert.match(w.row()?.lastError ?? "", /unpublished/);
});

test("a different published HEAD during final occupancy receives a fresh retention window", async (t) => {
  let inProvider = false;
  let publishedHead: string;
  let changed = false;
  const w = world(t, { deps: {
    occupancy: async (paths) => {
      if (inProvider && !changed) {
        gitIn(w.path, "reset", "--hard", publishedHead);
        assert.equal(gitIn(w.path, "status", "--porcelain"), "");
        changed = true;
      }
      return new Map(paths.map((path) => [path, { status: "known", occupants: [] }]));
    },
    teardown: async (...args) => {
      inProvider = true;
      await teardownWorktree(...args);
    },
  } });
  const initialHead = gitIn(w.path, "rev-parse", "HEAD");
  gitIn(w.path, "commit", "--allow-empty", "-m", "another published commit");
  publishedHead = gitIn(w.path, "rev-parse", "HEAD");
  gitIn(w.path, "push", "origin", "HEAD:refs/heads/published-retention-fixture");
  gitIn(w.path, "reset", "--hard", initialHead);

  await w.observer.runPass();
  w.state.now += WEEK;
  await w.observer.runPass();
  assert.ok(changed);
  assert.ok(existsSync(w.path));
  assert.equal(gitIn(w.path, "rev-parse", "HEAD"), publishedHead);
  assert.match(w.row()?.lastError ?? "", /Git activity changed/);

  await w.observer.runPass();
  assert.equal(w.row()?.cleanupDueAt, w.state.now + WEEK);
  assert.equal(w.row()?.claimToken, null);
  assert.ok(existsSync(w.path));
});

test("automatic return retains edits hidden during final publication verification", async (t) => {
  let inserted = false;
  let activityRechecked = false;
  const w = world(t, { deps: {
    returnBlocker: (path, options) => worktreeReturnBlocker(path, {
      ...options,
      readActivity: options?.readActivity && (async () => {
        assert.ok(inserted, "activity must be sampled after publication finishes");
        activityRechecked = true;
        return options.readActivity!();
      }),
      execute: async (command, args, runOptions) => {
        const result = await run(command, args, runOptions);
        if (!inserted && args.includes("rev-list") && options?.fetch === false) {
          gitIn(path, "update-index", "--assume-unchanged", "keep.txt");
          writeFileSync(join(path, "keep.txt"), "keep this late hidden work");
          assert.equal(gitIn(path, "status", "--porcelain"), "");
          inserted = true;
        }
        return result;
      },
    }),
  } });
  await w.observer.runPass();
  w.state.now += WEEK;
  await w.observer.runPass();
  assert.ok(inserted);
  assert.ok(activityRechecked);
  assert.equal(readFileSync(join(w.path, "keep.txt"), "utf8"), "keep this late hidden work");
  assert.equal(w.registry.getTask(w.task.id)?.worktreePath, w.path);
  assert.match(w.row()?.lastError ?? "", /index has hidden changes/);
});

test("automatic Git return refuses a different branch recreated at the recorded path", async (t) => {
  let inProvider = false;
  let replacementHead: string | undefined;
  const replacementBranch = "unrelated-worktree";
  const w = world(t, { deps: {
    occupancy: async (paths) => {
      if (inProvider && !replacementHead) {
        const recordedHead = gitIn(w.path, "rev-parse", "HEAD");
        gitIn(w.primary.repoRoot, "worktree", "remove", w.path);
        gitIn(w.primary.repoRoot, "worktree", "add", "-b", replacementBranch, w.path, recordedHead);
        replacementHead = gitIn(w.path, "rev-parse", "HEAD");
        assert.equal(replacementHead, recordedHead);
        assert.equal(gitIn(w.path, "status", "--porcelain"), "");
      }
      return new Map(paths.map((path) => [path, { status: "known", occupants: [] }]));
    },
    teardown: async (...args) => {
      inProvider = true;
      await teardownWorktree(...args);
    },
  } });
  await w.observer.runPass();
  w.state.now += WEEK;
  await w.observer.runPass();

  assert.ok(replacementHead, "the replacement was created during the final occupancy scan");
  assert.ok(existsSync(w.path), "the unrelated checkout must survive");
  assert.equal(gitIn(w.path, "branch", "--show-current"), replacementBranch);
  assert.equal(w.registry.getTask(w.task.id)?.worktreePath, w.path);
  assert.match(w.row()?.lastError ?? "", /branch does not match/);
});

for (const observation of ["unknown", "occupied"] as const) {
  test(`retention refuses ${observation} process occupancy at departure and at teardown`, async (t) => {
    const w = world(t);
    const active: WorktreeOccupancy = observation === "unknown"
      ? { status: "unknown", reason: "no process probe" }
      : { status: "known", occupants: [{} as never] };
    w.state.occupancy = active;
    await w.observer.runPass();
    assert.equal(w.row()?.unownedSince, null);
    w.state.occupancy = { status: "known", occupants: [] };
    await w.observer.runPass();
    w.state.now += WEEK;
    w.state.occupancy = active;
    await w.observer.runPass();
    assert.match(w.row()?.lastError ?? "", /process/);
    assert.ok(existsSync(w.path));
  });
}

test("the disposable census reports an unowned linked checkout without task provenance", async (t) => {
  const w = world(t);
  const unownedId = "unowned-census-checkout";
  const unowned = checkout(t, unownedId);
  const census = await disposableWorktreeCensus(w.registry.listTasks());
  const path = worktreeSlotPath(unownedId, 0);
  assert.deepEqual(census.entries.find((entry) => entry.path === path), {
    path, taskId: null, checkState: null, gitMetadata: "readable",
  });
  assert.ok(existsSync(unowned.worktreePath));
});

test("an unregistered directory stays on disk and appears with its blocker", async (t) => {
  const w = world(t);
  await w.observer.runPass();
  const admin = gitIn(w.path, "rev-parse", "--absolute-git-dir");
  rmSync(admin, { recursive: true });
  w.state.now += WEEK;
  await w.observer.runPass();
  assert.ok(existsSync(w.path));
  assert.ok(backgroundWorktreeRetentionStatus(w.registry.listTasks()).entries.find((row) =>
    row.taskId === w.task.id && row.blocker));
  const census = await disposableWorktreeCensus(w.registry.listTasks());
  assert.equal(census.entries.find((entry) => entry.taskId === w.task.id)?.gitMetadata, "unverified");
});

for (const change of ["ignored work", "deleted origin branch", "reattachment", "replacement", "flag disabled"] as const) {
  test(`retention preserves the checkout when ${change} appears at the provider boundary`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let mutate: () => void;
    let checks = 0;
    const w = world(t, { deps: {
      returnBlocker: async (path, options) => {
        const blocked = await worktreeReturnBlocker(path, options);
        if (++checks === 1) {
          assert.equal(blocked, null, "the checkout initially passes the safety gate");
          assert.equal(reserveWorktreeUse([path]), null, "launch cannot enter the removal reservation");
          mutate();
        }
        return blocked;
      },
      teardown: teardownWorktree,
    } });
    if (change === "ignored work") {
      writeFileSync(join(w.path, ".gitignore"), "keep-private\n");
      gitIn(w.path, "add", ".gitignore");
      gitIn(w.path, "commit", "-m", "ignore private work");
    }
    if (change === "deleted origin branch") {
      writeFileSync(join(w.path, "keep.txt"), "published work\n");
      gitIn(w.path, "commit", "-am", "publish task work");
    }
    gitIn(w.path, "push", "origin", w.primary.branch);
    const setFlag = (enabled: boolean) => applyFeatureFlagIntent({
      kind: "flag", id: SEVEN_DAY_WORKTREE_CLEANUP_FLAG_ID, enabled,
    });
    const observer = change === "flag disabled"
      ? createDaemonRetentionObserver({
        listTasks: () => [w.registry.getTask(w.task.id)!],
        refreshTaskAutomaticCleanup: (id) => w.registry.refreshTaskAutomaticCleanup(id),
      }, w.manager, () => w.state.now)
      : w.observer;
    if (change === "flag disabled") {
      assert.equal(setFlag(true).ok, true);
      t.after(() => { setFlag(false); });
    }
    mutate = () => {
      if (change === "ignored work") writeFileSync(join(w.path, "keep-private"), "private data\n");
      if (change === "deleted origin branch") gitIn(w.primary.origin, "update-ref", "-d", `refs/heads/${w.primary.branch}`);
      if (change === "reattachment") {
        const returning = w.addSession("returns-during-cleanup");
        w.exit(returning.id);
        t.mock.timers.tick(8_000);
      }
      if (change === "flag disabled") assert.equal(setFlag(false).ok, true);
      if (change === "replacement") {
        w.registry.upsertTask({ ...w.registry.getTask(w.task.id)!, dispatchedAt: w.state.now });
      }
    };
    await observer.runPass();
    w.state.now += WEEK;
    await observer.runPass();
    assert.ok(checks > 0, "the cleanup reached the provider guard");
    assert.ok(existsSync(w.path));
    assert.equal(w.registry.getTask(w.task.id)?.worktreePath, w.path);
    if (change === "reattachment") assert.equal(w.row()?.unownedSince, null);
  });
}

test("a partial return clears only the released repo and retains the unsafe sibling", async (t) => {
  const w = world(t, { multiRepo: true, deps: {
    teardown: async (task, legacy, priority, worktrees, guard) => {
      await teardownWorktree(task, legacy, priority, worktrees, async (path) => {
        const blocked = await guard!(path);
        if (!blocked && path === w.path) writeFileSync(join(w.secondary!.worktreePath, "late"), "late work");
        return blocked;
      });
    },
  } });
  await w.observer.runPass();
  w.state.now += WEEK;
  await w.observer.runPass();
  assert.equal(existsSync(w.path), false);
  assert.equal(w.registry.getTask(w.task.id)?.worktreePath, null);
  assert.ok(existsSync(join(w.secondary!.worktreePath, "late")));
  assert.equal(w.registry.getTask(w.task.id)?.extraRepos[0]?.worktreePath, w.secondary!.worktreePath);
  await w.observer.runPass();
  assert.equal(w.row()?.cleanupDueAt, w.state.now + WEEK);
});

test("retention leaves a hibernated task intact past its former deadline", async (t) => {
  const w = world(t);
  await w.observer.runPass();
  const deadline = w.row()?.cleanupDueAt;
  assert.equal(deadline, w.state.now + WEEK);
  const { dev, ino } = statSync(w.path, { bigint: true });
  w.registry.upsertTask({
    ...w.registry.getTask(w.task.id)!,
    status: "hibernated",
    hibernation: {
      sessionId: "sdk:hibernated-task", runtime: "sdk", agentSessionId: "sleeping-thread",
      noteKey: "sleeping-thread", permissionMode: null, hibernatedAt: w.state.now,
      checkout: { path: w.path, dev: String(dev), ino: String(ino) }, blocker: null, failure: null,
    },
  });

  w.state.now = deadline! + DAY;
  const pass = await w.observer.runPass();
  assert.equal(pass.observed, 0);
  assert.deepEqual(pass.cleanups, {});
  assert.equal(w.row(), null, "the old clock is pruned and no claim is taken");
  assert.equal(w.registry.getTask(w.task.id)?.status, "hibernated");
  assert.equal(w.registry.getTask(w.task.id)?.worktreePath, w.path);
  assert.ok(existsSync(w.path));
});

for (const [setting, enabled, mode, localWork] of [
  ["report-only", true, "report-only"], [undefined, false, "configured"],
  ["enforce", false, "configured"], [undefined, true, "enforce"],
  ["unexpected-preview-value", true, "report-only"],
  ["report-only", true, "report-only", true],
] as const) {
  test(`daemon preview setting selects ${mode} retention when ${setting ?? "unset"}, flag ${enabled ? "on" : "off"}${localWork ? " with local work" : ""}`, async (t) => {
    for (const prefix of ["MISSION", "FLEET", "HARNESS"]) {
      const key = `${prefix}_WORKTREE_CLEANUP_PREVIEW`;
      const previous = process.env[key];
      t.after(() => {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      });
      delete process.env[key];
    }
    if (setting !== undefined) process.env.MISSION_WORKTREE_CLEANUP_PREVIEW = setting;
    const previousDays = getWorktreesConfig().taskRetentionDays;
    t.after(() => { setWorktreesConfig({ taskRetentionDays: previousDays }); });
    setWorktreesConfig({ taskRetentionDays: 11 });

    const w = world(t);
    const notes = join(w.path, "local-notes.txt");
    if (localWork) writeFileSync(notes, "keep this local work");
    const registry = {
      listTasks: () => [w.registry.getTask(w.task.id)!],
      refreshTaskAutomaticCleanup: (id: string) => w.registry.refreshTaskAutomaticCleanup(id),
    };
    const observer = createDaemonRetentionObserver(registry, w.manager, () => w.state.now);
    const setFlag = (value: boolean) => applyFeatureFlagIntent({
      kind: "flag", id: SEVEN_DAY_WORKTREE_CLEANUP_FLAG_ID, enabled: value,
    });
    t.after(() => { setFlag(false); });
    if (enabled) assert.equal(setFlag(true).ok, true);
    await observer.runPass();
    const deadline = w.state.now + (mode === "configured" ? 11 * DAY : WEEK);
    assert.equal(w.row()?.cleanupDueAt, deadline);
    assert.equal(backgroundWorktreeRetentionStatus(registry.listTasks()).mode, mode);
    w.state.now = deadline;
    if (mode === "enforce") {
      assert.equal(setFlag(false).ok, true);
      assert.deepEqual((await observer.runPass()).cleanups, {});
      assert.ok(existsSync(w.path));
      assert.equal(w.row()?.cleanupDueAt, deadline + 4 * DAY);
      w.state.now += 4 * DAY;
    }
    const pass = await observer.runPass();
    if (mode === "report-only") {
      assert.deepEqual(pass.cleanups, {});
      assert.equal(w.row()?.claimToken, null);
      assert.equal(w.row()?.lastAttemptAt, null);
      const diagnostic = backgroundWorktreeRetentionStatus(registry.listTasks())
        .entries.find((entry) => entry.taskId === w.task.id);
      assert.equal(diagnostic?.cleanupDueAt, deadline);
      assert.match(diagnostic?.blocker ?? "", localWork ? /uncommitted, untracked or ignored work/ : /report only/);
      if (localWork) assert.equal(readFileSync(notes, "utf8"), "keep this local work");
      assert.ok(existsSync(w.path));
    } else {
      assert.deepEqual(pass.cleanups, { reclaimed: 1 });
      assert.equal(existsSync(w.path), false);
    }
  });
}

test("explicit task cleanup can release its own dirty checkout before retention is due", async (t) => {
  const w = world(t);
  writeFileSync(join(w.path, "operator-cleanup"), "deliberately discarded fixture\n");
  await w.observer.runPass();
  assert.equal(w.row()?.cleanupDueAt, w.state.now + WEEK);
  assert.deepEqual(await w.manager.reclaim(w.task.id), { ok: true });
  assert.equal(existsSync(w.path), false);
});

test("archive refusal retains the worktree and retries through the retention ledger", async (t) => {
  let archiveError = true;
  const w = world(t, { archiveError: () => archiveError });
  await w.observer.runPass();
  w.state.now += WEEK;
  await w.observer.runPass();
  assert.ok(existsSync(w.path));
  assert.match(w.row()?.lastError ?? "", /archive/);
  archiveError = false;
  w.state.now = w.row()?.retryAt ?? 0;
  await w.observer.runPass();
  assert.equal(existsSync(w.path), false);
});

for (const table of ["task_worktree_returns", "task_session_closures"]) {
  test(`a failed ${table} write rolls back completion and both obligations`, async (t) => {
    const w = world(t, { status: "running" });
    const session = w.addSession("closure-transaction");
    w.registry.upsertTask({ ...w.task, sessionId: session.id });
    openDb().exec(`CREATE TRIGGER refuse_completion BEFORE INSERT ON ${table}
      BEGIN SELECT RAISE(ABORT, 'obligation unavailable'); END`);
    try {
      await assert.rejects(w.manager.complete(w.task.id, "finished"), /obligation unavailable/);
      assert.equal(w.registry.getTask(w.task.id)?.status, "running");
      assert.equal(getTaskSessionClosure(w.task.id), null);
      assert.equal(taskOwesWorktreeReturn(w.registry.getTask(w.task.id)!), false);
    } finally {
      openDb().exec("DROP TRIGGER refuse_completion");
    }
  });
}
