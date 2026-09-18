import type { WorkflowRunDetail } from "../../src/shared/workflow.ts";
import { projectWorkflowRecovery } from "../../src/server/workflows/recovery.ts";

/** Give synthetic UI fixtures the same projection a daemon response carries. */
export function withWorkflowRecovery(detail: WorkflowRunDetail): WorkflowRunDetail {
  const latest = [...detail.submissions].sort((a, b) => a.round - b.round || a.segment - b.segment).at(-1);
  const attempts = new Map(detail.attempts.filter((a) => a.submissionId === latest?.id)
    .map((a) => [a.nodeId, a]));
  const recovery = projectWorkflowRecovery({
    status: detail.run.status, phase: detail.run.currentPhase,
    bindingId: detail.binding.id, bindingState: detail.binding.state,
    sessionId: detail.binding.sessionId, external: Boolean(detail.externalSource),
    round: detail.summary.round, maxRepairRounds: detail.summary.maxRepairRounds,
    latest: latest ?? null, attempts: [...attempts.values()],
    gate: detail.inspectorGate?.state ?? null,
    completionPolicy: detail.version?.completionPolicy ?? null, bindingHasOtherRun: false,
  });
  return { ...detail, run: { ...detail.run, recovery }, summary: { ...detail.summary, recovery } };
}
