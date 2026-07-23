import { test, after } from "node:test";
import { mkTask as baseTask } from "./helpers/session-fixture.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../src/shared/types.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";

// Point the daemon's state dir at a throwaway home BEFORE anything reads config,
// so this test never touches the real ~/.mission-control db. config.ts resolves the
// state dir at module load, so db/registry must be imported dynamically after.
// (Setting the legacy HARNESS_HOME also exercises the backward-compat env path.)
const home = mkdtempSync(join(tmpdir(), "mission-db-"));
process.env.HARNESS_HOME = home;
const {
  openDb,
  upsertTask,
  getTask,
  listTasks,
  loadActiveTasks,
  loadRecentTerminalTasks,
  loadResourceHoldingTerminalTasks,
  deleteTask,
} =
  await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");

after(() => rmSync(home, { recursive: true, force: true }));

/** The shared task fixture with this file's defaults on top. */
const mkTask = (over: Partial<Task> = {}): Task =>
  baseTask({ ...over });

function mkDiscovered(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    syntheticId: "sid",
    agent: "claude",
    name: "n",
    nameSource: "process",
    cwd: "/wt/a",
    gitBranch: null,
    gitRoot: null,
    repoRoot: null,
    nomistakesGated: false,
    pid: 1,
    tty: "ttys1",
    terminals: [],
    startedAt: 0,
    ...over,
  };
}

test("task round-trips dependencies and upsert updates in place (no duplicate row)", () => {
  openDb();
  upsertTask(mkTask({
    dependencies: [
      {
        type: "task",
        taskId: "pre",
        title: "Prerequisite",
        sessionId: null,
        episodeId: null,
        agentSessionId: null,
        branch: null,
        prUrl: null,
        selectedAt: 10,
        satisfiedAt: null,
      },
    ],
  }));
  assert.equal(getTask("t1")?.status, "backlog");
  assert.deepEqual(getTask("t1")?.dependencies, [
    {
      type: "task",
      taskId: "pre",
      title: "Prerequisite",
      sessionId: null,
      episodeId: null,
      agentSessionId: null,
      branch: null,
      prUrl: null,
      selectedAt: 10,
      satisfiedAt: null,
    },
  ]);

  upsertTask(mkTask({ status: "running", worktreePath: "/wt", sessionId: "s1", updatedAt: 2000 }));
  assert.equal(getTask("t1")?.status, "running");
  assert.equal(getTask("t1")?.worktreePath, "/wt");
  assert.equal(listTasks().length, 1);
});

test("loadActiveTasks keeps backlog/dispatching/running, drops terminal states", () => {
  upsertTask(mkTask({ id: "t2", status: "done" }));
  upsertTask(mkTask({ id: "t3", status: "running" }));
  upsertTask(mkTask({ id: "t4", status: "cancelled" }));
  const active = loadActiveTasks().map((t) => t.id);
  assert.ok(active.includes("t3"));
  assert.ok(!active.includes("t2"));
  assert.ok(!active.includes("t4"));
});

test("loadRecentTerminalTasks returns finished tasks newest-first, bounded", () => {
  upsertTask(mkTask({ id: "done-old", status: "done", updatedAt: 10 }));
  upsertTask(mkTask({ id: "done-new", status: "done", updatedAt: 9000 }));
  const recent = loadRecentTerminalTasks(1);
  assert.equal(recent.length, 1);
  assert.equal(recent[0]?.id, "done-new"); // most recent by updated_at
});

test("resource-holding cancelled tasks rehydrate until cleanup completes", () => {
  upsertTask(mkTask({
    id: "cancelled-resource-owner",
    status: "cancelled",
    worktreePath: "/wt/cancelled",
    branch: "harness/cancelled",
    provider: "git",
    homeName: "cancelled-home",
  }));
  const loaded = loadResourceHoldingTerminalTasks().find(
    (task) => task.id === "cancelled-resource-owner",
  );
  assert.equal(loaded?.worktreePath, "/wt/cancelled");
  assert.equal(loaded?.homeName, "cancelled-home");
  deleteTask("cancelled-resource-owner");
});

test("a finished task rehydrates into a fresh Registry (recent outcomes survive restart)", () => {
  upsertTask(mkTask({ id: "tDone", status: "done", outcome: "shipped", updatedAt: 5000 }));
  const r = new Registry();
  assert.ok(r.snapshot().tasks.some((t) => t.id === "tDone"));
});

test("deleteTask removes the row", () => {
  deleteTask("t3");
  assert.equal(getTask("t3"), undefined);
});

test("a session gets its task summary when cwd matches an active task's worktree", () => {
  const r = new Registry();
  r.upsertTask(mkTask({ id: "tA", status: "running", worktreePath: "/wt/a", title: "Wire it up" }));
  r.applyDiscovery([mkDiscovered({ cwd: "/wt/a" })]);
  const s = r.snapshot().sessions.find((x) => x.cwd === "/wt/a");
  assert.equal(s?.task?.id, "tA");
  assert.equal(s?.task?.title, "Wire it up");
  assert.equal(s?.task?.status, "running");
});

test("the in-memory task map is bounded: terminal tasks are trimmed to the recent cap", () => {
  const r = new Registry();
  // Insert well over the 50-task cap of finished tasks, newest updated_at last.
  for (let i = 0; i < 60; i++) {
    r.upsertTask(mkTask({ id: `bulk-${i}`, status: "done", updatedAt: 100000 + i }));
  }
  const terminal = r
    .snapshot()
    .tasks.filter((t) => t.status === "done" || t.status === "failed" || t.status === "cancelled");
  assert.ok(terminal.length <= 50, `expected <= 50 terminal tasks in memory, got ${terminal.length}`);
  assert.ok(r.getTask("bulk-59"), "newest terminal task is kept");
  assert.equal(r.getTask("bulk-0"), undefined, "oldest terminal task is evicted from memory");
});

test("prune never evicts terminal tasks that still hold resources", () => {
  const r = new Registry();
  // Oldest by updatedAt, but it holds a live worktree, so it must survive.
  r.upsertTask(mkTask({ id: "alive-fail", status: "failed", worktreePath: "/wt/alive", updatedAt: 1 }));
  r.upsertTask(mkTask({ id: "cancelled-home", status: "cancelled", homeName: "alive-home", updatedAt: 2 }));
  for (let i = 0; i < 60; i++) {
    r.upsertTask(mkTask({ id: `done-${i}`, status: "done", updatedAt: 1000 + i }));
  }
  assert.ok(r.getTask("alive-fail"), "a failed task with a worktree is never evicted");
  assert.ok(r.getTask("cancelled-home"), "a cancelled task with a terminal home is never evicted");
});

test("a backlog task (no worktree) never decorates a session", () => {
  const r = new Registry();
  r.upsertTask(mkTask({ id: "tB", status: "backlog", worktreePath: null }));
  r.applyDiscovery([mkDiscovered({ cwd: "/some/other/dir" })]);
  const s = r.snapshot().sessions.find((x) => x.cwd === "/some/other/dir");
  assert.equal(s?.task, null);
});
