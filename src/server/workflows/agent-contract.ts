import { SUBMIT_WORKFLOW_EVIDENCE_TOOL } from "./evidence-tool.ts";
import { workflowEvidenceAuthorizationContract } from "../execution-authorization.ts";

/** Runtime preference policy; the delivery ledger freezes it with the authored action. */
export function workflowPullRequestCiContract(): string {
  return [
    "## Workflow pull request CI follow-through",
    "Foreman's Keep sessions on track with CI option was selected when this packet was prepared. This policy extends the Pull Request action's stopping point through CI, including when the frozen instruction below says opening the PR is the whole job. Preserve all other task and repository restrictions.",
    "After opening or updating the PR, keep watching its checks. Wait for pending checks and inspect failing check logs. Follow only this action's PR and repository, on the same branch.",
    "Repair actionable CI failures within the authorized scope. Run tests specific to the failure; when they pass, commit and push the repair. Do not rerun the full local test suite before each repair commit.",
    "After every repair push, verify checks for the newly pushed head. Do not rely on an earlier green result. Continue until CI passes or a concrete external blocker prevents authorized progress; distinguish absent or unavailable checks from passing CI and report the blocker rather than retrying indefinitely.",
    "Report the PR, checked head, final CI outcome, and any blocker. Register useful new verification evidence when this workflow supports it, then end the turn so Mission Control can continue the workflow.",
    "This policy does not authorize merge, CI infrastructure changes, bypassing checks, or broader repository scope. Inspector review comments remain with the existing review workflow and Foreman review-comment policy. The workflow still validates published content against its reviewed snapshot.",
  ].join("\n");
}

export function workflowEvidenceContractAppendix(): string {
  return [
    "## Workflow evidence readiness",
    "Before completing the task, make sure the next Persona can inspect evidence for each material acceptance criterion. Personas receive the diff, bounded transcript, upstream Check results, and evidence registered through Mission Control. They do not receive ordinary tool-result bodies, unregistered files, or later pull-request comments and checks.",
    `Use the Mission Control \`${SUBMIT_WORKFLOW_EVIDENCE_TOOL}\` tool to close those visibility gaps: pass \`commandOutputs\` with the exact completed focused command, exit code, output, repository scope, and a precise caption; pass \`images\` with a checkout-relative gitignored PNG, JPEG, GIF, or WebP when the claim concerns rendered UI. Existing gitignored UTF-8 logs may instead use \`artifacts\`. Pass \`coverage\` to declare each criterion's stable id, author-selected proof class, repository scope, and links from evidence \`clientItemId\` values to their proof roles.`,
    "Capture evidence after the final relevant run, check that registration succeeded, and keep it proportional. One focused artifact may prove many tests or acceptance criteria; do not submit one output per test or dump an entire large suite when a focused run demonstrates the behavior.",
    workflowEvidenceAuthorizationContract(),
    "Do not commit evidence artifacts. Native registration carries proof to the Persona and does not replace focused tests or verification.",
  ].join("\n");
}
