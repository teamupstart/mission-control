import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkSession, mkTask } from "./helpers/session-fixture.ts";
import { Registry } from "../src/server/registry.ts";
import { TaskManager } from "../src/server/tasks.ts";
import { getTask, getTaskSessionClosure, taskOwesWorktreeReturn } from "../src/server/db.ts";
import type { Session } from "../src/shared/types.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("shutdown drain waits for a closure already stopping a session", async (t) => {
  const registry = new Registry();
  for (const task of registry.listTasks()) registry.removeTask(task.id);
  const entered = deferred();
  const release = deferred();
  const manager = new TaskManager(registry, {
    resetWouldDestroyWork: async () => null,
    kill: async () => { entered.resolve(); await release.promise; return { ok: true }; },
  }, undefined, undefined, undefined, {
    occupancy: async (paths) => new Map(paths.map((path) => [path, { status: "unknown", reason: "fixture" }])),
  });
  t.after(() => manager.stop());
  registry.applyDiscovery([]);
  const session = mkSession({ id: "closing", runtime: "terminal", pid: undefined });
  (registry as unknown as { sessions: Map<string, Session> }).sessions.set(session.id, session);
  const task = mkTask({ id: "closing-task", status: "running", sessionId: session.id, worktreePath: "/fixture/tree" });
  registry.upsertTask(task);
  await manager.complete(task.id, "finished");
  const sweep = manager.sweepMissionSessionClosures();
  await entered.promise;
  manager.stopMissionSessionClosures();
  let drained = false;
  const draining = manager.settleWorktreeReturns().then(() => { drained = true; });
  try {
    await turn();
    assert.equal(drained, false, "shutdown must not remove fixture state while a closure can still write it");
  } finally {
    release.resolve();
    await sweep;
    await draining;
  }
  assert.equal(getTaskSessionClosure(task.id)?.attempts, 1);
  assert.equal(taskOwesWorktreeReturn(registry.getTask(task.id)!), true, "shutdown preserves the durable retry");
});

test("stop detaches producers, drains active and queued returns, and preserves restart recovery", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const registry = new Registry();
  for (const task of registry.listTasks()) registry.removeTask(task.id);
  const listeners = () => registry.eventNames().map((name) => [name, registry.listenerCount(name)]);
  const before = listeners();
  const release = deferred();
  let probes = 0;
  const manager = new TaskManager(registry, undefined, undefined, undefined, undefined, {
    occupancy: async (paths) => {
      probes++;
      await release.promise;
      return new Map(paths.map((path) => [path, { status: "unknown", reason: "held probe" }]));
    },
  });
  t.after(() => manager.stop());
  registry.applyDiscovery([]);
  for (const id of ["queued-one", "queued-two"]) {
    registry.upsertTask(mkTask({ id, sessionId: null, status: "running", worktreePath: `/fixture/${id}` }));
    await manager.complete(id, "finished");
  }
  assert.equal(probes, 1, "same-repository returns serialize");
  assert.equal(manager.pendingCleanupJobs, 2);
  let stopped = false;
  const stopping = manager.stop();
  assert.equal(manager.stop(), stopping, "concurrent shutdown callers join the same drain");
  void stopping.then(() => { stopped = true; });
  try {
    await turn();
    assert.equal(stopped, false, "an active probe is still owned until it settles");
    assert.deepEqual(listeners(), before, "all registry producers detach before waiting");
  } finally {
    release.resolve();
    await stopping;
  }
  assert.equal(probes, 2, "already queued work drains too");
  assert.equal(manager.pendingCleanupJobs, 0);
  t.mock.timers.tick(90_000);
  registry.applyDiscovery([]);
  registry.emit("event", { type: "session_remove", id: "late-removal" });
  await manager.sweepMissionSessionClosures();
  await turn();
  assert.equal(probes, 2, "a stopped manager cannot retry from timers or registry events");
  const returned: string[] = [];
  const recovered = new Registry();
  const restarted = new TaskManager(recovered, undefined, undefined, undefined, undefined, {
    occupancy: async (paths) => new Map(paths.map((path) => [path, { status: "known", occupants: [] }])),
    teardown: async (task) => { assert.ok(task.id); returned.push(task.id); },
  });
  t.after(() => restarted.stop());
  await restarted.settleWorktreeReturns();
  recovered.applyDiscovery([]);
  await restarted.settleWorktreeReturns();
  assert.deepEqual(returned.sort(), ["queued-one", "queued-two"]);
  for (const id of returned) assert.equal(taskOwesWorktreeReturn(recovered.getTask(id)!), false);
});

test("stop waits for an asynchronous scout completion before its fixture state is removed", async (t) => {
  const registry = new Registry();
  for (const task of registry.listTasks()) registry.removeTask(task.id);
  const archive = deferred();
  const manager = new TaskManager(registry, undefined, undefined, undefined, {
    ensureReady: async () => { await archive.promise; return { ok: true }; },
    settleBeforeCleanup: async () => ({ ok: true }),
  });
  t.after(() => manager.stop());
  registry.applyDiscovery([]);
  registry.upsertTask(mkTask({ id: "archiving", kind: "scout", status: "running", sessionId: null, worktreePath: "/fixture/scout" }));
  const completion = manager.complete("archiving", "finished");
  let stopped = false;
  const stopping = manager.stop().then(() => { stopped = true; });
  try {
    await turn();
    assert.equal(stopped, false);
  } finally {
    archive.resolve();
    await completion;
    await stopping;
  }
  assert.equal(registry.getTask("archiving")?.status, "done");
  assert.equal(taskOwesWorktreeReturn(registry.getTask("archiving")!), true);
  assert.equal(manager.pendingCleanupJobs, 0);
});

test("stop drains queued cleanup after an asynchronous scout completion rejects", async (t) => {
  const registry = new Registry();
  for (const task of registry.listTasks()) registry.removeTask(task.id);
  const archive = deferred();
  const firstCleanup = deferred();
  const secondCleanup = deferred();
  const secondEntered = deferred();
  const probed: string[] = [];
  const manager = new TaskManager(registry, undefined, undefined, undefined, {
    ensureReady: async () => { await archive.promise; return { ok: true }; },
    settleBeforeCleanup: async () => ({ ok: true }),
  }, {
    occupancy: async (paths) => {
      probed.push(...paths);
      if (probed.length === 1) await firstCleanup.promise;
      else {
        secondEntered.resolve();
        await secondCleanup.promise;
      }
      return new Map(paths.map((path) => [path, { status: "unknown", reason: "held probe" }]));
    },
  });
  t.after(async () => {
    archive.resolve();
    firstCleanup.resolve();
    secondCleanup.resolve();
    await manager.stop();
    await manager.settleWorktreeReturns();
  });
  registry.applyDiscovery([]);
  const cleanupIds = ["rejection-cleanup-one", "rejection-cleanup-two"];
  for (const id of cleanupIds) {
    registry.upsertTask(mkTask({ id, status: "running", sessionId: null, worktreePath: `/fixture/${id}` }));
    await manager.complete(id, "finished");
  }
  assert.equal(probed.length, 1, "the second cleanup waits behind the first in the same repository");
  assert.equal(manager.pendingCleanupJobs, 2);
  const scoutId = "rejected-archive";
  registry.upsertTask(mkTask({ id: scoutId, kind: "scout", status: "running", sessionId: null, worktreePath: "/fixture/scout" }));
  const before = getTask(scoutId);
  assert.ok(before);
  const archiveFailure = new Error("archive storage unavailable");
  const completion = assert.rejects(manager.complete(scoutId, "finished"), (error) => error === archiveFailure);
  let stopState = "pending";
  const stopping = manager.stop().then(
    () => { stopState = "fulfilled"; return null; },
    (error: unknown) => { stopState = "rejected"; return error; },
  );
  try {
    await turn();
    assert.equal(stopState, "pending", "shutdown waits for the unresolved archive");
    archive.reject(archiveFailure);
    await completion;
    await turn();
    assert.equal(stopState, "pending", "archive rejection must not bypass the cleanup drain");
    assert.equal(manager.pendingCleanupJobs, 2);
    firstCleanup.resolve();
    await secondEntered.promise;
    await turn();
    assert.equal(stopState, "pending", "shutdown also waits for the previously queued cleanup");
    secondCleanup.resolve();
    assert.equal(await stopping, null, "shutdown absorbs completion failure after draining owned work");
    assert.equal(stopState, "fulfilled");
    assert.deepEqual(probed, cleanupIds.map((id) => `/fixture/${id}`));
    assert.equal(manager.pendingCleanupJobs, 0);
    assert.deepEqual(getTask(scoutId), before, "the failed completion leaves the durable scout and its checkout intact");
    assert.equal(taskOwesWorktreeReturn(getTask(scoutId)!), false, "a rejected completion creates no return obligation");
    for (const id of cleanupIds) assert.equal(taskOwesWorktreeReturn(getTask(id)!), true);
  } finally {
    archive.reject(archiveFailure);
    firstCleanup.resolve();
    secondCleanup.resolve();
    await completion;
    await stopping;
  }
});

test("fixture workers drain between tests and exit naturally without host scans", async () => {
  const started = performance.now();
  const env = { ...process.env };
  // This child is a runner, not this file's worker. Keep inherited state isolation while
  // letting node:test create its own workers and apply the preload to each of them.
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [
    "--test", "--import", "./test/setup-state.mjs", "--import", "tsx",
    "--import", "./test/helpers/audit-host-scans.mjs", "test/fixtures/task-manager-lifetime.ts",
  ], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(result, { code: 0, signal: null }, output);
  assert.match(output, /"hostScanAttempts":0/);
  assert.match(output, /"remaining":0/);
  console.info(`fixture worker exited naturally in ${Math.round(performance.now() - started)}ms; ${output.match(/CHILD_AUDIT .*/)?.[0]}`);
});
