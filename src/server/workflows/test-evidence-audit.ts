import { createHash } from "node:crypto";
import { z } from "zod";
import { TEST_EVIDENCE_REQUEST_CATEGORIES } from "@shared/workflow.ts";
import type {
  PersonaSnapshot,
  PersonaVerdict,
  TestEvidenceAuditAggregate,
  TestEvidenceAuditRate,
  TestEvidenceAuditSlice,
  TestEvidenceRequestCategory,
  WorkflowCheckEvidence,
  WorkflowContextSnapshot,
  WorkflowSubmission,
  WorkflowVersion,
} from "@shared/workflow.ts";

export const TEST_EVIDENCE_AUDITOR_PERSONA_ID = "builtin:test-evidence-auditor";

/**
 * How many of the newest `test_evidence_audit` events one aggregate reads.
 *
 * A cap rather than a whole-table scan, because this is drawn on a polling settings panel
 * and the event table is the busiest one the workflow subsystem writes. When the cap bites,
 * the aggregate says so (`truncated`) instead of presenting a partial window as the fleet's
 * history - the report's own method depends on knowing which runs were counted.
 */
export const TEST_EVIDENCE_AUDIT_SCAN_LIMIT = 2000;

/** How many guidance slices the aggregate returns. The rest are counted, not hidden. */
export const TEST_EVIDENCE_AUDIT_SLICE_LIMIT = 12;

const VISUAL_REQUEST = /\b(screenshot|screen capture|visual|rendered|pixels?|gif|video|browser view)\b/iu;
const EXECUTION_REQUEST = /\b(test output|command output|terminal output|exit code|actual run|execute|execution|transcript|focused test|focused command|request and response|log excerpt)\b/iu;

const DOWNSTREAM_PROOF = [
  { term: "pull_request", pattern: /\b(pull request|PR attachment|PR check|PR comment)\b/u },
  { term: "remote_ci", pattern: /\b(remote CI|CI result|CI check|GitHub check)\b/iu },
  { term: "inspector", pattern: /\bInspector(?: finding| review| result| evidence)?\b/iu },
  { term: "merge", pattern: /\bmerge(?:d| status| result)?\b/iu },
] as const;

/**
 * The identity of a Persona's guidance, without any of its prose.
 *
 * Twelve hex characters of a SHA-256 over the immutable `guidanceMarkdown` the attempt ran
 * with. It exists so a before/after comparison across guidance revisions is possible at all:
 * `sourceRevision` moves for any Persona edit including ones that never reach the guidance,
 * and the guidance text itself is exactly what must not be copied into a durable telemetry
 * event. A digest is bounded, stable, and says nothing about what the guidance contains.
 */
export function guidanceDigest(guidanceMarkdown: string): string {
  return createHash("sha256").update(guidanceMarkdown, "utf8").digest("hex").slice(0, 12);
}

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

/**
 * Structured, bounded facts for measuring evidence readiness and possible audit overreach.
 *
 * Everything written here is a count, a durable enum, or an identifier. No prompt, diff,
 * transcript, guidance text, verdict prose, operator directive or session content enters the
 * event - the two identity fields added for slicing are a workflow version number and a
 * guidance digest precisely because neither carries any of it.
 */
export function testEvidenceAuditEvent(input: {
  persona: PersonaSnapshot;
  nodeId: string;
  submission: WorkflowSubmission;
  context: WorkflowContextSnapshot;
  verdict: PersonaVerdict;
  checkEvidence: readonly WorkflowCheckEvidence[];
  operatorDirective: string | null;
  /**
   * The published version the attempt ran under, so a rollout can be sliced by revision.
   *
   * Narrowed to the two identity fields rather than taking the whole version: those are the
   * only things that may be written into a durable event, and a `Pick` is what says so at
   * the type level instead of trusting the body not to reach for the graph.
   */
  version: Pick<WorkflowVersion, "workflowId" | "version">;
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
    workflowId: input.version.workflowId,
    workflowVersion: input.version.version,
    guidance: {
      personaId: input.persona.sourcePersonaId,
      revision: input.persona.sourceRevision,
      digest: guidanceDigest(input.persona.guidanceMarkdown),
    },
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

/**
 * One appended event, read back.
 *
 * Deliberately lenient about SHAPE and strict about TYPE. Every identity field is optional
 * because events written before those fields existed are real history and must still be
 * counted; unknown keys are dropped, so a later field added to the writer cannot make an
 * older reader refuse the row. What it will not do is coerce: a payload whose `outcome` is
 * not a verdict, or whose counts are not numbers, is malformed and is reported as such
 * rather than silently contributing a zero to a rate an operator is about to act on.
 */
const AuditRecordSchema = z.object({
  round: z.number().int(),
  segment: z.number().int(),
  firstSubmission: z.boolean(),
  outcome: z.enum(["pass", "fail"]),
  rejectionCategories: z.array(z.enum(TEST_EVIDENCE_REQUEST_CATEGORIES)).default([]),
  evidenceReadiness: z.object({
    imageCount: z.number().int().nonnegative(),
    textArtifactCount: z.number().int().nonnegative(),
    checkCount: z.number().int().nonnegative(),
    checkOmittedBytes: z.number().int().nonnegative(),
    transcriptTruncated: z.boolean(),
    transcriptOmittedHeadBytes: z.number().int().nonnegative().default(0),
  }),
  possibleDownstreamProofOverreach: z.boolean(),
  workflowId: z.string().nullish(),
  workflowVersion: z.number().int().nullish(),
  guidance: z.object({
    personaId: z.string().nullish(),
    revision: z.number().int().nullish(),
    digest: z.string().nullish(),
  }).nullish(),
});

export type TestEvidenceAuditRecord = z.infer<typeof AuditRecordSchema>;

/** One stored event as the aggregate reads it: run identity, when, and the raw payload. */
export interface TestEvidenceAuditEventRow {
  runId: string;
  timestamp: number;
  payload: unknown;
}

function rate(count: number, total: number): TestEvidenceAuditRate {
  return { count, total, rate: total === 0 ? null : count / total };
}

/** The identity a slice is grouped by, as one key, with unknown fields kept distinguishable. */
function sliceKey(record: TestEvidenceAuditRecord): string {
  return JSON.stringify([
    record.workflowId ?? null,
    record.workflowVersion ?? null,
    record.guidance?.personaId ?? null,
    record.guidance?.revision ?? null,
    record.guidance?.digest ?? null,
  ]);
}

interface SliceAccumulator {
  slice: TestEvidenceAuditSlice;
  firstSubmissions: number;
  firstAccepted: number;
  failures: number;
}

/**
 * What a window of `test_evidence_audit` events says about the built-in auditor.
 *
 * Pure over the rows it is handed, so the arithmetic every number on the panel rests on is
 * testable without a database, a daemon or a model call - including the case that matters
 * most on a fresh install, which is no events at all. That case returns zeroed counts and
 * NULL rates throughout: an install that has never run the auditor must not read as one
 * whose first-pass acceptance is 0%.
 *
 * Denominators are chosen to match the report's method rather than to be convenient.
 * First-pass acceptance is over first submissions only (round 1, segment 0); the attempt
 * failure rate and possible-overreach rate are over every attempt; rejection categories are
 * over FAILING attempts and overlap, because one verdict can ask for a screenshot and a test
 * transcript at once; and readiness adoption is over first submissions, since a repair round
 * that finally attaches a screenshot says nothing about how ready the first packet was.
 */
export function aggregateTestEvidenceAudit(
  rows: readonly TestEvidenceAuditEventRow[],
  window: { scanLimit: number; truncated: boolean },
): TestEvidenceAuditAggregate {
  const runs = new Set<string>();
  const slices = new Map<string, SliceAccumulator>();
  const categories = new Map<TestEvidenceRequestCategory, number>();
  let malformed = 0;
  let attempts = 0;
  let failures = 0;
  let overreach = 0;
  let firstSubmissions = 0;
  let firstAccepted = 0;
  let withoutImages = 0;
  let withoutArtifacts = 0;
  let withoutChecks = 0;
  let transcriptTruncated = 0;
  let checkOmittedBytes = 0;
  let transcriptOmittedHeadBytes = 0;
  let oldestAt: number | null = null;
  let newestAt: number | null = null;

  for (const row of rows) {
    const parsed = AuditRecordSchema.safeParse(row.payload);
    if (!parsed.success) {
      malformed += 1;
      continue;
    }
    const record = parsed.data;
    attempts += 1;
    runs.add(row.runId);
    oldestAt = oldestAt === null ? row.timestamp : Math.min(oldestAt, row.timestamp);
    newestAt = newestAt === null ? row.timestamp : Math.max(newestAt, row.timestamp);
    const failed = record.outcome === "fail";
    if (failed) {
      failures += 1;
      // A category set is deduplicated before counting: the writer does not repeat one, and
      // a future one that did would otherwise push a share above 100%.
      for (const category of new Set(record.rejectionCategories)) {
        categories.set(category, (categories.get(category) ?? 0) + 1);
      }
    }
    if (record.possibleDownstreamProofOverreach) overreach += 1;
    if (record.firstSubmission) {
      firstSubmissions += 1;
      if (!failed) firstAccepted += 1;
      const readiness = record.evidenceReadiness;
      if (readiness.imageCount === 0) withoutImages += 1;
      if (readiness.textArtifactCount === 0) withoutArtifacts += 1;
      if (readiness.checkCount === 0) withoutChecks += 1;
      if (readiness.transcriptTruncated) transcriptTruncated += 1;
      checkOmittedBytes += readiness.checkOmittedBytes;
      transcriptOmittedHeadBytes += readiness.transcriptOmittedHeadBytes;
    }
    const key = sliceKey(record);
    const accumulator = slices.get(key) ?? {
      slice: {
        workflowId: record.workflowId ?? null,
        workflowVersion: record.workflowVersion ?? null,
        personaId: record.guidance?.personaId ?? null,
        personaRevision: record.guidance?.revision ?? null,
        guidanceDigest: record.guidance?.digest ?? null,
        attempts: 0,
        firstSubmissionAccepted: rate(0, 0),
        attemptFailures: rate(0, 0),
      },
      firstSubmissions: 0,
      firstAccepted: 0,
      failures: 0,
    };
    accumulator.slice.attempts += 1;
    if (failed) accumulator.failures += 1;
    if (record.firstSubmission) {
      accumulator.firstSubmissions += 1;
      if (!failed) accumulator.firstAccepted += 1;
    }
    slices.set(key, accumulator);
  }

  const ordered = [...slices.values()]
    .map((accumulator) => ({
      ...accumulator.slice,
      firstSubmissionAccepted: rate(accumulator.firstAccepted, accumulator.firstSubmissions),
      attemptFailures: rate(accumulator.failures, accumulator.slice.attempts),
    }))
    .sort((left, right) => right.attempts - left.attempts
      || (right.workflowVersion ?? -1) - (left.workflowVersion ?? -1)
      || (left.guidanceDigest ?? "").localeCompare(right.guidanceDigest ?? ""));

  return {
    attempts,
    runs: runs.size,
    attemptsPerRun: runs.size === 0 ? null : attempts / runs.size,
    malformed,
    truncated: window.truncated,
    scanLimit: window.scanLimit,
    oldestAt,
    newestAt,
    firstSubmissionAccepted: rate(firstAccepted, firstSubmissions),
    attemptFailures: rate(failures, attempts),
    rejectionCategories: TEST_EVIDENCE_REQUEST_CATEGORIES.map((category) => ({
      category,
      failures: rate(categories.get(category) ?? 0, failures),
    })),
    readiness: {
      withoutImages: rate(withoutImages, firstSubmissions),
      withoutTextArtifacts: rate(withoutArtifacts, firstSubmissions),
      withoutChecks: rate(withoutChecks, firstSubmissions),
      transcriptTruncated: rate(transcriptTruncated, firstSubmissions),
      checkOmittedBytes,
      transcriptOmittedHeadBytes,
    },
    possibleOverreach: rate(overreach, attempts),
    slices: ordered.slice(0, TEST_EVIDENCE_AUDIT_SLICE_LIMIT),
    slicesOmitted: Math.max(0, ordered.length - TEST_EVIDENCE_AUDIT_SLICE_LIMIT),
  };
}
