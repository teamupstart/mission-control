import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

// Seed a database whose slot table predates dependency claims, holding one warm slot, before
// importing db.ts and letting the production open path migrate it.
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
    created_at                INTEGER NOT NULL,
    updated_at                INTEGER NOT NULL
  );
  INSERT INTO worktree_slots (id, pool_id, ordinal, path, state, version, created_at, updated_at)
    VALUES ('slot-old', 'pool-old', 1, '/pool/1/repo', 'available', 7, 1, 1);
`);
legacy.close();

const { openDb } = await import("../src/server/db.ts");
const { WorktreeStore } = await import("../src/server/worktrees/store.ts");
const db = openDb();

test("an existing slot gains empty dependency-claim columns and its next claim runs every step", () => {
  const columns = (db.prepare(`PRAGMA table_info(worktree_slots)`).all() as Array<{ name: string }>)
    .map((column) => column.name);
  for (const name of ["deps_state", "deps_fingerprint", "deps_fingerprint_sha", "deps_claimed_at", "deps_last_error"]) {
    assert.ok(columns.includes(name), `${name} was added`);
  }
  const slot = new WorktreeStore(db).slot("slot-old");
  assert.ok(slot);
  assert.equal(slot.state, "available");
  assert.equal(slot.version, 7, "the upgrade rewrote nothing it did not add");
  assert.deepEqual(
    [slot.depsState, slot.depsFingerprint, slot.depsFingerprintSha, slot.depsClaimedAt, slot.depsLastError],
    [null, null, null, null, null],
    "never claimed, so no fingerprint a claim could skip on",
  );
  // Opening again is a no-op: the migration is idempotent.
  assert.doesNotThrow(() => openDb());
});
