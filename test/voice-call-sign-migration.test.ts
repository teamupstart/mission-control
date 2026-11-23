import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkTask } from "./helpers/session-fixture.ts";

// A version-48 database, written before call signs: the real schema, made in a child process by
// this build, then wound back to what a version-48 daemon left on disk - the tasks table without
// `call_sign`, holding one backlog task and one running task. The upgrade adds the nullable column,
// every existing task reads as having no call sign, and a call sign written after survives a
// reopen, which is what a daemon restart does.
const home = mkdtempSync(join(tmpdir(), "mission-voice-call-sign-migration-"));
process.env.MISSION_HOME = home;
execFileSync(process.execPath, ["--import", "tsx", "-e", "await import(process.env.DB_MODULE).then(m => m.openDb())"], {
  env: { ...process.env, DB_MODULE: new URL("../src/server/db.ts", import.meta.url).href }, stdio: "pipe",
});
const old = new DatabaseSync(join(home, "harness.db"));
old.exec(`ALTER TABLE tasks DROP COLUMN call_sign;
  INSERT INTO tasks (id, title, intent, kind, agent, repo_root, status, created_at, updated_at)
  VALUES ('backlog-task', 'Shelved', 'do it later', 'ship', 'claude', '/repo', 'backlog', 100, 100),
         ('running-task', 'Running', 'do it now', 'ship', 'claude', '/repo', 'running', 100, 100);
  PRAGMA user_version = 48`);
old.close();
const db = await import("../src/server/db.ts");
after(() => rmSync(home, { recursive: true, force: true }));

test("version 48 upgrade adds tasks.call_sign, and every existing task has no call sign", () => {
  const d = db.openDb();
  const columns = d.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown }>;
  const column = columns.find((c) => c.name === "call_sign");
  assert.deepEqual(column && { type: column.type, notnull: column.notnull, dflt: column.dflt_value }, { type: "TEXT", notnull: 0, dflt: null });
  assert.equal((d.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, db.CURRENT_DATABASE_SCHEMA_VERSION);
  assert.ok(db.CURRENT_DATABASE_SCHEMA_VERSION >= 49);
  for (const id of ["backlog-task", "running-task"]) {
    const task = db.getTask(id)!;
    assert.equal(task.title, id === "backlog-task" ? "Shelved" : "Running");
    assert.equal("callSign" in task, false, `${id} decodes exactly as before: no call sign key`);
  }
});

test("a call sign is written, survives a reopen, and is cleared; a value no writer stores reads as none", () => {
  db.upsertTask(mkTask({ id: "named", callSign: "Alice", status: "running" }));
  db.closeDb();
  db.openDb();
  assert.equal(db.getTask("named")!.callSign, "Alice");
  db.upsertTask({ ...db.getTask("named")!, callSign: null });
  assert.equal("callSign" in db.getTask("named")!, false);
  db.openDb().prepare("UPDATE tasks SET call_sign = ? WHERE id = 'named'").run("x".repeat(41));
  assert.equal("callSign" in db.getTask("named")!, false, "a stored value past the limit is not handed on");
  db.openDb().prepare("UPDATE tasks SET call_sign = ? WHERE id = 'named'").run("  Atlas  ");
  assert.equal(db.getTask("named")!.callSign, "Atlas", "a padded value reads trimmed");
  db.closeDb();
});
