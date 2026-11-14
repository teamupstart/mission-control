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

/**
 * A slot's dependency claim state. Append-only, like the slot states: a later build adds a
 * value, it never renames one. A NULL column is "never claimed".
 *
 * - `current`: every step of the last claim succeeded; the fingerprint beside it is trusted.
 * - `claiming`: the write-ahead before a claim's first step. Only a live claim holds it, so
 *   startup finding it means the claim was interrupted.
 * - `failed`: the last claim failed, timed out or was stopped; it left no fingerprint.
 * - `interrupted`: startup found `claiming` or `seeding`, or a seed was stopped or timed out.
 *   The next claim removes the seed paths and starts cold.
 * - `seeding`: the write-ahead before a seed renames anything into the tree. Like `claiming`,
 *   only a live claim holds it.
 */
export const WORKTREE_DEPS_STATES = ["current", "claiming", "failed", "interrupted", "seeding"] as const;
export type WorktreeDepsState = (typeof WORKTREE_DEPS_STATES)[number];

/** The write-aheads. Only a live claim holds one, so one found with no claim running was cut off. */
export const WORKTREE_DEPS_WRITE_AHEAD_STATES = ["claiming", "seeding"] as const satisfies readonly WorktreeDepsState[];

export function isDepsWriteAhead(state: string | null): boolean {
  return (WORKTREE_DEPS_WRITE_AHEAD_STATES as readonly string[]).includes(state ?? "");
}

/**
 * Whether a slot's last claim or seed was cut off, so its seed paths may be half renamed and
 * its next claim must start cold: `interrupted`, a write-ahead, or a state a later build wrote.
 * Only no state at all, `current` and `failed` are settled.
 */
export function depsCutOff(state: string | null): boolean {
  return state !== null && state !== "current" && state !== "failed";
}

/**
 * Why a slot was quarantined, as a category of fact rather than its prose. Persisted in
 * `worktree_slots.quarantine_category` and append-only, like the slot states: a later build adds
 * a value, it never renames, reorders or reuses one. A NULL column is a quarantine recorded
 * before categories existed that the migration could not classify, and it is never recovered
 * automatically.
 *
 * - `observation`: an observer did not answer - the process listing, a Git read, the worktree
 *   registration list, or a domain-ownership lookup. Nothing is known to be wrong with the slot.
 * - `state`: a positively observed fact makes the slot unsafe to hand out - dirty or untracked
 *   work, an occupant, a wrong path or common directory, a moved HEAD, a missing or unsafe
 *   registration, or lease identity that is stale or incomplete.
 * - `transition`: an allocator or operator-authored mutation failed or its outcome could not be
 *   proven - a reset, creation, setup command, dependency claim record, lease commit, return,
 *   removal, or an intent startup found interrupted.
 */
export const WORKTREE_QUARANTINE_CATEGORIES = ["observation", "state", "transition"] as const;
export type WorktreeQuarantineCategory = (typeof WORKTREE_QUARANTINE_CATEGORIES)[number];

/**
 * Which categories reconciliation may return to `available` once every safety fact is proven
 * again. Only a failed observation: it never said anything about the slot, so a later
 * observation that proves it idle is the whole of the evidence. A positively bad fact or an
 * unproven mutation stays quarantined until an operator acts on it.
 */
const QUARANTINE_RECOVERABLE: Record<WorktreeQuarantineCategory, boolean> = {
  observation: true,
  state: false,
  transition: false,
};

/** The recoverable categories, for the recovery compare-and-swap. */
export const RECOVERABLE_QUARANTINE_CATEGORIES = WORKTREE_QUARANTINE_CATEGORIES
  .filter((category) => QUARANTINE_RECOVERABLE[category]);

/**
 * Whether a stored category is one recovery may act on - a necessary condition only. A slot
 * that still holds a lease is never recovered whatever its category, so a caller asking whether
 * a slot will come back uses `quarantineAutoRecoverable`. Read as a string, so NULL and a value
 * a newer build wrote both fail closed.
 */
export function quarantineRecoverable(category: string | null): boolean {
  return (RECOVERABLE_QUARANTINE_CATEGORIES as readonly string[]).includes(category ?? "");
}

/**
 * Whether reconciliation could ever return this quarantined slot to `available` on its own: a
 * recoverable category AND no active lease identity at all, which `recoverQuarantined` also
 * requires. A slot quarantined while it held a lease - a leased slot whose owner lookup did not
 * answer, or a legacy reservation stranded by an unanswered recheck - keeps that lease until
 * its owner returns it or an operator destroys it, so it is never promised a recovery.
 */
export function quarantineAutoRecoverable(slot: Pick<WorktreeSlotRow,
  "quarantineCategory" | "activeLeaseId" | "activeOwnerKind" | "activeOwnerKey">): boolean {
  return quarantineRecoverable(slot.quarantineCategory) &&
    slot.activeLeaseId === null && slot.activeOwnerKind === null && slot.activeOwnerKey === null;
}

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
  /**
   * Read as string for the same fail-closed reason as `state`: only `quarantineRecoverable`
   * interprets it. Null on every slot that is not quarantined, and on a legacy quarantine.
   */
  quarantineCategory: string | null;
  /**
   * When the slot entered quarantine. Only that transition writes it, and every transition out
   * clears it; observation refreshes never touch it. Null on a legacy quarantine.
   */
  quarantinedAt: number | null;
  lastError: string | null;
  /** Read as string for the same fail-closed reason as `state`. Null is never claimed. */
  depsState: string | null;
  depsFingerprint: string | null;
  /** The commit the fingerprint was taken at. */
  depsFingerprintSha: string | null;
  depsClaimedAt: number | null;
  /** The last claim's failure: the failing step and its output tail. */
  depsLastError: string | null;
  createdAt: number;
  updatedAt: number;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
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
    quarantineCategory: nullableString(row.quarantine_category),
    quarantinedAt: row.quarantined_at === null || row.quarantined_at === undefined
      ? null
      : Number(row.quarantined_at),
    lastError: row.last_error === null ? null : String(row.last_error),
    depsState: nullableString(row.deps_state),
    depsFingerprint: nullableString(row.deps_fingerprint),
    depsFingerprintSha: nullableString(row.deps_fingerprint_sha),
    depsClaimedAt: row.deps_claimed_at === null || row.deps_claimed_at === undefined
      ? null
      : Number(row.deps_claimed_at),
    depsLastError: nullableString(row.deps_last_error),
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
           quarantine_reason = NULL, quarantine_category = NULL,
           quarantined_at = NULL, last_error = NULL, updated_at = ?
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
           last_released_owner_key = NULL, quarantine_reason = NULL, quarantine_category = NULL,
           quarantined_at = NULL, last_error = NULL,
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
         WHERE id = ? AND state IN ('leased', 'quarantined') AND version = ?`,
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
           leased_at = NULL, last_used_at = ?, quarantine_reason = NULL, quarantine_category = NULL,
           quarantined_at = NULL, last_error = NULL,
           updated_at = ?
         WHERE id = ? AND state = 'returning' AND version = ?`,
      )
      .run(currentHeadSha, now, now, slotId, version);
    return Number(changed.changes) === 1 ? this.slot(slotId) : null;
  }

  /**
   * Return a quarantined slot to `available` once the manager has re-proven every safety fact.
   * The compare-and-swap repeats the parts of that proof the row itself can state, so no caller
   * can recover a slot they do not cover: only a recoverable category, only a slot with no
   * active lease, and only at the HEAD the allocator last recorded for it. Release history is
   * kept, so a late return of the last lease still answers `alreadyReleased`.
   */
  recoverQuarantined(slotId: string, version: number, head: string, now: number): WorktreeSlotRow | null {
    const changed = this.db.prepare(
      `UPDATE worktree_slots SET state = 'available', version = version + 1,
         quarantine_reason = NULL, quarantine_category = NULL, quarantined_at = NULL,
         last_error = NULL, updated_at = ?
       WHERE id = ? AND state = 'quarantined' AND version = ?
         AND quarantine_category IN (${RECOVERABLE_QUARANTINE_CATEGORIES.map(() => "?").join(", ")})
         AND current_head_sha = ?
         AND active_lease_id IS NULL AND active_owner_kind IS NULL AND active_owner_key IS NULL`,
    ).run(now, slotId, version, ...RECOVERABLE_QUARANTINE_CATEGORIES, head);
    return Number(changed.changes) === 1 ? this.slot(slotId) : null;
  }

  /**
   * Undo a reservation of an available slot before anything touched it: the lease was never
   * granted, so the slot goes back exactly as it was screened, with its release history. Only
   * the reservation still provisioning at its own version, under its own lease, with no
   * dependency claim begun, can be undone.
   */
  cancelReservation(slotId: string, version: number, leaseId: string, now: number): WorktreeSlotRow | null {
    const changed = this.db.prepare(
      `UPDATE worktree_slots SET state = 'available', version = version + 1,
         active_lease_id = NULL, active_owner_kind = NULL, active_owner_key = NULL,
         leased_at = NULL, updated_at = ?
       WHERE id = ? AND state = 'provisioning' AND version = ? AND active_lease_id = ?
         AND COALESCE(deps_state, '') NOT IN (${WORKTREE_DEPS_WRITE_AHEAD_STATES.map(() => "?").join(", ")})`,
    ).run(now, slotId, version, leaseId, ...WORKTREE_DEPS_WRITE_AHEAD_STATES);
    return Number(changed.changes) === 1 ? this.slot(slotId) : null;
  }

  markPruning(slotId: string, version: number, now: number): WorktreeSlotRow | null {
    const changed = this.db
      .prepare(
        `UPDATE worktree_slots SET state = 'pruning', version = version + 1,
           last_error = NULL, updated_at = ?
         WHERE id = ? AND state IN ('available', 'quarantined') AND version = ?
           AND active_lease_id IS NULL AND active_owner_kind IS NULL AND active_owner_key IS NULL`,
      )
      .run(now, slotId, version);
    return Number(changed.changes) === 1 ? this.slot(slotId) : null;
  }

  /**
   * The one transition into quarantine. A slot already quarantined is refused rather than
   * rewritten, so its first reason, category and time stand: a later observation can never
   * relabel a positively unsafe slot as a recoverable one, and `quarantined_at` is only ever
   * the moment it entered.
   */
  quarantine(
    slotId: string,
    category: WorktreeQuarantineCategory,
    reason: string,
    error: string | null,
    now: number,
    expectedVersion?: number,
  ): WorktreeSlotRow | null {
    const where = expectedVersion === undefined ? "id = ?" : "id = ? AND version = ?";
    const args = expectedVersion === undefined
      ? [reason, category, now, error, now, slotId]
      : [reason, category, now, error, now, slotId, expectedVersion];
    const changed = this.db
      .prepare(
        `UPDATE worktree_slots SET state = 'quarantined', version = version + 1,
           quarantine_reason = ?, quarantine_category = ?, quarantined_at = ?,
           last_error = ?, updated_at = ?
         WHERE ${where} AND state <> 'quarantined'`,
      )
      .run(...args);
    return Number(changed.changes) === 1 ? this.slot(slotId) : null;
  }

  /**
   * The claim's write-ahead: ONE durable write that records the intent and clears the
   * fingerprint, before any step touches the tree. Only a reservation still provisioning at
   * the exact version its claim holds can take it. The version is deliberately left alone:
   * dependency state is not a slot transition, and the lease commit's compare-and-swap still
   * names the reservation it was granted.
   */
  beginClaim(slotId: string, version: number, now: number): boolean {
    const changed = this.db
      .prepare(
        `UPDATE worktree_slots SET deps_state = 'claiming', deps_fingerprint = NULL,
           deps_fingerprint_sha = NULL, updated_at = ?
         WHERE id = ? AND state = 'provisioning' AND version = ?`,
      )
      .run(now, slotId, version);
    return Number(changed.changes) === 1;
  }

  /**
   * The seed's write-ahead, before anything is renamed into the tree. The same shape as
   * `beginClaim`: one write that records the intent and clears the fingerprint.
   */
  beginSeed(slotId: string, version: number, now: number): boolean {
    const changed = this.db
      .prepare(
        `UPDATE worktree_slots SET deps_state = 'seeding', deps_fingerprint = NULL,
           deps_fingerprint_sha = NULL, updated_at = ?
         WHERE id = ? AND state = 'provisioning' AND version = ?`,
      )
      .run(now, slotId, version);
    return Number(changed.changes) === 1;
  }

  /**
   * Settle a seed that held the write-ahead. `current` is a seed whose source's fingerprint is
   * this commit's, so the steps are skipped and the inherited fingerprint is trusted.
   * `interrupted` is a seed that was stopped, timed out, or could not be placed whole: its
   * paths may be half renamed, so the next claim removes them and starts cold.
   */
  finishSeed(
    slotId: string,
    version: number,
    outcome:
      | { state: "current"; fingerprint: string; sha: string }
      | { state: "interrupted"; error: string | null },
    now: number,
  ): boolean {
    const current = outcome.state === "current";
    const changed = this.db
      .prepare(
        `UPDATE worktree_slots SET deps_state = ?, deps_fingerprint = ?, deps_fingerprint_sha = ?,
           deps_claimed_at = ?, deps_last_error = ?, updated_at = ?
         WHERE id = ? AND state = 'provisioning' AND version = ? AND deps_state = 'seeding'`,
      )
      .run(
        outcome.state,
        current ? outcome.fingerprint : null,
        current ? outcome.sha : null,
        now,
        current ? null : outcome.error,
        now,
        slotId,
        version,
      );
    return Number(changed.changes) === 1;
  }

  /**
   * Settle a claim that held the write-ahead. A failure records no fingerprint. `interrupted`
   * is a claim whose cleanup of an interrupted seed did not finish: the obligation to remove
   * the seed paths stays with the slot, so its next claim tries again.
   */
  finishClaim(
    slotId: string,
    version: number,
    outcome:
      | { state: "current"; fingerprint: string | null; sha: string }
      | { state: "failed" | "interrupted"; error: string },
    now: number,
  ): boolean {
    const current = outcome.state === "current";
    const changed = this.db
      .prepare(
        `UPDATE worktree_slots SET deps_state = ?, deps_fingerprint = ?, deps_fingerprint_sha = ?,
           deps_claimed_at = ?, deps_last_error = ?, updated_at = ?
         WHERE id = ? AND state = 'provisioning' AND version = ? AND deps_state = 'claiming'`,
      )
      .run(
        outcome.state,
        current ? outcome.fingerprint : null,
        current ? outcome.sha : null,
        now,
        current ? null : outcome.error,
        now,
        slotId,
        version,
      );
    return Number(changed.changes) === 1;
  }

  /**
   * Startup found a claim's or a seed's write-ahead with no live claim behind it. The
   * fingerprint was already cleared by the write-ahead; clearing it again here keeps that true
   * for a row an older build might have touched.
   */
  markClaimInterrupted(slotId: string, now: number): boolean {
    const changed = this.db
      .prepare(
        `UPDATE worktree_slots SET deps_state = 'interrupted', deps_fingerprint = NULL,
           deps_fingerprint_sha = NULL, updated_at = ?
         WHERE id = ? AND deps_state IN (${WORKTREE_DEPS_WRITE_AHEAD_STATES.map(() => "?").join(", ")})`,
      )
      .run(now, slotId, ...WORKTREE_DEPS_WRITE_AHEAD_STATES);
    return Number(changed.changes) === 1;
  }

  /**
   * Record what an observation saw. Never a state transition, so it leaves the version and
   * every quarantine column alone: a quarantined slot keeps the reason, category and time it
   * entered with, however often it is observed.
   */
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
