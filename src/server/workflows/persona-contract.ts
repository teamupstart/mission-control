import { createHash, randomUUID } from "node:crypto";
import { WorkflowContextSnapshotSchema, WorkflowPersonaReviewInputSchema } from "@shared/protocol.ts";
import { workflowHasPendingPullRequestAction } from "@shared/workflow.ts";
import type { PersonaVerdict, WorkflowPersonaReviewInput, WorkflowSubmission, WorkflowVersion } from "@shared/workflow.ts";

export function personaReviewInput(submission: WorkflowSubmission, version: WorkflowVersion): WorkflowPersonaReviewInput {
  const context = WorkflowContextSnapshotSchema.parse(submission.context);
  const readiness = submission.readiness;
  const known = new Set(context.canonicalCriteria.map((item) => item.id));
  if (!context.canonicalCriteria.some((item) => item.material)) known.add("evidence-coverage");
  const evidence = new Set([...(context.evidence.images ?? []), ...(context.evidence.artifacts ?? [])].map((item) => item.id));
  if (readiness?.criteria.some((item) => !known.has(item.criterionId)
      || item.links.some((link) => !evidence.has(link.evidenceId)))) {
    throw new Error("Readiness does not describe the frozen submission");
  }
  const pendingPullRequest = readiness?.criteria.some((row) => row.deferredToAction)
    && workflowHasPendingPullRequestAction(version.graph, submission.continuationNodeId);
  const legitimatelyDeferred = (id: string) => pendingPullRequest
    && context.canonicalCriteria.some((criterion) => criterion.id === id && criterion.fulfilledByAction === "pull_request");
  if (readiness?.criteria.some((row) => row.deferredToAction && !legitimatelyDeferred(row.criterionId))) {
    throw new Error("Readiness deferral has no pending publication action");
  }
  if (readiness?.status === "ready" && context.canonicalCriteria.some((criterion) => criterion.material
      && !readiness.criteria.some((row) => row.criterionId === criterion.id && (row.matchedClientCriterionId || row.deferredToAction && legitimatelyDeferred(row.criterionId))))) {
    throw new Error("Ready projection is missing a material criterion selection");
  }
  return WorkflowPersonaReviewInputSchema.parse({
    version: 1, operationId: randomUUID(), submissionId: submission.id,
    round: submission.round, segment: submission.segment,
    policy: version.evidenceReadinessPolicy,
    status: readiness?.status ?? "unknown", evaluatorVersion: readiness?.evaluatorVersion ?? null,
    criteria: readiness?.criteria.map((item) => ({
      ...(item.deferredToAction ? { deferredToAction: item.deferredToAction } : {}),
      criterionId: item.criterionId, material: item.material, claimId: item.matchedClientCriterionId,
      evidenceIds: [...new Set(item.links.map((link) => link.evidenceId))], gaps: item.gaps,
    })) ?? [],
  });
}

export function personaReviewInputDigest(input: WorkflowPersonaReviewInput): string {
  const { operationId: _operationId, ...contract } = input;
  return createHash("sha256").update(JSON.stringify(contract)).digest("hex");
}

/** Typed reasons only. Substantive objections, even suspicious prose, remain real findings. */
export function personaContractViolation(verdict: PersonaVerdict): string | null {
  if (verdict.verdict === "pass") return null;
  if (verdict.requestedChanges.some((change) => !change.basis)) return "missing_finding_basis";
  if (verdict.requestedChanges.some((change) => change.basis === "evidence_access")) return "evidence_access";
  if (verdict.requestedChanges.some((change) => change.basis === "coverage_registration")) return "coverage_registration";
  return null;
}
