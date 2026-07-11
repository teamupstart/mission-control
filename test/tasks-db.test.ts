import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../src/shared/types.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";

// Point the daemon's state dir at a throwaway home BEFORE anything reads config,
// so this test never touches the real ~/.ai-harness db. config.ts resolves
// HARNESS_HOME at module load, so db/registry must be imported dynamically after.
const home = mkdtempSync(join(tmpdir(), "harness-db-"));
process.env.HARNESS_HOME = home;
const { openDb, upsertTask, getTask, listTasks, loadActiveTasks, deleteTask } = await import(
  "../src/server/db.ts"
);
const { Registry } = await import("../src/server/registry.ts");

after(() => rmSync(home, { recursive: true, force: true }));

function mkTask(over: Partial<Task> = {}): Task {
  const now = 1000;
  return {
    id: "t1",
    title: "T",
    intent: "do the thing",
    kind: "ship",
    agent: "claude",
    repoRoot: "/repo",
    worktreePath: null,
    branch: null,
    provider: null,
    tmuxSession: null,
    sessionId: null,
    status: "queued",
    outcome: null,
    outcomeUrl: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    dispatchedAt: null,
    completedAt: null,
    ...over,
  };
}

function mkDiscovered(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    syntheticId: "sid",
    agent: "claude",
    name: "n",
    nameSource: "process",
    cwd: "/wt/a",
    gitBranch: null,
    nomistakesGated: false,
    pid: 1,
    tty: "ttys1",
    wezterm: null,
    tmux: null,
    startedAt: 0,
    ...over,
  };
}

test("task round-trips and upsert updates in place (no duplicate row)", () => {
  openDb();
  upsertTask(mkTask());
  assert.equal(getTask("t1")?.status, "queued");

  upsertTask(mkTask({ status: "running", worktreePath: "/wt", sessionId: "s1", updatedAt: 2000 }));
  assert.equal(getTask("t1")?.status, "running");
  assert.equal(getTask("t1")?.worktreePath, "/wt");
  assert.equal(listTasks().length, 1);
});

test("loadActiveTasks keeps queued/dispatching/running, drops terminal states", () => {
  upsertTask(mkTask({ id: "t2", status: "done" }));
  upsertTask(mkTask({ id: "t3", status: "running" }));
  upsertTask(mkTask({ id: "t4", status: "cancelled" }));
  const active = loadActiveTasks().map((t) => t.id);
  assert.ok(active.includes("t3"));
  assert.ok(!active.includes("t2"));
  assert.ok(!active.includes("t4"));
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

test("a queued task (no worktree) never decorates a session", () => {
  const r = new Registry();
  r.upsertTask(mkTask({ id: "tB", status: "queued", worktreePath: null }));
  r.applyDiscovery([mkDiscovered({ cwd: "/some/other/dir" })]);
  const s = r.snapshot().sessions.find((x) => x.cwd === "/some/other/dir");
  assert.equal(s?.task, null);
});
