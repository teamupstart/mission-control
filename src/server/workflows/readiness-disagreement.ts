import type {
  PersonaVerdict,
  WorkflowJson,
  WorkflowSubmission,
  WorkflowVersion,
} from "@shared/workflow.ts";

/**
 * The run event a submission earns when the evidence preflight and a Persona disagree about it.
 *
 * The invariant: a `ready` evaluation plus a Persona `fail` emits one, and nothing else does.
 * Those are two readings of the same submission contradicting each other. `gaps`, `overridden`
 * and `not_evaluated` are excluded because the preflight never said the packet was ready.
 *
 * The POLICY is recorded rather than required. An advisory `ready` gated nothing, so its
 * disagreement means something weaker than an enforced one - but it is the same contradiction,
 * it is just as reachable, and suppressing it would hide the case where an operator is deciding
 * whether the preflight is worth enforcing at all. The payload carries the policy so a reader
 * can tell the two apart.
 *
 * A signal, never a verdict rewrite: a Persona may fail structurally complete evidence on its
 * merits, and this only records that the two readings differ.
 */
export function readinessReviewDisagreementEvent(input: {
  submission: Pick<WorkflowSubmission, "id" | "round" | "segment" | "readiness">;
  nodeId: string;
  attemptId: string;
  persona: string;
  verdict: PersonaVerdict;
  version: Pick<WorkflowVersion, "evidenceReadinessPolicy">;
}): { eventId: string; payload: WorkflowJson } | null {
  if (input.verdict.verdict !== "fail") return null;
  if (input.submission.readiness?.status !== "ready") return null;
  return {
    // Keyed by the ATTEMPT, so a replayed or recovered write of the same verdict records one
    // disagreement, while a second Persona failing the same submission records its own.
    eventId: `readiness-review-disagreement:${input.attemptId}`,
    payload: {
      submissionId: input.submission.id,
      nodeId: input.nodeId,
      persona: input.persona,
      round: input.submission.round,
      segment: input.submission.segment,
      policy: input.version.evidenceReadinessPolicy,
      evaluatorVersion: input.submission.readiness.evaluatorVersion,
      readiness: input.submission.readiness.status,
      summary: input.verdict.summary.slice(0, 400),
    },
  };
}
