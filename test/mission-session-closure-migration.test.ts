import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-closure-upgrade-"));
process.env.MISSION_HOME = home;
const legacy = new DatabaseSync(join(home, "harness.db"));
legacy.exec(`
  CREATE TABLE task_session_closures (
    task_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, requested_at INTEGER NOT NULL,
    deadline_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, updated_at INTEGER NOT NULL
  );
  INSERT INTO task_session_closures VALUES ('task', 'session', 1000, 241000, 3, 'stop refused', 2000);
`);
legacy.close();
const db = await import("../src/server/db.ts");
after(() => rmSync(home, { recursive: true, force: true }));

test("upgrade preserves owed closure deadlines and persists retirement idempotently", () => {
  assert.deepEqual(db.getTaskSessionClosure("task"), {
    taskId: "task", sessionId: "session", requestedAt: 1000, deadlineAt: 241000,
    attempts: 3, lastError: "stop refused", updatedAt: 2000, retiredAt: null,
  });
  db.retireTaskSessionClosure("task", "session", 181000);
  db.retireTaskSessionClosure("task", "session", 182000);
  db.openTaskSessionClosure("task", "session", 200000, 440000);
  const held = db.getTaskSessionClosure("task")!;
  assert.equal(held.retiredAt, 181000);
  assert.equal(held.deadlineAt, 241000);
  assert.equal(held.attempts, 3);
  db.openTaskSessionClosure("task", "replacement", 300000, 540000);
  assert.equal(db.getTaskSessionClosure("task")?.retiredAt, null);
});
