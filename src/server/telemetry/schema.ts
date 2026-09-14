import type { DatabaseSync } from "node:sqlite";

/**
 * The telemetry facility's tables, on the daemon database's own upgrade path.
 *
 * WHY `harness.db` rather than a second SQLite file, which P1 left open:
 *
 * The separate file buys one thing - an independently enforceable disk quota - and costs four.
 * It needs its own version/recovery/upgrade lifecycle, its own ownership story beside
 * `state-ownership`, its own backup inclusion, and it gives up the one property this whole
 * design leans on: that a projection checkpoint, its aggregate state and its output batch
 * commit in ONE transaction with the same writer that already serializes every other write in
 * this process. Splitting the file would not remove that requirement, it would just move it
 * onto a second connection with no shared transaction.
 *
 * The quota argument is also weaker than it looks. A logical quota in a shared file is not a
 * hard cap on the file or its WAL either way, and the measured physical envelope (recorded in
 * docs/observability.md) is small enough that an enforced 256 MiB logical budget plus the
 * retention sweep bounds it adequately. If a later phase needs a hard disk cap, the store
 * interface here is the seam to move; nothing above it names a file.
 *
 * Everything below is created on every open and must stay idempotent, exactly like the rest of
 * `upgradeDatabaseToCurrentSchema`. Forward migrations go in `migrateTelemetry` beside it.
 */
export function createTelemetryTables(d: DatabaseSync): void {
  d.exec(`
    -- Immutable resource identity: what OTLP calls the producing entity. Content addressed,
    -- so two boots of the same build share one row and an upgrade mints a new one - which is
    -- exactly the behaviour that stops a replay after an upgrade restamping old batches with
    -- the new binary's service.version.
    CREATE TABLE IF NOT EXISTS telemetry_resources (
      id              TEXT PRIMARY KEY,
      attributes_json TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    );

    -- Immutable execution/association context, referenced by journal rows rather than copied
    -- into them. Pruned only when nothing references it.
    CREATE TABLE IF NOT EXISTS telemetry_contexts (
      id              TEXT PRIMARY KEY,
      attributes_json TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    );

    -- The canonical journal. One row per ACCEPTED semantic fact; commit here is what
    -- "accepted" means, and everything downstream is derived from it.
    --
    -- "seq" orders PROCESSING and is not event time: an out-of-order observation keeps its own
    -- occurred_at and still projects in arrival order, which is the only order a checkpoint
    -- can advance through.
    CREATE TABLE IF NOT EXISTS telemetry_journal (
      seq              INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id         TEXT NOT NULL UNIQUE,
      envelope_version INTEGER NOT NULL,
      name             TEXT NOT NULL,
      event_version    INTEGER NOT NULL,
      source_kind      TEXT NOT NULL,
      source_id        TEXT NOT NULL,
      source_revision  INTEGER NOT NULL,
      occurred_at      INTEGER NOT NULL,
      observed_at      INTEGER NOT NULL,
      resource_id      TEXT NOT NULL,
      context_id       TEXT NOT NULL,
      actor_json       TEXT NOT NULL,
      refs_json        TEXT NOT NULL,
      refs_omitted     INTEGER NOT NULL DEFAULT 0,
      facts_json       TEXT NOT NULL,
      -- Which profiles were eligible AT CAPTURE. Enabling a profile later cannot retroactively
      -- widen this row's audience; that is the whole "no historical sharing on opt-in" rule.
      profiles_json    TEXT NOT NULL,
      -- The consent epoch each eligible profile was in at capture, so a reset cannot mix
      -- pre-reset facts into a post-reset stream.
      epochs_json      TEXT NOT NULL,
      bytes            INTEGER NOT NULL,
      -- Set when the payload aged out. The ROW survives so its identity stays deduplicable;
      -- see telemetry_source_identities for the part that outlives even this.
      payload_pruned_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_telemetry_journal_occurred
      ON telemetry_journal(occurred_at);

    -- Durable dedupe, deliberately its own table rather than a unique index on the journal.
    --
    -- A unique key on a row that is later deleted is not durable deduplication: once retention
    -- prunes the journal row, the same source fact would be admitted again as fresh activity.
    -- These rows are tiny and outlive the payload by the reducer-state window.
    CREATE TABLE IF NOT EXISTS telemetry_source_identities (
      source_kind     TEXT NOT NULL,
      source_id       TEXT NOT NULL,
      source_revision INTEGER NOT NULL,
      event_id        TEXT NOT NULL,
      captured_at     INTEGER NOT NULL,
      PRIMARY KEY (source_kind, source_id, source_revision)
    );
    CREATE INDEX IF NOT EXISTS idx_telemetry_identities_captured
      ON telemetry_source_identities(captured_at);

    -- Per projection and per profile: how far it has consumed, and its own bounded state.
    --
    -- Namespaced by projection id so Phase 6's analytical reducers get their own rows and
    -- their own state version, and neither phase's migration touches the other's.
    CREATE TABLE IF NOT EXISTS telemetry_projection_state (
      projection    TEXT NOT NULL,
      profile       TEXT NOT NULL,
      state_version INTEGER NOT NULL,
      consumed_seq  INTEGER NOT NULL,
      state_json    TEXT NOT NULL,
      updated_at    INTEGER NOT NULL,
      PRIMARY KEY (projection, profile)
    );

    -- Durable cumulative aggregate state: one row per metric stream.
    --
    -- The key includes resource_id and policy_epoch, and both are load-bearing. A changed
    -- app version is a different OTLP resource and therefore a different stream with its own
    -- start time; a new consent epoch is a new baseline, so a fresh product opt-in cannot
    -- inherit the operator's cumulative pre-opt-in total.
    CREATE TABLE IF NOT EXISTS telemetry_series (
      profile         TEXT NOT NULL,
      policy_epoch    INTEGER NOT NULL,
      resource_id     TEXT NOT NULL,
      instrument      TEXT NOT NULL,
      dimensions_key  TEXT NOT NULL,
      dimensions_json TEXT NOT NULL,
      catalog_version INTEGER NOT NULL,
      kind            TEXT NOT NULL,      -- counter | histogram | gauge
      -- Stream start, preserved across restarts. This is what makes a cumulative counter
      -- survive a reboot instead of looking like a reset to the backend.
      start_time      INTEGER NOT NULL,
      last_time       INTEGER NOT NULL,
      value           REAL NOT NULL DEFAULT 0,
      hist_count      INTEGER,
      hist_sum        REAL,
      hist_min        REAL,
      hist_max        REAL,
      hist_buckets    TEXT,
      PRIMARY KEY (profile, policy_epoch, resource_id, instrument, dimensions_key)
    );

    -- Immutable export payloads. A retry re-sends THIS row; it never re-aggregates and never
    -- restamps, which is what keeps an ambiguous acknowledgement from double counting.
    CREATE TABLE IF NOT EXISTS telemetry_batches (
      id                     TEXT PRIMARY KEY,
      profile                TEXT NOT NULL,
      signal                 TEXT NOT NULL,
      destination_generation INTEGER NOT NULL,
      policy_epoch           INTEGER NOT NULL,
      catalog_version        INTEGER NOT NULL,
      envelope_version       INTEGER NOT NULL,
      payload_json           TEXT NOT NULL,
      digest                 TEXT NOT NULL,
      item_count             INTEGER NOT NULL,
      bytes                  INTEGER NOT NULL,
      created_at             INTEGER NOT NULL,
      oldest_event_at        INTEGER NOT NULL
    );

    -- Delivery state, separate from the payload so one destination's failure cannot rewrite a
    -- batch another destination already accepted.
    CREATE TABLE IF NOT EXISTS telemetry_delivery (
      batch_id         TEXT PRIMARY KEY,
      profile          TEXT NOT NULL,
      signal           TEXT NOT NULL,
      state            TEXT NOT NULL,
      attempts         INTEGER NOT NULL DEFAULT 0,
      lease_owner      TEXT,
      lease_expires_at INTEGER,
      next_attempt_at  INTEGER NOT NULL,
      accepted_items   INTEGER NOT NULL DEFAULT 0,
      rejected_items   INTEGER NOT NULL DEFAULT 0,
      last_error       TEXT,
      updated_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_telemetry_delivery_ready
      ON telemetry_delivery(profile, signal, state, next_attempt_at);

    -- Per-profile destination identity. The generation moves on every endpoint change and the
    -- policy epoch on every consent transition, so a queued batch can be matched against the
    -- destination it was built for and never silently follow a changed endpoint.
    CREATE TABLE IF NOT EXISTS telemetry_destinations (
      profile          TEXT PRIMARY KEY,
      generation       INTEGER NOT NULL DEFAULT 1,
      policy_epoch     INTEGER NOT NULL DEFAULT 1,
      -- A DIGEST of the endpoint, never the endpoint. Enough to detect a change, useless to
      -- anything that reads this table looking for somewhere to send data.
      endpoint_digest  TEXT NOT NULL DEFAULT '',
      paused_reason    TEXT,
      last_accepted_at INTEGER,
      last_error       TEXT,
      updated_at       INTEGER NOT NULL
    );

    -- Export credentials, resolved at SEND time and never at projection time.
    --
    -- Its own table rather than a field on the config blob, and that is the privacy contract
    -- rather than tidiness: "app_config" is enumerated by the settings backup service and
    -- returned by the config API, so a credential living there would be copied into every
    -- snapshot and echoed to every dashboard read.
    CREATE TABLE IF NOT EXISTS telemetry_secrets (
      profile      TEXT PRIMARY KEY,
      header_name  TEXT NOT NULL,
      header_value TEXT NOT NULL,
      updated_at   INTEGER NOT NULL
    );

    -- What could NOT be recorded, aggregated by kind so it is bounded by the vocabulary rather
    -- than by how bad the day was.
    CREATE TABLE IF NOT EXISTS telemetry_gaps (
      kind     TEXT PRIMARY KEY,
      count    INTEGER NOT NULL DEFAULT 0,
      first_at INTEGER NOT NULL,
      last_at  INTEGER NOT NULL,
      detail   TEXT NOT NULL DEFAULT ''
    );
  `);
}

/**
 * Forward migrations for the tables above, run on every open after the CREATEs.
 *
 * Empty in Phase 1 because these tables ship together, and present anyway because the next
 * phase to add a column needs the seam to already be on the upgrade path rather than inventing
 * one under time pressure. Each addition must be idempotent: this runs on every start.
 */
export function migrateTelemetry(d: DatabaseSync): void {
  void d;
}

/** The idempotent column add the migrations above use. Mirrors `db.ts`'s private helper. */
export function addTelemetryColumn(
  d: DatabaseSync,
  table: string,
  column: string,
  decl: string,
): boolean {
  const columns = d.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  if (columns.some((c) => c.name === column)) return false;
  d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl};`);
  return true;
}
