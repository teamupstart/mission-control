import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../db.ts";
import { pinLeasedWorktree, verifyPinnedBase } from "../dispatcher.ts";
import {
  acquireLease,
  canonicalPath,
  checkHolderToken,
  defaultTreehouseCli,
  withPoolLock,
  type TreehouseCli,
} from "../pool-lease.ts";
import { parsePoolStatus } from "../pool.ts";

/**
 * Who owns a pooled worktree while a Workflow check runs in it, and who hands it back.
 *
 * A check is a build running in a leased tree. It has no session and no task, so every
 * liveness signal the pool reaper trusts reads "idle" on it - and between the lease and the
 * spawn it has no processes either. `treehouse return --force` terminates processes in a
 * tree and hard-resets it, so a reaper that judged such a tree a leak would kill the check
 * and discard the very work it was checking. This module is the ownership model that makes
 * that impossible, and it is deliberately made of four independent parts:
 *
 *  1. **A holder token outside `LEASE_HOLDERS`** (`checkHolderToken`), so the shared reaper
 *     structurally cannot return a check lease - it refuses on ownership, with no new logic.
 *  2. **A pin** (`PoolPins.checkLeasePaths`), which is defence in depth against the token
 *     scheme being renamed or `LEASE_HOLDERS` being widened.
 *  3. **A durable row** (`workflow_check_leases`), so a daemon killed mid-check can still
 *     find the tree it was holding.
 *  4. **This module's own reclamation**, which is an OBLIGATION rather than a nicety: the
 *     shared reaper cannot see check leases, so it can never collect a leaked one either.
 *
 * ## The question this module can answer, and the one it cannot
 *
 * `treehouse status` prints a path, a state and a holder label - no lease id, no timestamp.
 * So path + exact holder token is the whole of the identity available, and it proves exactly
 * one thing: **this tree is ours**. It says nothing about whether anything is still WRITING
 * in it. Those are different questions and they authorise different actions:
 *
 *  - Ownership alone authorises a return only for a row carrying the sentinel pid, because
 *    that sentinel is positive proof the supervisor gate was never released and no branch
 *    code ever ran.
 *  - For every other row, emptiness must be PROVEN before a return, and this module cannot
 *    prove it. That is `CheckGroupRecovery`, implemented by the process supervisor and
 *    injected here. Its default refuses, so an uninjected daemon keeps the tree rather than
 *    hard-resetting a live build.
 *
 * The reverse seam runs the other way: `CheckProcessRegistry` is how the supervisor makes
 * its process identity durable. Neither side can answer the other's question alone.
 */

/**
 * The lease's own lifecycle, which is not the attempt's.
 *
 *  - `held`      - we have the tree.
 *  - `returning` - a return was authorised and FAILED. The row stays here, the pin stays,
 *                  and reclamation retries with backoff. It must never delete the row or
 *                  permit a second lease for this attempt: an attempt rollover that erased
 *                  the row would erase the only record of a resource that is still owned.
 *  - `returned`  - confirmed back in the pool. Terminal, retained for audit.
 *  - `lost`      - the path is held by a token that is not ours. Terminal, retained for
 *                  audit, NO return issued, and the pin dropped. See `releaseForAttempt`.
 */
export type CheckLeaseState = "held" | "returning" | "returned" | "lost";

/**
 * The states in which this process still believes it is holding the tree - and therefore
 * the ONLY states that contribute a pin or block a retry.
 *
 * Named once and used by every query rather than spelled per call site, because the two
 * terminal states are retained deliberately and a query that forgot to exclude them would
 * re-pin every path this subsystem has ever leased: a successfully returned tree would
 * become unreapable forever, and a `lost` row would silently get its pin back on the next
 * sweep, undoing the one thing that keeps a mismatched path from costing a pool slot for
 * the life of the daemon.
 */
const LIVE_STATES: readonly CheckLeaseState[] = ["held", "returning"];

/** The sentinel pid meaning "the supervisor gate was never released". */
export const NO_SUPERVISOR_PID = 0;
/** The sentinel identity meaning the same; opaque to this module either way. */
export const NO_SUPERVISOR_TICKS = "";

export interface CheckLeaseRow {
  attemptId: string;
  submissionId: string;
  nodeId: string;
  repoRoot: string;
  leasePath: string;
  holderToken: string;
  cleanupState: CheckLeaseState;
  supervisorPid: number;
  supervisorStartTicks: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Contract P: how the process supervisor makes its identity durable.
 *
 * `record` is called BEFORE branch code is allowed to run, so a crash between spawn and
 * persist is impossible to confuse with a group that never started - the row carries the
 * sentinel in exactly one of those cases. `clear` is called only after confirmed group
 * EMPTINESS, never on mere leader exit, because a leader can exit with descendants still
 * writing into the tree.
 *
 * `startTimeTicks` is OPAQUE here and never parsed: it is a composite the supervisor owns
 * (a start-time field plus a command line carrying the attempt id, because no
 * shell-reachable start-time has the resolution to stand alone). Storing it as a string it
 * only ever compares is what lets the supervisor change its composition without touching
 * this table.
 *
 * Synchronous by design - it is a single UPDATE, and the caller is a gate that must not be
 * allowed to yield between persisting identity and releasing branch code.
 */
export interface CheckProcessRegistry {
  /** Persist supervisor identity BEFORE branch code is allowed to run. */
  record(attemptId: string, pid: number, startTimeTicks: string): void;
  /** Clear after confirmed group emptiness, never merely leader exit. */
  clear(attemptId: string): void;
}

/**
 * The opposite-direction seam: can the supervisor prove this attempt's process group is
 * gone?
 *
 * Only `"empty"` authorises a destructive return. `"not-empty"` and `"unknown"` both keep
 * the row and the pin for a later pass, which is the fail-closed direction: keeping a tree
 * we own costs a pool slot until the next sweep, while returning one that is still being
 * written into terminates a live build and hard-resets its work.
 */
export type CheckGroupRecovery = (attemptId: string) => Promise<"empty" | "not-empty" | "unknown">;

/**
 * The default, and it refuses. The supervisor that can answer this ships in a later change,
 * and until it is injected the honest answer is "we cannot tell" - which keeps the lease.
 * Inert in practice today, because nothing acquires a lease yet.
 */
export const refusingGroupRecovery: CheckGroupRecovery = async () => "unknown";

/** What a release attempt actually did, so a caller can tell "clean" from "not yet". */
export type CheckLeaseRelease =
  /** The tree is back in the pool, or was already back. Cleanup is complete. */
  | { outcome: "returned" }
  /** Someone else holds this path. No return issued, row kept for audit, pin dropped. */
  | { outcome: "lost"; holder: string | null }
  /** The return failed. Row and pin retained in `returning`; reclamation will retry. */
  | { outcome: "retry"; reason: string };

// ---- persistence -----------------------------------------------------------

function toRow(r: Record<string, unknown>): CheckLeaseRow {
  return {
    attemptId: String(r.attempt_id),
    submissionId: String(r.submission_id),
    nodeId: String(r.node_id),
    repoRoot: String(r.repo_root),
    leasePath: String(r.lease_path),
    holderToken: String(r.holder_token),
    cleanupState: String(r.cleanup_state) as CheckLeaseState,
    supervisorPid: Number(r.supervisor_pid),
    supervisorStartTicks: String(r.supervisor_start_ticks),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

const LIVE_PLACEHOLDERS = LIVE_STATES.map(() => "?").join(", ");

/**
 * The only reader and writer of `workflow_check_leases`. Kept a class of its own rather
 * than folded into `WorkflowStore` so "one module writes this table" is checkable by
 * looking at one file, and so the manager above can be driven against a temp database.
 */
export class CheckLeaseStore {
  constructor(private readonly db: DatabaseSync = openDb()) {}

  insertHeld(input: {
    attemptId: string;
    submissionId: string;
    nodeId: string;
    repoRoot: string;
    leasePath: string;
    holderToken: string;
    now: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO workflow_check_leases
           (attempt_id, submission_id, node_id, repo_root, lease_path, holder_token,
            cleanup_state, supervisor_pid, supervisor_start_ticks, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'held', ?, ?, ?, ?)`,
      )
      .run(
        input.attemptId,
        input.submissionId,
        input.nodeId,
        input.repoRoot,
        input.leasePath,
        input.holderToken,
        NO_SUPERVISOR_PID,
        NO_SUPERVISOR_TICKS,
        input.now,
        input.now,
      );
  }

  get(attemptId: string): CheckLeaseRow | null {
    const row = this.db
      .prepare(`SELECT * FROM workflow_check_leases WHERE attempt_id = ?`)
      .get(attemptId);
    return row ? toRow(row as Record<string, unknown>) : null;
  }

  /** Every row this process still believes it is holding. */
  listLive(): CheckLeaseRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM workflow_check_leases
          WHERE cleanup_state IN (${LIVE_PLACEHOLDERS})
          ORDER BY created_at`,
      )
      .all(...LIVE_STATES);
    return (rows as Record<string, unknown>[]).map(toRow);
  }

  /**
   * The pin query. The state filter is the whole point and belongs HERE, in the SQL, not in
   * a comment at the call site - see `LIVE_STATES`.
   */
  livePaths(): string[] {
    const rows = this.db
      .prepare(
        `SELECT lease_path FROM workflow_check_leases WHERE cleanup_state IN (${LIVE_PLACEHOLDERS})`,
      )
      .all(...LIVE_STATES);
    return (rows as Record<string, unknown>[]).map((r) => String(r.lease_path));
  }

  /** Contract R's answer, from this table alone - never a join retention can break. */
  hasLiveForNode(submissionId: string, nodeId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM workflow_check_leases
          WHERE submission_id = ? AND node_id = ? AND cleanup_state IN (${LIVE_PLACEHOLDERS})
          LIMIT 1`,
      )
      .get(submissionId, nodeId, ...LIVE_STATES);
    return row !== undefined;
  }

  setState(attemptId: string, state: CheckLeaseState, now: number): void {
    this.db
      .prepare(`UPDATE workflow_check_leases SET cleanup_state = ?, updated_at = ? WHERE attempt_id = ?`)
      .run(state, now, attemptId);
  }

  setSupervisor(attemptId: string, pid: number, ticks: string, now: number): void {
    this.db
      .prepare(
        `UPDATE workflow_check_leases
            SET supervisor_pid = ?, supervisor_start_ticks = ?, updated_at = ?
          WHERE attempt_id = ?`,
      )
      .run(pid, ticks, now, attemptId);
  }

  /**
   * Used only to unwind an acquisition whose pin failed and whose tree is CONFIRMED back in
   * the pool. Nothing else deletes: a row that survives is the record of a resource that may
   * still be owned, which is the property this table exists for.
   */
  delete(attemptId: string): void {
    this.db.prepare(`DELETE FROM workflow_check_leases WHERE attempt_id = ?`).run(attemptId);
  }
}

// ---- the manager -----------------------------------------------------------

export interface CheckLeaseDeps {
  cli?: TreehouseCli;
  /** `pinLeasedWorktree` - injectable so tests can fail a pin without a real pool. */
  pin?: (repoRoot: string, leasePath: string, baseSha: string) => Promise<void>;
  /** `verifyPinnedBase` - the existing full-40-hex check, never a second regex. */
  verifyBase?: (repoRoot: string, baseSha: string) => Promise<string>;
  now?: () => number;
  /** How many leaked rows one reclamation pass may work through. */
  maxReclaimPerPass?: number;
}

/** The first retry delay after a failed return; doubled per consecutive failure. */
const RECLAIM_BACKOFF_MS = 60_000;
/** The ceiling on that backoff - roughly an hour, after which it retries every pass. */
const RECLAIM_BACKOFF_MAX_MS = 3_600_000;

export class CheckLeaseManager {
  private readonly store: CheckLeaseStore;
  private readonly cli: TreehouseCli;
  private readonly pin: (repoRoot: string, leasePath: string, baseSha: string) => Promise<void>;
  private readonly verifyBase: (repoRoot: string, baseSha: string) => Promise<string>;
  private readonly now: () => number;
  private readonly maxReclaimPerPass: number;

  /**
   * Paths pinned in memory, added SYNCHRONOUSLY the moment acquire returns a path and
   * removed only once the tree is confirmed no longer ours.
   *
   * The durable query already covers everything persisted, so this set exists for exactly
   * one window: between `treehouse get` returning and the INSERT committing. That window
   * contains an `await`, and a reaper tick landing inside it would see a leased tree with no
   * row, no session, no task and no processes. The union of the two sources is what makes
   * the pin true from acquisition rather than from persistence.
   */
  private readonly justAcquired = new Set<string>();

  /** Attempts whose lease this process handed out and has not been asked to release. */
  private readonly owned = new Set<string>();

  /** Attempts with a lease operation in flight, so reclamation never races the owner. */
  private readonly busy = new Set<string>();

  /** Consecutive failed returns per attempt, and when the next one may be tried. */
  private readonly backoff = new Map<string, { failures: number; nextAt: number }>();

  constructor(db: DatabaseSync = openDb(), deps: CheckLeaseDeps = {}) {
    this.store = new CheckLeaseStore(db);
    this.cli = deps.cli ?? defaultTreehouseCli;
    this.pin = deps.pin ?? pinLeasedWorktree;
    this.verifyBase = deps.verifyBase ?? verifyPinnedBase;
    this.now = deps.now ?? Date.now;
    this.maxReclaimPerPass = deps.maxReclaimPerPass ?? 8;
  }

  /**
   * Contract P, implemented against the two sentinel-defaulted columns. Handed out as an
   * interface so its consumer never reaches the table.
   */
  readonly processes: CheckProcessRegistry = {
    record: (attemptId, pid, startTimeTicks) =>
      this.store.setSupervisor(attemptId, pid, startTimeTicks, this.now()),
    clear: (attemptId) =>
      this.store.setSupervisor(attemptId, NO_SUPERVISOR_PID, NO_SUPERVISOR_TICKS, this.now()),
  };

  /** Every path a check is holding: the durable live rows, union the just-acquired set. */
  pinnedPaths(): string[] {
    return [...new Set([...this.store.livePaths(), ...this.justAcquired])];
  }

  /**
   * Contract R: does this node still own a lease that is not resolved? A retry carries a
   * NEW attempt id and would lease a DIFFERENT tree, so this has to be asked before one is
   * created rather than discovered afterwards.
   */
  unresolvedLeaseForNode(submissionId: string, nodeId: string): boolean {
    return this.store.hasLiveForNode(submissionId, nodeId);
  }

  /**
   * Take a pooled worktree for one check attempt and pin it to the captured commit.
   *
   * There is deliberately NO fallback to `git worktree add`. The pool is what carries the
   * warm ignored dependencies that `clean -fd` preserves, so a cold tree would turn a
   * three-minute check into a twelve-minute one; a dry pool is infrastructure, not a reason
   * to build a slower checkout. (`provisionWorktree` does fall back, and the asymmetry is
   * intended: a dispatched session can afford a cold tree.)
   *
   * Every failure here is infrastructure and never a verdict.
   */
  async acquireForAttempt(input: {
    attemptId: string;
    submissionId: string;
    nodeId: string;
    repoRoot: string;
    headSha: string;
  }): Promise<string> {
    const { attemptId, repoRoot } = input;
    // Claimed SYNCHRONOUSLY, before the first await, and this ordering is the guard rather
    // than a detail. Every check below reads state that a concurrent call for the same
    // attempt could still change: two callers that both got past `store.get` would each
    // lease a tree, the second would fail its INSERT on the primary key, and its unwind
    // would then act on `attemptId` - deleting the FIRST caller's row. That caller keeps a
    // live tree with no durable record of it, and because a check holder is deliberately
    // invisible to the shared reaper, nothing would ever collect it.
    if (this.busy.has(attemptId)) {
      throw new Error(
        `check attempt ${attemptId} is already acquiring a lease - ` +
          "refusing to take a second lease for one attempt",
      );
    }
    this.busy.add(attemptId);
    try {
      // Resolved BEFORE anything is leased, so a caller naming a commit this repository does
      // not have costs an error rather than a pool slot that then has to be unwound.
      const baseSha = await this.verifyBase(repoRoot, input.headSha);
      // One lease per attempt id, EVER - not merely one at a time. A live row means the
      // resource is still owned and a second lease would put two writers in one tree; a
      // terminal row means this attempt has already had its turn, and a retry is a new
      // attempt id by construction. Both are refused here, with a message, rather than left
      // to surface as a primary-key violation from the INSERT below.
      const existing = this.store.get(attemptId);
      if (existing) {
        throw new Error(
          `check attempt ${attemptId} already holds ${existing.leasePath} (${existing.cleanupState}) - ` +
            "refusing to take a second lease for one attempt",
        );
      }
      return await withPoolLock(repoRoot, async () => {
        const lease = await acquireLease(repoRoot, checkHolderToken(attemptId), this.cli);
        if (lease.path === null) {
          throw new Error(
            `the treehouse pool in ${repoRoot} could not hand over a worktree for this check: ` +
              lease.failure.what +
              (lease.failure.stderr ? ` - treehouse said: ${lease.failure.stderr}` : ""),
          );
        }
        const path = canonicalPath(lease.path);
        // Pinned first and synchronously: from here on the reaper must see this path even
        // though the row below has not been written yet.
        this.justAcquired.add(path);
        // Whether the row under `attemptId` is OURS. The unwind below may only touch a row
        // this invocation actually wrote: an INSERT can fail because some other row already
        // owns this attempt id or this path, and in that case the row under that key belongs
        // to a live lease somebody else is holding. Deleting it, or flipping it to
        // `returning`, would strip a live tree of its only durable record.
        let inserted = false;
        try {
          this.store.insertHeld({
            attemptId,
            submissionId: input.submissionId,
            nodeId: input.nodeId,
            repoRoot,
            leasePath: path,
            holderToken: checkHolderToken(attemptId),
            now: this.now(),
          });
          inserted = true;
          await this.pin(repoRoot, path, baseSha);
        } catch (err) {
          // The lease is LIVE and we are about to throw, so nothing downstream will ever
          // record this tree - the pool would lose the slot permanently. Hand it back while
          // we still know it is ours and nothing has been launched into it, and only drop
          // the row and the pin once that return is CONFIRMED. A return that itself fails
          // rides along with the real cause instead of replacing it, and leaves the lease
          // recorded for reclamation rather than pretending it is gone.
          const cause = err instanceof Error ? err.message : String(err);
          const returned = await this.cli.return({ cwd: repoRoot, path, force: true });
          if (returned.code === 0) {
            if (inserted) this.store.delete(attemptId);
            this.justAcquired.delete(path);
            throw new Error(cause);
          }
          if (inserted) this.store.setState(attemptId, "returning", this.now());
          throw new Error(
            `${cause} - and the pool lease could not be returned: ` +
              `${returned.stderr.trim() || `exit ${returned.code}`} (${path} is still held` +
              // A tree we could neither record nor return. Naming it is all we can do: there
              // is no row to reclaim it from, so a human has to hand it back.
              (inserted ? ")" : ", and no lease row could be written for it)"),
          );
        }
        this.owned.add(attemptId);
        return path;
      });
    } finally {
      this.busy.delete(attemptId);
    }
  }

  /**
   * Hand a check's tree back, idempotently, and only if it is still ours.
   *
   * Four outcomes, and the fourth is the one that matters: a path held by a DIFFERENT token
   * is never returned. Without that rule, a daemon recovering from a crash between a
   * successful return and the row's deletion would return a tree the pool has since leased
   * to someone else, terminating their processes and hard-resetting their work.
   */
  async releaseForAttempt(attemptId: string): Promise<CheckLeaseRelease> {
    const row = this.store.get(attemptId);
    // No row, or an already-terminal one: the prior return is accounted for. Complete
    // cleanup without calling treehouse, because there is nothing left to return and a
    // return issued on a hunch is exactly the destructive mistake above.
    if (!row || !LIVE_STATES.includes(row.cleanupState)) {
      this.forget(attemptId, row?.leasePath ?? null);
      return { outcome: "returned" };
    }
    this.busy.add(attemptId);
    try {
      return await withPoolLock(row.repoRoot, () => this.resolveLocked(row));
    } finally {
      this.busy.delete(attemptId);
      this.owned.delete(attemptId);
    }
  }

  /**
   * The identity comparison and the return it authorises, as one critical section. The
   * caller holds this repo's pool lock, which is what makes the comparison mean anything at
   * the moment the return runs - against this process. Against another process it does not,
   * and that residual is closed by the token comparison itself rather than by the lock: an
   * out-of-process actor re-leasing this path holds it under its own label, so we refuse.
   */
  private async resolveLocked(row: CheckLeaseRow): Promise<CheckLeaseRelease> {
    const status = await this.cli.status(row.repoRoot);
    if (status.code !== 0) {
      return this.failedReturn(row, `treehouse status exited ${status.code}`);
    }
    const wanted = canonicalPath(row.leasePath);
    const tree = parsePoolStatus(status.stdout).find((t) => canonicalPath(t.path) === wanted);

    // Absent from status, or holding nobody's lease: the prior return already succeeded.
    // Issue nothing - the slot is not ours to act on any more - and complete cleanup.
    if (!tree || tree.state === "available" || tree.holder === null) {
      this.settle(row, "returned");
      return { outcome: "returned" };
    }
    // Held by a token that is not ours. Refuse the return, keep the row for audit, and DROP
    // the pin. Keeping the pin would be a different bug: the pin protects OUR lease, and a
    // mismatch is positive proof this tree is not ours, so holding it would outlive the
    // external holder's lease and permanently bar the ordinary reaper from that path - one
    // pool slot lost for the life of the daemon. Dropping it is safe in every sub-case: an
    // external re-lease is genuinely not ours; another check's lease is pinned by its own
    // row; and our own still-running check cannot reach this branch, because its holder
    // token matches by construction.
    if (tree.holder !== row.holderToken) {
      this.settle(row, "lost");
      return { outcome: "lost", holder: tree.holder };
    }
    const returned = await this.cli.return({ cwd: row.repoRoot, path: row.leasePath, force: true });
    if (returned.code !== 0) {
      return this.failedReturn(row, returned.stderr.trim() || `exit ${returned.code}`);
    }
    this.settle(row, "returned");
    return { outcome: "returned" };
  }

  /**
   * A return we authorised and could not complete. The row stays live in `returning`, the
   * pin stays, and no second lease is possible for this attempt - because the resource is
   * still owned and saying otherwise is how an attempt rollover ends up with two writers in
   * one tree. Nothing downstream may treat this as clean.
   */
  private failedReturn(row: CheckLeaseRow, reason: string): CheckLeaseRelease {
    this.store.setState(row.attemptId, "returning", this.now());
    const prior = this.backoff.get(row.attemptId)?.failures ?? 0;
    const failures = prior + 1;
    this.backoff.set(row.attemptId, {
      failures,
      nextAt: this.now() + Math.min(RECLAIM_BACKOFF_MS * 2 ** prior, RECLAIM_BACKOFF_MAX_MS),
    });
    return { outcome: "retry", reason };
  }

  /** Move a row to a terminal state and stop pinning its path. */
  private settle(row: CheckLeaseRow, state: "returned" | "lost"): void {
    this.store.setState(row.attemptId, state, this.now());
    this.forget(row.attemptId, row.leasePath);
  }

  private forget(attemptId: string, leasePath: string | null): void {
    if (leasePath !== null) this.justAcquired.delete(canonicalPath(leasePath));
    this.owned.delete(attemptId);
    this.backoff.delete(attemptId);
  }

  /**
   * Restore the pins durable rows imply, then resolve each row by whichever question it
   * actually needs answered.
   *
   * **This must complete before the pool reaper's first sweep.** A pin registered after that
   * sweep is invisible to it, which is the same ordering rule that makes embedded sessions
   * restore before the discovery poller starts.
   */
  async reconcileOnStartup(recovery: CheckGroupRecovery = refusingGroupRecovery): Promise<void> {
    const rows = this.store.listLive();
    // Synchronous, before the first await: the pins are live from this point even though
    // resolving them below takes subprocesses and time.
    for (const row of rows) this.justAcquired.add(canonicalPath(row.leasePath));
    for (const row of rows) {
      try {
        await this.resolveRecovered(row, recovery);
      } catch (err) {
        console.error(
          `[mission-control] could not reconcile check lease ${row.leasePath}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  /**
   * The rule that separates ownership from emptiness, applied to a row this process did not
   * acquire.
   *
   *  - A `returning` row already had its return authorised and recorded; that decision was
   *    made when the group was known to be finished, so retrying the return is all that is
   *    left. Re-asking about the group would strand it behind a seam that may not be
   *    injected.
   *  - A sentinel row never released the supervisor gate, so no branch code ever ran and
   *    there is no group to prove empty. Identity alone authorises its return.
   *  - Anything else may still have a live process group writing into the tree, and
   *    ownership says nothing about that. Only a proven-empty group authorises the return;
   *    `not-empty` and `unknown` keep the row and the pin for a later pass.
   */
  private async resolveRecovered(row: CheckLeaseRow, recovery: CheckGroupRecovery): Promise<void> {
    if (row.cleanupState === "returning") {
      await this.releaseForAttempt(row.attemptId);
      return;
    }
    if (row.supervisorPid === NO_SUPERVISOR_PID && row.supervisorStartTicks === NO_SUPERVISOR_TICKS) {
      await this.releaseForAttempt(row.attemptId);
      return;
    }
    if ((await recovery(row.attemptId)) === "empty") {
      await this.releaseForAttempt(row.attemptId);
    }
  }

  /**
   * Collect check leases nobody is coming back for.
   *
   * This exists because of a decision made elsewhere: a check lease is held under a token
   * outside `LEASE_HOLDERS`, so the shared pool reaper structurally cannot return one - and
   * therefore can never collect a LEAKED one either. That protection and this obligation are
   * the same decision seen from two sides, so this pass is not optional.
   *
   * Bounded per pass, and it skips anything this process is actively working on: a lease
   * whose check is still running is not a leak, and a return whose retry is still in backoff
   * is not ready.
   */
  async reclaimLeaked(recovery: CheckGroupRecovery = refusingGroupRecovery): Promise<void> {
    const now = this.now();
    const due = this.store
      .listLive()
      .filter((row) => !this.owned.has(row.attemptId) && !this.busy.has(row.attemptId))
      .filter((row) => (this.backoff.get(row.attemptId)?.nextAt ?? 0) <= now)
      .slice(0, this.maxReclaimPerPass);
    for (const row of due) {
      try {
        await this.resolveRecovered(row, recovery);
      } catch (err) {
        console.error(
          `[mission-control] could not reclaim check lease ${row.leasePath}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}
