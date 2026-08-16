import type { DatabaseSync } from "node:sqlite";

export const WORKTREE_SLOT_STATES = [
  "provisioning",
  "available",
  "leased",
  "returning",
  "pruning",
  "quarantined",
] as const;
export type WorktreeSlotState = (typeof WORKTREE_SLOT_STATES)[number];

export interface WorktreePoolRow {
  id: string;
  gitCommonDirectory: string;
  mainCheckoutRoot: string;
  poolPath: string;
  ordinalHighWater: number;
  lastReconciledAt: number | null;
  reconciliationError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorktreeSlotRow {
  id: string;
  poolId: string;
  ordinal: number;
  path: string;
  /** Read as string so a newer append-only state fails closed instead of being coerced. */
  state: string;
  version: number;
  requestedHeadSha: string | null;
  currentHeadSha: string | null;
  activeLeaseId: string | null;
  activeOwnerKind: string | null;
  activeOwnerKey: string | null;
  leasedAt: number | null;
  lastReleasedLeaseId: string | null;
  lastReleasedOwnerKind: string | null;
  lastReleasedOwnerKey: string | null;
  lastUsedAt: number | null;
  quarantineReason: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

function poolRow(row: Record<string, unknown>): WorktreePoolRow {
  return {
    id: String(row.id),
    gitCommonDirectory: String(row.git_common_dir),
    mainCheckoutRoot: String(row.main_checkout_root),
    poolPath: String(row.pool_path),
    ordinalHighWater: Number(row.ordinal_high_water),
    lastReconciledAt: row.last_reconciled_at === null ? null : Number(row.last_reconciled_at),
    reconciliationError: row.reconciliation_error === null ? null : String(row.reconciliation_error),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function slotRow(row: Record<string, unknown>): WorktreeSlotRow {
  return {
    id: String(row.id),
    poolId: String(row.pool_id),
    ordinal: Number(row.ordinal),
    path: String(row.path),
    state: String(row.state),
    version: Number(row.version),
    requestedHeadSha: row.requested_head_sha === null ? null : String(row.requested_head_sha),
    currentHeadSha: row.current_head_sha === null ? null : String(row.current_head_sha),
    activeLeaseId: row.active_lease_id === null ? null : String(row.active_lease_id),
    activeOwnerKind: row.active_owner_kind === null ? null : String(row.active_owner_kind),
    activeOwnerKey: row.active_owner_key === null ? null : String(row.active_owner_key),
    leasedAt: row.leased_at === null ? null : Number(row.leased_at),
    lastReleasedLeaseId:
      row.last_released_lease_id === null ? null : String(row.last_released_lease_id),
    lastReleasedOwnerKind:
      row.last_released_owner_kind === null ? null : String(row.last_released_owner_kind),
    lastReleasedOwnerKey:
      row.last_released_owner_key === null ? null : String(row.last_released_owner_key),
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
    quarantineReason: row.quarantine_reason === null ? null : String(row.quarantine_reason),
    lastError: row.last_error === null ? null : String(row.last_error),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** The only reader/writer for native operational pool and slot rows. */
export class WorktreeStore {
  constructor(private readonly db: DatabaseSync) {}

  pools(): WorktreePoolRow[] {
    return (this.db.prepare(`SELECT * FROM worktree_pools ORDER BY created_at, id`).all() as unknown as Record<string, unknown>[])
      .map(poolRow);
  }

  poolCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM worktree_pools`).get() as { n: number };
    return Number(row.n);
  }

  pool(id: string): WorktreePoolRow | null {
    const row = this.db.prepare(`SELECT * FROM worktree_pools WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? poolRow(row) : null;
  }

  poolByCommonDirectory(commonDirectory: string): WorktreePoolRow | null {
    const row = this.db.prepare(`SELECT * FROM worktree_pools WHERE git_common_dir = ?`).get(
      commonDirectory,
    ) as Record<string, unknown> | undefined;
    return row ? poolRow(row) : null;
  }

  ensurePool(input: {
    id: string;
    gitCommonDirectory: string;
    mainCheckoutRoot: string;
    poolPath: string;
    now: number;
  }): WorktreePoolRow {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO worktree_pools
           (id, git_common_dir, main_checkout_root, pool_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.gitCommonDirectory,
        input.mainCheckoutRoot,
        input.poolPath,
        input.now,
        input.now,
      );
    const existing = this.poolByCommonDirectory(input.gitCommonDirectory);
    if (!existing || existing.poolPath !== input.poolPath) {
      throw new Error("native pool identity conflicts with an existing common directory or pool path");
    }
    if (existing.mainCheckoutRoot !== input.mainCheckoutRoot) {
      this.db
        .prepare(`UPDATE worktree_pools SET main_checkout_root = ?, updated_at = ? WHERE id = ?`)
        .run(input.mainCheckoutRoot, input.now, existing.id);
      return this.pool(existing.id)!;
    }
    return existing;
  }

  slots(poolId?: string): WorktreeSlotRow[] {
    const rows = poolId
      ? this.db.prepare(`SELECT * FROM worktree_slots WHERE pool_id = ? ORDER BY ordinal`).all(poolId)
      : this.db.prepare(`SELECT * FROM worktree_slots ORDER BY pool_id, ordinal`).all();
    return (rows as unknown as Record<string, unknown>[]).map(slotRow);
  }

  slot(id: string): WorktreeSlotRow | null {
    const row = this.db.prepare(`SELECT * FROM worktree_slots WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? slotRow(row) : null;
  }

  slotByPath(path: string): WorktreeSlotRow | null {
    const row = this.db.prepare(`SELECT * FROM worktree_slots WHERE path = ?`).get(path) as
      | Record<string, unknown>
      | undefined;
    return row ? slotRow(row) : null;
  }

  slotByLeaseId(leaseId: string): WorktreeSlotRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM worktree_slots
          WHERE active_lease_id = ? OR last_released_lease_id = ?
          LIMIT 1`,
      )
      .get(leaseId, leaseId) as Record<string, unknown> | undefined;
    return row ? slotRow(row) : null;
  }

  poolForSlot(slotId: string): WorktreePoolRow | null {
    const row = this.db
      .prepare(
        `SELECT p.* FROM worktree_pools p
         JOIN worktree_slots s ON s.pool_id = p.id WHERE s.id = ?`,
      )
      .get(slotId) as Record<string, unknown> | undefined;
    return row ? poolRow(row) : null;
  }

  reserveNew(input: {
    poolId: string;
    maxSlots: number;
    id: string;
    pathForOrdinal: (ordinal: number) => string;
    leaseId: string;
    ownerKind: string;
    ownerKey: string;
    requestedHeadSha: string;
    now: number;
  }): WorktreeSlotRow | null {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const count = this.db
        .prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(ordinal), 0) AS max_ordinal FROM worktree_slots WHERE pool_id = ?`)
        .get(input.poolId) as { n: number; max_ordinal: number };
      if (Number(count.n) >= input.maxSlots) {
        this.db.exec("COMMIT;");
        return null;
      }
      const pool = this.db
        .prepare(`SELECT ordinal_high_water FROM worktree_pools WHERE id = ?`)
        .get(input.poolId) as { ordinal_high_water: number } | undefined;
      const highWater = Number(pool?.ordinal_high_water);
      const maxOrdinal = Number(count.max_ordinal);
      if (
        !pool ||
        !Number.isSafeInteger(highWater) ||
        highWater < 0 ||
        !Number.isSafeInteger(maxOrdinal) ||
        maxOrdinal < 0
      ) {
        throw new Error("native pool ordinal high-water mark is invalid");
      }
      const ordinal = Math.max(highWater, maxOrdinal) + 1;
      if (!Number.isSafeInteger(ordinal)) {
        throw new Error("native pool ordinal space is exhausted");
      }
      const advanced = this.db
        .prepare(
          `UPDATE worktree_pools SET ordinal_high_water = ?, updated_at = ?
           WHERE id = ? AND ordinal_high_water = ?`,
        )
        .run(ordinal, input.now, input.poolId, highWater);
      if (Number(advanced.changes) !== 1) {
        throw new Error("native pool ordinal high-water mark could not be advanced");
      }
      this.db
        .prepare(
          `INSERT INTO worktree_slots
             (id, pool_id, ordinal, path, state, version, requested_head_sha,
              active_lease_id, active_owner_kind, active_owner_key, leased_at,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, 'provisioning', 1, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.poolId,
          ordinal,
          input.pathForOrdinal(ordinal),
          input.requestedHeadSha,
          input.leaseId,
          input.ownerKind,
          input.ownerKey,
          input.now,
          input.now,
          input.now,
        );
      this.db.exec("COMMIT;");
      return this.slot(input.id);
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {}
      throw error;
    }
  }

  reserveAvailable(input: {
    slotId: string;
    version: number;
    leaseId: string;
    ownerKind: string;
    ownerKey: string;
    requestedHeadSha: string;
    now: number;
  }): WorktreeSlotRow | null {
    const changed = this.db
      .prepare(
        `UPDATE worktree_slots SET
           state = 'provisioning', version = version + 1, requested_head_sha = ?,
           active_lease_id = ?, active_owner_kind = ?, active_owner_key = ?, leased_at = ?,
           quarantine_reason = NULL, last_error = NULL, updated_at = ?
         WHERE id = ? AND state = 'available' AND version = ?`,
      )
      .run(
        input.requestedHeadSha,
        input.leaseId,
        input.ownerKind,
        input.ownerKey,
        input.now,
        input.now,
        input.slotId,
        input.version,
      );
    return Number(changed.changes) === 1 ? this.slot(input.slotId) : null;
  }

  finalizeLease(slotId: string, version: number, currentHeadSha: string, now: number): WorktreeSlotRow | null {
    const changed = this.db
      .prepare(
        `UPDATE worktree_slots SET
           state = 'leased', version = version + 1, current_head_sha = ?, last_used_at = ?,
           last_released_lease_id = NULL, last_released_owner_kind = NULL,
           last_released_owner_key = NULL, quarantine_reason = NULL, last_error = NULL,
           updated_at = ?
         WHERE id = ? AND state = 'provisioning' AND version = ?`,
      )
      .run(currentHeadSha, now, now, slotId, version);
    return Number(changed.changes) === 1 ? this.slot(slotId) : null;
  }

  markReturning(slotId: string, version: number, targetSha: string, now: number): WorktreeSlotRow | null {
    const changed = this.db
      .prepare(
        `UPDATE worktree_slots SET
           state = 'returning', version = version + 1, requested_head_sha = ?,
           last_error = NULL, updated_at = ?
         WHERE id = ? AND state = 'leased' AND version = ?`,
      )
      .run(targetSha, now, slotId, version);
    return Number(changed.changes) === 1 ? this.slot(slotId) : null;
  }

  completeRelease(slotId: string, version: number, currentHeadSha: string, now: number): WorktreeSlotRow | null {
    const changed = this.db
      .prepare(
        `UPDATE worktree_slots SET
           state = 'available', version = version + 1, current_head_sha = ?,
           last_released_lease_id = active_lease_id,
           last_released_owner_kind = active_owner_kind,
           last_released_owner_key = active_owner_key,
           active_lease_id = NULL, active_owner_kind = NULL, active_owner_key = NULL,
           leased_at = NULL, last_used_at = ?, quarantine_reason = NULL, last_error = NULL,
           updated_at = ?
         WHERE id = ? AND state = 'returning' AND version = ?`,
      )
      .run(currentHeadSha, now, now, slotId, version);
    return Number(changed.changes) === 1 ? this.slot(slotId) : null;
  }

  quarantine(
    slotId: string,
    reason: string,
    error: string | null,
    now: number,
    expectedVersion?: number,
  ): WorktreeSlotRow | null {
    const where = expectedVersion === undefined ? "id = ?" : "id = ? AND version = ?";
    const args = expectedVersion === undefined
      ? [reason, error, now, slotId]
      : [reason, error, now, slotId, expectedVersion];
    const changed = this.db
      .prepare(
        `UPDATE worktree_slots SET state = 'quarantined', version = version + 1,
           quarantine_reason = ?, last_error = ?, updated_at = ? WHERE ${where}`,
      )
      .run(...args);
    return Number(changed.changes) === 1 ? this.slot(slotId) : null;
  }

  updateObserved(slotId: string, currentHeadSha: string | null, error: string | null, now: number): void {
    this.db
      .prepare(`UPDATE worktree_slots SET current_head_sha = ?, last_error = ?, updated_at = ? WHERE id = ?`)
      .run(currentHeadSha, error, now, slotId);
  }

  removePruned(slotId: string, version: number): boolean {
    const changed = this.db
      .prepare(`DELETE FROM worktree_slots WHERE id = ? AND state = 'pruning' AND version = ?`)
      .run(slotId, version);
    return Number(changed.changes) === 1;
  }

  recordReconciliation(poolId: string, now: number, error: string | null): void {
    this.db
      .prepare(
        `UPDATE worktree_pools SET last_reconciled_at = ?, reconciliation_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(now, error, now, poolId);
  }
}
