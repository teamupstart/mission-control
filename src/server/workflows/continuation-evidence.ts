import { createHash } from "node:crypto";
import type { SessionGoal, Task } from "@shared/types.ts";
import { isActiveTask } from "@shared/task-status.ts";
import type { WorkflowBinding, WorkflowStagedEvidenceList } from "@shared/workflow.ts";
import { hasOperatorHandoffHold, resolvedSessionIntent } from "@shared/goal.ts";
import { sampleCheckoutBoundary } from "./repository-artifact/seal.ts";
import { explicitHandoffRestriction } from "../goal/handoff-restrictions.ts";
import { canonicalWorktreePath } from "../worktrees/path.ts";

export function continuationDigest(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function evidenceContract(
  task: Task | undefined,
  binding: WorkflowBinding,
  goal: SessionGoal | null,
  root: string | null,
): string | null {
  if (!task || !isActiveTask(task.status) || task.sessionId !== binding.sessionId ||
      (task.kind !== "ship" && task.kind !== "bugfix") || task.extraRepos.length ||
      !root || !binding.sessionCwd || canonicalWorktreePath(binding.sessionCwd) !== root ||
      !goal?.openingPrompt || !resolvedSessionIntent(goal) || goal.pendingPrompts.length ||
      hasOperatorHandoffHold(goal.objective) || explicitHandoffRestriction(goal.objective)) return null;
  return continuationDigest([
    task.id, task.kind, task.intent, task.title, task.repoRoot, task.baseSha,
    binding.noteKey, binding.id, binding.workflowVersionId, binding.triggerMode, binding.deliveryMode,
    root, goal.objectiveVersion, goal.objective, goal.handoffReleasedAt ?? null,
  ]);
}

export function packetDigest(contract: string, root: string, tray: WorkflowStagedEvidenceList): string {
  return continuationDigest([contract, root, tray.generation, tray.images, tray.artifacts, tray.coverage]);
}

export async function checkoutDigest(root: string): Promise<string | null> {
  // Registration remains available even if the optional boundary is too large or slow.
  return sampleCheckoutBoundary(root, AbortSignal.timeout(5_000), { requireStandaloneCommit: true }).catch(() => null);
}
