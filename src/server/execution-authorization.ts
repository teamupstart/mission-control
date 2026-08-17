import { SUBMIT_WORKFLOW_EVIDENCE_TOOL } from "./workflows/evidence-tool.ts";

export interface ExecutionAuthorizationContext {
  /** The receiving prompt can use the selected Persona workflow's evidence tool. */
  workflowEvidence: boolean;
  /** The prompt continues work already owned by a workflow run. */
  workflowContinuation: boolean;
}

const PULL_REQUEST_AUTHORIZATION = [
  "When this task or the current workflow asks for a pull request, the operator has already authorized you to commit the scoped work, push its task branch, and create or update that pull request in the repository scope Mission Control issued. Act directly without asking for another confirmation.",
  "This authorization is conditional, not a requirement. An explicit no-PR instruction wins. It does not authorize merge, another repository, or another external write, and it does not change sandbox approval or server-side validation.",
].join("\n");

const WORKFLOW_EVIDENCE_AUTHORIZATION =
  `The operator has already authorized \`${SUBMIT_WORKFLOW_EVIDENCE_TOOL}\` for task-produced, checkout-relative artifacts, the repository slot Mission Control issued, and \`repositoryScope: "all"\` only when Mission Control issued that scope. Call it directly without asking the human to approve the payload or Mission Control destination; server-side validation remains authoritative.`;

const WORKFLOW_RESUBMISSION_OWNERSHIP =
  "Finish the requested work, register useful new evidence when eligible, and stop. Mission Control's engine or the Runs UI owns any resubmission; do not ask the human to resubmit the workflow.";

/** Mission Control's standing execution policy, rendered around task- or workflow-owned work. */
export function executionAuthorizationContract(context: ExecutionAuthorizationContext): string {
  return [
    "## Mission Control execution authorization",
    PULL_REQUEST_AUTHORIZATION,
    ...(context.workflowEvidence ? [WORKFLOW_EVIDENCE_AUTHORIZATION] : []),
    ...(context.workflowContinuation ? [WORKFLOW_RESUBMISSION_OWNERSHIP] : []),
  ].join("\n");
}

/** The evidence-specific policy arm, reused inside the optional evidence usage appendix. */
export function workflowEvidenceAuthorizationContract(): string {
  return [WORKFLOW_EVIDENCE_AUTHORIZATION, WORKFLOW_RESUBMISSION_OWNERSHIP].join("\n");
}
