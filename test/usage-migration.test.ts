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
  CREATE TABLE usage_sources (
    source_key TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    offset INTEGER NOT NULL,
    model_id TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
  );
  INSERT INTO usage_ledger
    (note_key, agent, model_id, query_source, window_end_ns, ts, cost_usd, input, output)
  VALUES ('legacy-session', 'claude', 'claude-opus', 'main', '1', 1000, 1.25, 10, 2);
`);
raw.close();

const { openDb, sessionCostFor, automationSpendSince, fleetEstimatedCostSince } = await import(
  "../src/server/db.ts"
);
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

test("a pre-feature database gains spend_kind, and its rows stay session spend", () => {
  const db = openDb();
  const columns = db.prepare(`PRAGMA table_info(usage_ledger)`).all() as unknown as Array<{ name: string }>;
  assert.ok(columns.some((c) => c.name === "spend_kind"), "missing migrated spend_kind");
  // The backfill has to be 'session': every row written before headless accounting existed
  // came from a card's own OTel or rollout stream. Defaulting the other way would move a
  // day's real fleet spend into the automation line on the first upgrade.
  const row = db
    .prepare(`SELECT spend_kind FROM usage_ledger WHERE note_key = 'legacy-session'`)
    .get() as { spend_kind: string } | undefined;
  assert.equal(row?.spend_kind, "session");
  assert.equal(fleetEstimatedCostSince(0), 1.25, "and it still counts toward the fleet");
  assert.deepEqual(automationSpendSince(0), [], "with nothing invented in the automation line");
});

test("the index on the migrated column exists on an upgraded database", () => {
  // The trap this guards: an index naming spend_kind cannot live in the CREATE TABLE block,
  // because that block runs BEFORE migrate() adds the column - an upgraded database would
  // fail to open at all. Asserting the index exists here proves it was created on the
  // migration path, on a database that genuinely predates the column.
  const db = openDb();
  const idx = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_ledger_kind'`)
    .get() as { name: string } | undefined;
  assert.equal(idx?.name, "idx_ledger_kind");
});

test("the new cursor table is created on an upgraded database", () => {
  const db = openDb();
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_sources'`)
    .get() as { name: string } | undefined;
  assert.equal(row?.name, "usage_sources");
  const columns = db.prepare(`PRAGMA table_info(usage_sources)`).all() as unknown as Array<{ name: string }>;
  for (const name of ["discard_partial", "file_id"]) {
    assert.ok(columns.some((column) => column.name === name), `missing migrated ${name}`);
  }
});
