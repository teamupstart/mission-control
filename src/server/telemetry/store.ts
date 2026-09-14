/**
 * Every read and write the telemetry facility makes against SQLite.
 *
 * One module so the transaction boundaries are visible in one place, and so nothing above it
 * knows whether the rows live in `harness.db` or somewhere else. The daemon is the only writer
 * here for the same reason it is everywhere else: the Foreman worker, the MCP server and the
 * browser all reach telemetry over the loopback API.
 *
 * The rule that matters most in this file: NO NETWORK I/O INSIDE A TRANSACTION. Serialization
 * and sending happen outside `telemetryTransaction`, against immutable rows that were already
 * committed, which is what lets a crash mid-send be a retry rather than a hole.
 */
import type { DatabaseSync } from "node:sqlite";
import {
  TELEMETRY_LIMITS,
  type TelemetryActor,
  type TelemetryDeliveryState,
  type TelemetryGapKind,
  type TelemetryPauseReason,
  type TelemetryProfileId,
  type TelemetrySignal,
  type TelemetrySourceIdentity,
} from "@shared/telemetry.ts";
import { openDb } from "../db.ts";
import { digest, stableJson } from "./identity.ts";

/**
 * One `BEGIN IMMEDIATE` transaction, matching the workflow store's helper.
 *
 * Immediate rather than deferred because every caller here writes, and taking the write lock
 * up front turns a second writer into an immediate failure rather than a partial transaction
 * that fails on its first write. `db.ts` documents why there is no busy timeout beside it.
 */
export function telemetryTransaction<T>(fn: (d: DatabaseSync) => T): T {
  const d = openDb();
  d.exec("BEGIN IMMEDIATE");
  try {
    const result = fn(d);
    d.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      d.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

// ---- resources and contexts ----

/**
 * Record an immutable resource identity and return its content address.
 *
 * Idempotent by construction: the same attributes always produce the same id, so a daemon that
 * restarts a hundred times on one build writes one row.
 */
export function putResource(d: DatabaseSync, attributes: Record<string, string>, now: number): string {
  const id = digest(attributes);
  d.prepare(
    `INSERT INTO telemetry_resources (id, attributes_json, created_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(id, stableJson(attributes), now);
  return id;
}

export function getResource(d: DatabaseSync, id: string): Record<string, string> | null {
  const row = d.prepare(`SELECT attributes_json FROM telemetry_resources WHERE id = ?`).get(id) as
    | { attributes_json: string }
    | undefined;
  if (!row) return null;
  return JSON.parse(row.attributes_json) as Record<string, string>;
}

export function putContext(d: DatabaseSync, attributes: Record<string, string>, now: number): string {
  const id = digest(attributes);
  d.prepare(
    `INSERT INTO telemetry_contexts (id, attributes_json, created_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(id, stableJson(attributes), now);
  return id;
}

export function getContext(d: DatabaseSync, id: string): Record<string, string> | null {
  const row = d.prepare(`SELECT attributes_json FROM telemetry_contexts WHERE id = ?`).get(id) as
    | { attributes_json: string }
    | undefined;
  if (!row) return null;
  return JSON.parse(row.attributes_json) as Record<string, string>;
}

// ---- journal ----

export interface StoredTelemetryEvent {
  seq: number;
  eventId: string;
  envelopeVersion: number;
  name: string;
  eventVersion: number;
  source: TelemetrySourceIdentity;
  occurredAt: number;
  observedAt: number;
  resourceId: string;
  contextId: string;
  actor: TelemetryActor;
  refs: Record<string, string>;
  refsOmitted: number;
  facts: Record<string, unknown>;
  /** The profiles eligible AT CAPTURE. Never recomputed from today's config. */
  profiles: TelemetryProfileId[];
  /** Each eligible profile's consent epoch at capture. */
  epochs: Record<string, number>;
  bytes: number;
}

export type JournalAppend = Omit<StoredTelemetryEvent, "seq">;

interface JournalRow {
  seq: number;
  event_id: string;
  envelope_version: number;
  name: string;
  event_version: number;
  source_kind: string;
  source_id: string;
  source_revision: number;
  occurred_at: number;
  observed_at: number;
  resource_id: string;
  context_id: string;
  actor_json: string;
  refs_json: string;
  refs_omitted: number;
  facts_json: string;
  profiles_json: string;
  epochs_json: string;
  bytes: number;
}

function toEvent(row: JournalRow): StoredTelemetryEvent {
  return {
    seq: row.seq,
    eventId: row.event_id,
    envelopeVersion: row.envelope_version,
    name: row.name,
    eventVersion: row.event_version,
    source: { kind: row.source_kind, id: row.source_id, revision: row.source_revision },
    occurredAt: row.occurred_at,
    observedAt: row.observed_at,
    resourceId: row.resource_id,
    contextId: row.context_id,
    actor: JSON.parse(row.actor_json) as TelemetryActor,
    refs: JSON.parse(row.refs_json) as Record<string, string>,
    refsOmitted: row.refs_omitted,
    facts: JSON.parse(row.facts_json) as Record<string, unknown>,
    profiles: JSON.parse(row.profiles_json) as TelemetryProfileId[],
    epochs: JSON.parse(row.epochs_json) as Record<string, number>,
    bytes: row.bytes,
  };
}

/**
 * Append one accepted fact, or report that its source identity is already recorded.
 *
 * The duplicate check reads `telemetry_source_identities` rather than the journal, because the
 * journal row can be pruned while the identity must not be: an expired historical source must
 * never be importable again as fresh activity.
 */
export function findSourceIdentity(
  d: DatabaseSync,
  source: TelemetrySourceIdentity,
): string | null {
  const existing = d
    .prepare(
      `SELECT event_id FROM telemetry_source_identities
        WHERE source_kind = ? AND source_id = ? AND source_revision = ?`,
    )
    .get(source.kind, source.id, source.revision) as { event_id: string } | undefined;
  return existing?.event_id ?? null;
}

export function appendJournal(
  d: DatabaseSync,
  event: JournalAppend,
): { kind: "accepted"; seq: number } | { kind: "duplicate"; eventId: string } {
  // Kept here as well as at the caller: this function must be safe to call on its own, and the
  // two checks agreeing costs one indexed lookup.
  const existingId = findSourceIdentity(d, event.source);
  if (existingId) return { kind: "duplicate", eventId: existingId };

  const result = d
    .prepare(
      `INSERT INTO telemetry_journal (
         event_id, envelope_version, name, event_version,
         source_kind, source_id, source_revision,
         occurred_at, observed_at, resource_id, context_id,
         actor_json, refs_json, refs_omitted, facts_json,
         profiles_json, epochs_json, bytes
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      event.eventId,
      event.envelopeVersion,
      event.name,
      event.eventVersion,
      event.source.kind,
      event.source.id,
      event.source.revision,
      event.occurredAt,
      event.observedAt,
      event.resourceId,
      event.contextId,
      JSON.stringify(event.actor),
      JSON.stringify(event.refs),
      event.refsOmitted,
      JSON.stringify(event.facts),
      JSON.stringify(event.profiles),
      JSON.stringify(event.epochs),
      event.bytes,
    );

  d.prepare(
    `INSERT INTO telemetry_source_identities
       (source_kind, source_id, source_revision, event_id, captured_at)
     VALUES (?,?,?,?,?)`,
  ).run(event.source.kind, event.source.id, event.source.revision, event.eventId, event.observedAt);

  return { kind: "accepted", seq: Number(result.lastInsertRowid) };
}

/** One bounded projection batch: rows after `afterSeq`, oldest first, payload still present. */
export function readJournalAfter(
  d: DatabaseSync,
  afterSeq: number,
  limit: number,
): StoredTelemetryEvent[] {
  const rows = d
    .prepare(
      `SELECT * FROM telemetry_journal
        WHERE seq > ? AND payload_pruned_at IS NULL
        ORDER BY seq ASC LIMIT ?`,
    )
    .all(afterSeq, limit) as unknown as JournalRow[];
  return rows.map(toEvent);
}

/** The highest sequence the journal holds, or 0 when it is empty. */
export function journalHead(d: DatabaseSync): number {
  const row = d.prepare(`SELECT MAX(seq) AS head FROM telemetry_journal`).get() as
    | { head: number | null }
    | undefined;
  return row?.head ?? 0;
}

/** Rows admitted but not yet consumed by the slowest projection. */
export function journalBacklog(d: DatabaseSync, consumedSeq: number): number {
  const row = d
    .prepare(
      `SELECT COUNT(*) AS n FROM telemetry_journal WHERE seq > ? AND payload_pruned_at IS NULL`,
    )
    .get(consumedSeq) as { n: number } | undefined;
  return row?.n ?? 0;
}

// ---- projection state ----

export interface StoredProjectionState {
  stateVersion: number;
  consumedSeq: number;
  state: unknown;
}

export function getProjectionState(
  d: DatabaseSync,
  projection: string,
  profile: TelemetryProfileId,
): StoredProjectionState | null {
  const row = d
    .prepare(
      `SELECT state_version, consumed_seq, state_json FROM telemetry_projection_state
        WHERE projection = ? AND profile = ?`,
    )
    .get(projection, profile) as
    | { state_version: number; consumed_seq: number; state_json: string }
    | undefined;
  if (!row) return null;
  return {
    stateVersion: row.state_version,
    consumedSeq: row.consumed_seq,
    state: JSON.parse(row.state_json) as unknown,
  };
}

export function putProjectionState(
  d: DatabaseSync,
  projection: string,
  profile: TelemetryProfileId,
  next: StoredProjectionState,
  now: number,
): void {
  d.prepare(
    `INSERT INTO telemetry_projection_state
       (projection, profile, state_version, consumed_seq, state_json, updated_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(projection, profile) DO UPDATE SET
       state_version = excluded.state_version,
       consumed_seq  = excluded.consumed_seq,
       state_json    = excluded.state_json,
       updated_at    = excluded.updated_at`,
  ).run(projection, profile, next.stateVersion, next.consumedSeq, JSON.stringify(next.state), now);
}

/** The lowest checkpoint across every registered projection, which bounds payload pruning. */
export function lowestConsumedSeq(d: DatabaseSync): number | null {
  const row = d
    .prepare(`SELECT MIN(consumed_seq) AS low FROM telemetry_projection_state`)
    .get() as { low: number | null } | undefined;
  return row?.low ?? null;
}

// ---- cumulative series ----

export interface SeriesKey {
  profile: TelemetryProfileId;
  policyEpoch: number;
  resourceId: string;
  instrument: string;
  dimensionsKey: string;
}

export interface StoredSeries extends SeriesKey {
  dimensions: Record<string, string>;
  catalogVersion: number;
  kind: "counter" | "histogram" | "gauge";
  startTime: number;
  lastTime: number;
  value: number;
  histogram: StoredHistogram | null;
}

export interface StoredHistogram {
  count: number;
  sum: number;
  min: number | null;
  max: number | null;
  /** One entry per boundary, plus the final `+Inf` bucket. */
  buckets: number[];
}

interface SeriesRow {
  profile: string;
  policy_epoch: number;
  resource_id: string;
  instrument: string;
  dimensions_key: string;
  dimensions_json: string;
  catalog_version: number;
  kind: string;
  start_time: number;
  last_time: number;
  value: number;
  hist_count: number | null;
  hist_sum: number | null;
  hist_min: number | null;
  hist_max: number | null;
  hist_buckets: string | null;
}

function toSeries(row: SeriesRow): StoredSeries {
  return {
    profile: row.profile as TelemetryProfileId,
    policyEpoch: row.policy_epoch,
    resourceId: row.resource_id,
    instrument: row.instrument,
    dimensionsKey: row.dimensions_key,
    dimensions: JSON.parse(row.dimensions_json) as Record<string, string>,
    catalogVersion: row.catalog_version,
    kind: row.kind as StoredSeries["kind"],
    startTime: row.start_time,
    lastTime: row.last_time,
    value: row.value,
    histogram:
      row.hist_buckets === null
        ? null
        : {
            count: row.hist_count ?? 0,
            sum: row.hist_sum ?? 0,
            min: row.hist_min,
            max: row.hist_max,
            buckets: JSON.parse(row.hist_buckets) as number[],
          },
  };
}

export function getSeries(d: DatabaseSync, key: SeriesKey): StoredSeries | null {
  const row = d
    .prepare(
      `SELECT * FROM telemetry_series
        WHERE profile = ? AND policy_epoch = ? AND resource_id = ?
          AND instrument = ? AND dimensions_key = ?`,
    )
    .get(key.profile, key.policyEpoch, key.resourceId, key.instrument, key.dimensionsKey) as
    | SeriesRow
    | undefined;
  return row ? toSeries(row) : null;
}

export function putSeries(d: DatabaseSync, series: StoredSeries): void {
  d.prepare(
    `INSERT INTO telemetry_series (
       profile, policy_epoch, resource_id, instrument, dimensions_key, dimensions_json,
       catalog_version, kind, start_time, last_time, value,
       hist_count, hist_sum, hist_min, hist_max, hist_buckets
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(profile, policy_epoch, resource_id, instrument, dimensions_key) DO UPDATE SET
       catalog_version = excluded.catalog_version,
       last_time    = excluded.last_time,
       value        = excluded.value,
       hist_count   = excluded.hist_count,
       hist_sum     = excluded.hist_sum,
       hist_min     = excluded.hist_min,
       hist_max     = excluded.hist_max,
       hist_buckets = excluded.hist_buckets`,
  ).run(
    series.profile,
    series.policyEpoch,
    series.resourceId,
    series.instrument,
    series.dimensionsKey,
    JSON.stringify(series.dimensions),
    series.catalogVersion,
    series.kind,
    series.startTime,
    series.lastTime,
    series.value,
    series.histogram?.count ?? null,
    series.histogram?.sum ?? null,
    series.histogram?.min ?? null,
    series.histogram?.max ?? null,
    series.histogram ? JSON.stringify(series.histogram.buckets) : null,
  );
}

/** How many distinct streams one instrument already has, for the per-instrument ceiling. */
export function seriesCountForInstrument(
  d: DatabaseSync,
  profile: TelemetryProfileId,
  policyEpoch: number,
  resourceId: string,
  instrument: string,
): number {
  const row = d
    .prepare(
      `SELECT COUNT(*) AS n FROM telemetry_series
        WHERE profile = ? AND policy_epoch = ? AND resource_id = ? AND instrument = ?`,
    )
    .get(profile, policyEpoch, resourceId, instrument) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** How many distinct streams one profile already has, for the per-profile ceiling. */
export function seriesCountForProfile(d: DatabaseSync, profile: TelemetryProfileId): number {
  const row = d
    .prepare(`SELECT COUNT(*) AS n FROM telemetry_series WHERE profile = ?`)
    .get(profile) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function listSeries(d: DatabaseSync, profile: TelemetryProfileId): StoredSeries[] {
  const rows = d
    .prepare(`SELECT * FROM telemetry_series WHERE profile = ? ORDER BY instrument, dimensions_key`)
    .all(profile) as unknown as SeriesRow[];
  return rows.map(toSeries);
}

// ---- batches and delivery ----

export interface StoredBatch {
  id: string;
  profile: TelemetryProfileId;
  signal: TelemetrySignal;
  destinationGeneration: number;
  policyEpoch: number;
  catalogVersion: number;
  envelopeVersion: number;
  /** The durable DTO. Wire bytes are produced outside the transaction, from this. */
  payload: unknown;
  digest: string;
  itemCount: number;
  bytes: number;
  createdAt: number;
  oldestEventAt: number;
}

interface BatchRow {
  id: string;
  profile: string;
  signal: string;
  destination_generation: number;
  policy_epoch: number;
  catalog_version: number;
  envelope_version: number;
  payload_json: string;
  digest: string;
  item_count: number;
  bytes: number;
  created_at: number;
  oldest_event_at: number;
}

function toBatch(row: BatchRow): StoredBatch {
  return {
    id: row.id,
    profile: row.profile as TelemetryProfileId,
    signal: row.signal as TelemetrySignal,
    destinationGeneration: row.destination_generation,
    policyEpoch: row.policy_epoch,
    catalogVersion: row.catalog_version,
    envelopeVersion: row.envelope_version,
    payload: JSON.parse(row.payload_json) as unknown,
    digest: row.digest,
    itemCount: row.item_count,
    bytes: row.bytes,
    createdAt: row.created_at,
    oldestEventAt: row.oldest_event_at,
  };
}

/** Insert an immutable batch and its independent pending delivery row, together. */
export function insertBatch(d: DatabaseSync, batch: StoredBatch, now: number): void {
  d.prepare(
    `INSERT INTO telemetry_batches (
       id, profile, signal, destination_generation, policy_epoch, catalog_version,
       envelope_version, payload_json, digest, item_count, bytes, created_at, oldest_event_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    batch.id,
    batch.profile,
    batch.signal,
    batch.destinationGeneration,
    batch.policyEpoch,
    batch.catalogVersion,
    batch.envelopeVersion,
    JSON.stringify(batch.payload),
    batch.digest,
    batch.itemCount,
    batch.bytes,
    batch.createdAt,
    batch.oldestEventAt,
  );
  d.prepare(
    `INSERT INTO telemetry_delivery
       (batch_id, profile, signal, state, attempts, next_attempt_at, updated_at)
     VALUES (?,?,?,'pending',0,?,?)`,
  ).run(batch.id, batch.profile, batch.signal, now, now);
}

export interface LeasedBatch {
  batch: StoredBatch;
  attempts: number;
}

/**
 * Take the oldest ready batch for one destination and signal, and mark it leased.
 *
 * One at a time per partition, which is what keeps ordered cumulative points ordered and holds
 * the single in-flight request budget. A lease that expires is reclaimable, and reclaiming one
 * deliberately does NOT assume the previous request never reached the server - see
 * `settleDelivery`'s ambiguity handling.
 */
export function leaseBatch(
  d: DatabaseSync,
  profile: TelemetryProfileId,
  signal: TelemetrySignal,
  owner: string,
  now: number,
): LeasedBatch | null {
  const row = d
    .prepare(
      `SELECT b.*, dl.attempts AS attempts FROM telemetry_delivery dl
         JOIN telemetry_batches b ON b.id = dl.batch_id
        WHERE dl.profile = ? AND dl.signal = ?
          AND dl.state IN ('pending','retry','leased')
          AND dl.next_attempt_at <= ?
          AND (dl.state != 'leased' OR dl.lease_expires_at IS NULL OR dl.lease_expires_at <= ?)
        ORDER BY b.created_at ASC, b.id ASC LIMIT 1`,
    )
    .get(profile, signal, now, now) as (BatchRow & { attempts: number }) | undefined;
  if (!row) return null;
  d.prepare(
    `UPDATE telemetry_delivery
        SET state = 'leased', lease_owner = ?, lease_expires_at = ?, updated_at = ?
      WHERE batch_id = ?`,
  ).run(owner, now + TELEMETRY_LIMITS.leaseMs, now, row.id);
  return { batch: toBatch(row), attempts: row.attempts };
}

export function settleDelivery(
  d: DatabaseSync,
  batchId: string,
  next: {
    state: TelemetryDeliveryState;
    attempts: number;
    nextAttemptAt: number;
    acceptedItems?: number;
    rejectedItems?: number;
    lastError: string | null;
  },
  now: number,
): void {
  d.prepare(
    `UPDATE telemetry_delivery
        SET state = ?, attempts = ?, lease_owner = NULL, lease_expires_at = NULL,
            next_attempt_at = ?, accepted_items = ?, rejected_items = ?,
            last_error = ?, updated_at = ?
      WHERE batch_id = ?`,
  ).run(
    next.state,
    next.attempts,
    next.nextAttemptAt,
    next.acceptedItems ?? 0,
    next.rejectedItems ?? 0,
    next.lastError,
    now,
    batchId,
  );
}

/**
 * Release every lease this daemon may have left behind.
 *
 * Called on startup. A leased row whose sender died is returned to `retry` rather than
 * `pending`, because its request may have been accepted remotely: the retry path is where
 * that ambiguity is already handled and counted.
 */
export function recoverLeases(d: DatabaseSync, now: number): number {
  const result = d
    .prepare(
      `UPDATE telemetry_delivery
          SET state = 'retry', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE state = 'leased'`,
    )
    .run(now);
  return Number(result.changes);
}

/** Drop the payload of a settled batch while keeping its delivery accounting. */
export function releaseBatchPayload(d: DatabaseSync, batchId: string): void {
  d.prepare(`DELETE FROM telemetry_batches WHERE id = ?`).run(batchId);
}

export interface DeliveryCounts {
  pending: number;
  retrying: number;
  accepted: number;
  rejected: number;
  expired: number;
  oldestPendingAt: number | null;
  pendingBytes: number;
}

export function deliveryCounts(d: DatabaseSync, profile: TelemetryProfileId): DeliveryCounts {
  const rows = d
    .prepare(
      `SELECT dl.state AS state, COUNT(*) AS n FROM telemetry_delivery dl
        WHERE dl.profile = ? GROUP BY dl.state`,
    )
    .all(profile) as unknown as Array<{ state: string; n: number }>;
  const by = new Map(rows.map((r) => [r.state, r.n]));
  const oldest = d
    .prepare(
      `SELECT MIN(b.created_at) AS at, COALESCE(SUM(b.bytes), 0) AS bytes
         FROM telemetry_delivery dl JOIN telemetry_batches b ON b.id = dl.batch_id
        WHERE dl.profile = ? AND dl.state IN ('pending','retry','leased')`,
    )
    .get(profile) as { at: number | null; bytes: number } | undefined;
  return {
    // A leased batch is still undelivered work, so it reads as pending rather than vanishing
    // from the operator's view for the duration of one request.
    pending: (by.get("pending") ?? 0) + (by.get("leased") ?? 0),
    retrying: by.get("retry") ?? 0,
    accepted: by.get("accepted") ?? 0,
    rejected: by.get("rejected") ?? 0,
    expired: by.get("expired") ?? 0,
    oldestPendingAt: oldest?.at ?? null,
    pendingBytes: oldest?.bytes ?? 0,
  };
}

/** Undelivered batches older than the retention window, oldest first. */
export function expiredBatchIds(
  d: DatabaseSync,
  olderThan: number,
  now: number,
  limit: number,
): string[] {
  const rows = d
    .prepare(
      `SELECT dl.batch_id AS id FROM telemetry_delivery dl
         JOIN telemetry_batches b ON b.id = dl.batch_id
        WHERE dl.state IN ('pending','retry','leased')
          -- A batch whose lease is still live is IN FLIGHT: a request carrying it is awaiting
          -- a response right now. Expiring it would delete the payload from under the sender,
          -- so its settlement would then update accounting for a batch that no longer exists.
          -- A lease that has already expired is fair game; that sender is gone.
          AND (dl.state != 'leased' OR dl.lease_expires_at IS NULL OR dl.lease_expires_at <= ?)
          AND b.created_at < ?
        ORDER BY b.created_at ASC LIMIT ?`,
    )
    .all(now, olderThan, limit) as unknown as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** Every undelivered batch for one profile, for a consent withdrawal purge. */
export function purgeProfileQueue(d: DatabaseSync, profile: TelemetryProfileId): number {
  const ids = d
    .prepare(
      `SELECT batch_id AS id FROM telemetry_delivery
        WHERE profile = ? AND state IN ('pending','retry','leased')`,
    )
    .all(profile) as unknown as Array<{ id: string }>;
  for (const { id } of ids) {
    d.prepare(`DELETE FROM telemetry_batches WHERE id = ?`).run(id);
    d.prepare(`DELETE FROM telemetry_delivery WHERE batch_id = ?`).run(id);
  }
  d.prepare(`DELETE FROM telemetry_series WHERE profile = ?`).run(profile);
  d.prepare(`DELETE FROM telemetry_projection_state WHERE profile = ?`).run(profile);
  return ids.length;
}

// ---- destinations ----

export interface StoredDestination {
  profile: TelemetryProfileId;
  generation: number;
  policyEpoch: number;
  endpointDigest: string;
  pausedReason: TelemetryPauseReason | null;
  lastAcceptedAt: number | null;
  lastError: string | null;
}

export function getDestination(d: DatabaseSync, profile: TelemetryProfileId): StoredDestination {
  const row = d.prepare(`SELECT * FROM telemetry_destinations WHERE profile = ?`).get(profile) as
    | {
        profile: string;
        generation: number;
        policy_epoch: number;
        endpoint_digest: string;
        paused_reason: string | null;
        last_accepted_at: number | null;
        last_error: string | null;
      }
    | undefined;
  if (!row) {
    // The defaults, WITHOUT writing them. Reading a destination must not create one: the health
    // route is a read, an installation that has never opted in must leave no telemetry trace,
    // and a status poll is not consent. `updateDestination` does the upsert when something
    // actually changes.
    return {
      profile,
      generation: 1,
      policyEpoch: 1,
      endpointDigest: "",
      pausedReason: null,
      lastAcceptedAt: null,
      lastError: null,
    };
  }
  return {
    profile,
    generation: row.generation,
    policyEpoch: row.policy_epoch,
    endpointDigest: row.endpoint_digest,
    pausedReason: (row.paused_reason as TelemetryPauseReason | null) ?? null,
    lastAcceptedAt: row.last_accepted_at,
    lastError: row.last_error,
  };
}

export function updateDestination(
  d: DatabaseSync,
  profile: TelemetryProfileId,
  patch: Partial<Omit<StoredDestination, "profile">>,
  now: number,
): void {
  const current = getDestination(d, profile);
  const next = { ...current, ...patch };
  d.prepare(
    `INSERT INTO telemetry_destinations
       (profile, generation, policy_epoch, endpoint_digest, paused_reason,
        last_accepted_at, last_error, updated_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(profile) DO UPDATE SET
       generation       = excluded.generation,
       policy_epoch     = excluded.policy_epoch,
       endpoint_digest  = excluded.endpoint_digest,
       paused_reason    = excluded.paused_reason,
       last_accepted_at = excluded.last_accepted_at,
       last_error       = excluded.last_error,
       updated_at       = excluded.updated_at`,
  ).run(
    profile,
    next.generation,
    next.policyEpoch,
    next.endpointDigest,
    next.pausedReason,
    next.lastAcceptedAt,
    next.lastError,
    now,
  );
}

// ---- secrets ----

export function putSecret(
  d: DatabaseSync,
  profile: TelemetryProfileId,
  headerName: string,
  headerValue: string,
  now: number,
): void {
  d.prepare(
    `INSERT INTO telemetry_secrets (profile, header_name, header_value, updated_at)
     VALUES (?,?,?,?)
     ON CONFLICT(profile) DO UPDATE SET
       header_name = excluded.header_name,
       header_value = excluded.header_value,
       updated_at = excluded.updated_at`,
  ).run(profile, headerName, headerValue, now);
}

export function clearSecret(d: DatabaseSync, profile: TelemetryProfileId): void {
  d.prepare(`DELETE FROM telemetry_secrets WHERE profile = ?`).run(profile);
}

/**
 * Resolve a credential at SEND time.
 *
 * Nothing caches the result: a credential that lived in a projection's memory would outlive the
 * consent that authorized it, and a batch that carried one would put it on disk.
 */
export function getSecret(
  d: DatabaseSync,
  profile: TelemetryProfileId,
): { headerName: string; headerValue: string } | null {
  const row = d
    .prepare(`SELECT header_name, header_value FROM telemetry_secrets WHERE profile = ?`)
    .get(profile) as { header_name: string; header_value: string } | undefined;
  if (!row) return null;
  return { headerName: row.header_name, headerValue: row.header_value };
}

export function hasSecret(d: DatabaseSync, profile: TelemetryProfileId): boolean {
  return getSecret(d, profile) !== null;
}

// ---- gaps ----

/**
 * Record that something could not be recorded.
 *
 * Aggregated by kind, so an offline week produces six rows rather than a second unbounded log.
 * The detail is the LAST one, bounded, and never a payload.
 */
export function recordGap(
  d: DatabaseSync,
  kind: TelemetryGapKind,
  detail: string,
  now: number,
  count = 1,
): void {
  d.prepare(
    `INSERT INTO telemetry_gaps (kind, count, first_at, last_at, detail)
     VALUES (?,?,?,?,?)
     ON CONFLICT(kind) DO UPDATE SET
       count = telemetry_gaps.count + excluded.count,
       last_at = excluded.last_at,
       detail = excluded.detail`,
  ).run(kind, count, now, now, detail.slice(0, 256));
}

export function listGaps(
  d: DatabaseSync,
): Array<{ kind: TelemetryGapKind; count: number; firstAt: number; lastAt: number; detail: string }> {
  const rows = d
    .prepare(`SELECT kind, count, first_at, last_at, detail FROM telemetry_gaps ORDER BY kind`)
    .all() as unknown as Array<{
    kind: string;
    count: number;
    first_at: number;
    last_at: number;
    detail: string;
  }>;
  return rows.map((r) => ({
    kind: r.kind as TelemetryGapKind,
    count: r.count,
    firstAt: r.first_at,
    lastAt: r.last_at,
    detail: r.detail,
  }));
}

// ---- capacity ----

/**
 * The logical bytes charged against the total budget.
 *
 * Counts payload copies and pending serialization inputs, not just journal JSON: a batch is a
 * second copy of the same facts and pretending otherwise would let the real footprint be
 * several times the number an operator was shown.
 */
export function usedBytes(d: DatabaseSync): number {
  const row = d
    .prepare(
      `SELECT
         (SELECT COALESCE(SUM(bytes),0) FROM telemetry_journal WHERE payload_pruned_at IS NULL)
         + (SELECT COALESCE(SUM(bytes),0) FROM telemetry_batches)
         + (SELECT COALESCE(SUM(LENGTH(state_json)),0) FROM telemetry_projection_state)
         + (SELECT COALESCE(SUM(LENGTH(dimensions_json) + 64),0) FROM telemetry_series)
         + (SELECT COALESCE(SUM(LENGTH(attributes_json)),0) FROM telemetry_contexts)
         + (SELECT COALESCE(SUM(LENGTH(attributes_json)),0) FROM telemetry_resources)
         AS total`,
    )
    .get() as { total: number } | undefined;
  return row?.total ?? 0;
}

// ---- retention ----

/** Drop the payload of journal rows that are past the window AND already projected. */
export function pruneJournalPayloads(
  d: DatabaseSync,
  olderThan: number,
  consumedThrough: number,
  now: number,
  limit: number,
): number {
  const result = d
    .prepare(
      `UPDATE telemetry_journal SET payload_pruned_at = ?, facts_json = '{}', refs_json = '{}', bytes = 0
        WHERE seq IN (
          SELECT seq FROM telemetry_journal
           WHERE payload_pruned_at IS NULL AND observed_at < ? AND seq <= ?
           ORDER BY seq ASC LIMIT ?
        )`,
    )
    .run(now, olderThan, consumedThrough, limit);
  return Number(result.changes);
}

/** Drop pruned journal rows whose dedupe identity has also aged past the reducer window. */
export function pruneJournalRows(d: DatabaseSync, olderThan: number, limit: number): number {
  const result = d
    .prepare(
      `DELETE FROM telemetry_journal WHERE seq IN (
         SELECT seq FROM telemetry_journal
          WHERE payload_pruned_at IS NOT NULL AND observed_at < ?
          ORDER BY seq ASC LIMIT ?
       )`,
    )
    .run(olderThan, limit);
  return Number(result.changes);
}

/** Expire dedupe identities past the reducer-state window. */
export function pruneSourceIdentities(d: DatabaseSync, olderThan: number, limit: number): number {
  const result = d
    .prepare(
      `DELETE FROM telemetry_source_identities WHERE rowid IN (
         SELECT rowid FROM telemetry_source_identities WHERE captured_at < ? LIMIT ?
       )`,
    )
    .run(olderThan, limit);
  return Number(result.changes);
}

/** Drop contexts and resources nothing references any more. */
export function pruneOrphanedContexts(d: DatabaseSync): number {
  const result = d
    .prepare(
      `DELETE FROM telemetry_contexts
        WHERE id NOT IN (SELECT DISTINCT context_id FROM telemetry_journal)`,
    )
    .run();
  return Number(result.changes);
}
