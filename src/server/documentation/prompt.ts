import { deferredImperativeList, taskCompletionContract } from "@shared/task-completion.ts";

/** Shared by fresh dispatch and assignment through withTaskKindContract. */
export function documentTaskAppendix(workflowEvidence: boolean): string {
  const contract = taskCompletionContract("document")!;
  return [
    "## Document task",
    "Write or maintain the requested repository documentation. Read the repository's documentation index and relevant owner documents before editing. Verify changed claims against the implementation and current authoritative references.",
    "Keep one authoritative owner for each detailed fact or contract. Update that owner and replace stale or copied explanations with short context and descriptive links to the owning section. Preserve essential prerequisites, warnings, and examples where readers need them. Conciseness means useful information without repetition, not a word-count target.",
    "Compare the changed topics with relevant current guides, references, and inbound links. Respect explicit versions and supersession; historical plans and archives are not automatically current authority. Keep unrelated documentation cleanup out of scope.",
    "Before treating removed detail as missing, search the other documents and inspect relevant git history, including git log -p and commit messages. Map materially removed requirements and decisions to their current owning sections or explicit superseding decisions. For material consolidation, add one short editorial note explaining the rationale and destination and welcoming restoration of useful local context; keep presentation choices revisitable without weakening requirements.",
    "Resolve specialized terms with a concrete example or a precise definition link. Use one name per concept. State outcomes as what the caller gets, and keep design choices with their real rationale in scope or decision sections. Keep verified claims with their evidence, verification date, and relevant environment or version. Name only deliverables in scope and describe dependency release events accurately, rather than treating a document section as a completed prerequisite.",
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
      "When content is removed or consolidated, include relevant search results, git history patches and commit messages, and a removed-detail-to-owner mapping with the destination text. Include dated evidence for claims of verified behavior. State unavailable history or evidence honestly; the reviewers cannot search the checkout themselves.",
      "Include enough surrounding text to preserve meaning. File paths, changed hunks, and ordinary tool output alone cannot establish consistency. Identify missing or truncated material without claiming alignment. Register current comparison text after every repair; earlier evidence proves the version it captured.",
    ] : []),
  ].join("\n");
}
