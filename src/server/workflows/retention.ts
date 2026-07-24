import type { WorkflowRetentionConfig } from "@shared/workflow.ts";
import type { WorkflowRetentionResult, WorkflowStore } from "./store.ts";

export const WORKFLOW_RETENTION_INTERVAL_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

export function runWorkflowRetention(
  store: WorkflowStore,
  config: WorkflowRetentionConfig,
  now = Date.now(),
): WorkflowRetentionResult {
  return store.runRetention({
    rawEvidenceBefore: now - config.rawEvidenceDays * DAY_MS,
    completedRunsBefore: now - config.completedRunDays * DAY_MS,
    maxCompletedRuns: config.maxCompletedRuns,
    now,
  });
}
