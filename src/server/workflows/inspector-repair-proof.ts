import { WorkflowInspectorOnlyContextSchema } from "@shared/protocol.ts";
import type {
  WorkflowCompletionPolicy,
  WorkflowInspectorGateState,
  WorkflowRun,
  WorkflowSubmission,
} from "@shared/workflow.ts";
import { workflowInspectorOnlyRepair } from "@shared/workflow-lifecycle.ts";

/**
 * What a completed run accepted when it finished through Inspector-only repair rounds.
 *
 * `headSha` is the full commit id Inspector reviewed clean at the exact head. `failedBaseHeadSha`
 * is the full commit id the first repair round replaced. The caller still has to show that it
 * is the head of `published`, which records only the abbreviation its capture read.
 */
export interface AcceptedInspectorRepair {
  published: WorkflowSubmission;
  headSha: string;
  failedBaseHeadSha: string;
}

/**
 * Prove, from durable rows alone, that a completed run's terminal content is an
 * Inspector-only repair that the published policy authorized and Inspector accepted.
 *
 * A completed publication that ends in an Inspector-only round has no full snapshot of its
 * final content. The publication handoff's accepted tree belongs to the reviewed submission
 * BEFORE the repairs, so comparing the checkout to it would compare stale content. This
 * returns the reviewed head only when every fact agrees, and null otherwise:
 *
 * - the workflow version's published policy repairs Inspector findings Inspector-only;
 * - the run completed through the clean Inspector gate: no wait reason, no outstanding
 *   finding, no reviewed-content hold, and the pinned, observed and recorded heads are the
 *   terminal submission's head;
 * - every submission after the publication continuation is an Inspector-only repair round
 *   for its own new head, and each round replaced the head the previous one introduced.
 *
 * The caller still owns the repository read: the checkout must be that exact commit and
 * publish nothing beyond its tree. Missing or contradictory proof is a fresh review.
 */
export function acceptedInspectorRepair(input: {
  run: Pick<WorkflowRun, "id" | "status" | "currentPhase" | "inspectorHeadSha">;
  gate: WorkflowInspectorGateState | null;
  policy: WorkflowCompletionPolicy | undefined;
  submissions: readonly WorkflowSubmission[];
  publishedSubmissionId: string;
}): AcceptedInspectorRepair | null {
  const { run, gate, policy, submissions } = input;
  if (run.status !== "completed" || run.currentPhase !== "complete") return null;
  if (!gate || !workflowInspectorOnlyRepair(policy, gate)) return null;
  if (gate.waitReason !== null || gate.findingFingerprints.length > 0 || gate.grantObservation) return null;

  const index = submissions.findIndex((submission) => submission.id === input.publishedSubmissionId);
  const published = index >= 0 ? submissions[index] : undefined;
  if (!published || published.mode !== "full_workflow" || published.status !== "completed") return null;
  const repairs = submissions.slice(index + 1);
  if (repairs.length === 0) return null;

  let replaced: string | null = null;
  let failedBaseHeadSha: string | null = null;
  for (const repair of repairs) {
    if (repair.mode !== "inspector_only" || repair.status !== "completed" || !repair.prHeadSha) return null;
    const context = WorkflowInspectorOnlyContextSchema.safeParse(repair.context);
    if (!context.success) return null;
    const { failedHeadSha, newHeadSha } = context.data;
    if (newHeadSha !== repair.prHeadSha || newHeadSha === failedHeadSha
      || repair.triggerKey !== `inspector-head:${run.id}:${newHeadSha}`) return null;
    if (replaced === null) failedBaseHeadSha = failedHeadSha;
    else if (failedHeadSha !== replaced) return null;
    replaced = newHeadSha;
  }
  const headSha = replaced!;
  if (gate.targetHeadSha !== headSha || gate.observedHeadSha !== headSha || run.inspectorHeadSha !== headSha) {
    return null;
  }
  return { published, headSha, failedBaseHeadSha: failedBaseHeadSha! };
}
