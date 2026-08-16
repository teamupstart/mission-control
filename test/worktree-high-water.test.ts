import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

// Seed the schema from the development window before pools persisted an ordinal high-water
// mark. The production open path must backfill it before any pruned slot can be replaced.
const home = process.env.HARNESS_HOME;
assert.ok(home, "test/setup-state.mjs must provide an isolated HARNESS_HOME");
mkdirSync(home, { recursive: true });
const path = join(home, "harness.db");
const legacy = new DatabaseSync(path);
legacy.exec(`
  CREATE TABLE worktree_pools (
    id                     TEXT    NOT NULL PRIMARY KEY,
    git_common_dir         TEXT    NOT NULL,
    main_checkout_root     TEXT    NOT NULL,
    pool_path              TEXT    NOT NULL,
    last_reconciled_at     INTEGER,
    reconciliation_error  TEXT,
    created_at             INTEGER NOT NULL,
    updated_at             INTEGER NOT NULL
  );
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
  INSERT INTO worktree_pools
    (id, git_common_dir, main_checkout_root, pool_path, created_at, updated_at)
  VALUES ('pool', '/repo/.git', '/repo', '/pool', 1, 1);
  INSERT INTO worktree_slots
    (id, pool_id, ordinal, path, state, version, created_at, updated_at)
  VALUES ('slot-7', 'pool', 7, '/pool/7/repo', 'pruning', 3, 1, 1);
`);
legacy.close();

const { openDb } = await import("../src/server/db.ts");
const { WorktreeStore } = await import("../src/server/worktrees/store.ts");
const db = openDb();
const store = new WorktreeStore(db);

test("migration retires existing ordinals and allocation advances the durable high-water mark", () => {
  assert.equal(store.pool("pool")?.ordinalHighWater, 7);
  assert.equal(store.removePruned("slot-7", 3), true);

  const next = store.reserveNew({
    poolId: "pool",
    maxSlots: 2,
    id: "slot-8",
    pathForOrdinal: (ordinal) => `/pool/${ordinal}/repo`,
    leaseId: "lease-8",
    ownerKind: "task",
    ownerKey: "task-8",
    requestedHeadSha: "a".repeat(40),
    now: 8,
  });
  assert.equal(next?.ordinal, 8);
  assert.equal(next?.path, "/pool/8/repo");
  assert.equal(store.pool("pool")?.ordinalHighWater, 8);

  assert.throws(() =>
    store.reserveNew({
      poolId: "pool",
      maxSlots: 2,
      id: "slot-8",
      pathForOrdinal: (ordinal) => `/pool/${ordinal}/repo`,
      leaseId: "lease-9",
      ownerKind: "task",
      ownerKey: "task-9",
      requestedHeadSha: "b".repeat(40),
      now: 9,
    }),
  );
  assert.equal(store.pool("pool")?.ordinalHighWater, 8, "failed insertion rolls back allocation");
});
