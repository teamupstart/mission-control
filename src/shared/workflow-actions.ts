/** The Phase 4 action manifest. Paths select owners; paths never enter telemetry. */
export const WORKFLOW_ACTION_ROUTES = [
  ["POST", "/api/personas", "persona.create"],
  ["POST", "/api/personas/import", "persona.import"],
  ["POST", "/api/personas/:id/reimport", "persona.reimport"],
  ["PATCH", "/api/personas/:id", "persona.edit"],
  ["DELETE", "/api/personas/:id", "persona.archive"],
  ["POST", "/api/workflows", "workflow.create"],
  ["PUT", "/api/workflows/config", "workflow.configure"],
  ["PUT", "/api/workflow-commands/:id", "workflow.command"],
  ["PATCH", "/api/workflows/:id", "workflow.edit"],
  ["DELETE", "/api/workflows/:id", "workflow.archive"],
  ["POST", "/api/workflows/:id/unarchive", "workflow.unarchive"],
  ["POST", "/api/workflows/:id/delete", "workflow.delete"],
  ["POST", "/api/workflows/:id/publish", "workflow.publish"],
  ["POST", "/api/workflow-bindings", "workflow.bind"],
  ["PATCH", "/api/workflow-bindings/:id", "workflow.binding.edit"],
  ["DELETE", "/api/workflow-bindings/:id", "workflow.unbind"],
  ["POST", "/api/workflow-bindings/:id/submit", "workflow.submit"],
  ["POST", "/api/workflow-bindings/:id/reattach", "workflow.reattach"],
  ["POST", "/api/workflow-runs/:id/resubmit", "workflow.resubmit"],
  ["POST", "/api/workflow-runs/:id/retry", "workflow.retry"],
  ["POST", "/api/workflow-runs/:id/cancel", "workflow.cancel"],
  ["POST", "/api/workflow-runs/:id/grant-rounds", "workflow.grant_rounds"],
  ["POST", "/api/workflow-runs/:id/prepare-pr", "workflow.prepare_pr"],
  ["POST", "/api/workflow-runs/:id/recheck-inspector", "workflow.recheck"],
  ["POST", "/api/workflow-runs/:id/set-nodes-disabled", "workflow.toggle_nodes"],
  ["POST", "/api/workflow-runs/:id/set-persona-directive", "workflow.directive"],
  ["POST", "/api/workflow-runs/:id/remove-persona-directive", "workflow.remove_directive"],
  ["POST", "/api/workflow-runs/:id/restart-full", "workflow.restart"],
  ["POST", "/api/workflow-runs/:id/submissions/:submissionId/evidence-recovery", "workflow.evidence_recovery"],
  ["POST", "/api/workflow-runs/:id/submissions/:submissionId/evidence-readiness/retry", "workflow.readiness_retry"],
  ["POST", "/api/workflow-runs/:id/submissions/:submissionId/evidence-readiness/override", "workflow.readiness_override"],
  ["POST", "/api/workflow-deliveries/:id/retry", "workflow.delivery_retry"],
  ["POST", "/api/workflow-deliveries/:id/resolve", "workflow.delivery_resolve"],
] as const;
export type WorkflowAction = typeof WORKFLOW_ACTION_ROUTES[number][2];
const matchers = WORKFLOW_ACTION_ROUTES.map(([method, path, action]) => ({ method, path, action,
  pattern: new RegExp(`^${path.replace(/:[A-Za-z]+/g, "([^/]+)")}$`) }));
export function matchWorkflowAction(method: string, path: string) {
  for (const entry of matchers) {
    if (method !== entry.method) continue;
    const match = entry.pattern.exec(path);
    if (match) return { action: entry.action, subject: match[1] ?? null,
      owner: entry.path.split("/")[2] ?? "" };
  }
  return null;
}
