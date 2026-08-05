import type { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { WorktreeProvider } from "@shared/types.ts";
import { CHECK_WORKTREES_DIR } from "../config.ts";
import { openDb } from "../db.ts";
import { pinLeasedWorktree, verifyPinnedBase } from "../dispatcher.ts";
import { verifyHeadIs } from "../git/ensemble-snapshot.ts";
import {
  acquireLease,
  canonicalPath,
  checkHolderToken,
  defaultTreehouseCli,
  settleLease,
  withPoolLock,
  type TreehouseCli,
} from "../pool-lease.ts";
import { parsePoolStatus, treehouseInstalled } from "../pool.ts";
import { run, type RunResult } from "../util/exec.ts";

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
  /**
   * Which provider handed this tree over, and therefore the ONLY provider that may take it
   * back. Authoritative on release and never re-probed from the current machine - see
   * `providerFor`.
   */
  provider: WorktreeProvider;
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
    // Read through, NOT validated here. A value this build cannot serve is refused at the
    // point it would be acted on (`providerFor`), where refusing means keeping the tree -
    // rather than coerced to a default here, where the coercion would be invisible and would
    // hand somebody else's tree to the wrong provider.
    provider: String(r.provider) as WorktreeProvider,
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
    /** Written at acquisition and read on every release; never re-derived. */
    provider: WorktreeProvider;
    now: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO workflow_check_leases
           (attempt_id, submission_id, node_id, repo_root, lease_path, holder_token,
            cleanup_state, supervisor_pid, supervisor_start_ticks, provider, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'held', ?, ?, ?, ?, ?)`,
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
        input.provider,
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

// ---- the tree provider -----------------------------------------------------

/**
 * The three facts about a lease a provider is allowed to see: where the tree is, and what
 * this process's claim on it is called.
 *
 * Narrower than `CheckLeaseRow` deliberately, and in both directions. A `CheckLeaseRow`
 * satisfies it structurally, so the manager passes rows straight through - but a provider
 * cannot reach `cleanup_state` even to read it, which is the strongest available statement of
 * the rule that the manager owns the lifecycle and a provider is a mechanism. It is also what
 * lets the acquisition's own unwind call `handBack` for a tree whose row does not exist yet,
 * and could not exist - that path is reached precisely when the INSERT failed.
 */
export interface CheckTreeRef {
  repoRoot: string;
  leasePath: string;
  holderToken: string;
}

/** What a provider found when it asked who holds a tree. See `CheckTreeProvider.ownership`. */
export type CheckTreeOwnership =
  /** We failed to LOOK. Proves nothing, authorises nothing - see `resolveLocked`. */
  | { state: "unreadable"; reason: string }
  /** The tree is not held at all: a prior return already succeeded. */
  | { state: "gone" }
  /** Held, under this label. The MANAGER compares it against the row's token, not us. */
  | { state: "held"; holder: string };

/**
 * Everything `CheckLeaseManager` needs from a worktree source, and the only route it has to
 * one.
 *
 * The manager's state machine - the four release outcomes, every `cleanup_state` write, the
 * pins, the backoff, the reclamation pass - is provider-agnostic and stays where it is. What
 * moves behind here is exactly the set of operations that name a specific mechanism, so that
 * a second mechanism is an implementation rather than a second copy of the state machine.
 *
 * `ownership` returns a shape rather than a boolean because the two mechanisms answer with
 * different authority. A pool SLOT is handed out over and over, so a path alone says nothing
 * about who holds it and the holder token is the whole of the available identity. A tree cut
 * for one attempt lives at a path derived from an attempt id, which is unique forever and
 * never reused, so presence at that path is ownership by construction. Collapsing that
 * asymmetry into a boolean would hide which of the two a given answer came from.
 */
export interface CheckTreeProvider {
  /** The EXISTING union `Task.provider` and `teardownWorktree` already use. */
  readonly kind: WorktreeProvider;
  /**
   * Take a tree for one attempt, and answer with its realpath plus the token this process
   * will be known by. Throws with an operator-readable cause if no tree was taken.
   *
   * Deliberately does NOT bring the tree to `baseSha` - `pin` does, and the split is
   * load-bearing rather than stylistic. The manager writes its durable row between the two,
   * so a daemon killed during the reset still finds the resource it is holding, and the
   * acquisition's unwind can tell "we could not record it" from "we could not prepare it".
   * `baseSha` is passed here anyway because a provider that CREATES a tree (rather than
   * being handed a warm one) can start it at the right commit in one step.
   */
  acquire(input: {
    repoRoot: string;
    attemptId: string;
    baseSha: string;
  }): Promise<{ path: string; holderToken: string }>;
  /** Bring an already-taken tree to `baseSha`, or throw. Called once the row is durable. */
  pin(input: { repoRoot: string; path: string; baseSha: string }): Promise<void>;
  /** Who holds this path now, read from the provider's own bookkeeping. */
  ownership(ref: CheckTreeRef): Promise<CheckTreeOwnership>;
  /**
   * Hand the tree back. Returns the mechanism's own result rather than throwing, because a
   * non-zero exit is a routine outcome the manager has a state for (`returning`).
   */
  handBack(ref: CheckTreeRef): Promise<RunResult>;
  /**
   * Serialize a whole acquire, or a whole status → compare → return, against anything else
   * this process does to the same resource.
   */
  withLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * The pool, behind that interface, and nothing more than that.
 *
 * Every call here is the call this module made inline before the interface existed, including
 * the wording of its errors - the operator-facing string is part of the behaviour, and a
 * check that could not get a tree is read by whoever has to fix the machine.
 */
export class TreehouseCheckTreeProvider implements CheckTreeProvider {
  readonly kind: WorktreeProvider = "treehouse";

  constructor(
    private readonly cli: TreehouseCli,
    /** `pinLeasedWorktree` - the ownership-checked hard reset, injectable for tests. */
    private readonly reset: (repoRoot: string, leasePath: string, baseSha: string) => Promise<void>,
  ) {}

  async acquire(input: {
    repoRoot: string;
    attemptId: string;
  }): Promise<{ path: string; holderToken: string }> {
    const holderToken = checkHolderToken(input.attemptId);
    const lease = await acquireLease(input.repoRoot, holderToken, this.cli);
    if (lease.path === null) {
      throw new Error(
        `the treehouse pool in ${input.repoRoot} could not hand over a worktree for this check: ` +
          lease.failure.what +
          (lease.failure.stderr ? ` - treehouse said: ${lease.failure.stderr}` : ""),
      );
    }
    return { path: canonicalPath(lease.path), holderToken };
  }

  /** A pool tree arrives warm and holding whatever the last user left, so it is reset. */
  async pin(input: { repoRoot: string; path: string; baseSha: string }): Promise<void> {
    await this.reset(input.repoRoot, input.path, input.baseSha);
  }

  async ownership(ref: CheckTreeRef): Promise<CheckTreeOwnership> {
    const status = await this.cli.status(ref.repoRoot);
    // `treehouse status` prints no lease id and no timestamp, so a pool we could not read
    // leaves us with no identity to compare at all. That is a failure to LOOK, and the
    // manager treats it as one; it is not evidence about who holds the tree.
    if (status.code !== 0) {
      return { state: "unreadable", reason: `treehouse status exited ${status.code}` };
    }
    const wanted = canonicalPath(ref.leasePath);
    const tree = parsePoolStatus(status.stdout).find((t) => canonicalPath(t.path) === wanted);
    // Absent from status, or holding nobody's lease: the slot is not ours to act on.
    if (!tree || tree.state === "available" || tree.holder === null) return { state: "gone" };
    return { state: "held", holder: tree.holder };
  }

  handBack(ref: CheckTreeRef): Promise<RunResult> {
    // Forced: this is a reclaimer with no stdin, and `return` without `--force` can prompt.
    return this.cli.return({ cwd: ref.repoRoot, path: ref.leasePath, force: true });
  }

  /**
   * The per-repository pool lock, held across a SEQUENCE of treehouse calls - which is what
   * makes the identity comparison in `resolveLocked` mean anything at the moment the return
   * runs. See `withPoolLock`, and note it is not reentrant.
   */
  withLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
    return withPoolLock(repoRoot, fn);
  }
}

/** Long enough for git to take its shared repository locks on a busy developer machine. */
const GIT_WORKTREE_ADD_TIMEOUT_MS = 60_000;
const GIT_WORKTREE_REMOVE_TIMEOUT_MS = 30_000;

/**
 * A one-attempt detached git worktree, used when the treehouse binary is not resolvable.
 *
 * Unlike a pool slot, this path is derived from an attempt id that is unique forever and is
 * never reused. That difference is what lets `ownership` treat registration at the path as
 * proof that this is still our tree without an external holder ledger.
 */
export class GitCheckTreeProvider implements CheckTreeProvider {
  readonly kind: WorktreeProvider = "git";

  async acquire(input: {
    repoRoot: string;
    attemptId: string;
    baseSha: string;
  }): Promise<{ path: string; holderToken: string }> {
    mkdirSync(CHECK_WORKTREES_DIR, { recursive: true });
    const path = join(CHECK_WORKTREES_DIR, input.attemptId);
    if (existsSync(path)) {
      throw new Error(
        `the check worktree path ${path} already exists for attempt ${input.attemptId} - ` +
          "refusing to reuse it",
      );
    }

    const added = await run(
      "git",
      ["-C", input.repoRoot, "worktree", "add", "--detach", path, input.baseSha],
      { timeoutMs: GIT_WORKTREE_ADD_TIMEOUT_MS },
    );
    if (added.code !== 0) {
      throw new Error(`git worktree add failed: ${added.stderr.trim() || `exit ${added.code}`}`);
    }

    try {
      return {
        path: realpathSync(path),
        // Git has no holder label. The manager still records its normal per-attempt token so
        // the lifecycle row keeps one shape across providers; `ownership` returns that same
        // token only after proving the unique attempt path is still registered.
        holderToken: checkHolderToken(input.attemptId),
      };
    } catch (err) {
      // The add succeeded but no row can name this tree yet. Remove it here, before the
      // manager sees an acquisition, so a failed canonicalisation cannot leak an untracked
      // worktree.
      const removed = await this.remove(input.repoRoot, path);
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(
        removed.code === 0
          ? cause
          : `${cause} - and the git worktree could not be removed: ` +
              (removed.stderr.trim() || `exit ${removed.code}`),
      );
    }
  }

  /** The detached add chose the commit; this re-read proves git actually landed there. */
  async pin(input: { repoRoot: string; path: string; baseSha: string }): Promise<void> {
    await verifyHeadIs(input.path, input.baseSha);
  }

  async ownership(ref: CheckTreeRef): Promise<CheckTreeOwnership> {
    const listed = await run(
      "git",
      ["-C", ref.repoRoot, "worktree", "list", "--porcelain"],
      { timeoutMs: GIT_WORKTREE_REMOVE_TIMEOUT_MS },
    );
    if (listed.code !== 0 || listed.outcomeUnknown) {
      return {
        state: "unreadable",
        reason:
          `git worktree list ${listed.outcomeUnknown ? "did not complete" : `exited ${listed.code}`}` +
          (listed.stderr.trim() ? `: ${listed.stderr.trim()}` : ""),
      };
    }

    const wanted = canonicalPath(ref.leasePath);
    const present = listed.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .some((line) => canonicalPath(line.slice("worktree ".length)) === wanted);
    if (!present) return { state: "gone" };

    // A pool slot is reused, so its path cannot identify its current holder. A git check
    // tree is different: its path contains an attempt id that is unique forever and never
    // reused. Presence in git's own worktree ledger is therefore ownership by construction.
    return { state: "held", holder: ref.holderToken };
  }

  handBack(ref: CheckTreeRef): Promise<RunResult> {
    return this.remove(ref.repoRoot, ref.leasePath);
  }

  /**
   * There is no cross-process pool to serialise against. Git takes its own repository locks,
   * and the manager's `busy` set provides the in-process single-flight this lifecycle needs.
   */
  withLock<T>(_repoRoot: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  private remove(repoRoot: string, path: string): Promise<RunResult> {
    // Keep this argv identical to dispatch teardown's git-provider arm.
    return run(
      "git",
      ["-C", repoRoot, "worktree", "remove", "--force", path],
      { timeoutMs: GIT_WORKTREE_REMOVE_TIMEOUT_MS },
    );
  }
}

// ---- the manager -----------------------------------------------------------

export interface CheckLeaseDeps {
  cli?: TreehouseCli;
  /** `pinLeasedWorktree` - injectable so tests can fail a pin without a real pool. */
  pin?: (repoRoot: string, leasePath: string, baseSha: string) => Promise<void>;
  /** `verifyPinnedBase` - the existing full-40-hex check, never a second regex. */
  verifyBase?: (repoRoot: string, baseSha: string) => Promise<string>;
  /** The acquire-time provider probe. Tests inject it alongside a fake treehouse CLI. */
  treehouseInstalled?: () => Promise<boolean>;
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
  private readonly verifyBase: (repoRoot: string, baseSha: string) => Promise<string>;
  private readonly treehouseInstalled: () => Promise<boolean>;
  private readonly now: () => number;
  private readonly maxReclaimPerPass: number;

  /**
   * Paths pinned in memory, added SYNCHRONOUSLY the moment acquire returns a path and
   * removed only once the tree is confirmed no longer ours.
   *
   * The durable query already covers everything persisted, so this set exists for exactly
   * one window: between a provider returning a tree and the INSERT committing. That window
   * contains an `await`, and a reaper tick landing inside it could otherwise see a tree with
   * no row, no session, no task and no processes. The union of the two sources is what makes
   * the pin true from acquisition rather than from persistence. For git the pin is inert to
   * the pool reaper, but keeping it unconditional preserves one lifecycle across providers.
   */
  private readonly justAcquired = new Set<string>();

  /** Attempts whose lease this process handed out and has not been asked to release. */
  private readonly owned = new Set<string>();

  /** Attempts with a lease operation in flight, so reclamation never races the owner. */
  private readonly busy = new Set<string>();

  /** Consecutive failed returns per attempt, and when the next one may be tried. */
  private readonly backoff = new Map<string, { failures: number; nextAt: number }>();

  /** The pool fast path, held separately because acquire-time selection names it directly. */
  private readonly treehouse: CheckTreeProvider;
  /** The cold, isolated fallback used only when the treehouse binary is unavailable. */
  private readonly git: CheckTreeProvider;

  /**
   * Every provider this build can reach, keyed by the value a row records.
   *
   * A lookup that can MISS, with no fallback anywhere - which is the recorded-provider
   * contract expressed as code rather than as a comment. A row names the mechanism that
   * actually handed its tree over, and the release path must use that one or none: re-probing
   * the machine would hand a pooled tree to whatever is installed now, and defaulting would
   * do the same thing more quietly. See `providerFor`.
   */
  private readonly providers: ReadonlyMap<WorktreeProvider, CheckTreeProvider>;

  constructor(db: DatabaseSync = openDb(), deps: CheckLeaseDeps = {}) {
    this.store = new CheckLeaseStore(db);
    this.verifyBase = deps.verifyBase ?? verifyPinnedBase;
    this.treehouseInstalled = deps.treehouseInstalled ?? treehouseInstalled;
    this.now = deps.now ?? Date.now;
    this.maxReclaimPerPass = deps.maxReclaimPerPass ?? 8;
    // Built from the same injected seams this manager has always exposed, so every existing
    // caller and test keeps driving the real adapter and the real lock against its own fake
    // subprocess without knowing the interface arrived.
    //
    // The manager keeps NO reference of its own to either. A leftover `this.cli` would be the
    // first thing a future change reached for, and one direct call is all it takes to put a
    // second route to a tree back beside the interface - which is the drift this seam exists
    // to make hard.
    this.treehouse = new TreehouseCheckTreeProvider(
      deps.cli ?? defaultTreehouseCli,
      deps.pin ?? pinLeasedWorktree,
    );
    this.git = new GitCheckTreeProvider();
    this.providers = new Map([
      [this.treehouse.kind, this.treehouse],
      [this.git.kind, this.git],
    ]);
  }

  /**
   * The provider that must take a row's tree back: the one the row RECORDS.
   *
   * Never a fresh probe of this machine, and that is the entire reason the column exists.
   * Installing or removing treehouse between a check's acquire and its release is routine on
   * a developer's machine, and both directions are destructive if the release re-decides: a
   * pooled tree handed to `git worktree remove` loses a pool slot for good, and a plain
   * worktree handed to `treehouse return --force` is a hard reset of a directory the pool has
   * never heard of.
   *
   * A row naming a provider this build cannot reach throws, which is the fail-closed
   * direction: the row stays live, the pin stays, the tree is kept. `CheckRuntime` already
   * treats a throw from `releaseForAttempt` as an unresolved cleanup and hands the attempt to
   * reclamation, so the tree is not forgotten - it is just not destroyed by a guess.
   */
  private providerFor(row: CheckLeaseRow): CheckTreeProvider {
    const provider = this.providers.get(row.provider);
    if (!provider) {
      throw new Error(
        `check attempt ${row.attemptId} took ${row.leasePath} from the "${row.provider}" ` +
          "provider, which this build cannot reach - refusing to hand it to a different one",
      );
    }
    return provider;
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
   * Stop claiming an attempt's lease WITHOUT returning its tree.
   *
   * The one exit a finished check has when its process group could not be proven empty.
   * `releaseForAttempt` is the ordinary exit and it drops this claim in its `finally`, but it
   * also ISSUES the return - and a return is exactly what an unproven group forbids. Without
   * this, a check whose build left something running would stay in `owned` for the life of
   * the daemon, and `reclaimLeaked` skips owned rows on the reasonable assumption that their
   * check is still going. The row would then be collected by nothing until a restart: the
   * shared reaper cannot see check leases at all, which is the whole reason this class owns
   * its own reclamation.
   *
   * So the claim is dropped and everything protective is kept - the row stays `held`, the pin
   * stays, `unresolvedLeaseForNode` keeps refusing a retry - and the next reclamation pass
   * asks the group-recovery seam again. That pass is the one that eventually proves the
   * stragglers gone and hands the tree back, which is the self-healing direction described on
   * `terminateCheckGroup`.
   */
  handOffForReclaim(attemptId: string): void {
    this.owned.delete(attemptId);
  }

  /**
   * Take an isolated worktree for one check attempt and pin it to the captured commit.
   *
   * Treehouse remains the fast path whenever its binary is resolvable. A machine without
   * that binary uses a detached git worktree instead, preserving the isolation and exact-
   * commit invariants so the check still produces a real verdict. A present but dry or
   * broken pool remains infrastructure; provider selection is not a fallback after an
   * acquisition failure.
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
      // Resolved ONCE per acquisition and recorded on the row below, because the row is what
      // the release path reads. A check deliberately asks about the BINARY only. It must not
      // consult `isTreehouseRepo`: repositories without `treehouse.toml` already take pooled
      // trees for checks, and changing that opt-in rule is a separately filed decision.
      const provider = (await this.treehouseInstalled()) ? this.treehouse : this.git;
      return await provider.withLock(repoRoot, async () => {
        const taken = await provider.acquire({ repoRoot, attemptId, baseSha });
        const path = taken.path;
        // Pinned first and synchronously: from here on the reaper must see this path even
        // though the row below has not been written yet.
        this.justAcquired.add(path);
        // Our own pin speaks for this tree from here, so the acquisition's provisional
        // protection can stand down - see `settleLease`. Kept HERE, on this side of the
        // interface, because the two protections hand over to each other and an `await`
        // between them would be a window in which neither covers the tree. Inert for a
        // provider that installed no provisional protection of its own.
        settleLease(path);
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
            holderToken: taken.holderToken,
            provider: provider.kind,
            now: this.now(),
          });
          inserted = true;
          // AFTER the row, always. Bringing the tree to the commit is the expensive step and
          // the one that can be interrupted, so the record of what we are holding has to
          // exist before it starts - and the unwind below distinguishes "we could not record
          // it" from "we could not prepare it" on exactly that basis.
          await provider.pin({ repoRoot, path, baseSha });
        } catch (err) {
          // The lease is LIVE and we are about to throw, so nothing downstream will ever
          // record this tree - the pool would lose the slot permanently. Hand it back while
          // we still know it is ours and nothing has been launched into it, and only drop
          // the row and the pin once that return is CONFIRMED. A return that itself fails
          // rides along with the real cause instead of replacing it, and leaves the lease
          // recorded for reclamation rather than pretending it is gone.
          const cause = err instanceof Error ? err.message : String(err);
          // The same hand-back the release path uses, reached with no row to name it by -
          // which is why a provider takes a `CheckTreeRef` rather than a `CheckLeaseRow`.
          const returned = await provider.handBack({
            repoRoot,
            leasePath: path,
            holderToken: taken.holderToken,
          });
          if (returned.code === 0) {
            if (inserted) this.store.delete(attemptId);
            this.justAcquired.delete(path);
            throw new Error(cause);
          }
          if (inserted) this.store.setState(attemptId, "returning", this.now());
          const mechanism = provider.kind === "treehouse" ? "pool lease" : "git worktree";
          throw new Error(
            `${cause} - and the ${mechanism} could not be returned: ` +
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
      // From the ROW, never from a fresh probe of this machine - see `providerFor`. Inside the
      // try so a refusal still drops this process's claim on the way out.
      const provider = this.providerFor(row);
      return await provider.withLock(row.repoRoot, () => this.resolveLocked(row, provider));
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
  private async resolveLocked(
    row: CheckLeaseRow,
    provider: CheckTreeProvider,
  ): Promise<CheckLeaseRelease> {
    const owner = await provider.ownership(row);
    if (owner.state === "unreadable") {
      // A source we could not READ is not a return we attempted, and the difference is
      // load-bearing rather than pedantic. `returning` means AUTHORISED - startup recovery
      // retries such a row without re-consulting group emptiness, precisely because the
      // decision to return it was already made against a tree we had proven was ours and
      // finished. Here we proved neither: we failed to look. Writing `returning` would let
      // one unreadable moment during cleanup become a forced return after the next restart,
      // terminating a check that is still running and hard-resetting its tree - the exact
      // failure the group-recovery seam exists to prevent.
      //
      // So the row keeps whatever authorisation it already had: a `held` row stays `held`
      // and will be asked about its process group; a row that was already `returning`
      // stays authorised, because that verdict was reached honestly.
      return this.retryLater(row, owner.reason);
    }

    // Not held at all: the prior return already succeeded. Issue nothing - the tree is not
    // ours to act on any more - and complete cleanup.
    if (owner.state === "gone") {
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
    if (owner.holder !== row.holderToken) {
      this.settle(row, "lost");
      return { outcome: "lost", holder: owner.holder };
    }
    const returned = await provider.handBack(row);
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
    // Authorised: we read the pool, proved the tree was ours, issued the return, and it
    // failed. That verdict survives a restart, which is what `returning` records.
    this.store.setState(row.attemptId, "returning", this.now());
    return this.retryLater(row, reason);
  }

  /**
   * Back off and try again later, WITHOUT changing what this lease is authorised to do.
   *
   * Split from `failedReturn` so that "we could not look" can never be mistaken later for
   * "we decided and failed". Only the second may skip the group-emptiness question.
   */
  private retryLater(row: CheckLeaseRow, reason: string): CheckLeaseRelease {
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
   *  - A `returning` row already had its return AUTHORISED and recorded: the pool was read,
   *    the tree was proven ours, the return was issued, and it failed. Retrying it is all
   *    that is left, and re-asking about the group would strand it behind a seam that may
   *    not be injected. This is only sound because nothing else writes that state - a
   *    release that could not read the pool deliberately leaves the row where it was, so
   *    "unreadable" can never be mistaken for "decided". See `retryLater`.
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
