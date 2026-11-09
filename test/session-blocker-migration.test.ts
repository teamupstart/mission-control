import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Schema 25 over a database written at schema 24, before sessions could record a blocker.
// The table arrives through `migrate()`, an upgraded database reads as having no blocked
// session, and running the upgrade again changes nothing.

const home = mkdtempSync(join(tmpdir(), "mission-session-blocker-migration-"));
process.env.MISSION_HOME = home;

const raw = new DatabaseSync(join(home, "harness.db"));
raw.exec(`
  CREATE TABLE IF NOT EXISTS session_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, ts INTEGER NOT NULL,
    kind TEXT NOT NULL, payload TEXT
  );
  PRAGMA user_version = 24;
`);
raw.close();

const {
  openDb, upgradeDatabaseToCurrentSchema, loadSessionBlockers, upsertSessionBlocker, CURRENT_DATABASE_SCHEMA_VERSION,
} = await import("../src/server/db.ts");
after(() => rmSync(home, { recursive: true, force: true }));

test("a schema 24 database gains an empty session_blockers table and is stamped current", () => {
  assert.equal(CURRENT_DATABASE_SCHEMA_VERSION, 25);
  const d = openDb();
  const columns = (d.prepare(`PRAGMA table_info(session_blockers)`).all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(columns, [
    "note_key", "task_id", "kind", "reason", "waiting_on", "resume_when", "details",
    "reference_url", "started_at", "updated_at", "checked_at", "reply", "last_held_at",
  ]);
  assert.equal((d.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 25);
  assert.deepEqual(loadSessionBlockers(), []);
});

test("the upgrade is idempotent and keeps a stored blocker", () => {
  const blocker = {
    kind: "service" as const, reason: "Staging DB is down", waitingOn: "Infra on-call", resumeWhen: "Staging is back",
    details: null, referenceUrl: null, startedAt: 5, updatedAt: 5, checkedAt: null, reply: null,
  };
  upsertSessionBlocker({ noteKey: "k1", taskId: "t1", blocker, lastHeldAt: 9 });
  upgradeDatabaseToCurrentSchema(openDb());
  assert.deepEqual(loadSessionBlockers(), [{ noteKey: "k1", taskId: "t1", blocker, lastHeldAt: 9 }]);
});

test("a kind written by a newer build reads as other rather than dropping the hold", () => {
  openDb().prepare(`UPDATE session_blockers SET kind = 'future-kind' WHERE note_key = 'k1'`).run();
  assert.equal(loadSessionBlockers()[0]?.blocker.kind, "other");
});
