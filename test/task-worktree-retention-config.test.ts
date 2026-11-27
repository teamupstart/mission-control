import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkTask } from "./helpers/session-fixture.ts";
import { WorktreesConfigPatchSchema } from "../src/shared/protocol.ts";
import { APP_CONFIG_ENTRIES } from "../src/shared/app-config-entries.ts";
import { tempDir } from "./temp-root.mjs";

const home = tempDir("mission-retention-config-");
process.env.MISSION_HOME = home;
execFileSync(process.execPath, ["--import", "tsx", "-e", "await import(process.env.DB_MODULE).then(m => m.openDb())"], {
  env: { ...process.env, DB_MODULE: new URL("../src/server/db.ts", import.meta.url).href }, stdio: "pipe",
});
const old = new DatabaseSync(join(home, "harness.db"));
old.exec(`ALTER TABLE task_worktree_retention DROP COLUMN retention_ms;
  INSERT INTO task_worktree_retention (task_id, generation, fingerprint, last_changed_at, observed_at, cleanup_due_at, updated_at)
  VALUES ('old-clock', 'g', 'f', 100, 200, 2592000100, 200);
  PRAGMA user_version = 32`);
old.close();
const db = await import("../src/server/db.ts");
const { getWorktreesConfig, setWorktreesConfig } = await import("../src/server/worktrees/config.ts");
const { TaskWorktreeRetentionObserver, defaultRetentionObserverDeps, taskResourceGeneration, RETENTION_OBSERVE_INTERVAL_MS } = await import("../src/server/task-worktree-retention.ts");
after(() => rmSync(home, { recursive: true, force: true }));
const DAY = 86400000;
const START = 1800000000000;

test("version 32 upgrade captures recovery before adding the policy and preserves old deadlines", () => {
  const row = db.openDb().prepare("SELECT retention_ms, cleanup_due_at FROM task_worktree_retention WHERE task_id = 'old-clock'").get();
  assert.equal(row?.retention_ms, 30 * DAY);
  assert.equal(row?.cleanup_due_at, 2592000100);
  const backupRoot = join(home, "backups", "database");
  const backups = existsSync(backupRoot) ? readdirSync(backupRoot).filter(name => name.startsWith("pre-migration-")) : [];
  assert.equal(backups.length, 1, "the version-32 database needs a recovery point before migration");
  const recovery = new DatabaseSync(join(backupRoot, backups[0]!), { readOnly: true });
  try {
    assert.equal(recovery.prepare("PRAGMA user_version").get()!.user_version, 32);
    assert.ok(!recovery.prepare("PRAGMA table_info(task_worktree_retention)").all().some(column => column.name === "retention_ms"));
    assert.equal(recovery.prepare("SELECT cleanup_due_at FROM task_worktree_retention WHERE task_id = 'old-clock'").get()!.cleanup_due_at, 2592000100);
  } finally { recovery.close(); }
  assert.equal(db.openDb().prepare("PRAGMA user_version").get()!.user_version, db.CURRENT_DATABASE_SCHEMA_VERSION);
  db.closeDb();
  const reopened = db.openDb();
  assert.deepEqual(reopened.prepare("SELECT retention_ms, cleanup_due_at FROM task_worktree_retention WHERE task_id = 'old-clock'").get(), row);
  assert.deepEqual(readdirSync(backupRoot).filter(name => name.startsWith("pre-migration-")), backups, "reopening at the current version must not capture again");
});

test("config defaults, validates writes, clamps damaged stored values, and preserves unrelated patches", () => {
  assert.equal(getWorktreesConfig().taskRetentionDays, 30);
  for (const value of [0, 6, 91, 14.5, null, "14"]) {
    assert.equal(WorktreesConfigPatchSchema.safeParse({ taskRetentionDays: value }).success, false);
  }
  for (const value of [7, 14, 90]) {
    setWorktreesConfig(WorktreesConfigPatchSchema.parse({ taskRetentionDays: value }));
    assert.equal(getWorktreesConfig().taskRetentionDays, value);
  }
  setWorktreesConfig({ maxSlots: 8 });
  assert.equal(getWorktreesConfig().taskRetentionDays, 90);
  for (const [stored, expected] of [[0, 7], [100, 90], [14.9, 14], [null, 30], ["bad", 30]]) {
    db.openDb().prepare("UPDATE app_config SET value = ? WHERE key = ?").run(JSON.stringify({ taskRetentionDays: stored }), APP_CONFIG_ENTRIES.worktrees.key);
    assert.equal(getWorktreesConfig().taskRetentionDays, expected);
  }
  setWorktreesConfig({ taskRetentionDays: 30 });
});

test("a live observer rereads config after each probe; grace survives later passes and restart", async () => {
  const task = mkTask({ id: "dynamic", status: "cancelled", worktreePath: "/wt/config" });
  db.upsertTask(task);
  let now = START;
  let known = true;
  let duringProbe: (() => void) | undefined;
  const deps = {
    ...defaultRetentionObserverDeps,
    listTasks: () => [task], now: () => now,
    probe: async () => {
      duringProbe?.(); duringProbe = undefined;
      return known ? { kind: "known" as const, digest: "fp" } : { kind: "unknown" as const, reason: "unreadable" };
    },
  };
  const observer = new TaskWorktreeRetentionObserver(deps);
  await observer.runPass();
  const read = () => db.getTaskWorktreeRetention(task.id)!;
  assert.equal(read().cleanupDueAt, START + 30 * DAY);
  now += 20 * DAY;
  setWorktreesConfig({ taskRetentionDays: 14 });
  assert.equal(read().cleanupDueAt, START + 30 * DAY, "saving only changes config");
  known = false;
  await observer.runPass();
  assert.equal(read().cleanupDueAt, START + 30 * DAY, "unknown probes cannot rebase");
  known = true;
  await observer.runPass();
  const grace = now + RETENTION_OBSERVE_INTERVAL_MS;
  assert.equal(read().cleanupDueAt, grace);
  assert.equal(db.claimTaskWorktreeCleanup({ taskId: task.id, generation: taskResourceGeneration(task), fingerprint: "fp", token: "early", now }).claimed, false);
  now += RETENTION_OBSERVE_INTERVAL_MS;
  await new TaskWorktreeRetentionObserver(deps).runPass();
  assert.equal(read().cleanupDueAt, grace, "restart must not slide grace");
  duringProbe = () => setWorktreesConfig({ taskRetentionDays: 60 });
  await observer.runPass();
  assert.equal(read().cleanupDueAt, START + 60 * DAY, "a change during the probe wins before claiming");
  assert.equal(read().lastChangedAt, START);
  setWorktreesConfig({ taskRetentionDays: 45 });
  await observer.runPass();
  assert.equal(read().cleanupDueAt, START + 45 * DAY, "future deadline needs no extra grace");
  now = START + 46 * DAY;
  assert.equal(db.claimTaskWorktreeCleanup({ taskId: task.id, generation: taskResourceGeneration(task), fingerprint: "fp", token: "claimed", now }).claimed, true);
  setWorktreesConfig({ taskRetentionDays: 90 });
  await observer.runPass();
  assert.equal(read().cleanupDueAt, START + 45 * DAY, "setting does not mutate an active claim");
  db.deferTaskWorktreeCleanup({ taskId: task.id, token: "claimed", now, retryAt: now + DAY, error: "provider refused" });
  await observer.runPass();
  assert.equal(read().cleanupDueAt, START + 90 * DAY, "lengthening includes unclaimed retries");
  assert.equal(read().retryAt, now + DAY, "policy changes preserve backoff");
});


test("lengthening cannot erase an outstanding shortening grace even for a very old tree", () => {
  const task = mkTask({ id: "old-grace", status: "failed", worktreePath: "/wt/old" });
  db.upsertTask(task);
  const observe = (now: number, days: number) => db.recordTaskWorktreeObservation({
    taskId: task.id, generation: taskResourceGeneration(task), fingerprint: "fp", now, retentionMs: days * DAY,
  }).row!;
  observe(START, 30);
  const now = START + 60 * DAY;
  const shortened = observe(now, 7);
  assert.equal(shortened.cleanupDueAt, now + RETENTION_OBSERVE_INTERVAL_MS);
  const extended = observe(now + 1000, 14);
  assert.equal(extended.cleanupDueAt, shortened.cleanupDueAt);
  assert.equal(observe(now + 2000, 90).cleanupDueAt, START + 90 * DAY);
});
