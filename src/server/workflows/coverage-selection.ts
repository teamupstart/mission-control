import { WorkflowContextSnapshotSchema } from "@shared/protocol.ts";
import { selectWorkflowCoverageClaims, type WorkflowCoverageSelection, type WorkflowSubmission } from "@shared/workflow.ts";
import type { WorkflowStore } from "./store.ts";

export function previousEvidenceSubmission(store: WorkflowStore, submission: WorkflowSubmission): WorkflowSubmission | null {
  const previous = submission.parentSubmissionId
    ? store.getSubmission(submission.parentSubmissionId)
    : store.listSubmissions(submission.runId).filter((row) => row.round < submission.round
      || (row.round === submission.round && row.segment < submission.segment)).at(-1) ?? null;
  return previous?.runId === submission.runId
      && (previous.round < submission.round || (previous.round === submission.round && previous.segment < submission.segment))
    ? previous : null;
}

/** Replay legacy declaration provenance, never timestamps or an inferred semantic winner. */
export function submissionCoverageSelection(store: WorkflowStore, submission: WorkflowSubmission): WorkflowCoverageSelection | undefined {
  const chain: WorkflowSubmission[] = [];
  const visited = new Set<string>();
  let cursor: WorkflowSubmission | null = submission;
  let previous: WorkflowCoverageSelection | undefined;
  while (cursor) {
    if (visited.has(cursor.id) || chain.length >= 128) return undefined;
    visited.add(cursor.id);
    const parsed = WorkflowContextSnapshotSchema.safeParse(cursor.context);
    if (!parsed.success) return undefined;
    if (parsed.data.coverageSelection) {
      const source = previousEvidenceSubmission(store, cursor);
      if (parsed.data.coverageSelection.sourceSubmissionId !== (source?.id ?? null)) return undefined;
      previous = parsed.data.coverageSelection;
      break;
    }
    chain.push(cursor);
    const parent = previousEvidenceSubmission(store, cursor);
    if (cursor.parentSubmissionId && !parent) return undefined;
    cursor = parent;
  }
  for (const row of chain.reverse()) {
    const context = WorkflowContextSnapshotSchema.parse(row.context);
    previous = selectWorkflowCoverageClaims({
      canonicalCriteria: context.canonicalCriteria,
      criterionMappings: context.criterionMappings,
      coverage: store.listSubmissionCoverage(row.id),
      previous,
      sourceSubmissionId: previousEvidenceSubmission(store, row)?.id ?? null,
    });
  }
  return previous;
}
