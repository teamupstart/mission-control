import { createHash } from "node:crypto";
import {
  deleteTaskWorktreeRetention,
  getTask,
  listOrphanedTaskWorktreeRetentionIds,
  recordTaskWorktreeObservation,
  type RetentionObservationOutcome,
} from "./db.ts";
import {
  defaultWorktreeActivityDeps,
  taskActivityFingerprint,
  type ActivityFingerprint,
} from "./git/worktree-activity.ts";
import { unref } from "./util/timers.ts";
import { isTerminalTask } from "@shared/task-status.ts";
import { taskHasWorktrees, taskRepoRefs } from "@shared/task-repos.ts";
import type { Task } from "@shared/types.ts";

// The daemon's durable, task-level worktree activity clock.
//
// It answers one question on a slow loop - "when did anything Git-visible last change in this
// terminal task's checkouts?" - and writes the answer, plus the 30-day deadline it implies, to
// the `task_worktree_retention` ledger. That is ALL it does.
//
// **This phase reclaims nothing.** Not a slot reset, not a Treehouse return, not a
// `git worktree remove`, not a terminal home stop, not a task field cleared. The destructive
// half of the approved plan is a separate, separately-reviewed change that consumes this
// ledger through `TaskManager.reclaim()`. The invariant is visible in `RetentionObserverDeps`,
// which names no cleanup capability at all, and is pinned by a source scan in
// `test/task-worktree-retention-observer.test.ts` so it cannot be crossed by an import.
//
// The observer is deliberately boring and its bias is always toward keeping a tree alive:
//
//  - It only ever looks at `done` / `failed` / `cancelled` tasks that still hold a worktree.
//  - It seeds a full window at the FIRST successful observation of a set of resources, never
//    from `updated_at`, `completedAt`, or a file mtime - none of which can prove when a
//    checkout was last touched, and all of which would silently backdate a tree that this
//    build has never actually looked at.
//  - An unreadable tree records a reason and moves no deadline.
//  - A stale pass cannot write onto resources that were replaced while it was running.

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
 * The identity of everything a cleanup of this task would ACT ON, as one digest.
 *
 * It exists to answer, before any ledger write, "is what I observed still what the task owns?"
 * A pass that probed a tree, then took a second on three other tasks, must not land that
 * fingerprint on a task that was re-dispatched in between - the new checkout would inherit an
 * age it never lived, and in the next phase that is a deletion.
 *
 * What goes in is exactly the cleanup-relevant facts, and each is here for a reason:
 *
 *  - `id` and `dispatchedAt` - the ATTEMPT. A rescheduled task that runs again is a new tree
 *    even if it happens to land on the same path.
 *  - every repository's position, root, recorded worktree path, provider and native lease -
 *    the tuple teardown itself reads. A slot returned and re-leased at the same path under a
 *    new lease id is a different tree wearing the same name, and a partial release that
 *    cleared one repository's path is a different set of resources than the one observed.
 *  - `homeName`, `terminalResourceId`, `sessionId` - terminal ownership, which reclaim can stop
 *    or clear. A generation blind to them would survive a mutation that changed what cleanup
 *    would do.
 *
 * What is deliberately OUT: title, intent, labels, dependencies, outcome, pull request state,
 * `updatedAt`. All of them move under ordinary bookkeeping, and any of them in here would
 * restart a task's grace period every time the PR poller ran.
 *
 * Hashed rather than stored verbatim, because this is a comparison key and not a second source
 * of truth about resources - nothing may ever read a path back out of it.
 */
export function taskResourceGeneration(task: Task): string {
  const canonical = JSON.stringify({
    id: task.id,
    dispatchedAt: task.dispatchedAt,
    homeName: task.homeName,
    terminalResourceId: task.terminalResourceId,
    sessionId: task.sessionId,
    repos: taskRepoRefs(task).map((ref) => [
      ref.position,
      ref.repoRoot,
      ref.worktreePath,
      ref.provider,
      ref.worktreeLeaseId,
    ]),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Is this task one the retention clock is allowed to run for at all? */
export function isRetentionCandidate(task: Task): boolean {
  return isTerminalTask(task.status) && taskHasWorktrees(task);
}

/**
 * Everything the observer can do, stated as data.
 *
 * Note what is absent and cannot be added without changing this shape: there is no
 * `TaskManager`, no `WorktreeManager`, no `reclaim`, no `teardownWorktree`, no provider. The
 * observer is structurally incapable of releasing anything, which is the point of shipping it
 * a phase ahead of the cleanup that consumes it.
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
    void this.tick();
  }

  private tick(): void {
    if (this.stopped) return;
    this.pass = this.runPass()
      .catch((err) => {
        console.error("[retention] observation pass failed:", err);
        return { observed: 0, pruned: 0, outcomes: {} };
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
    let pruned = 0;
    for (const id of this.deps.listOrphans()) {
      if (this.stopped) break;
      this.deps.deleteRow(id);
      pruned += 1;
    }

    const candidates = this.deps.listTasks().filter(isRetentionCandidate);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (!this.stopped) {
        const task = candidates[next++];
        if (!task) return;
        const outcome = await this.observe(task);
        if (outcome) outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      }
    };
    const workers = Array.from(
      { length: Math.max(1, Math.min(this.deps.concurrency, candidates.length)) },
      worker,
    );
    await Promise.all(workers);
    return { observed: candidates.length, pruned, outcomes };
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
  private async observe(task: Task): Promise<RetentionObservationOutcome | null> {
    const before = taskResourceGeneration(task);
    let fingerprint: ActivityFingerprint;
    try {
      fingerprint = await this.deps.probe(task);
    } catch (err) {
      fingerprint = { kind: "unknown", reason: `probe threw: ${String(err)}` };
    }
    if (this.stopped) return null;

    const current = this.deps.reloadTask(task.id);
    if (!current || !isRetentionCandidate(current)) return null;
    const after = taskResourceGeneration(current);
    if (after !== before) return null;

    const result = this.deps.record({
      taskId: task.id,
      generation: after,
      fingerprint: fingerprint.kind === "known" ? fingerprint.digest : null,
      reason: fingerprint.kind === "unknown" ? fingerprint.reason : null,
      now: this.deps.now(),
      retentionMs: this.deps.retentionMs,
    });
    return result.outcome;
  }
}
