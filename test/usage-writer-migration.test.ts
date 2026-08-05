import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Backfilling `usage_ledger.writer` on a database that predates the column.
//
// The fixture is deliberately the INTERMEDIATE schema, not the oldest one: it already has
// `spend_kind` and `cost_basis` and is missing only `writer`. That is the state that makes the
// backfill interesting, because it is the only state where all three arms are reachable - a
// genuinely pre-feature database has no automation or rollout rows to relabel, so it would
// only ever exercise the fallback. `usage-migration.test.ts` covers that older jump.
//
// What the backfill has to get right is that every arm is DECIDABLE from columns the row
// already carried. It is a relabelling, not a guess, and these rows pin each mapping.

const home = mkdtempSync(join(tmpdir(), "mission-usage-writer-"));
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
    spend_kind TEXT NOT NULL DEFAULT 'session',
    cost_usd REAL NOT NULL DEFAULT 0,
    cost_basis TEXT NOT NULL DEFAULT 'reported',
    cost_known INTEGER NOT NULL DEFAULT 1,
    pricing_version TEXT NOT NULL DEFAULT '',
    input INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0,
    reasoning_output INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    UNIQUE(note_key, model_id, query_source, window_end_ns)
  );
  INSERT INTO usage_ledger
    (note_key, agent, model_id, window_end_ns, ts, spend_kind, cost_usd, cost_basis, input)
  VALUES
    ('a-session',      'claude', 'claude-opus-5', '1', 1000, 'session',    1.25, 'reported',        10),
    ('foreman:review', 'claude', 'claude-opus-5', '2', 2000, 'automation', 0.50, 'reported',        20),
    ('a-codex',        'codex',  'gpt-5.5',       '3', 3000, 'session',    0.75, 'api-equivalent',  30),
    ('a-codex-un',     'codex',  'mystery-model', '4', 4000, 'session',    0.00, 'unpriced',        40);
`);
raw.close();

const { openDb, otelUsageHasRows } = await import("../src/server/db.ts");
after(() => rmSync(home, { recursive: true, force: true }));

/** Every row's writer, keyed by note key, after migrate() ran on open. */
function writers(): Record<string, string> {
  const rows = openDb()
    .prepare(`SELECT note_key, writer FROM usage_ledger`)
    .all() as unknown as Array<{ note_key: string; writer: string }>;
  return Object.fromEntries(rows.map((r) => [r.note_key, r.writer]));
}

test("the writer column is added to a database that predates it", () => {
  const columns = openDb()
    .prepare(`PRAGMA table_info(usage_ledger)`)
    .all() as unknown as Array<{ name: string }>;
  assert.ok(columns.some((c) => c.name === "writer"), "missing migrated writer");
});

test("each legacy row is relabelled from what it already carried", () => {
  const w = writers();
  // Narrowest arm first: only `recordAutomationUsage` writes an automation row.
  assert.equal(w["foreman:review"], "report", "a role's spend came from a headless run report");
  // Only the rollout reader prices locally, so a local basis identifies it.
  assert.equal(w["a-codex"], "rollout", "a locally-priced row came from the rollout reader");
  assert.equal(w["a-codex-un"], "rollout", "including one whose model it could not price");
  // What remains is Claude's reported session telemetry, which before the driver became a
  // writer had exactly one possible source.
  assert.equal(w["a-session"], "otel", "a reported session row could only have been exported");
});

test("no row is left unlabelled, so '' can only ever mean a newer bug", () => {
  assert.equal(
    Object.values(writers()).filter((v) => v === "").length,
    0,
    "the backfill's last arm is unconditional",
  );
});

test("a relabelled export satisfies the exporter-specific health check", () => {
  // The reason the column exists. `otelUsageHasRows` is what tells the Cost panel whether
  // Claude Code's exporter has ever delivered - a question that became unanswerable from
  // (spend_kind, cost_basis) alone once a driver could write rows matching both.
  assert.equal(otelUsageHasRows(), true, "the upgraded session row counts as a real export");
});

test("the backfill is idempotent across a reopen", () => {
  // migrate() runs on every open. The arms are guarded on `writer = ''`, so a second pass must
  // be a no-op rather than walking rows back to the fallback.
  const before = writers();
  openDb();
  assert.deepEqual(writers(), before);
});
