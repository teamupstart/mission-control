import { deferredImperativeList, taskCompletionContract } from "@shared/task-completion.ts";

/** Shared by fresh dispatch and assignment through withTaskKindContract. */
export function documentTaskAppendix(workflowEvidence: boolean): string {
  const contract = taskCompletionContract("document")!;
  return [
    "## Document task",
    "Write or maintain the requested repository documentation. Read the repository's documentation index and relevant owner documents before editing. Verify changed claims against the implementation and current authoritative references.",
    "Keep one authoritative owner for each detailed fact or contract. Update that owner and replace stale or copied explanations with short context and descriptive links to the owning section. Preserve essential prerequisites, warnings, and examples where readers need them. Conciseness means useful information without repetition, not a word-count target.",
    "Compare the changed topics with relevant current guides, references, and inbound links. Respect explicit versions and supersession; historical plans and archives are not automatically current authority. Keep unrelated documentation cleanup out of scope.",
    "Run focused link, anchor, formatting, generated-reference, and documentation-build checks as applicable. Verify runnable examples only in an appropriate isolated environment. Report unavailable checks honestly; prose-only work does not require a full application test suite unless the repository explicitly requires it.",
    "",
    "## Document task completion handoff",
    "Complete the documentation and its required verification, report the result, and end this turn:",
    ...contract.complete.map((requirement) => `- ${requirement}`),
    `During this initial task turn, do not ${deferredImperativeList(contract)}, even if the task request or repository instructions normally include those steps.`,
    "Mission Control owns the next step. Only a later instruction from Foreman or the selected workflow starts commit, push, pull-request, and CI follow-through.",
    ...(workflowEvidence ? [
      "",
      "## Documentation review evidence",
      "The selected workflow's Personas have no repository tools. Before completing, register a gitignored UTF-8 artifact with submit_workflow_evidence containing the current changed documents and complete relevant sections from unchanged authoritative documents needed to compare them. Label each source by checkout-relative path and revision or content hash. Include the file inventory, intended audience, review scope, explicit supersession, and focused check results.",
      "Include enough surrounding text to preserve meaning. File paths, changed hunks, and ordinary tool output alone cannot establish consistency. Identify missing or truncated material without claiming alignment. Register current comparison text after every repair; earlier evidence proves the version it captured.",
    ] : []),
  ].join("\n");
}
