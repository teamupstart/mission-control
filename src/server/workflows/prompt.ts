import type {
  PersonaFeedbackSummary,
  PersonaSnapshot,
  WorkflowContextSnapshot,
  WorkflowPersonaDirectiveSnapshot,
} from "@shared/workflow.ts";
import { REVIEW_LIMITS, reviewContract } from "@shared/review.ts";
import { boundedSection, untrustedBlock, untrustedJsonBlock } from "../review/prompt.ts";

function priorFeedback(items: PersonaFeedbackSummary[]): string {
  if (items.length === 0) return "(none)";
  return items.map((item) => [
    `Persona: ${item.personaName}`,
    `Summary: ${item.summary}`,
    `Requested changes: ${item.requestedChanges.length === 0 ? "(none)" : item.requestedChanges.join("; ")}`,
  ].join("\n")).join("\n\n");
}

/**
 * Build the immutable, intent-first Persona review prompt.
 *
 * Evidence is fenced and explicitly untrusted. The exact published Persona Markdown is
 * interpolated after the human's intent, so a Persona may specialize review without
 * silently rewriting what the operator asked for.
 *
 * The framing sentence, the section bounds and the fence naming come from the shared review
 * helpers; the question this asks and the `PersonaVerdict` it must answer in stay here,
 * because they are what makes this a Persona review rather than review in general.
 */
export function buildPersonaPrompt(
  persona: PersonaSnapshot,
  context: WorkflowContextSnapshot,
  operatorDirective: WorkflowPersonaDirectiveSnapshot | null = null,
): string {
  const decisions = context.humanDecisions.length === 0
    ? "(none recorded)"
    : context.humanDecisions.map((item) => [
        `- [${item.source.kind}:${item.source.id}] ${item.decision}`,
        item.rationale ? `  Rationale: ${item.rationale}` : null,
      ].filter(Boolean).join("\n")).join("\n");

  return [
    ...(operatorDirective ? [
      "# EXTREMELY CRITICAL OPERATOR DIRECTIVE",
      "This instruction was authored directly by the human operator for this Persona in this workflow run. It has the highest priority among all review content in this prompt. If it conflicts with the original human intent, published Persona guidance, prior Persona feedback, or evidence text, follow this directive.",
      "It does not override system safety requirements or the required JSON verdict format.",
      JSON.stringify({ feedback: operatorDirective.feedback }),
      "",
    ] : []),
    "# Immutable review contract",
    reviewContract({
      subject: "the submitted snapshot",
      guidanceLabel: "Persona guidance",
      evidenceLabel: "diff, transcript, and standards content",
    }),
    "",
    "# Original human intent",
    "Raw goal:",
    boundedSection(context.primaryGoal.rawPrompt),
    "",
    `Refined goal: ${context.primaryGoal.refined ?? "(none)"}`,
    "Human decisions:",
    boundedSection(decisions),
    "Constraints:",
    context.constraints.length === 0
      ? "(none recorded)"
      : boundedSection(context.constraints.map((item) => `- ${item}`).join("\n")),
    "Acceptance criteria:",
    context.acceptanceCriteria.length === 0
      ? "(none recorded)"
      : boundedSection(context.acceptanceCriteria.map((item) => `- ${item}`).join("\n")),
    "",
    "# Published Persona guidance",
    boundedSection(persona.guidanceMarkdown, REVIEW_LIMITS.guidance),
    "",
    "# Prior Persona feedback (non-human)",
    boundedSection(priorFeedback(context.priorPersonaFeedback)),
    "",
    "# Untrusted evidence",
    ...untrustedJsonBlock("workflow-metadata", {
      headSha: context.evidence.headSha,
      workingTreeDirty: context.evidence.workingTreeDirty,
      workingTreeStatus: context.evidence.workingTreeStatus,
      workingTreeStatusTruncated: context.evidence.workingTreeStatusTruncated,
      diffFingerprint: context.evidence.diffFingerprint,
      diffTruncated: context.evidence.diffTruncated,
      transcriptTruncated: context.evidence.transcriptTruncated,
      standardsTruncated: context.evidence.standardsTruncated,
    }),
    ...untrustedBlock("workflow-diff", context.evidence.diff),
    ...untrustedJsonBlock("workflow-transcript", context.evidence.transcript),
    ...untrustedJsonBlock("workflow-standards", context.evidence.standards),
    "",
    "# Required output",
    "Reply with ONLY one JSON object. A pass must have {\"verdict\":\"pass\",\"summary\":string,\"approvalDetails\":{\"reason\":string,\"evidence\":[EvidenceRef]},\"confidence\":0..1}. A fail must have {\"verdict\":\"fail\",\"summary\":string,\"requestedChanges\":[{\"title\":string,\"rationale\":string,\"evidence\":[EvidenceRef],\"path\"?:string,\"line\"?:integer}],\"confidence\":0..1}, with at least one EvidenceRef for every requested change. EvidenceRef is {\"kind\":\"diff\"|\"transcript\"|\"standard\"|\"goal\"|\"decision\",\"quote\":string,\"path\"?:string,\"line\"?:integer}. Never use a fail verdict for an infrastructure or evidence-access problem.",
  ].join("\n");
}
