import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const home = mkdtempSync(join(tmpdir(), "mission-scout-upgrade-"));
process.env.MISSION_HOME = home;
const { openDb, closeDb } = await import("../src/server/db.ts");
const { ArchiveCaptureStore } = await import("../src/server/archives/capture-store.ts");
after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });

test("upgrading the non-null task ledger preserves every existing value and index", () => {
  const db = openDb();
  const store = new ArchiveCaptureStore();
  const common = { taskId: "old-task", sessionId: "old-session", episodeId: "old-episode",
    producerId: "11111111-2222-4333-8444-555555555555", title: "Old report", question: "Question",
    prompts: null, origin: { agent: "claude", model: null, source: null }, repos: [] };
  const scout = store.reserve({ ...common, kind: "scout" });
  store.recordSubmission(scout.operationKey, { reportPath: "docs/reports/old/report.html", summary: "accepted", supporting: [], tags: ["old"] });
  store.reserve({ ...common, kind: "plan", scope: { slot: "repo-01", directory: "docs/plans/old" } });
  const before = db.prepare("SELECT * FROM archive_capture_jobs ORDER BY operation_key").all();
  const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='archive_capture_jobs' AND sql IS NOT NULL").all() as { sql: string }[];
  const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='archive_capture_jobs'").get() as { sql: string };
  db.exec(sql.replace("CREATE TABLE archive_capture_jobs", "CREATE TABLE old_capture_jobs").replace(/task_id\s+TEXT,/, "task_id TEXT NOT NULL,"));
  db.exec("INSERT INTO old_capture_jobs SELECT * FROM archive_capture_jobs; DROP TABLE archive_capture_jobs; ALTER TABLE old_capture_jobs RENAME TO archive_capture_jobs;");
  for (const index of indexes) db.exec(index.sql);
  closeDb();
  const upgraded = openDb();
  assert.deepEqual(upgraded.prepare("SELECT * FROM archive_capture_jobs ORDER BY operation_key").all(), before);
  assert.deepEqual(upgraded.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='archive_capture_jobs' AND sql IS NOT NULL").all(), indexes);
  const taskless = new ArchiveCaptureStore().reserve({ ...common, taskId: null, kind: "scout", scope: { slot: "repo-01", directory: "docs/reports/taskless" } });
  assert.equal(taskless.taskId, null);
  closeDb();
  assert.equal(new ArchiveCaptureStore(openDb()).get(taskless.operationKey)?.archiveId, taskless.archiveId);
});
