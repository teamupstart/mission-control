import { createHash } from "node:crypto";
import {
  taskHasWorktrees,
  taskHoldsCleanupResources,
  taskRepoRefs,
} from "@shared/task-repos.ts";
import { isTerminalTask } from "@shared/task-status.ts";
import type { Task } from "@shared/types.ts";

// The identity of everything a cleanup of a task would ACT ON, and the eligibility rule that
// decides whether it has a retention clock at all.
//
// Its own module rather than a member of the retention service because the DATABASE WRITER
// needs it: `recordTaskWorktreeObservation` re-derives the generation inside its own
// transaction, so the comparison that protects a ledger row is made by the thing doing the
// writing rather than by a caller that checked a moment earlier. `db.ts` and the retention
// service both import it here, which is what keeps that from being a circular import.

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
 *  - `homeName`, `homeBackend`, `terminalResourceId`, `sessionId` - terminal ownership,
 *    which reclaim can stop
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
    homeBackend: task.homeBackend ?? null,
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

/**
 * Is this task one the retention clock is allowed to START for at all?
 *
 * Worktrees, deliberately: the clock measures Git-visible change, so a task with no checkout
 * has nothing to measure and never earns a window. This is the rule for SEEDING a row, not for
 * keeping one - see `taskHoldsCleanupResources`.
 */
export function isRetentionCandidate(task: Task): boolean {
  return isTerminalTask(task.status) && taskHasWorktrees(task);
}


/**
 * May an existing ledger row still be worked - claimed, retried, finished?
 *
 * The keeping rule to `isRetentionCandidate`'s seeding rule. A row is only ever created for a
 * task with checkouts, but once created it must survive until the cleanup it drives has
 * released everything, and a teardown that hands back the final checkout and then fails on the
 * terminal home ends exactly between those two facts. Judging that row by the seeding rule is
 * what would delete the retry while a live resource is still recorded.
 */
export function isRetentionRetryable(task: Task): boolean {
  return isTerminalTask(task.status) && taskHoldsCleanupResources(task);
}

// The keeping rule lives in shared because the dashboard gates its controls on it too.
export { taskHoldsCleanupResources };
