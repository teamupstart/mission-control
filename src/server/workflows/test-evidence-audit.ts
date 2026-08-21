import type {
  PersonaSnapshot,
  PersonaVerdict,
  WorkflowCheckEvidence,
  WorkflowContextSnapshot,
  WorkflowSubmission,
} from "@shared/workflow.ts";

export const TEST_EVIDENCE_AUDITOR_PERSONA_ID = "builtin:test-evidence-auditor";

export type TestEvidenceRequestCategory =
  | "visual_artifact"
  | "focused_execution"
  | "downstream_proof"
  | "other";

const VISUAL_REQUEST = /\b(screenshot|screen capture|visual|rendered|pixels?|gif|video|browser view)\b/iu;
const EXECUTION_REQUEST = /\b(test output|command output|terminal output|exit code|actual run|execute|execution|transcript|focused test|focused command|request and response|log excerpt)\b/iu;

const DOWNSTREAM_PROOF = [
  { term: "pull_request", pattern: /\b(pull request|PR attachment|PR check|PR comment)\b/u },
  { term: "remote_ci", pattern: /\b(remote CI|CI result|CI check|GitHub check)\b/iu },
  { term: "inspector", pattern: /\bInspector(?: finding| review| result| evidence)?\b/iu },
  { term: "merge", pattern: /\bmerge(?:d| status| result)?\b/iu },
] as const;

export function isTestEvidenceAuditorPersona(persona: PersonaSnapshot): boolean {
  return persona.sourcePersonaId === TEST_EVIDENCE_AUDITOR_PERSONA_ID
    || persona.name.trim().toLocaleLowerCase() === "test evidence auditor";
}

function verdictRequestText(verdict: PersonaVerdict): string {
  if (verdict.verdict !== "fail") return "";
  return [
    verdict.summary,
    ...verdict.requestedChanges.flatMap((change) => [change.title, change.rationale]),
  ].join("\n");
}

export function testEvidenceRequestCategories(
  verdict: PersonaVerdict,
): TestEvidenceRequestCategory[] {
  if (verdict.verdict !== "fail") return [];
  const text = verdictRequestText(verdict);
  const categories: TestEvidenceRequestCategory[] = [];
  if (VISUAL_REQUEST.test(text)) categories.push("visual_artifact");
  if (EXECUTION_REQUEST.test(text)) categories.push("focused_execution");
  if (DOWNSTREAM_PROOF.some(({ pattern }) => pattern.test(text))) categories.push("downstream_proof");
  if (categories.length === 0) categories.push("other");
  return categories;
}

function originalIntentText(
  context: WorkflowContextSnapshot,
  operatorDirective: string | null,
): string {
  return [
    context.primaryGoal.rawPrompt,
    context.primaryGoal.refined,
    ...context.constraints,
    ...context.acceptanceCriteria,
    ...context.humanDecisions.flatMap((decision) => [decision.decision, decision.rationale]),
    operatorDirective,
  ].filter((value): value is string => typeof value === "string" && value.length > 0).join("\n");
}

/** Structured, bounded facts for measuring evidence readiness and possible audit overreach. */
export function testEvidenceAuditEvent(input: {
  persona: PersonaSnapshot;
  nodeId: string;
  submission: WorkflowSubmission;
  context: WorkflowContextSnapshot;
  verdict: PersonaVerdict;
  checkEvidence: readonly WorkflowCheckEvidence[];
  operatorDirective: string | null;
}): Record<string, unknown> | null {
  if (!isTestEvidenceAuditorPersona(input.persona)) return null;
  const requestText = verdictRequestText(input.verdict);
  const intentText = originalIntentText(input.context, input.operatorDirective);
  const downstreamProofRequests = DOWNSTREAM_PROOF
    .filter(({ pattern }) => pattern.test(requestText))
    .map(({ term, pattern }) => ({
      term,
      explicitInIntent: pattern.test(intentText),
    }));
  return {
    nodeId: input.nodeId,
    submissionId: input.submission.id,
    round: input.submission.round,
    segment: input.submission.segment,
    firstSubmission: input.submission.round === 1 && input.submission.segment === 0,
    outcome: input.verdict.verdict,
    rejectionCategories: testEvidenceRequestCategories(input.verdict),
    evidenceReadiness: {
      imageCount: input.context.evidence.images?.length ?? 0,
      textArtifactCount: input.context.evidence.artifacts?.length ?? 0,
      checkCount: input.checkEvidence.length,
      checkOmittedBytes: input.checkEvidence.reduce((sum, item) => sum + item.omittedBytes, 0),
      transcriptMessageCount: input.context.evidence.transcript.length,
      transcriptTruncated: input.context.evidence.transcriptTruncated,
      transcriptOmittedHeadBytes: input.context.evidence.transcriptOmittedHeadBytes ?? 0,
      transcriptMiddleOmitted: input.context.evidence.transcriptMiddleOmitted ?? false,
    },
    downstreamProofRequests,
    possibleDownstreamProofOverreach: downstreamProofRequests.some(
      (request) => !request.explicitInIntent,
    ),
  };
}
