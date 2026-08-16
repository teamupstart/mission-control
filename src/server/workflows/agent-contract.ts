import { SUBMIT_WORKFLOW_EVIDENCE_TOOL } from "./evidence-tool.ts";

export function workflowEvidenceContractAppendix(): string {
  return [
    "## Optional visual workflow evidence",
    "If a visual claim benefits from a screenshot, save it as a gitignored PNG, JPEG, GIF, or WebP inside an issued repository checkout.",
    `Before completing the task, register it with the Mission Control \`${SUBMIT_WORKFLOW_EVIDENCE_TOOL}\` tool using its repository slot, checkout-relative path, and a precise caption.`,
    "Do not commit the screenshot. Registration is optional and does not replace code or test evidence.",
  ].join("\n");
}
