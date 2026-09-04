import { SUBMIT_WORKFLOW_EVIDENCE_TOOL } from "./evidence-tool.ts";
import { workflowEvidenceAuthorizationContract } from "../execution-authorization.ts";

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
