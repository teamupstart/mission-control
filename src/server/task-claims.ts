import type { Task, TaskClaimWarning, TaskProvisioning } from "@shared/types.ts";
import { renderClaimArgv, type RunningClaim, type WorktreeClaimWarning } from "./worktrees/claim.ts";

// What a task shows about the dependency claims its dispatch runs: the claim it is waiting on
// right now, and the claims that failed in the trees it was handed. The worktree manager owns
// the claims; these are the task's views of them.

/** The repository a task owner position names: 0 is the primary, n > 0 the nth attached one. */
function repoRootAt(task: Pick<Task, "repoRoot" | "extraRepos">, position: number): string | null {
  if (position === 0) return task.repoRoot;
  return task.extraRepos[position - 1]?.repoRoot ?? null;
}

/**
 * The dispatching task's provisioning phase, from the claim running in one of its worktrees.
 * Null until the claim's first step starts: before that the tree is still being reset or set
 * up and its fingerprint read, which the dispatch's ordinary "provisioning" already covers, and
 * a claim whose fingerprint matches never shows as installing at all.
 */
export function taskProvisioningView(
  task: Pick<Task, "status" | "repoRoot" | "extraRepos">,
  running: { claim: RunningClaim; position: number } | null,
): TaskProvisioning | null {
  if (task.status !== "dispatching" || !running?.claim.step) return null;
  const repoRoot = repoRootAt(task, running.position);
  if (!repoRoot) return null;
  const { claim } = running;
  const step = claim.step!;
  return {
    phase: "installingDependencies",
    repoRoot,
    slotId: claim.slotId,
    claimId: claim.id,
    startedAt: claim.startedAt,
    step: {
      step: step.step,
      stepCount: step.stepCount,
      command: renderClaimArgv(step.argv),
      startedAt: step.startedAt,
    },
  };
}

/** A failed claim as the task records it. Values were redacted before the claim reported it. */
export function taskClaimWarning(repoRoot: string, warning: WorktreeClaimWarning): TaskClaimWarning {
  return {
    repoRoot,
    step: warning.step,
    stepCount: warning.stepCount,
    command: renderClaimArgv(warning.argv),
    reason: warning.reason,
    tail: warning.tail,
    truncatedBytes: warning.truncatedBytes,
  };
}
