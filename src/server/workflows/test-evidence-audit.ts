import { createHash } from "node:crypto";
import { z } from "zod";
import {
  TEST_EVIDENCE_AUDITOR_PERSONA_ID,
  TEST_EVIDENCE_REQUEST_CATEGORIES,
  WORKFLOW_EVIDENCE_PROOF_CLASSES,
  WORKFLOW_EVIDENCE_PROOF_ROLES,
  WORKFLOW_EVIDENCE_READINESS_GAP_CODES,
  WORKFLOW_EVIDENCE_READINESS_POLICIES,
  WORKFLOW_EVIDENCE_READINESS_STATUSES,
} from "@shared/workflow.ts";
import type {
  PersonaSnapshot,
  PersonaVerdict,
  TestEvidenceAuditAggregate,
  TestEvidenceAuditRate,
  TestEvidenceAuditSlice,
  TestEvidenceReadinessCategoryCount,
  TestEvidenceReadinessScopeCategory,
  TestEvidenceReadinessSlice,
  TestEvidenceRequestCategory,
  WorkflowCheckEvidence,
  WorkflowContextSnapshot,
  WorkflowEvidenceCoverageClaim,
  WorkflowEvidenceProofClass,
  WorkflowEvidenceProofRole,
  WorkflowEvidenceReadinessGapCode,
  WorkflowEvidenceReadinessResult,
  WorkflowJson,
  WorkflowNodeAttempt,
  WorkflowSubmission,
  WorkflowVersion,
} from "@shared/workflow.ts";

export { TEST_EVIDENCE_AUDITOR_PERSONA_ID };

export const TEST_EVIDENCE_AUDIT_SCAN_LIMIT = 2000;
export const TEST_EVIDENCE_AUDIT_SLICE_LIMIT = 12;
export const TEST_EVIDENCE_PREFLIGHT_EVENT_KINDS = [
  "evidence_readiness_evaluated",
  "evidence_preflight_refinement_reserved",
  "evidence_readiness_overridden",
] as const;

const VISUAL_REQUEST = /\b(screenshot|screen capture|visual|rendered|pixels?|gif|video|browser view)\b/iu;
const EXECUTION_REQUEST = /\b(test output|command output|terminal output|exit code|actual run|execute|execution|transcript|focused test|focused command|request and response|log excerpt)\b/iu;
const DOWNSTREAM_PROOF = [
  { term: "pull_request", pattern: /\b(pull request|PR attachment|PR check|PR comment)\b/u },
  { term: "remote_ci", pattern: /\b(remote CI|CI result|CI check|GitHub check)\b/iu },
  { term: "inspector", pattern: /\bInspector(?: finding| review| result| evidence)?\b/iu },
  { term: "merge", pattern: /\bmerge(?:d| status| result)?\b/iu },
] as const;

const MISSING_ROLES: Partial<Record<WorkflowEvidenceReadinessGapCode, WorkflowEvidenceProofRole[]>> = {
  missing_execution: ["execution"],
  missing_rendered_output: ["rendered_output"],
  missing_baseline_measurement: ["baseline_measurement"],
  missing_result_measurement: ["result_measurement"],
  missing_deliverable_or_rendered_output: ["deliverable", "rendered_output"],
  missing_state_snapshot: ["state_snapshot"],
};

export function guidanceDigest(guidanceMarkdown: string): string {
  return createHash("sha256").update(guidanceMarkdown, "utf8").digest("hex").slice(0, 12);
}

/** Opaque correlation only. The underlying database identity never enters telemetry payloads. */
export function evidenceTelemetryKey(kind: "submission" | "attempt", id: string): string {
  return createHash("sha256").update(`workflow-${kind}:${id}`, "utf8").digest("hex").slice(0, 24);
}

function evidenceTelemetryEventId(kind: "readiness" | "audit", id: string): string {
  const source = kind === "audit" ? "attempt" : "submission";
  return `${kind}:${evidenceTelemetryKey(source, id)}`;
}

export function isTestEvidenceAuditorPersona(persona: PersonaSnapshot): boolean {
  return persona.sourcePersonaId === TEST_EVIDENCE_AUDITOR_PERSONA_ID
    || persona.name.trim().toLocaleLowerCase() === "test evidence auditor";
}

/** Durable semantic identity: infrastructure retries are not completed Auditor attempts. */
export function isFirstCompletedTestEvidenceAuditorAttempt(
  attempts: readonly WorkflowNodeAttempt[],
  currentAttemptId: string,
): boolean {
  const completed = attempts.filter((attempt) =>
    attempt.state === "completed"
    && attempt.persona !== null
    && isTestEvidenceAuditorPersona(attempt.persona));
  return completed.length === 1 && completed[0]?.id === currentAttemptId;
}

function verdictRequestText(verdict: PersonaVerdict): string {
  if (verdict.verdict !== "fail") return "";
  return [
    verdict.summary,
    ...verdict.requestedChanges.flatMap((change) => [change.title, change.rationale]),
  ].join("\n");
}

export function testEvidenceRequestCategories(verdict: PersonaVerdict): TestEvidenceRequestCategory[] {
  if (verdict.verdict !== "fail") return [];
  const text = verdictRequestText(verdict);
  const categories: TestEvidenceRequestCategory[] = [];
  if (VISUAL_REQUEST.test(text)) categories.push("visual_artifact");
  if (EXECUTION_REQUEST.test(text)) categories.push("focused_execution");
  if (DOWNSTREAM_PROOF.some(({ pattern }) => pattern.test(text))) categories.push("downstream_proof");
  if (categories.length === 0) categories.push("other");
  return categories;
}

function originalIntentText(context: WorkflowContextSnapshot, operatorDirective: string | null): string {
  return [
    context.primaryGoal.rawPrompt,
    context.primaryGoal.refined,
    ...context.constraints,
    ...context.acceptanceCriteria,
    ...context.humanDecisions.flatMap((decision) => [decision.decision, decision.rationale]),
    operatorDirective,
  ].filter((value): value is string => typeof value === "string" && value.length > 0).join("\n");
}

function scopeCategory(
  coverage: readonly Pick<WorkflowEvidenceCoverageClaim, "repositoryScope">[],
): TestEvidenceReadinessScopeCategory {
  const hasAll = coverage.some((claim) => claim.repositoryScope === "all");
  const hasRepository = coverage.some((claim) => claim.repositoryScope !== "all");
  if (hasAll && hasRepository) return "mixed";
  if (hasAll) return "all";
  if (hasRepository) return "repository";
  return "none";
}

function categoryCounts<T extends string>(values: readonly T[]): Array<{ category: T; count: number }> {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([category, count]) => ({ category, count }));
}

/** A capture-time structural fact containing only counts, enums, versions, and opaque identity. */
export function evidenceReadinessEvaluatedEvent(input: {
  submission: WorkflowSubmission;
  readiness: WorkflowEvidenceReadinessResult | null;
  coverage: readonly WorkflowEvidenceCoverageClaim[];
  version: Pick<WorkflowVersion, "workflowId" | "version" | "evidenceReadinessPolicy">;
}): { eventId: string; payload: WorkflowJson } {
  const gapCriteria = input.readiness?.criteria.filter((criterion) => criterion.gaps.length > 0) ?? [];
  const gapCodes = gapCriteria.flatMap((criterion) => criterion.gaps);
  const proofClasses = gapCriteria.flatMap((criterion) =>
    criterion.authorProofClass === null ? [] : [criterion.authorProofClass]);
  const missingRoles = gapCodes.flatMap((gap) => MISSING_ROLES[gap] ?? []);
  return {
    eventId: evidenceTelemetryEventId("readiness", input.submission.id),
    payload: {
      submissionKey: evidenceTelemetryKey("submission", input.submission.id),
      policy: input.version.evidenceReadinessPolicy,
      evaluatorVersion: input.readiness?.evaluatorVersion ?? null,
      status: input.readiness?.status ?? "not_evaluated",
      round: input.submission.round,
      segment: input.submission.segment,
      refinementReason: input.submission.refinementReason ?? null,
      criteriaCount: input.readiness?.criteria.length ?? 0,
      mappedClaimCount: input.readiness?.criteria.filter(
        (criterion) => criterion.matchedClientCriterionId !== null,
      ).length ?? 0,
      warningCount: input.readiness?.criteria.reduce(
        (sum, criterion) => sum + criterion.warnings.length,
        0,
      ) ?? 0,
      gapCount: gapCodes.length,
      gapCodes: categoryCounts(gapCodes),
      proofClasses: categoryCounts(proofClasses),
      missingRoles: categoryCounts(missingRoles),
      override: input.readiness?.status === "overridden",
      workflowId: input.version.workflowId,
      workflowVersion: input.version.version,
      repositoryScope: scopeCategory(input.coverage),
    },
  };
}

/** One completed semantic Auditor attempt and its activation-time readiness snapshot. */
export function testEvidenceAuditEvent(input: {
  persona: PersonaSnapshot;
  nodeId: string;
  attemptId: string;
  firstAuditorAttempt: boolean;
  submission: WorkflowSubmission;
  context: WorkflowContextSnapshot;
  verdict: PersonaVerdict;
  checkEvidence: readonly WorkflowCheckEvidence[];
  operatorDirective: string | null;
  version: Pick<WorkflowVersion, "workflowId" | "version" | "evidenceReadinessPolicy">;
}): { eventId: string; payload: WorkflowJson } | null {
  if (!isTestEvidenceAuditorPersona(input.persona)) return null;
  const requestText = verdictRequestText(input.verdict);
  const intentText = originalIntentText(input.context, input.operatorDirective);
  const downstreamProofRequests = DOWNSTREAM_PROOF
    .filter(({ pattern }) => pattern.test(requestText))
    .map(({ term, pattern }) => ({ term, explicitInIntent: pattern.test(intentText) }));
  return {
    eventId: evidenceTelemetryEventId("audit", input.attemptId),
    payload: {
      nodeId: input.nodeId,
      submissionKey: evidenceTelemetryKey("submission", input.submission.id),
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
      firstAuditorAttempt: input.firstAuditorAttempt,
      readinessSnapshot: {
        policy: input.version.evidenceReadinessPolicy,
        evaluatorVersion: input.submission.readiness?.evaluatorVersion ?? null,
        status: input.submission.readiness?.status ?? "not_evaluated",
      },
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
    },
  };
}

const ReadinessSnapshotSchema = z.object({
  policy: z.enum(WORKFLOW_EVIDENCE_READINESS_POLICIES),
  evaluatorVersion: z.string().max(100).nullish(),
  status: z.enum(WORKFLOW_EVIDENCE_READINESS_STATUSES),
});

const AuditRecordSchema = z.object({
  round: z.number().int(),
  segment: z.number().int(),
  firstSubmission: z.boolean(),
  firstAuditorAttempt: z.boolean().optional(),
  submissionKey: z.string().max(100).optional(),
  readinessSnapshot: ReadinessSnapshotSchema.optional(),
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

const counted = <T extends readonly [string, ...string[]]>(values: T) => z.object({
  category: z.enum(values),
  count: z.number().int().nonnegative(),
});

const ReadinessEvaluationRecordSchema = z.object({
  submissionKey: z.string().max(100),
  policy: z.enum(WORKFLOW_EVIDENCE_READINESS_POLICIES),
  evaluatorVersion: z.string().max(100).nullish(),
  status: z.enum(WORKFLOW_EVIDENCE_READINESS_STATUSES),
  round: z.number().int().positive(),
  segment: z.number().int().nonnegative(),
  refinementReason: z.enum(["session_action", "evidence_preflight"]).nullish(),
  criteriaCount: z.number().int().nonnegative(),
  mappedClaimCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),
  gapCount: z.number().int().nonnegative(),
  gapCodes: z.array(counted(WORKFLOW_EVIDENCE_READINESS_GAP_CODES)),
  proofClasses: z.array(counted(WORKFLOW_EVIDENCE_PROOF_CLASSES)),
  missingRoles: z.array(counted(WORKFLOW_EVIDENCE_PROOF_ROLES)),
  override: z.boolean(),
  workflowId: z.string().nullish(),
  workflowVersion: z.number().int().nullish(),
  repositoryScope: z.enum(["none", "repository", "all", "mixed"]),
});

export type TestEvidenceAuditRecord = z.infer<typeof AuditRecordSchema>;

export interface TestEvidenceAuditEventRow {
  runId: string;
  timestamp: number;
  payload: unknown;
}

export interface TestEvidencePreflightEventRow extends TestEvidenceAuditEventRow {
  eventId: string | null;
  kind: (typeof TEST_EVIDENCE_PREFLIGHT_EVENT_KINDS)[number];
}

function rate(count: number, total: number): TestEvidenceAuditRate {
  return { count, total, rate: total === 0 ? null : count / total };
}

function sliceKey(record: TestEvidenceAuditRecord): string {
  return JSON.stringify([
    record.workflowId ?? null,
    record.workflowVersion ?? null,
    record.guidance?.personaId ?? null,
    record.guidance?.digest ?? null,
  ]);
}

interface SliceAccumulator {
  slice: TestEvidenceAuditSlice;
  firstAuditorAttempts: number;
  firstAuditorAccepted: number;
  firstSubmissions: number;
  firstAccepted: number;
  failures: number;
}

interface ReadinessCategoryAccumulator<T extends string> {
  category: T;
  occurrences: number;
  evaluations: Set<string>;
}

function addReadinessCategories<T extends string>(
  target: Map<T, ReadinessCategoryAccumulator<T>>,
  categories: readonly { category: T; count: number }[],
  evaluationKey: string,
): void {
  for (const item of new Map(categories.map((entry) => [entry.category, entry])).values()) {
    const value = target.get(item.category) ?? {
      category: item.category,
      occurrences: 0,
      evaluations: new Set<string>(),
    };
    value.occurrences += item.count;
    value.evaluations.add(evaluationKey);
    target.set(item.category, value);
  }
}

function finishReadinessCategories<T extends string>(
  source: Map<T, ReadinessCategoryAccumulator<T>>,
  interceptedEvaluations: number,
): TestEvidenceReadinessCategoryCount<T>[] {
  return [...source.values()]
    .map((item) => ({
      category: item.category,
      occurrences: item.occurrences,
      affectedEvaluations: rate(item.evaluations.size, interceptedEvaluations),
    }))
    .sort((left, right) => right.occurrences - left.occurrences
      || left.category.localeCompare(right.category));
}

function preflightSubmissionCorrelationKey(runId: string, submissionKey: string): string {
  return JSON.stringify([runId, submissionKey]);
}

function matchedLifecycleRunCount(
  lifecycleSubmissionKeys: ReadonlySet<string>,
  interceptedSubmissionRuns: ReadonlyMap<string, string>,
): number {
  const runs = new Set<string>();
  for (const key of lifecycleSubmissionKeys) {
    const runId = interceptedSubmissionRuns.get(key);
    if (runId !== undefined) runs.add(runId);
  }
  return runs.size;
}

export function aggregateTestEvidenceAudit(
  rows: readonly TestEvidenceAuditEventRow[],
  window: { scanLimit: number; truncated: boolean },
  preflightRows: readonly TestEvidencePreflightEventRow[] = [],
  preflightWindow: { truncated: boolean } = { truncated: false },
): TestEvidenceAuditAggregate {
  const runs = new Set<string>();
  const slices = new Map<string, SliceAccumulator>();
  const categories = new Map<TestEvidenceRequestCategory, number>();
  let malformed = 0;
  let attempts = 0;
  let failures = 0;
  let overreach = 0;
  let firstAuditorKnown = 0;
  let firstAuditorUnknown = 0;
  let firstAuditorAttempts = 0;
  let firstAuditorAccepted = 0;
  let firstSubmissions = 0;
  let firstAccepted = 0;
  let postReadyTotal = 0;
  let postReadyRejected = 0;
  let postOverrideTotal = 0;
  let postOverrideRejected = 0;
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
      for (const category of new Set(record.rejectionCategories)) {
        categories.set(category, (categories.get(category) ?? 0) + 1);
      }
    }
    if (record.possibleDownstreamProofOverreach) overreach += 1;
    if (record.firstAuditorAttempt === undefined) firstAuditorUnknown += 1;
    else {
      firstAuditorKnown += 1;
      if (record.firstAuditorAttempt) {
        firstAuditorAttempts += 1;
        if (!failed) firstAuditorAccepted += 1;
        if (record.readinessSnapshot?.status === "ready") {
          postReadyTotal += 1;
          if (failed) postReadyRejected += 1;
        }
        if (record.readinessSnapshot?.status === "overridden") {
          postOverrideTotal += 1;
          if (failed) postOverrideRejected += 1;
        }
      }
    }
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
        firstAuditorAttemptAccepted: rate(0, 0),
        firstAuditorAttemptUnknown: 0,
        firstSubmissionAccepted: rate(0, 0),
        attemptFailures: rate(0, 0),
      },
      firstAuditorAttempts: 0,
      firstAuditorAccepted: 0,
      firstSubmissions: 0,
      firstAccepted: 0,
      failures: 0,
    };
    const revision = record.guidance?.revision ?? null;
    if (revision !== null
      && (accumulator.slice.personaRevision === null || revision > accumulator.slice.personaRevision)) {
      accumulator.slice.personaRevision = revision;
    }
    accumulator.slice.attempts += 1;
    if (failed) accumulator.failures += 1;
    if (record.firstAuditorAttempt === undefined) accumulator.slice.firstAuditorAttemptUnknown += 1;
    else if (record.firstAuditorAttempt) {
      accumulator.firstAuditorAttempts += 1;
      if (!failed) accumulator.firstAuditorAccepted += 1;
    }
    if (record.firstSubmission) {
      accumulator.firstSubmissions += 1;
      if (!failed) accumulator.firstAccepted += 1;
    }
    slices.set(key, accumulator);
  }

  const ordered = [...slices.values()]
    .map((item) => ({
      ...item.slice,
      firstAuditorAttemptAccepted: rate(item.firstAuditorAccepted, item.firstAuditorAttempts),
      firstSubmissionAccepted: rate(item.firstAccepted, item.firstSubmissions),
      attemptFailures: rate(item.failures, item.slice.attempts),
    }))
    .sort((left, right) => right.attempts - left.attempts
      || (right.workflowVersion ?? -1) - (left.workflowVersion ?? -1)
      || (left.guidanceDigest ?? "").localeCompare(right.guidanceDigest ?? ""));

  const seenEventIds = new Set<string>();
  const interceptedRuns = new Set<string>();
  const interceptedSubmissionRuns = new Map<string, string>();
  const refinedSubmissionKeys = new Set<string>();
  const overriddenSubmissionKeys = new Set<string>();
  const readinessSlices = new Map<string, {
    slice: TestEvidenceReadinessSlice;
    enforcing: number;
    interceptions: number;
    unavailable: number;
  }>();
  const gapCounts = new Map<WorkflowEvidenceReadinessGapCode, ReadinessCategoryAccumulator<WorkflowEvidenceReadinessGapCode>>();
  const proofClassCounts = new Map<WorkflowEvidenceProofClass, ReadinessCategoryAccumulator<WorkflowEvidenceProofClass>>();
  const missingRoleCounts = new Map<WorkflowEvidenceProofRole, ReadinessCategoryAccumulator<WorkflowEvidenceProofRole>>();
  let preflightMalformed = 0;
  let evaluations = 0;
  let enforcingEvaluations = 0;
  let interceptions = 0;
  let unavailable = 0;

  for (const [index, row] of preflightRows.entries()) {
    if (row.eventId && seenEventIds.has(row.eventId)) continue;
    if (row.eventId) seenEventIds.add(row.eventId);
    switch (row.kind) {
      case "evidence_preflight_refinement_reserved": {
        const parsed = z.object({
          parentSubmissionId: z.string().min(1),
          round: z.number().int().positive(),
          segment: z.number().int().positive(),
        }).safeParse(row.payload);
        if (!parsed.success) preflightMalformed += 1;
        else {
          refinedSubmissionKeys.add(preflightSubmissionCorrelationKey(
            row.runId,
            evidenceTelemetryKey("submission", parsed.data.parentSubmissionId),
          ));
        }
        continue;
      }
      case "evidence_readiness_overridden": {
        const parsed = z.object({
          submissionId: z.string().min(1),
          acknowledgedRisk: z.literal(true),
        }).safeParse(row.payload);
        if (!parsed.success) preflightMalformed += 1;
        else {
          overriddenSubmissionKeys.add(preflightSubmissionCorrelationKey(
            row.runId,
            evidenceTelemetryKey("submission", parsed.data.submissionId),
          ));
        }
        continue;
      }
      case "evidence_readiness_evaluated": {
        const parsed = ReadinessEvaluationRecordSchema.safeParse(row.payload);
        if (!parsed.success) {
          preflightMalformed += 1;
          continue;
        }
        const record = parsed.data;
        evaluations += 1;
        const enforcing = record.policy === "criterion_mapped_v1";
        const intercepted = enforcing && record.status === "gaps";
        if (enforcing) enforcingEvaluations += 1;
        if (intercepted) {
          interceptions += 1;
          interceptedRuns.add(row.runId);
          interceptedSubmissionRuns.set(
            preflightSubmissionCorrelationKey(row.runId, record.submissionKey),
            row.runId,
          );
          const evaluationKey = row.eventId ?? `${row.runId}:${row.timestamp}:${index}`;
          addReadinessCategories(gapCounts, record.gapCodes, evaluationKey);
          addReadinessCategories(proofClassCounts, record.proofClasses, evaluationKey);
          addReadinessCategories(missingRoleCounts, record.missingRoles, evaluationKey);
        }
        if (enforcing && record.status === "unavailable") unavailable += 1;
        const key = JSON.stringify([
          record.workflowId ?? null,
          record.workflowVersion ?? null,
          record.evaluatorVersion ?? null,
        ]);
        const accumulator = readinessSlices.get(key) ?? {
          slice: {
            workflowId: record.workflowId ?? null,
            workflowVersion: record.workflowVersion ?? null,
            evaluatorVersion: record.evaluatorVersion ?? null,
            evaluations: 0,
            interceptions: rate(0, 0),
            unavailable: rate(0, 0),
          },
          enforcing: 0,
          interceptions: 0,
          unavailable: 0,
        };
        accumulator.slice.evaluations += 1;
        if (enforcing) accumulator.enforcing += 1;
        if (intercepted) accumulator.interceptions += 1;
        if (enforcing && record.status === "unavailable") accumulator.unavailable += 1;
        readinessSlices.set(key, accumulator);
        continue;
      }
      default: {
        const _exhaustive: never = row.kind;
        preflightMalformed += 1;
        continue;
      }
    }
  }

  const readinessOrdered = [...readinessSlices.values()]
    .map((item) => ({
      ...item.slice,
      interceptions: rate(item.interceptions, item.enforcing),
      unavailable: rate(item.unavailable, item.enforcing),
    }))
    .sort((left, right) => right.evaluations - left.evaluations
      || (right.workflowVersion ?? -1) - (left.workflowVersion ?? -1)
      || (left.evaluatorVersion ?? "").localeCompare(right.evaluatorVersion ?? ""));
  const interceptedRunCount = interceptedRuns.size;

  return {
    attempts,
    runs: runs.size,
    attemptsPerRun: runs.size === 0 ? null : attempts / runs.size,
    malformed,
    truncated: window.truncated,
    scanLimit: window.scanLimit,
    oldestAt,
    newestAt,
    firstAuditorAttemptAccepted: rate(firstAuditorAccepted, firstAuditorAttempts),
    firstAuditorAttemptKnown: firstAuditorKnown,
    firstAuditorAttemptUnknown: firstAuditorUnknown,
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
    postReadyAuditorRejections: rate(postReadyRejected, postReadyTotal),
    postOverrideAuditorRejections: rate(postOverrideRejected, postOverrideTotal),
    preflight: {
      evaluations,
      enforcingEvaluations,
      malformed: preflightMalformed,
      truncated: preflightWindow.truncated,
      interceptions: rate(interceptions, enforcingEvaluations),
      sameRoundRefinements: rate(
        matchedLifecycleRunCount(refinedSubmissionKeys, interceptedSubmissionRuns),
        interceptedRunCount,
      ),
      overrides: rate(
        matchedLifecycleRunCount(overriddenSubmissionKeys, interceptedSubmissionRuns),
        interceptedRunCount,
      ),
      unavailable: rate(unavailable, enforcingEvaluations),
      gapCodes: finishReadinessCategories(gapCounts, interceptions),
      proofClasses: finishReadinessCategories(proofClassCounts, interceptions),
      missingRoles: finishReadinessCategories(missingRoleCounts, interceptions),
      slices: readinessOrdered.slice(0, TEST_EVIDENCE_AUDIT_SLICE_LIMIT),
      slicesOmitted: Math.max(0, readinessOrdered.length - TEST_EVIDENCE_AUDIT_SLICE_LIMIT),
    },
    slices: ordered.slice(0, TEST_EVIDENCE_AUDIT_SLICE_LIMIT),
    slicesOmitted: Math.max(0, ordered.length - TEST_EVIDENCE_AUDIT_SLICE_LIMIT),
  };
}
