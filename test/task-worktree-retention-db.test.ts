import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Task } from "../src/shared/types.ts";
import { mkTask as baseTask } from "./helpers/session-fixture.ts";

// The durable half of the worktree activity clock: the ledger's schema, its transitions, and
// the one thing it must never do - invent a deadline out of a read that failed.
//
// The home is built as a PRE-FEATURE database on purpose (see below) so that the very first
// thing this file proves is that an existing install opens, keeps its rows, and gains the new
// table without a backfill.

const home = mkdtempSync(join(tmpdir(), "mission-retention-db-"));
process.env.HARNESS_HOME = home;

// Build a full, current-schema database in a CHILD process, then remove the retention table
// from the file. What is left is exactly the shape an installed daemon carries today: every
// other table, real rows, and no ledger. `openDb` has no close, so the upgrade can only be
// exercised by handing this process a file that was created before it ever opened one.
execFileSync(
  process.execPath,
  ["--import", "tsx", "-e", "await import(process.env.DB_MODULE).then((m) => m.openDb())"],
  { env: { ...process.env, HARNESS_HOME: home, DB_MODULE: new URL("../src/server/db.ts", import.meta.url).href }, stdio: "inherit" },
);
const dbPath = join(home, "harness.db");
assert.ok(existsSync(dbPath), "the child built a database to upgrade");
{
  const pre = new DatabaseSync(dbPath);
  pre.exec("DROP TABLE IF EXISTS task_worktree_retention");
  pre.prepare(
    `INSERT INTO tasks (id, title, intent, kind, agent, repo_root, status, created_at, updated_at)
     VALUES ('legacy', 'Legacy', 'i', 'ship', 'claude', '/repo', 'done', 1, 1)`,
  ).run();
  pre.close();
}

const { taskResourceGeneration } = await import("../src/server/task-resource-generation.ts");
const {
  openDb,
  upsertTask,
  deleteTask,
  getTask,
  getTaskWorktreeRetention,
  listTaskWorktreeRetention,
  listDueTaskWorktreeRetention,
  listOrphanedTaskWorktreeRetentionIds,
  deleteTaskWorktreeRetention,
  recordTaskWorktreeObservation,
} = await import("../src/server/db.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const DAY = 24 * 60 * 60 * 1000;
const WINDOW = 30 * DAY;
const NOW = 1_700_000_000_000;

const mkTask = (over: Partial<Task> = {}): Task =>
  baseTask({ status: "done", worktreePath: "/wt/a", ...over });

/**
 * One observation, defaulting to the generation the stored task ACTUALLY has.
 *
 * Derived rather than hard-coded because the writer re-derives it inside its own transaction
 * and refuses anything else - a test that invented a generation string would be testing the
 * rejection path on every call.
 */
function observe(over: Partial<Parameters<typeof recordTaskWorktreeObservation>[0]> = {}) {
  const taskId = over.taskId ?? "t-obs";
  const stored = getTask(taskId);
  return recordTaskWorktreeObservation({
    taskId,
    generation: stored ? taskResourceGeneration(stored) : "no-such-task",
    fingerprint: "fp-1",
    now: NOW,
    retentionMs: WINDOW,
    ...over,
  });
}

test("a pre-feature database opens, keeps its rows, and gains the ledger", () => {
  // The upgrade contract: no destructive backfill, and nothing that was there before is lost.
  assert.equal(getTask("legacy")?.status, "done", "the pre-existing task row survived the open");
  const tables = openDb()
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .all("task_worktree_retention") as unknown as Array<{ name: string }>;
  assert.equal(tables.length, 1, "the ledger table was created on an existing database");
  // And the upgraded install carries NO ledger rows: an existing tree's clock starts at the
  // first observation, not from `updated_at`. That is the rollout safety mechanism.
  assert.deepEqual(listTaskWorktreeRetention(), []);
});

test("the first observation seeds a full window from NOW", () => {
  upsertTask(mkTask({ id: "t-obs" }));
  const { outcome, row } = observe();
  assert.equal(outcome, "seeded");
  assert.equal(row?.lastChangedAt, NOW);
  assert.equal(row?.observedAt, NOW);
  assert.equal(row?.cleanupDueAt, NOW + WINDOW);
  assert.equal(row?.cleanupState, "observing");
  assert.equal(row?.claimToken, null);
});

test("an unchanged fingerprint advances only the observation time", () => {
  const later = NOW + 5 * DAY;
  const { outcome, row } = observe({ now: later });
  assert.equal(outcome, "unchanged");
  assert.equal(row?.observedAt, later);
  assert.equal(row?.lastChangedAt, NOW, "an unchanged tree does not get a fresh boundary");
  assert.equal(row?.cleanupDueAt, NOW + WINDOW);
});

test("a change on day 29 resets the deadline for another full window", () => {
  const day29 = NOW + 29 * DAY;
  const { outcome, row } = observe({ now: day29, fingerprint: "fp-2" });
  assert.equal(outcome, "changed");
  assert.equal(row?.lastChangedAt, day29);
  assert.equal(row?.cleanupDueAt, day29 + WINDOW);
});

test("an unknown read records a bounded reason and moves no clock at all", () => {
  const before = getTaskWorktreeRetention("t-obs");
  const { outcome, row } = observe({
    now: NOW + 40 * DAY,
    fingerprint: null,
    reason: "x".repeat(5000),
  });
  assert.equal(outcome, "unknown-recorded");
  assert.equal(row?.lastChangedAt, before?.lastChangedAt);
  assert.equal(row?.cleanupDueAt, before?.cleanupDueAt);
  assert.equal(row?.observedAt, before?.observedAt, "an unknown read is not an observation");
  assert.ok((row?.lastError?.length ?? 0) <= 500, "stored diagnosis is bounded");
});

test("an unknown read with no matching row writes nothing - a failed read invents no deadline", () => {
  upsertTask(mkTask({ id: "t-never-seen" }));
  const { outcome } = observe({ taskId: "t-never-seen", fingerprint: null, reason: "unreadable" });
  assert.equal(outcome, "unknown-skipped");
  assert.equal(getTaskWorktreeRetention("t-never-seen"), null);
  deleteTask("t-never-seen");
});

test("a new resource generation replaces the row and starts a fresh window", () => {
  const redispatch = NOW + 50 * DAY;
  // A real re-dispatch: a new attempt onto a new checkout.
  upsertTask(mkTask({ id: "t-obs", worktreePath: "/wt/b", dispatchedAt: 4242 }));
  const { outcome, row } = observe({ now: redispatch, fingerprint: "fp-3" });
  assert.equal(outcome, "replaced");
  assert.equal(row?.generation, taskResourceGeneration(getTask("t-obs")!));
  assert.equal(row?.lastChangedAt, redispatch, "a replacement tree cannot inherit an older age");
  assert.equal(row?.cleanupDueAt, redispatch + WINDOW);
  assert.equal(row?.lastError, null, "the superseded row's diagnosis does not survive");
});

test("an observation whose task moved underneath it is refused by the writer", () => {
  // The check/write race, closed where the write happens. The caller validated the generation
  // and then - before the ledger write - the task was re-dispatched. Nothing may be written:
  // the fingerprint in hand describes trees the task no longer owns, and letting it land would
  // hand a brand new checkout an age it never lived.
  upsertTask(mkTask({ id: "t-race", worktreePath: "/wt/race", dispatchedAt: 1 }));
  observe({ taskId: "t-race", fingerprint: "fp-race" });
  const before = getTaskWorktreeRetention("t-race");
  assert.ok(before, "the race fixture has a settled clock to protect");
  const stale = taskResourceGeneration(getTask("t-race")!);

  upsertTask(mkTask({ id: "t-race", worktreePath: "/wt/race-2", dispatchedAt: 9999 }));
  const moved = recordTaskWorktreeObservation({
    taskId: "t-race",
    generation: stale,
    fingerprint: "fp-from-the-old-tree",
    now: NOW + 60 * DAY,
    retentionMs: WINDOW,
  });
  assert.equal(moved.outcome, "generation-moved");
  const after = getTaskWorktreeRetention("t-race");
  assert.equal(after?.fingerprint, before.fingerprint, "the stale fingerprint did not land");
  assert.equal(after?.lastChangedAt, before.lastChangedAt);
  assert.equal(after?.cleanupDueAt, before.cleanupDueAt);
  assert.equal(after?.generation, before.generation);

  // The same refusal covers a task that stopped qualifying, and an unknown read on a moved one.
  upsertTask(mkTask({ id: "t-race", status: "running", worktreePath: "/wt/race-2" }));
  assert.equal(observe({ taskId: "t-race", fingerprint: "fp-x" }).outcome, "generation-moved");
  assert.equal(
    recordTaskWorktreeObservation({
      taskId: "t-race",
      generation: stale,
      fingerprint: null,
      reason: "unreadable",
      now: NOW,
      retentionMs: WINDOW,
    }).outcome,
    "generation-moved",
  );
  assert.equal(getTaskWorktreeRetention("t-race")?.fingerprint, before.fingerprint);

  // And a task that no longer exists at all.
  deleteTask("t-race");
  assert.equal(
    recordTaskWorktreeObservation({
      taskId: "t-race",
      generation: stale,
      fingerprint: "fp-y",
      now: NOW,
      retentionMs: WINDOW,
    }).outcome,
    "generation-moved",
  );
  assert.equal(getTaskWorktreeRetention("t-race"), null, "deleteTask took the row with it");
});

test("a successful observation clears a previous unknown's diagnosis", () => {
  observe({ now: NOW + 51 * DAY, fingerprint: null, reason: "transient" });
  assert.ok(getTaskWorktreeRetention("t-obs")?.lastError);
  observe({ now: NOW + 52 * DAY, fingerprint: "fp-3" });
  assert.equal(getTaskWorktreeRetention("t-obs")?.lastError, null);
});

test("the claim columns stay inert - nothing in observation can transition a cleanup", () => {
  // Phase 1's zero-cleanup boundary, asserted where it could actually be crossed. Every write
  // above has run; none of them may have touched a claim.
  for (const row of listTaskWorktreeRetention()) {
    assert.equal(row.cleanupState, "observing", `${row.taskId} left observation state`);
    assert.equal(row.claimToken, null);
    assert.equal(row.claimedAt, null);
    assert.equal(row.lastAttemptAt, null);
    assert.equal(row.retryAt, null);
  }
});

test("due rows are selectable by deadline - the queue the next phase consumes", () => {
  const row = getTaskWorktreeRetention("t-obs");
  assert.ok(row);
  assert.deepEqual(listDueTaskWorktreeRetention(row.cleanupDueAt - 1).map((r) => r.taskId), []);
  assert.deepEqual(listDueTaskWorktreeRetention(row.cleanupDueAt).map((r) => r.taskId), ["t-obs"]);
});

test("orphans are the rows that no longer describe anything, in one query", () => {
  // Three ways a row stops describing something, plus the survivor that must not be swept.
  upsertTask(mkTask({ id: "t-rescheduled" }));
  upsertTask(mkTask({ id: "t-released" }));
  upsertTask(mkTask({
    id: "t-attached-only",
    worktreePath: null,
    extraRepos: [{
      repoRoot: "/other",
      worktreePath: "/wt/attached",
      branch: "b",
      provider: "git",
      worktreeLeaseId: null,
      baseSha: null,
      prUrl: null,
      prState: null,
      mergedAt: null,
    }],
  }));
  for (const id of ["t-rescheduled", "t-released", "t-attached-only"]) {
    observe({ taskId: id });
  }
  assert.deepEqual(listOrphanedTaskWorktreeRetentionIds(), []);

  upsertTask(mkTask({ id: "t-rescheduled", status: "backlog" }));
  upsertTask(mkTask({ id: "t-released", worktreePath: null }));
  const orphans = new Set(listOrphanedTaskWorktreeRetentionIds());
  assert.ok(orphans.has("t-rescheduled"), "a task put back into the backlog is not a candidate");
  assert.ok(orphans.has("t-released"), "a task whose last tree was released has no clock to keep");
  assert.ok(
    !orphans.has("t-attached-only"),
    "a partial-teardown survivor still holds a checkout and keeps its clock",
  );
  for (const id of orphans) deleteTaskWorktreeRetention(id);
  assert.deepEqual(listOrphanedTaskWorktreeRetentionIds(), []);
});

test("deleting a task takes its ledger row with it", () => {
  assert.ok(getTaskWorktreeRetention("t-attached-only"));
  deleteTask("t-attached-only");
  assert.equal(getTaskWorktreeRetention("t-attached-only"), null);
});
