import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-work-cycle-migration-"));
process.env.MISSION_HOME = home;

// A pre-feature database with the hook-only table already populated. Opening it through
// the current schema must add work-cycle state without reinterpreting or losing this row.
const raw = new DatabaseSync(join(home, "harness.db"));
raw.exec(`
  CREATE TABLE session_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT
  );
  INSERT INTO session_events (session_id, ts, kind, payload)
  VALUES ('legacy-hook-session', 1234, 'Stop', '{"state":"idle"}');
`);
raw.close();

const {
  completeWorkCycle,
  hooksEverSeen,
  markWorkCycleActive,
  openDb,
  workCycleFor,
} = await import("../src/server/db.ts");
const db = openDb();

after(() => rmSync(home, { recursive: true, force: true }));

test("an upgraded database gains the dedicated current-state table", () => {
  const columns = db.prepare(`PRAGMA table_info(session_work_cycles)`).all() as unknown as Array<{
    name: string;
  }>;
  assert.deepEqual(
    columns.map((column) => column.name),
    ["logical_key", "generation", "active", "completed_at", "updated_at"],
  );
  assert.equal(workCycleFor("never-observed"), null);
});

test("the additive table preserves existing hook rows and their meaning", () => {
  assert.equal(hooksEverSeen("legacy-hook-session"), true);
  const row = db
    .prepare(`SELECT kind, payload FROM session_events WHERE session_id = ?`)
    .get("legacy-hook-session") as { kind: string; payload: string } | undefined;
  assert.equal(row?.kind, "Stop");
  assert.equal(row?.payload, '{"state":"idle"}');
});

test("the migrated table stores one current projection instead of a turn ledger", () => {
  assert.deepEqual(markWorkCycleActive("migrated-cycle", 2_000), {
    logicalKey: "migrated-cycle",
    generation: 0,
    active: true,
    completedAt: null,
    updatedAt: 2_000,
  });
  assert.deepEqual(completeWorkCycle("migrated-cycle", 2_100, 2_101), {
    logicalKey: "migrated-cycle",
    generation: 1,
    active: false,
    completedAt: 2_100,
    updatedAt: 2_101,
  });
  completeWorkCycle("migrated-cycle", 2_200, 2_201);

  const rows = db
    .prepare(`SELECT logical_key, generation FROM session_work_cycles WHERE logical_key = ?`)
    .all("migrated-cycle") as unknown as Array<{ logical_key: string; generation: number }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.logical_key, "migrated-cycle");
  assert.equal(rows[0]?.generation, 1);
});
