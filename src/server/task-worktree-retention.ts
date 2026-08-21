import {
  claimTaskWorktreeCleanup,
  completeTaskWorktreeCleanup,
  deferTaskWorktreeCleanup,
  deleteTaskWorktreeRetention,
  getTask,
  getTaskWorktreeRetention,
  listOrphanedTaskWorktreeRetentionIds,
  recordTaskWorktreeObservation,
  recoverAbandonedTaskWorktreeCleanups,
  releaseTaskWorktreeCleanupClaim,
  type RetentionObservationOutcome,
  type TaskWorktreeRetentionRow,
} from "./db.ts";
import {
  defaultWorktreeActivityDeps,
  readFailureClass,
  taskActivityFingerprint,
  type ActivityFingerprint,
} from "./git/worktree-activity.ts";
import { unref } from "./util/timers.ts";
import { randomUUID } from "node:crypto";
import type { AutomaticReclaimOutcome, AutomaticReclaimRequest } from "./tasks.ts";
// Re-exported below: the generation and the eligibility rule live in their own module because
// the database writer derives them too, inside the transaction that protects a ledger row.
import {
  isRetentionCandidate,
  isRetentionRetryable,
  taskResourceGeneration,
} from "./task-resource-generation.ts";
import { taskHasWorktrees } from "@shared/task-repos.ts";
import type { Task } from "@shared/types.ts";

// The daemon's durable, task-level worktree activity clock, and the sweep that acts on it.
//
// It answers one question on a slow loop - "when did anything Git-visible last change in this
// terminal task's checkouts?" - writes the answer and the 30-day deadline it implies to the
// `task_worktree_retention` ledger, and once that deadline passes without a change, hands the
// task to `TaskManager` to be reclaimed.
//
// **It still removes nothing itself.** Not a slot reset, not a Treehouse return, not a
// `git worktree remove`, not a terminal home stop, not a task field cleared. Every destructive
// act goes through the reclaim core `TaskManager` already owns, reached through ONE injected
// dependency (`RetentionCleanupDeps.reclaim`) - so this module imports no provider, no
// allocator and no teardown function, and a source scan in
// `test/task-worktree-retention-observer.test.ts` keeps it that way. The ownership direction
// is fixed: terminal task -> this sweep -> `TaskManager` -> provider-aware teardown.
//
// The sweep is deliberately boring and its bias is always toward keeping a tree alive:
//
//  - It only ever looks at `done` / `failed` / `cancelled` tasks that still hold a worktree.
//  - It seeds a full window at the FIRST successful observation of a set of resources, never
//    from `updated_at`, `completedAt`, or a file mtime - none of which can prove when a
//    checkout was last touched, and all of which would silently backdate a tree that this
//    build has never actually looked at.
//  - An unreadable tree records a reason and moves no deadline, and can never be claimed: a
//    claim requires a FRESH successful probe that still matches the fingerprint the deadline
//    was granted against, so "we could not look" is never permission to delete.
//  - A stale pass cannot write onto resources that were replaced while it was running.
//  - Anything uncertain - an unknown probe, a refusing provider, an unpublishable archive, a
//    partial release - keeps every durable resource fact and retries with backoff. The tree
//    stays past due; a failure to clean it is never converted into another 30 days of life.

export { isRetentionCandidate, taskResourceGeneration };

/** How long a terminal task's checkouts survive without a Git-visible change. */
export const RETENTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How often the observer looks.
 *
 * Fixed, internal, and materially shorter than the window so a change late in a tree's life is
 * seen well before the deadline it resets. Deliberately NOT `MISSION_WORKTREE_SWEEP_MS`: that
 * setting tunes native pool maintenance and can be set to 0 to switch it off entirely, and the
 * approved policy has no off switch. A retention clock that stopped whenever an operator
 * quietened pool reconciliation would freeze every deadline in place without saying so.
 */
export const RETENTION_OBSERVE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** How many checkouts are probed at once. Bounded so a large stale fleet stays background work. */
export const RETENTION_PROBE_CONCURRENCY = 4;

/**
 * The first retry delay after a due cleanup fails, and the ceiling it doubles toward.
 *
 * The intervals are 1h, 2h, 4h, … capped at a day - a true doubling from the FIRST failure,
 * not from the second. That matters because every retry is another destructive attempt against
 * a provider that has already refused once, and an interval that repeats before it doubles buys
 * an extra early one.
 *
 * The observation cadence is the real floor: a retry cannot happen sooner than the next pass.
 */
export const RETENTION_RETRY_BASE_MS = 60 * 60 * 1000;
export const RETENTION_RETRY_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * How long to wait before attempting this task again, doubling each time it fails.
 *
 * Derived from the row rather than from an `attempts` column, and the two numbers it reads are
 * the exact endpoints of the interval that just elapsed: `retry_at` is when this attempt became
 * allowed, and `last_attempt_at` is when the PREVIOUS one ran. Their difference is the delay
 * that was granted last time, so doubling it is a real attempt progression - 1h, 2h, 4h - and
 * not an approximation of one.
 *
 * The row is the one read during observation, BEFORE the claim: claiming overwrites
 * `last_attempt_at` with the current time, which would erase the interval this needs.
 *
 * A row with no prior retry starts at the base. So does one whose endpoints cannot describe an
 * interval - a first failure, a claim reopened after a daemon death (which resets
 * `last_attempt_at` for exactly this reason, so a long outage is not mistaken for a long
 * backoff), or a clock that moved backwards. Starting over at an hour is the conservative
 * direction for a schedule whose only job is to stop hammering a provider.
 */
export function nextRetryDelayMs(
  row: Pick<TaskWorktreeRetentionRow, "retryAt" | "lastAttemptAt">,
  baseMs: number,
  maxMs: number,
): number {
  const previous =
    row.retryAt !== null && row.lastAttemptAt !== null ? row.retryAt - row.lastAttemptAt : 0;
  if (previous < baseMs) return Math.min(baseMs, maxMs);
  return Math.min(maxMs, previous * 2);
}

/**
 * The only route from this module to anything destructive, stated as data.
 *
 * There is exactly one function here that removes anything, `reclaim`, and it is `TaskManager`'s
 * queued automatic entry - not a provider, not the allocator, not `teardownWorktree`. The rest
 * are ledger transitions and one browser-facing refresh. Nothing in this file may import a
 * teardown path directly, and the source scan in the observer's tests enforces that, so the
 * shape below is the complete inventory of what automatic retention is able to do.
 *
 * Optional on `RetentionObserverDeps`: an observer constructed without it behaves exactly as
 * the observation-only build did, which is what the zero-cleanup tests continue to drive.
 */
export interface RetentionCleanupDeps {
  /** CAS the ledger row into a claim, given a generation and a FRESH matching fingerprint. */
  claim: typeof claimTaskWorktreeCleanup;
  /** Hand the task to `TaskManager`'s repository-serialized automatic reclaim. */
  reclaim: (
    request: AutomaticReclaimRequest,
  ) => Promise<AutomaticReclaimOutcome | { kind: "not-queued" }>;
  /** Drop the row once the task provably holds nothing left to release. */
  complete: typeof completeTaskWorktreeCleanup;
  /** Read a row without writing one. Used only to find an unfinished cleanup to resume. */
  readRow: typeof getTaskWorktreeRetention;
  /** Keep the due boundary, record a bounded reason, back off. */
  defer: typeof deferTaskWorktreeCleanup;
  /** Hand the row back to plain observation, unpenalised. */
  release: typeof releaseTaskWorktreeCleanupClaim;
  /** Reopen claims left behind by a daemon that died mid-attempt. Once, at start. */
  recoverAbandoned: typeof recoverAbandonedTaskWorktreeCleanups;
  /** Re-derive the browser-safe summary and emit the ordinary whole-task update. */
  refreshSummary: (taskId: string) => void;
  /** A value only one attempt holds. Seam so a test can assert on exact tokens. */
  mintToken: () => string;
  retryBaseMs: number;
  retryMaxMs: number;
}

export const defaultRetentionCleanupDeps: Omit<RetentionCleanupDeps, "reclaim" | "refreshSummary"> = {
  claim: claimTaskWorktreeCleanup,
  complete: completeTaskWorktreeCleanup,
  readRow: getTaskWorktreeRetention,
  defer: deferTaskWorktreeCleanup,
  release: releaseTaskWorktreeCleanupClaim,
  recoverAbandoned: recoverAbandonedTaskWorktreeCleanups,
  mintToken: () => randomUUID(),
  retryBaseMs: RETENTION_RETRY_BASE_MS,
  retryMaxMs: RETENTION_RETRY_MAX_MS,
};

/**
 * Everything the retention sweep can do, stated as data.
 *
 * Note what is still absent and cannot be added without changing this shape: there is no
 * `WorktreeManager`, no `teardownWorktree`, no provider, no allocator, no filesystem removal.
 * The single destructive capability lives behind `cleanup.reclaim`, which is `TaskManager`'s
 * own guarded entry - so this service is structurally incapable of releasing anything except
 * by asking the class that owns the lifecycle to do it.
 */
export interface RetentionObserverDeps {
  /** The in-memory task set. The registry's map, which startup reconciliation has filled. */
  listTasks: () => Task[];
  /** Authoritative re-read immediately before a write. SQLite, not the map. */
  reloadTask: (id: string) => Task | undefined;
  probe: (task: Task) => Promise<ActivityFingerprint>;
  record: typeof recordTaskWorktreeObservation;
  listOrphans: () => string[];
  deleteRow: (taskId: string) => void;
  now: () => number;
  intervalMs: number;
  retentionMs: number;
  concurrency: number;
  /** Timer seam. Returns a canceller, so a test drives passes without real time. */
  schedule: (fn: () => void, ms: number) => () => void;
  /**
   * The due-cleanup half. Absent means observe only - no claim is ever taken and no task is
   * ever handed to `TaskManager`, which is the shape the zero-cleanup tests construct.
   */
  cleanup?: RetentionCleanupDeps;
}

export const defaultRetentionObserverDeps: Omit<RetentionObserverDeps, "listTasks"> = {
  reloadTask: getTask,
  probe: (task) => taskActivityFingerprint(task, defaultWorktreeActivityDeps),
  record: recordTaskWorktreeObservation,
  listOrphans: listOrphanedTaskWorktreeRetentionIds,
  deleteRow: deleteTaskWorktreeRetention,
  now: Date.now,
  intervalMs: RETENTION_OBSERVE_INTERVAL_MS,
  retentionMs: RETENTION_WINDOW_MS,
  concurrency: RETENTION_PROBE_CONCURRENCY,
  schedule: (fn, ms) => {
    const timer = unref(setTimeout(fn, ms));
    return () => clearTimeout(timer);
  },
};

/** What one pass did, for logging and for tests to assert against. */
export interface RetentionPassResult {
  observed: number;
  pruned: number;
  outcomes: Record<string, number>;
  /** Per due-task cleanup result, keyed by the transition it produced. */
  cleanups: Record<string, number>;
}

export class TaskWorktreeRetentionObserver {
  private readonly deps: RetentionObserverDeps;
  private stopped = false;
  private started = false;
  private cancelTimer: (() => void) | null = null;
  private pass: Promise<RetentionPassResult> | null = null;

  constructor(deps: RetentionObserverDeps) {
    this.deps = deps;
  }

  /**
   * Begin observing: one pass now, then the next scheduled from the COMPLETION of the current
   * one rather than on a fixed interval, so a slow pass over a large fleet delays its successor
   * instead of overlapping it.
   *
   * Call this only after the first completed discovery sweep. Before that, session and task
   * reconciliation has not established who owns what, and a pass run against a half-filled map
   * would seed windows for resources whose ownership is about to change - costing every one of
   * them a needless replacement on the very next pass.
   */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    const cleanup = this.deps.cleanup;
    if (cleanup) {
      // A `claimed` row at this exact moment cannot belong to anybody: this process has just
      // started and holds no claims, so whoever minted that token died mid-attempt. Reopened
      // as RETRY rather than as plain observing, because a crash during provider teardown is
      // genuinely ambiguous - the tree may be half-removed and the lease may or may not be
      // back - and the retry then runs after startup reconciliation has re-established what
      // the task actually still owns. The deadline is untouched either way.
      const reopened = cleanup.recoverAbandoned(this.deps.now());
      if (reopened > 0) {
        console.log(`[retention] reopened ${reopened} cleanup claim(s) left by a previous run`);
      }
    }
    void this.tick();
  }

  private tick(): void {
    if (this.stopped) return;
    this.pass = this.runPass()
      .catch((err) => {
        console.error("[retention] observation pass failed:", err);
        return { observed: 0, pruned: 0, outcomes: {}, cleanups: {} };
      })
      .finally(() => {
        this.pass = null;
        if (this.stopped) return;
        this.cancelTimer = this.deps.schedule(() => {
          this.cancelTimer = null;
          this.tick();
        }, this.deps.intervalMs);
      });
  }

  /**
   * Stop, and wait for a pass already in flight.
   *
   * Awaited in daemon shutdown BEFORE `worktrees.stop()`, for the same reason the workflow
   * engine is: a probe is reading checkouts the allocator is about to reconcile, and a read
   * left running past the allocator's teardown would report `unknown` about trees that were
   * perfectly healthy when it started - writing a diagnosis nobody can act on.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    await this.pass?.catch(() => {});
  }

  /**
   * One full observation pass. Exposed for tests, which drive it directly rather than through
   * the timer.
   *
   * Order matters: prune first, observe second. Pruning is answered from SQLite (a task that
   * was deleted, rescheduled out of a terminal state, or has no checkout left), so doing it
   * first means the observation loop never spends a Git probe on a task whose row is about to
   * be dropped anyway.
   */
  async runPass(): Promise<RetentionPassResult> {
    const outcomes: Record<string, number> = {};
    const cleanups: Record<string, number> = {};
    let pruned = 0;
    for (const id of this.deps.listOrphans()) {
      if (this.stopped) break;
      this.deps.deleteRow(id);
      pruned += 1;
    }

    // The KEEPING rule, not the seeding one. A task whose cleanup released its final checkout
    // and then failed on the terminal home holds no worktree, so the seeding rule would drop it
    // from the sweep entirely and its row would sit in `retry` with nothing ever coming back
    // for it. `observe` refuses to seed a clock for one of these; it only finishes them.
    const candidates = this.deps.listTasks().filter(isRetentionRetryable);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (!this.stopped) {
        const task = candidates[next++];
        if (!task) return;
        const observed = await this.observe(task);
        if (observed.outcome) {
          outcomes[observed.outcome] = (outcomes[observed.outcome] ?? 0) + 1;
        }
        if (!observed.due) continue;
        const cleanup = await this.reclaimDue(observed.due);
        if (cleanup) cleanups[cleanup] = (cleanups[cleanup] ?? 0) + 1;
      }
    };
    const workers = Array.from(
      { length: Math.max(1, Math.min(this.deps.concurrency, candidates.length)) },
      worker,
    );
    await Promise.all(workers);
    return { observed: candidates.length, pruned, outcomes, cleanups };
  }

  /**
   * Observe one task: hash its checkouts, then write the result against the generation the
   * task ACTUALLY has at write time.
   *
   * The re-read is the whole race guard, and it is a re-read from SQLite rather than from the
   * registry map because the map is a projection that a concurrent event may not have reached
   * yet. Between the generation computed before the probe and the one computed after it, a
   * re-dispatch, a reschedule or a partial release can have happened; when it has, the write is
   * abandoned rather than retargeted, because the fingerprint in hand describes trees that are
   * no longer the ones the task owns.
   */
  private async observe(task: Task): Promise<{
    outcome: RetentionObservationOutcome | null;
    due: DueCleanup | null;
  }> {
    // No checkout left: this task is not being CLOCKED any more - there is nothing Git-visible
    // to read and no window that could move - but its cleanup may still be unfinished, because
    // a teardown can hand back the final tree and then fail on the terminal home. That row
    // stays retryable until the release completes. `record` is deliberately not reached from
    // here, so nothing ever seeds a clock for a home that never had one.
    if (!taskHasWorktrees(task)) return { outcome: null, due: this.unfinishedCleanup(task) };

    const before = taskResourceGeneration(task);
    let fingerprint: ActivityFingerprint;
    try {
      fingerprint = await this.deps.probe(task);
    } catch (err) {
      // Classified, never `String(err)`: a filesystem error's message carries the path of the
      // file it failed on, and this reason is persisted. See `readFailureClass`.
      fingerprint = { kind: "unknown", reason: `probe threw (${readFailureClass(err)})` };
    }
    if (this.stopped) return { outcome: null, due: null };

    const current = this.deps.reloadTask(task.id);
    if (!current || !isRetentionCandidate(current)) return { outcome: null, due: null };
    const after = taskResourceGeneration(current);
    if (after !== before) return { outcome: null, due: null };

    const now = this.deps.now();
    const result = this.deps.record({
      taskId: task.id,
      generation: after,
      fingerprint: fingerprint.kind === "known" ? fingerprint.digest : null,
      reason: fingerprint.kind === "unknown" ? fingerprint.reason : null,
      now,
      retentionMs: this.deps.retentionMs,
    });

    // Is this task now due, and did THIS observation establish the fact a claim needs?
    //
    // The fingerprint handed forward is the one that was just read from the real checkouts, so
    // the claim below is never taken on a value the ledger merely remembers. Every path that
    // did not produce a trustworthy fresh digest - an unknown read, a refused write, a
    // generation that moved under the pass - yields no candidate at all, which is what makes
    // "we could not look" structurally unable to authorize a deletion.
    const row = result.row;
    if (
      !this.deps.cleanup
      || !row
      || fingerprint.kind !== "known"
      || row.generation !== after
      || row.fingerprint !== fingerprint.digest
      || row.cleanupDueAt > now
      || (row.retryAt !== null && row.retryAt > now)
      || row.cleanupState === "claimed"
    ) {
      return { outcome: result.outcome, due: null };
    }
    return {
      outcome: result.outcome,
      due: { taskId: task.id, generation: after, fingerprint: fingerprint.digest, row },
    };
  }

  /**
   * The due form of an unfinished cleanup: no probe, no clock, only the row's own retry.
   *
   * There is no fingerprint to take and none is needed. What a fingerprint buys is "never
   * destroy a checkout somebody has worked in", and this task has no checkout left - what
   * remains is a terminal home, which holds no unpushed work. The row's stored value is handed
   * back unchanged so the claim still compares against exactly what it recorded.
   *
   * Returns nothing unless a row already exists and a previous attempt already put it in
   * `retry`. A home-only task that never had a row gets none here.
   */
  private unfinishedCleanup(task: Task): DueCleanup | null {
    const cleanup = this.deps.cleanup;
    if (!cleanup || !task.homeName) return null;
    const row = cleanup.readRow(task.id);
    if (!row || row.cleanupState !== "retry") return null;
    const now = this.deps.now();
    if (row.retryAt !== null && row.retryAt > now) return null;
    // The row must already name what the task holds now. A cleanup that shrank the resource set
    // adopts it on the way into `retry`, so this matches for the case that produced it and
    // refuses anything else rather than acting on a stale identity.
    if (row.generation !== taskResourceGeneration(task)) return null;
    return { taskId: task.id, generation: row.generation, fingerprint: row.fingerprint, row };
  }

  /**
   * One due task: claim it durably, ask `TaskManager` to reclaim it, and record what happened.
   *
   * Every branch below either finishes the clock, hands it back to plain observation, or leaves
   * it exactly where it was and schedules a retry. None of them ever moves `last_changed_at` or
   * `cleanup_due_at` forward - the only thing in the product that may do that is a successful
   * observation of genuinely changed Git state, which is the whole reason a failed cleanup
   * cannot quietly buy a checkout another month.
   */
  private async reclaimDue(due: DueCleanup): Promise<string | null> {
    const cleanup = this.deps.cleanup;
    if (!cleanup || this.stopped) return null;
    const token = cleanup.mintToken();
    const claim = cleanup.claim({
      taskId: due.taskId,
      generation: due.generation,
      fingerprint: due.fingerprint,
      token,
      now: this.deps.now(),
    });
    // Refused claims are ordinary, not errors: another pass or another daemon got there first,
    // the deadline moved, or the task was replaced between the probe and the transaction.
    if (!claim.claimed) return `claim-refused:${claim.refusal}`;

    const outcome = await cleanup.reclaim({
      taskId: due.taskId,
      generation: due.generation,
      fingerprint: due.fingerprint,
      probe: (task) => this.deps.probe(task),
      abandoned: () => this.stopped,
    });

    const now = this.deps.now();
    switch (outcome.kind) {
      case "not-queued": {
        // The repository is busy with another cleanup, or this task already has one waiting.
        // Nothing was attempted, so nothing is penalised - the claim simply goes back.
        cleanup.release(due.taskId, token, now);
        return "not-queued";
      }
      case "reclaimed": {
        const result = cleanup.complete(due.taskId, token);
        cleanup.refreshSummary(due.taskId);
        // `still-held` would mean teardown reported success while a checkout is still recorded,
        // which the row must survive: deleting it would grant that tree a brand new 30 days.
        if (result.kind === "still-held") {
          await this.deferWithRemaining(due, token, now, "cleanup left a checkout behind");
          return "reclaimed-partial";
        }
        return "reclaimed";
      }
      case "activity-changed": {
        // Work landed in the checkout between this pass's probe and the cleanup's own. The
        // claim is dropped without penalty; the next successful observation is what grants the
        // new full window, from a real reading rather than from this attempt's guess.
        cleanup.release(due.taskId, token, now);
        cleanup.refreshSummary(due.taskId);
        return "activity-changed";
      }
      case "ownership-changed": {
        // A re-dispatch, a reschedule, a manual reclaim. The old deadline describes resources
        // this task no longer has, so ordinary observation reseeds under the replacement rule.
        cleanup.release(due.taskId, token, now);
        cleanup.refreshSummary(due.taskId);
        return "ownership-changed";
      }
      default: {
        await this.deferWithRemaining(due, token, now, outcome.detail);
        cleanup.refreshSummary(due.taskId);
        return outcome.kind;
      }
    }
  }

  /**
   * Record a failed attempt: keep the due boundary, adopt whatever is still standing, back off.
   *
   * The adoption is the subtle half. A partial release, or a quiescence that stopped the
   * terminal home before a provider refused, leaves the task owning LESS than the claim was
   * taken against - so its generation has moved, and left alone the next observation would call
   * that an external replacement and hand the survivor a fresh 30 days. It is not a
   * replacement: this cleanup caused it, under its own claim, and the remaining tree was
   * already 30 days quiet. So the row adopts the current generation and the current aggregate
   * fingerprint of what remains, and keeps its deadline.
   *
   * When the remaining trees cannot be read at all, nothing is adopted and the row keeps the
   * generation it had. `recordTaskWorktreeObservation` covers that case from the other side:
   * a generation change found on a row that is already in `retry` is adopted rather than
   * replaced, because a row only reaches `retry` after a due cleanup already ran on it.
   */
  private async deferWithRemaining(
    due: DueCleanup,
    token: string,
    now: number,
    detail: string,
  ): Promise<void> {
    const cleanup = this.deps.cleanup;
    if (!cleanup) return;
    const retryAt = now + nextRetryDelayMs(due.row, cleanup.retryBaseMs, cleanup.retryMaxMs);
    const current = this.deps.reloadTask(due.taskId);
    if (current && isRetentionRetryable(current)) {
      const generation = taskResourceGeneration(current);
      if (generation === due.generation) {
        cleanup.defer({ taskId: due.taskId, token, now, retryAt, error: detail });
        return;
      }
      await this.adoptRemaining(due, token, now, retryAt, detail, current, generation);
      return;
    }
    // Nothing left that this cleanup is responsible for - or no task at all. `complete`
    // re-derives that inside its own transaction before deleting, and reports `still-held` if
    // anything reappeared, so a resource acquired since this attempt began defers instead of
    // losing its row.
    if (cleanup.complete(due.taskId, token).kind !== "deleted") {
      cleanup.defer({ taskId: due.taskId, token, now, retryAt, error: detail });
    }
  }

  /** The async tail of `deferWithRemaining`: re-probe what survived, then adopt it. */
  private async adoptRemaining(
    due: DueCleanup,
    token: string,
    now: number,
    retryAt: number,
    detail: string,
    current: Task,
    generation: string,
  ): Promise<void> {
    const cleanup = this.deps.cleanup;
    if (!cleanup) return;
    // Every tree came back and something else did not - the terminal home. There is nothing
    // left to fingerprint and nothing a fingerprint would protect, so adopt the identity of
    // what is STILL held and leave the stored value alone. That is what lets a later pass claim
    // this row against the task as it is now and finish the release.
    if (!taskHasWorktrees(current)) {
      // The row's own stored fingerprint is re-sent unchanged: `defer` adopts a generation only
      // alongside one, and that pairing is right - the two describe the same observation and
      // must never be written apart. There is simply no NEW reading to offer, so the recorded
      // value stands and only the identity moves.
      cleanup.defer({
        taskId: due.taskId,
        token,
        now,
        retryAt,
        error: detail,
        generation,
        fingerprint: due.row.fingerprint,
      });
      return;
    }
    let fingerprint: ActivityFingerprint;
    try {
      fingerprint = await this.deps.probe(current);
    } catch (err) {
      fingerprint = { kind: "unknown", reason: `probe threw (${readFailureClass(err)})` };
    }
    if (fingerprint.kind === "known") {
      cleanup.defer({
        taskId: due.taskId,
        token,
        now,
        retryAt,
        error: detail,
        generation,
        fingerprint: fingerprint.digest,
      });
    } else {
      cleanup.defer({ taskId: due.taskId, token, now, retryAt, error: detail });
    }
  }
}

/** A task whose deadline has arrived, carried with the fresh reading that proved it quiet. */
interface DueCleanup {
  taskId: string;
  generation: string;
  fingerprint: string;
  row: TaskWorktreeRetentionRow;
}
