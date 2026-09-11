import { z } from "zod";
import { PersonaVerdictSchema } from "@shared/protocol.ts";
import {
  EVIDENCE_REF_KINDS,
  PERSONA_FINDING_BASES,
  WORKFLOW_EXECUTION_LIMITS,
  type EvidenceRef,
  type PersonaVerdict,
  type RequestedChange,
} from "@shared/workflow.ts";
import { parseModelJson } from "../llm/structured.ts";

// The model-facing shape is intentionally looser only where normalization is safe.
// Structural errors stay parse failures so infrastructure trouble can never turn into a
// Persona fail verdict.
const EvidenceInputSchema = z.object({
  kind: z.enum(EVIDENCE_REF_KINDS),
  quote: z.string(),
  path: z.string().optional(),
  line: z.number().finite().optional(),
});
const RequestedChangeInputSchema = z.object({
  basis: z.enum(PERSONA_FINDING_BASES).optional(),
  title: z.string(),
  rationale: z.string(),
  evidence: z.array(EvidenceInputSchema).min(1),
  path: z.string().optional(),
  line: z.number().finite().optional(),
});
const PersonaVerdictInputSchema = z.discriminatedUnion("verdict", [
  z.object({
    verdict: z.literal("pass"),
    summary: z.string(),
    approvalDetails: z.object({
      reason: z.string(),
      evidence: z.array(EvidenceInputSchema),
    }),
    confidence: z.number().finite(),
  }),
  z.object({
    verdict: z.literal("fail"),
    summary: z.string(),
    requestedChanges: z.array(RequestedChangeInputSchema).min(1),
    confidence: z.number().finite(),
  }),
]);

function clipped(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max);
}

function line(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Math.max(1, Math.min(WORKFLOW_EXECUTION_LIMITS.verdictLine, Math.trunc(value)));
}

function evidenceRef(value: z.infer<typeof EvidenceInputSchema>): EvidenceRef {
  return {
    kind: value.kind,
    quote: clipped(value.quote, WORKFLOW_EXECUTION_LIMITS.verdictReason),
    ...(value.path === undefined
      ? {}
      : { path: clipped(value.path, WORKFLOW_EXECUTION_LIMITS.verdictPath) }),
    ...(line(value.line) === undefined ? {} : { line: line(value.line) }),
  };
}

function requestedChange(value: z.infer<typeof RequestedChangeInputSchema>): RequestedChange {
  return {
    ...(value.basis ? { basis: value.basis } : {}),
    title: clipped(value.title, WORKFLOW_EXECUTION_LIMITS.verdictSummary),
    rationale: clipped(value.rationale, WORKFLOW_EXECUTION_LIMITS.verdictReason),
    evidence: value.evidence
      .slice(0, WORKFLOW_EXECUTION_LIMITS.verdictEvidence)
      .map(evidenceRef),
    ...(value.path === undefined
      ? {}
      : { path: clipped(value.path, WORKFLOW_EXECUTION_LIMITS.verdictPath) }),
    ...(line(value.line) === undefined ? {} : { line: line(value.line) }),
  };
}

/** Normalize bounded scalar/array values while preserving the strict pass/fail union. */
export function normalizePersonaVerdict(
  value: unknown,
  currentImageIds: ReadonlySet<string> = new Set(),
  currentArtifactIds: ReadonlySet<string> = new Set(),
  currentCheckAttemptIds: ReadonlySet<string> = new Set(),
): PersonaVerdict | null {
  const parsed = PersonaVerdictInputSchema.safeParse(value);
  if (!parsed.success) return null;
  const confidence = Math.max(0, Math.min(1, parsed.data.confidence));
  const normalized: PersonaVerdict = parsed.data.verdict === "pass"
    ? {
        verdict: "pass",
        summary: clipped(parsed.data.summary, WORKFLOW_EXECUTION_LIMITS.verdictSummary),
        approvalDetails: {
          reason: clipped(parsed.data.approvalDetails.reason, WORKFLOW_EXECUTION_LIMITS.verdictReason),
          evidence: parsed.data.approvalDetails.evidence
            .slice(0, WORKFLOW_EXECUTION_LIMITS.verdictEvidence)
            .map(evidenceRef),
        },
        confidence,
      }
    : {
        verdict: "fail",
        summary: clipped(parsed.data.summary, WORKFLOW_EXECUTION_LIMITS.verdictSummary),
        requestedChanges: parsed.data.requestedChanges
          .slice(0, WORKFLOW_EXECUTION_LIMITS.verdictChanges)
          .map(requestedChange),
        confidence,
      };
  const strict = PersonaVerdictSchema.safeParse(normalized);
  if (!strict.success) return null;
  const refs = strict.data.verdict === "pass"
    ? strict.data.approvalDetails.evidence
    : strict.data.requestedChanges.flatMap((change) => change.evidence);
  if (refs.some((ref) => ref.kind === "image" && (!ref.path || !currentImageIds.has(ref.path)))) {
    return null;
  }
  if (refs.some((ref) => ref.kind === "artifact" && (!ref.path || !currentArtifactIds.has(ref.path)))) {
    return null;
  }
  if (refs.some((ref) =>
    ref.kind === "check" && (!ref.path || !currentCheckAttemptIds.has(ref.path)))) {
    return null;
  }
  return strict.data;
}

/** Extract and validate model JSON. Null is an infrastructure parse failure, never a fail. */
export function parsePersonaVerdict(
  raw: string,
  currentImageIds: ReadonlySet<string> = new Set(),
  currentArtifactIds: ReadonlySet<string> = new Set(),
  currentCheckAttemptIds: ReadonlySet<string> = new Set(),
): PersonaVerdict | null {
  const input = parseModelJson(raw, PersonaVerdictInputSchema);
  return input
    ? normalizePersonaVerdict(input, currentImageIds, currentArtifactIds, currentCheckAttemptIds)
    : null;
}

export function verdictRequestedChanges(verdict: PersonaVerdict): RequestedChange[] {
  return verdict.verdict === "fail" ? verdict.requestedChanges : [];
}
