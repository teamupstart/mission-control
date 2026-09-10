import type {
  PersonaFeedbackSummary,
  PersonaSnapshot,
  WorkflowCheckEvidence,
  WorkflowContextSnapshot,
  WorkflowEvidenceInheritance,
  WorkflowPersonaDirectiveSnapshot,
} from "@shared/workflow.ts";
import { REVIEW_LIMITS, reviewContract } from "@shared/review.ts";
import { boundedSection, untrustedBlock, untrustedJsonBlock } from "../review/prompt.ts";

/**
 * The carry-forward mark, or nothing at all for evidence captured here.
 *
 * Spread rather than emitted as a null, because a `null` on every entry of every manifest is
 * prompt bytes spent to say that the ordinary case is ordinary. The origin round and the
 * repository fingerprint the bytes were captured against are the two facts a reviewer needs
 * to decide whether a carried artifact still proves anything, and they belong in the manifest
 * rather than in the contract text, where they would be a claim about evidence instead of
 * part of it.
 */
function carriedForward(
  item: { inheritedFrom?: WorkflowEvidenceInheritance | null },
): { capturedInRound: number; capturedAtRepositoryFingerprint: string | null } | Record<string, never> {
  if (!item.inheritedFrom) return {};
  return {
    capturedInRound: item.inheritedFrom.round,
    capturedAtRepositoryFingerprint: item.inheritedFrom.repositoryFingerprint,
  };
}

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
  checkEvidence: readonly WorkflowCheckEvidence[] = [],
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
      evidenceLabel: "diff, transcript, Check, text artifact, image, and standards content",
    }),
    "",
    "# Original human intent",
    "Review contract (durable objective; historical runs retain their captured goal):",
    boundedSection(context.primaryGoal.rawPrompt),
    ...(context.primaryGoal.openingAsk && context.primaryGoal.openingAsk !== context.primaryGoal.rawPrompt ? [
      "Opening request this contract was derived from (as recorded by the Goal pipeline):",
      boundedSection(context.primaryGoal.openingAsk),
    ] : []),
    ...(context.primaryGoal.intentSource ? [
      `Captured objective version ${context.primaryGoal.intentSource.objectiveVersion}; prompt revision ${context.primaryGoal.intentSource.promptRevision}; resolved revision ${context.primaryGoal.intentSource.resolvedPromptRevision}; relationship ${context.primaryGoal.intentSource.relationship ?? "unresolved"}.`,
    ] : []),
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
    "# Evidence availability contract",
    "Completed Check outcomes below come only from upstream Check nodes that receipted this same immutable submission. Their command, exit code, retained output tail, omitted-byte count, HEAD SHA, and attempt identity are evidence. Read the outcome and output together: a detailed passing run can demonstrate behavior, while a bare status cannot.",
    "Submitted text artifacts were digest-bound and frozen into this submission from either a securely staged repository path or a bounded completed-command report. Their UTF-8 content is exact retained evidence; direct command artifacts include the agent-reported command and exit code, while upstream Check evidence is server-observed. Captions are claims to verify against the content. Evidence-only logs do not need to be committed.",
    "A manifest entry carrying capturedInRound and capturedAtRepositoryFingerprint was captured for an earlier submission of this run and carried forward rather than re-collected, so it proves the tree it names and not necessarily this one. Its bytes are the exact original bytes. Judge its staleness yourself: evidence captured against a fingerprint other than this submission's may still be sufficient when the change it demonstrates is untouched, and is worth questioning when the requested fix is in what it shows.",
    "Judge the evidence available at this Persona stage. Pull-request checks, remote CI, and Inspector findings may be later workflow stages, so their absence is not a failure unless the original human intent, operator directive, or published Persona guidance explicitly requires them now.",
    "Criterion coverage declarations are validated by the evidence preflight before this review and are not rendered here, so their presence, absence, or shape is not a Persona concern and is never a reason to fail a submission.",
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
      transcriptOmittedHeadBytes: context.evidence.transcriptOmittedHeadBytes ?? 0,
      transcriptMiddleOmitted: context.evidence.transcriptMiddleOmitted ?? false,
      standardsTruncated: context.evidence.standardsTruncated,
    }),
    ...untrustedJsonBlock("workflow-image-manifest", (context.evidence.images ?? []).map((image) => ({
      id: image.id,
      caption: image.caption,
      displayName: image.displayName,
      repositoryScope: image.repositoryScope,
      mimeType: image.mimeType,
      bytes: image.bytes,
      sha256: image.sha256,
      ...carriedForward(image),
    }))),
    ...untrustedJsonBlock("workflow-check-evidence", checkEvidence),
    ...untrustedJsonBlock("workflow-text-artifact-manifest", (context.evidence.artifacts ?? []).map(
      (artifact) => ({
        id: artifact.id,
        caption: artifact.caption,
        displayName: artifact.displayName,
        repositoryScope: artifact.repositoryScope,
        mimeType: artifact.mimeType,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
        availability: artifact.availability,
        ...carriedForward(artifact),
      }),
    )),
    ...(context.evidence.artifacts ?? []).flatMap((artifact) => [
      ...untrustedJsonBlock(`workflow-text-artifact-${artifact.id}-metadata`, {
        id: artifact.id,
        caption: artifact.caption,
        displayName: artifact.displayName,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
      }),
      ...untrustedBlock(`workflow-text-artifact-${artifact.id}`, artifact.content),
    ]),
    ...untrustedBlock("workflow-diff", context.evidence.diff),
    ...untrustedJsonBlock("workflow-transcript", context.evidence.transcript),
    ...untrustedJsonBlock("workflow-standards", context.evidence.standards),
    "",
    "# Required output",
    "Reply with ONLY one JSON object. A pass must have {\"verdict\":\"pass\",\"summary\":string,\"approvalDetails\":{\"reason\":string,\"evidence\":[EvidenceRef]},\"confidence\":0..1}. A fail must have {\"verdict\":\"fail\",\"summary\":string,\"requestedChanges\":[{\"title\":string,\"rationale\":string,\"evidence\":[EvidenceRef],\"path\"?:string,\"line\"?:integer}],\"confidence\":0..1}, with at least one EvidenceRef for every requested change. EvidenceRef is {\"kind\":\"diff\"|\"transcript\"|\"standard\"|\"goal\"|\"decision\"|\"check\"|\"image\"|\"artifact\",\"quote\":string,\"path\"?:string,\"line\"?:integer}. For Check evidence, path MUST be the immutable attemptId and quote the retained output or outcome fact. For image evidence, path MUST be the stable image id from the manifest, quote is your visual observation, and line must be omitted. For text artifact evidence, path MUST be the stable artifact id from the manifest and line must be omitted. Never use a fail verdict for an infrastructure or evidence-access problem.",
  ].join("\n");
}
