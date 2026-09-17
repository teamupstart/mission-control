/** Advisory topics, independent of finding basis. Persisted ids are append-only. */
export const WORKFLOW_FINDING_REASONS = [
  "requirements", "correctness", "test_coverage", "execution_evidence", "visual_evidence",
  "maintainability", "architecture", "security", "performance", "documentation", "delivery",
  "other", "unknown",
] as const;
export type WorkflowFindingReason = (typeof WORKFLOW_FINDING_REASONS)[number];

export function workflowFindingReason(value: unknown): WorkflowFindingReason {
  return typeof value === "string" && (WORKFLOW_FINDING_REASONS as readonly string[]).includes(value)
    ? value as WorkflowFindingReason : "unknown";
}
