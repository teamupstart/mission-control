import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-usage-migrate-"));
process.env.MISSION_HOME = home;

const raw = new DatabaseSync(join(home, "harness.db"));
raw.exec(`
  CREATE TABLE usage_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_key TEXT NOT NULL,
    session_id TEXT,
    agent TEXT NOT NULL DEFAULT 'claude',
    model_id TEXT NOT NULL DEFAULT '',
    query_source TEXT NOT NULL DEFAULT '',
    window_end_ns TEXT NOT NULL,
    ts INTEGER NOT NULL,
    cost_usd REAL NOT NULL DEFAULT 0,
    input INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    UNIQUE(note_key, model_id, query_source, window_end_ns)
  );
  INSERT INTO usage_ledger
    (note_key, agent, model_id, query_source, window_end_ns, ts, cost_usd, input, output)
  VALUES ('legacy-session', 'claude', 'claude-opus', 'main', '1', 1000, 1.25, 10, 2);
`);
raw.close();

const { openDb, sessionCostFor } = await import("../src/server/db.ts");
after(() => rmSync(home, { recursive: true, force: true }));

test("legacy usage rows gain truthful reported-cost defaults", () => {
  const db = openDb();
  const columns = db.prepare(`PRAGMA table_info(usage_ledger)`).all() as unknown as Array<{ name: string }>;
  for (const name of ["cost_basis", "cost_known", "pricing_version", "reasoning_output"]) {
    assert.ok(columns.some((column) => column.name === name), `missing migrated ${name}`);
  }
  const summary = sessionCostFor("legacy-session");
  assert.equal(summary?.basis, "reported");
  assert.equal(summary?.costUsd, 1.25);
  assert.deepEqual(summary?.pricingVersions, []);
  assert.equal(summary?.reasoningOutput, 0);
});

test("the new cursor table is created on an upgraded database", () => {
  const db = openDb();
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_sources'`)
    .get() as { name: string } | undefined;
  assert.equal(row?.name, "usage_sources");
  const columns = db.prepare(`PRAGMA table_info(usage_sources)`).all() as unknown as Array<{ name: string }>;
  assert.ok(columns.some((column) => column.name === "discard_partial"));
});
