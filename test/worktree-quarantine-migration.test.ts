import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

// Seed a schema 28 database whose slot table predates quarantine categories and times, holding
// the quarantines the field database had, before importing db.ts and letting the production
// open path migrate it.
const home = process.env.HARNESS_HOME;
assert.ok(home, "test/setup-state.mjs must provide an isolated HARNESS_HOME");
mkdirSync(home, { recursive: true });
const legacy = new DatabaseSync(join(home, "harness.db"));
legacy.exec(`
  CREATE TABLE worktree_slots (
    id                        TEXT    NOT NULL PRIMARY KEY,
    pool_id                   TEXT    NOT NULL,
    ordinal                   INTEGER NOT NULL,
    path                      TEXT    NOT NULL,
    state                     TEXT    NOT NULL,
    version                   INTEGER NOT NULL,
    requested_head_sha        TEXT,
    current_head_sha          TEXT,
    active_lease_id           TEXT,
    active_owner_kind         TEXT,
    active_owner_key          TEXT,
    leased_at                 INTEGER,
    last_released_lease_id    TEXT,
    last_released_owner_kind  TEXT,
    last_released_owner_key   TEXT,
    last_used_at              INTEGER,
    quarantine_reason         TEXT,
    last_error                TEXT,
    deps_state                TEXT,
    deps_fingerprint          TEXT,
    deps_fingerprint_sha      TEXT,
    deps_claimed_at           INTEGER,
    deps_last_error           TEXT,
    created_at                INTEGER NOT NULL,
    updated_at                INTEGER NOT NULL
  );
  PRAGMA user_version = 28;
`);
const ROWS: Array<[id: string, state: string, reason: string | null]> = [
  ["occupancy", "quarantined", "slot process occupancy is unknown"],
  ["before-reset", "quarantined", "slot occupancy became unknown before reset"],
  ["before-seed", "quarantined", "slot occupancy became unknown before it was seeded from"],
  ["git-unknown", "quarantined", "slot Git state is unknown"],
  ["git-inspect", "quarantined", "slot Git state could not be inspected"],
  ["registrations", "quarantined", "Git registrations could not be read"],
  ["registrations-pool", "quarantined", "Git worktree registrations are unknown: git worktree list timed out"],
  ["owner-read", "quarantined", "last-released domain ownership could not be read"],
  ["owner-unknown", "quarantined", "last-released domain ownership is unknown"],
  ["leased-owner", "quarantined", "leased domain ownership is unknown"],
  // Positively bad facts and unproven transitions are not observations.
  ["moved", "quarantined", "available slot HEAD moved outside an allocator transition"],
  ["setup", "quarantined", "operator-authored setup command failed"],
  ["dirty", "quarantined", "available slot has dirty or untracked work"],
  // Exact, never a pattern: neither a near miss nor a LIKE wildcard classifies a row.
  ["near-miss", "quarantined", "slot process occupancy is unknown, then a process entered"],
  ["wildcard", "quarantined", "slot occupancy became unknown%"],
  ["no-reason", "quarantined", null],
  // Only quarantined rows are classified: a stale reason on an available row is history.
  ["available", "available", "slot process occupancy is unknown"],
];
const insert = legacy.prepare(
  `INSERT INTO worktree_slots (id, pool_id, ordinal, path, state, version, quarantine_reason, created_at, updated_at)
   VALUES (?, 'pool-old', ?, ?, ?, 3, ?, 1, 99)`,
);
ROWS.forEach(([id, state, reason], index) => insert.run(id, index + 1, `/pool/${index + 1}/repo`, state, reason));
legacy.close();

const { openDb, upgradeDatabaseToCurrentSchema, CURRENT_DATABASE_SCHEMA_VERSION } = await import("../src/server/db.ts");
const { WorktreeStore, quarantineRecoverable } = await import("../src/server/worktrees/store.ts");
const db = openDb();
const store = new WorktreeStore(db);

test("legacy quarantines from an observer that did not answer become recoverable observations", () => {
  const observation = new Set(["occupancy", "before-reset", "before-seed", "git-unknown", "git-inspect",
    "registrations", "registrations-pool", "owner-read", "owner-unknown", "leased-owner"]);
  for (const [id] of ROWS) {
    const slot = store.slot(id)!;
    assert.equal(slot.quarantineCategory, observation.has(id) ? "observation" : null, id);
    assert.equal(quarantineRecoverable(slot.quarantineCategory), observation.has(id), id);
    assert.equal(slot.quarantinedAt, null, `${id}: the time it entered was never recorded`);
    assert.equal(slot.version, 3, `${id}: the upgrade is not a slot transition`);
    assert.equal(slot.updatedAt, 99);
  }
  assert.equal(
    (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    CURRENT_DATABASE_SCHEMA_VERSION,
  );
});

test("the backfill runs once, with the column, and a later upgrade never reclassifies", () => {
  // A quarantine written after the upgrade carries its own category, and an operator-visible
  // NULL must stay NULL: re-running the upgrade path is how every later open looks.
  db.prepare(`UPDATE worktree_slots SET quarantine_category = NULL WHERE id = 'occupancy'`).run();
  upgradeDatabaseToCurrentSchema(db);
  assert.equal(store.slot("occupancy")?.quarantineCategory, null);
});
