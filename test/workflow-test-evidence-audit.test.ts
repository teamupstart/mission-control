import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  PersonaSnapshot,
  PersonaVerdict,
  WorkflowContextSnapshot,
  WorkflowEvidenceCoverageClaim,
  WorkflowEvidenceReadinessResult,
  WorkflowNodeAttempt,
  WorkflowSubmission,
} from "../src/shared/workflow.ts";
import {
  aggregateTestEvidenceAudit,
  evidenceReadinessEvaluatedEvent,
  evidenceTelemetryKey,
  guidanceDigest,
  isFirstCompletedTestEvidenceAuditorAttempt,
  testEvidenceAuditEvent,
  testEvidenceRequestCategories,
  type TestEvidenceAuditEventRow,
  type TestEvidencePreflightEventRow,
} from "../src/server/workflows/test-evidence-audit.ts";

const persona: PersonaSnapshot = {
  sourcePersonaId: "builtin:test-evidence-auditor",
  sourceRevision: 1,
  name: "Test Evidence Auditor",
  description: "",
  guidanceMarkdown: "Review evidence.",
  runner: null,
  model: null,
};

const context: WorkflowContextSnapshot = {
  primaryGoal: { rawPrompt: "Show the UI behavior working", refined: null, sourceNoteKey: "note" },
  humanDecisions: [],
  constraints: [],
  acceptanceCriteria: [],
  priorPersonaFeedback: [],
  session: { agent: "codex", name: "work", cwd: "/repo", branch: "feature" },
  evidence: {
    headSha: "abc",
    diffFingerprint: "diff",
    diff: "patch",
    diffTruncated: false,
    workingTreeDirty: true,
    workingTreeStatus: [],
    workingTreeStatusTruncated: false,
    transcript: [{ role: "assistant", content: "Implemented and tested." }],
    transcriptAnchor: null,
    transcriptTruncated: true,
    transcriptOmittedHeadBytes: 900,
    standards: [],
    standardsTruncated: false,
    images: [],
    artifacts: [],
  },
  compaction: { status: "fallback", runner: null, model: null, error: null },
};

const submission = {
  id: "submission",
  runId: "run",
  round: 1,
  segment: 0,
  parentSubmissionId: null,
  continuationNodeId: null,
  continuationNodeAttemptId: null,
  mode: "full_workflow",
  triggerSource: "manual",
  triggerKey: "trigger",
  evidenceFingerprint: "fingerprint",
  context: {},
  evidence: {},
  prHeadSha: null,
  status: "running",
  createdAt: 1,
  updatedAt: 1,
  completedAt: null,
} satisfies WorkflowSubmission;

/** Only the two identifiers the event may carry; the guidance digest comes from the persona. */
const version = {
  workflowId: "workflow-review",
  version: 8,
  evidenceReadinessPolicy: "criterion_mapped_v1" as const,
};

const verdict: PersonaVerdict = {
  verdict: "fail",
  summary: "The proof is unavailable",
  requestedChanges: [{
    title: "Attach a screenshot and remote CI result",
    rationale: "Show rendered pixels and actual command output with an exit code.",
    evidence: [{ kind: "transcript", quote: "Implemented and tested." }],
  }],
  confidence: 1,
};

test("Test Evidence telemetry classifies readiness gaps and flags downstream proof overreach", () => {
  assert.deepEqual(testEvidenceRequestCategories(verdict), [
    "visual_artifact",
    "focused_execution",
    "downstream_proof",
  ]);
  const event = testEvidenceAuditEvent({
    persona,
    nodeId: "auditor",
    attemptId: "attempt-1",
    firstAuditorAttempt: true,
    submission,
    context,
    verdict,
    checkEvidence: [],
    operatorDirective: null,
    version,
  });
  assert.ok(event);
  const payload = event.payload as Record<string, unknown>;
  assert.equal(payload.possibleDownstreamProofOverreach, true);
  assert.deepEqual(payload.downstreamProofRequests, [{ term: "remote_ci", explicitInIntent: false }]);
  assert.deepEqual(payload.evidenceReadiness, {
    imageCount: 0,
    textArtifactCount: 0,
    checkCount: 0,
    checkOmittedBytes: 0,
    transcriptMessageCount: 1,
    transcriptTruncated: true,
    transcriptOmittedHeadBytes: 900,
    transcriptMiddleOmitted: false,
  });
});

test("an explicit human request for downstream proof is recorded without an overreach flag", () => {
  const event = testEvidenceAuditEvent({
    persona,
    nodeId: "auditor",
    attemptId: "attempt-2",
    firstAuditorAttempt: true,
    submission,
    context: {
      ...context,
      acceptanceCriteria: ["Include the remote CI result in the evidence."],
    },
    verdict,
    checkEvidence: [],
    operatorDirective: null,
    version,
  });
  assert.ok(event);
  const payload = event.payload as Record<string, unknown>;
  assert.equal(payload.possibleDownstreamProofOverreach, false);
  assert.deepEqual(payload.downstreamProofRequests, [{ term: "remote_ci", explicitInIntent: true }]);
});

/**
 * The two identity fields recommendation 06's method depends on.
 *
 * Without them no before/after comparison across guidance revisions is possible at all, and
 * the report's rollout criterion cannot be evaluated. Asserted here as VALUES rather than as
 * presence, because the failure that matters is a digest wired to the wrong text - it would
 * still render a plausible hex string and nothing downstream would contradict it.
 */
test("the event carries workflow and guidance identity without carrying guidance prose", () => {
  const event = testEvidenceAuditEvent({
    persona,
    nodeId: "auditor",
    attemptId: "attempt-3",
    firstAuditorAttempt: true,
    submission,
    context,
    verdict,
    checkEvidence: [],
    operatorDirective: null,
    version,
  });
  assert.ok(event);
  const payload = event.payload as Record<string, unknown>;
  assert.equal(payload.workflowId, "workflow-review");
  assert.equal(payload.workflowVersion, 8);
  assert.deepEqual(payload.guidance, {
    personaId: "builtin:test-evidence-auditor",
    revision: 1,
    digest: guidanceDigest("Review evidence."),
  });
  // The digest is identity, never prose: the guidance text itself must not be recoverable
  // from, or present anywhere in, a durable telemetry event.
  assert.doesNotMatch(JSON.stringify(payload), /Review evidence\./);
  assert.doesNotMatch(JSON.stringify(payload), /"submissionId"/);
  assert.doesNotMatch(JSON.stringify(payload), /"submission"/);
  assert.match(String(payload.guidance && (payload.guidance as { digest: string }).digest), /^[0-9a-f]{12}$/);
  assert.notEqual(guidanceDigest("Review evidence."), guidanceDigest("Review evidence, strictly."));
});

test("readiness evaluation telemetry is bounded, opaque, and replay-stable", () => {
  const readiness: WorkflowEvidenceReadinessResult = {
    evaluatorVersion: "criterion_mapped_v1",
    status: "gaps",
    criteria: [{
      criterionId: "criterion-secret",
      criterion: "Private criterion text must not enter telemetry",
      material: true,
      matchedClientCriterionId: "claim-secret",
      authorProofClass: "visual",
      suggestedProofClass: "integration",
      links: [],
      gaps: ["missing_execution", "missing_rendered_output"],
      warnings: ["model_proof_class_disagreement"],
    }],
    gapCodes: ["missing_execution", "missing_rendered_output"],
    warningCodes: ["model_proof_class_disagreement"],
    unavailableReason: null,
  };
  const coverage: WorkflowEvidenceCoverageClaim[] = [{
    clientCriterionId: "claim-secret",
    criterion: "Private criterion text must not enter telemetry",
    proofClass: "visual",
    repositoryScope: "repo-01",
    links: [],
  }];
  const first = evidenceReadinessEvaluatedEvent({ submission, readiness, coverage, version });
  const replay = evidenceReadinessEvaluatedEvent({ submission, readiness, coverage, version });
  const distinct = evidenceReadinessEvaluatedEvent({
    submission: { ...submission, id: "submission-2" },
    readiness,
    coverage,
    version,
  });
  const reevaluated = evidenceReadinessEvaluatedEvent({
    submission,
    readiness: null,
    coverage,
    version,
  });
  assert.equal(first.eventId, replay.eventId);
  assert.notEqual(first.eventId, distinct.eventId);
  assert.notEqual(
    first.eventId,
    reevaluated.eventId,
    "a changed evaluation of the same resumed submission needs its own replay-stable event",
  );
  assert.deepEqual(first.payload, {
    submissionKey: evidenceTelemetryKey("submission", submission.id),
    policy: "criterion_mapped_v1",
    evaluatorVersion: "criterion_mapped_v1",
    status: "gaps",
    round: 1,
    segment: 0,
    refinementReason: null,
    criteriaCount: 1,
    mappedClaimCount: 1,
    warningCount: 1,
    gapCount: 2,
    gapCodes: [
      { category: "missing_execution", count: 1 },
      { category: "missing_rendered_output", count: 1 },
    ],
    proofClasses: [{ category: "visual", count: 1 }],
    missingRoles: [
      { category: "execution", count: 1 },
      { category: "rendered_output", count: 1 },
    ],
    override: false,
    workflowId: "workflow-review",
    workflowVersion: 8,
    repositoryScope: "repository",
  });
  const serialized = JSON.stringify(first.payload);
  assert.doesNotMatch(serialized, /Private criterion|criterion-secret|claim-secret|submissionId/);
  assert.doesNotMatch(serialized, /"submission"/);
});

test("durable completed attempt history ignores infrastructure retries", () => {
  const attempt = (
    id: string,
    state: WorkflowNodeAttempt["state"],
    candidate: PersonaSnapshot | null = persona,
  ) => ({ id, state, persona: candidate }) as WorkflowNodeAttempt;
  assert.equal(isFirstCompletedTestEvidenceAuditorAttempt([
    attempt("infra-1", "error"),
    attempt("infra-2", "error"),
    attempt("semantic-1", "completed"),
  ], "semantic-1"), true);
  assert.equal(isFirstCompletedTestEvidenceAuditorAttempt([
    attempt("semantic-1", "completed"),
    attempt("semantic-2", "completed"),
  ], "semantic-2"), false);
  assert.equal(isFirstCompletedTestEvidenceAuditorAttempt([
    attempt("other", "completed", { ...persona, name: "Other", sourcePersonaId: "other" }),
    attempt("semantic-1", "completed"),
  ], "semantic-1"), true);
});

// --- the aggregate --------------------------------------------------------------------

/** One synthetic stored event. Defaults are a clean, passing first submission. */
function row(over: {
  runId?: string;
  timestamp?: number;
  round?: number;
  segment?: number;
  outcome?: "pass" | "fail";
  rejectionCategories?: string[];
  images?: number;
  artifacts?: number;
  checks?: number;
  checkOmittedBytes?: number;
  transcriptTruncated?: boolean;
  transcriptOmittedHeadBytes?: number;
  overreach?: boolean;
  workflowVersion?: number;
  digest?: string;
  personaId?: string;
  revision?: number;
  firstAuditorAttempt?: boolean | null;
  readinessStatus?: "not_evaluated" | "ready" | "gaps" | "unavailable" | "overridden";
} = {}): TestEvidenceAuditEventRow {
  const round = over.round ?? 1;
  const segment = over.segment ?? 0;
  return {
    runId: over.runId ?? "run-1",
    timestamp: over.timestamp ?? 1000,
    payload: {
      nodeId: "auditor",
      submissionKey: "111111111111111111111111",
      workflowId: "workflow-review",
      workflowVersion: over.workflowVersion ?? 8,
      guidance: {
        personaId: over.personaId ?? "builtin:test-evidence-auditor",
        revision: over.revision ?? 1,
        digest: over.digest ?? "aaaaaaaaaaaa",
      },
      round,
      segment,
      firstSubmission: round === 1 && segment === 0,
      ...(over.firstAuditorAttempt === null
        ? {}
        : { firstAuditorAttempt: over.firstAuditorAttempt ?? round === 1 }),
      readinessSnapshot: {
        policy: "criterion_mapped_v1",
        evaluatorVersion: "criterion_mapped_v1",
        status: over.readinessStatus ?? "ready",
      },
      outcome: over.outcome ?? "pass",
      rejectionCategories: over.rejectionCategories ?? [],
      evidenceReadiness: {
        imageCount: over.images ?? 1,
        textArtifactCount: over.artifacts ?? 1,
        checkCount: over.checks ?? 1,
        checkOmittedBytes: over.checkOmittedBytes ?? 0,
        transcriptMessageCount: 3,
        transcriptTruncated: over.transcriptTruncated ?? false,
        transcriptOmittedHeadBytes: over.transcriptOmittedHeadBytes ?? 0,
        transcriptMiddleOmitted: false,
      },
      downstreamProofRequests: [],
      possibleDownstreamProofOverreach: over.overreach ?? false,
    },
  };
}

const WINDOW = { scanLimit: 2000, truncated: false };

function preflightRow(over: {
  runId: string;
  eventId: string;
  submissionId?: string;
  kind?: TestEvidencePreflightEventRow["kind"];
  status?: "not_evaluated" | "ready" | "gaps" | "unavailable" | "overridden";
  policy?: "off" | "criterion_mapped_v1";
  workflowVersion?: number;
  evaluatorVersion?: string | null;
  payload?: unknown;
}): TestEvidencePreflightEventRow {
  const kind = over.kind ?? "evidence_readiness_evaluated";
  const submissionId = over.submissionId ?? `${over.runId}-submission`;
  const markerPayload = kind === "evidence_preflight_refinement_reserved"
    ? { parentSubmissionId: submissionId, round: 1, segment: 1 }
    : { submissionId, acknowledgedRisk: true };
  return {
    runId: over.runId,
    timestamp: 1000,
    eventId: over.eventId,
    kind,
    payload: over.payload ?? (kind === "evidence_readiness_evaluated" ? {
      submissionKey: evidenceTelemetryKey("submission", submissionId),
      policy: over.policy ?? "criterion_mapped_v1",
      evaluatorVersion: over.evaluatorVersion === undefined
        ? "criterion_mapped_v1"
        : over.evaluatorVersion,
      status: over.status ?? "ready",
      round: 1,
      segment: 0,
      refinementReason: null,
      criteriaCount: 1,
      mappedClaimCount: 1,
      warningCount: 0,
      gapCount: over.status === "gaps" ? 2 : 0,
      gapCodes: over.status === "gaps"
        ? [
            { category: "missing_execution", count: 1 },
            { category: "missing_rendered_output", count: 1 },
          ]
        : [],
      proofClasses: over.status === "gaps" ? [{ category: "visual", count: 1 }] : [],
      missingRoles: over.status === "gaps"
        ? [
            { category: "execution", count: 1 },
            { category: "rendered_output", count: 1 },
          ]
        : [],
      override: false,
      workflowId: "workflow-review",
      workflowVersion: over.workflowVersion ?? 13,
      repositoryScope: "repository",
    } : markerPayload),
  };
}

/**
 * The case a fresh install is in, and the one a rate must not lie about.
 *
 * "No auditor attempt has ever run" and "every attempt failed" are the two readings this
 * telemetry exists to tell apart, and a rate of 0 renders identically for both. Every rate
 * is null here, and nothing divides by zero.
 */
test("the aggregate over no events reports no readings rather than zero readings", () => {
  const aggregate = aggregateTestEvidenceAudit([], WINDOW);
  assert.equal(aggregate.attempts, 0);
  assert.equal(aggregate.runs, 0);
  assert.equal(aggregate.attemptsPerRun, null);
  assert.equal(aggregate.malformed, 0);
  assert.equal(aggregate.oldestAt, null);
  assert.equal(aggregate.newestAt, null);
  assert.deepEqual(aggregate.firstAuditorAttemptAccepted, { count: 0, total: 0, rate: null });
  assert.equal(aggregate.firstAuditorAttemptKnown, 0);
  assert.equal(aggregate.firstAuditorAttemptUnknown, 0);
  assert.deepEqual(aggregate.firstSubmissionAccepted, { count: 0, total: 0, rate: null });
  assert.deepEqual(aggregate.attemptFailures, { count: 0, total: 0, rate: null });
  assert.deepEqual(aggregate.possibleOverreach, { count: 0, total: 0, rate: null });
  assert.deepEqual(aggregate.postReadyAuditorRejections, { count: 0, total: 0, rate: null });
  assert.deepEqual(aggregate.preflight.interceptions, { count: 0, total: 0, rate: null });
  assert.deepEqual(aggregate.readiness.withoutImages, { count: 0, total: 0, rate: null });
  assert.equal(aggregate.readiness.checkOmittedBytes, 0);
  assert.deepEqual(aggregate.slices, []);
  assert.equal(aggregate.slicesOmitted, 0);
  // Every category still gets a row at zero, so a missing reason reads as "none seen"
  // rather than as a category the classifier forgot exists.
  assert.deepEqual(aggregate.rejectionCategories.map((entry) => entry.category), [
    "visual_artifact",
    "focused_execution",
    "downstream_proof",
    "other",
  ]);
  assert.deepEqual(aggregate.rejectionCategories[0]!.failures, { count: 0, total: 0, rate: null });
});

/**
 * The five numbers the report's rollout criterion is written in, each over its OWN
 * population. Getting a denominator wrong here is silent: every one of these still renders
 * as a plausible percentage.
 */
test("the aggregate measures first-pass acceptance, attempt failures and attempts per run", () => {
  const aggregate = aggregateTestEvidenceAudit([
    row({ runId: "run-1", outcome: "fail", rejectionCategories: ["visual_artifact"], timestamp: 10 }),
    row({ runId: "run-1", round: 2, outcome: "pass", timestamp: 20 }),
    row({ runId: "run-2", outcome: "pass", timestamp: 30 }),
    row({ runId: "run-3", outcome: "fail", rejectionCategories: ["visual_artifact", "focused_execution"], timestamp: 40 }),
    row({ runId: "run-3", round: 2, outcome: "fail", rejectionCategories: ["other"], overreach: true, timestamp: 50 }),
  ], WINDOW);
  assert.equal(aggregate.attempts, 5);
  assert.equal(aggregate.runs, 3);
  assert.equal(aggregate.attemptsPerRun, 5 / 3);
  assert.equal(aggregate.oldestAt, 10);
  assert.equal(aggregate.newestAt, 50);
  // First submissions are the three round-1/segment-0 attempts, one of which passed.
  assert.deepEqual(aggregate.firstSubmissionAccepted, { count: 1, total: 3, rate: 1 / 3 });
  // Failures are over ALL attempts, repair rounds included.
  assert.deepEqual(aggregate.attemptFailures, { count: 3, total: 5, rate: 3 / 5 });
  assert.deepEqual(aggregate.possibleOverreach, { count: 1, total: 5, rate: 1 / 5 });
  // Categories are over FAILING attempts and overlap - one verdict asked for two things -
  // so these shares deliberately sum past 1.
  const share = (name: string): number | null =>
    aggregate.rejectionCategories.find((entry) => entry.category === name)!.failures.rate;
  assert.equal(share("visual_artifact"), 2 / 3);
  assert.equal(share("focused_execution"), 1 / 3);
  assert.equal(share("downstream_proof"), 0);
  assert.equal(share("other"), 1 / 3);
});

test("first Auditor acceptance excludes interceptions and keeps disagreement denominators distinct", () => {
  const auditRows = [
    row({
      runId: "run-ready",
      segment: 2,
      firstAuditorAttempt: true,
      readinessStatus: "ready",
      outcome: "fail",
    }),
    row({
      runId: "run-ready",
      round: 2,
      firstAuditorAttempt: false,
      readinessStatus: "ready",
      outcome: "pass",
    }),
    row({
      runId: "run-override",
      firstAuditorAttempt: true,
      readinessStatus: "overridden",
      outcome: "fail",
    }),
    row({ runId: "run-legacy", firstAuditorAttempt: null, outcome: "pass" }),
  ];
  const readinessRows = [
    preflightRow({ runId: "run-ready", eventId: "ready-gap", status: "gaps" }),
    preflightRow({
      runId: "run-ready",
      eventId: "ready-refinement",
      kind: "evidence_preflight_refinement_reserved",
    }),
    preflightRow({ runId: "run-ready", eventId: "ready-final", status: "ready" }),
    preflightRow({ runId: "run-override", eventId: "override-gap", status: "gaps" }),
    preflightRow({
      runId: "run-override",
      eventId: "override-marker",
      kind: "evidence_readiness_overridden",
    }),
    preflightRow({ runId: "run-unavailable", eventId: "unavailable", status: "unavailable" }),
    preflightRow({ runId: "run-off", eventId: "off-gap", status: "gaps", policy: "off" }),
  ];
  const aggregate = aggregateTestEvidenceAudit(
    auditRows,
    WINDOW,
    readinessRows,
    { truncated: false },
  );
  assert.deepEqual(aggregate.firstAuditorAttemptAccepted, { count: 0, total: 2, rate: 0 });
  assert.equal(aggregate.firstAuditorAttemptKnown, 3);
  assert.equal(aggregate.firstAuditorAttemptUnknown, 1);
  assert.deepEqual(aggregate.postReadyAuditorRejections, { count: 1, total: 1, rate: 1 });
  assert.deepEqual(aggregate.postOverrideAuditorRejections, { count: 1, total: 1, rate: 1 });
  assert.equal(aggregate.preflight.evaluations, 5);
  assert.equal(aggregate.preflight.enforcingEvaluations, 4);
  assert.deepEqual(aggregate.preflight.interceptions, { count: 2, total: 4, rate: 0.5 });
  assert.deepEqual(aggregate.preflight.sameRoundRefinements, { count: 1, total: 2, rate: 0.5 });
  assert.deepEqual(aggregate.preflight.overrides, { count: 1, total: 2, rate: 0.5 });
  assert.deepEqual(aggregate.preflight.unavailable, { count: 1, total: 4, rate: 0.25 });
  assert.deepEqual(aggregate.preflight.proofClasses, [{
    category: "visual",
    occurrences: 2,
    affectedEvaluations: { count: 2, total: 2, rate: 1 },
  }]);
  assert.deepEqual(aggregate.preflight.missingRoles.map((item) => item.category), [
    "execution",
    "rendered_output",
  ]);
  assert.deepEqual(aggregate.slices[0]?.firstAuditorAttemptAccepted, {
    count: 0,
    total: 2,
    rate: 0,
  });
});

test("lifecycle outcomes apply only to their intercepted submission within a run", () => {
  const aggregate = aggregateTestEvidenceAudit([], WINDOW, [
    preflightRow({
      runId: "run-repeat",
      eventId: "later-gap",
      submissionId: "later-submission",
      status: "gaps",
    }),
    preflightRow({
      runId: "run-repeat",
      eventId: "earlier-refinement",
      submissionId: "earlier-submission",
      kind: "evidence_preflight_refinement_reserved",
    }),
    preflightRow({
      runId: "run-repeat",
      eventId: "earlier-override",
      submissionId: "earlier-submission",
      kind: "evidence_readiness_overridden",
    }),
  ], { truncated: false });

  assert.deepEqual(aggregate.preflight.interceptions, { count: 1, total: 1, rate: 1 });
  assert.deepEqual(aggregate.preflight.sameRoundRefinements, { count: 0, total: 1, rate: 0 });
  assert.deepEqual(aggregate.preflight.overrides, { count: 0, total: 1, rate: 0 });
});

test("replayed preflight events are deduplicated and readiness snapshots survive split windows", () => {
  const evaluated = preflightRow({ runId: "run-1", eventId: "same", status: "gaps" });
  const aggregate = aggregateTestEvidenceAudit([
    row({
      runId: "run-1",
      firstAuditorAttempt: true,
      readinessStatus: "ready",
      outcome: "fail",
    }),
  ], WINDOW, [evaluated, { ...evaluated }], { truncated: true });
  assert.equal(aggregate.preflight.evaluations, 1);
  assert.deepEqual(aggregate.preflight.interceptions, { count: 1, total: 1, rate: 1 });
  assert.equal(aggregate.preflight.truncated, true);
  assert.deepEqual(
    aggregate.postReadyAuditorRejections,
    { count: 1, total: 1, rate: 1 },
    "the Auditor event's activation snapshot keeps disagreement measurable when its readiness event is outside the window",
  );
});

test("evidence readiness adoption is measured over first submissions only", () => {
  const aggregate = aggregateTestEvidenceAudit([
    row({ runId: "run-1", images: 0, artifacts: 0, checks: 0, checkOmittedBytes: 400, transcriptTruncated: true, transcriptOmittedHeadBytes: 900 }),
    row({ runId: "run-2", images: 2, artifacts: 0, checkOmittedBytes: 100 }),
    // A repair round that finally attached everything says nothing about first-packet
    // readiness, so it must not move any denominator below.
    row({ runId: "run-1", round: 2, images: 5, artifacts: 5, checkOmittedBytes: 9999 }),
  ], WINDOW);
  assert.deepEqual(aggregate.readiness.withoutImages, { count: 1, total: 2, rate: 0.5 });
  assert.deepEqual(aggregate.readiness.withoutTextArtifacts, { count: 2, total: 2, rate: 1 });
  assert.deepEqual(aggregate.readiness.withoutChecks, { count: 1, total: 2, rate: 0.5 });
  assert.deepEqual(aggregate.readiness.transcriptTruncated, { count: 1, total: 2, rate: 0.5 });
  assert.equal(aggregate.readiness.checkOmittedBytes, 500);
  assert.equal(aggregate.readiness.transcriptOmittedHeadBytes, 900);
});

/**
 * The before/after comparison the identity fields were added for, and the reason older
 * events are not dropped: history written before those fields existed is still history.
 */
test("attempts slice by workflow version and guidance digest, keeping unidentified history", () => {
  const legacy = row({ runId: "run-0", outcome: "fail", rejectionCategories: ["other"] });
  delete (legacy.payload as Record<string, unknown>).workflowVersion;
  delete (legacy.payload as Record<string, unknown>).guidance;
  const aggregate = aggregateTestEvidenceAudit([
    legacy,
    row({ runId: "run-1", workflowVersion: 8, digest: "aaaaaaaaaaaa", outcome: "fail", rejectionCategories: ["visual_artifact"] }),
    row({ runId: "run-2", workflowVersion: 8, digest: "aaaaaaaaaaaa", outcome: "fail", rejectionCategories: ["visual_artifact"] }),
    row({ runId: "run-3", workflowVersion: 10, digest: "bbbbbbbbbbbb", outcome: "pass" }),
  ], WINDOW);
  assert.equal(aggregate.slices.length, 3);
  const [busiest, ...rest] = aggregate.slices;
  assert.equal(busiest!.guidanceDigest, "aaaaaaaaaaaa");
  assert.equal(busiest!.workflowVersion, 8);
  assert.equal(busiest!.attempts, 2);
  assert.deepEqual(busiest!.firstSubmissionAccepted, { count: 0, total: 2, rate: 0 });
  assert.deepEqual(busiest!.attemptFailures, { count: 2, total: 2, rate: 1 });
  const improved = rest.find((slice) => slice.guidanceDigest === "bbbbbbbbbbbb");
  assert.ok(improved, "the newer guidance revision must be its own slice");
  assert.deepEqual(improved.firstSubmissionAccepted, { count: 1, total: 1, rate: 1 });
  const unknown = rest.find((slice) => slice.guidanceDigest === null);
  assert.ok(unknown, "events written before the identity fields existed are still counted");
  assert.equal(unknown.workflowVersion, null);
  assert.equal(unknown.attempts, 1);
  assert.equal(aggregate.attempts, 4);
});

/**
 * A Persona edit that did not touch the guidance must not split the guidance's population.
 *
 * The digest is a hash of the exact guidance an attempt ran with, so two revisions carrying
 * identical bytes are one guidance. Grouping by revision as well used to open a second slice
 * for a rename or a model change - two rows the panel labels identically, each computing its
 * rates over half the attempts, which is the opposite of what a before/after comparison needs.
 * A revision that DID change the guidance changes the digest, so real revisions still separate.
 */
test("a Persona edit that leaves the guidance identical stays one slice", () => {
  const aggregate = aggregateTestEvidenceAudit([
    row({ runId: "run-1", revision: 1, digest: "aaaaaaaaaaaa", outcome: "fail", rejectionCategories: ["visual_artifact"] }),
    row({ runId: "run-2", revision: 4, digest: "aaaaaaaaaaaa", outcome: "pass" }),
    row({ runId: "run-3", revision: 2, digest: "aaaaaaaaaaaa", outcome: "pass" }),
  ], WINDOW);
  assert.equal(aggregate.slices.length, 1, "identical guidance must not be split by revision");
  const [only] = aggregate.slices;
  assert.equal(only!.attempts, 3);
  // Reported over the WHOLE population, which is the point of not splitting it.
  assert.deepEqual(only!.firstSubmissionAccepted, { count: 2, total: 3, rate: 2 / 3 });
  // The newest revision seen carrying this guidance, not the first and not the last read.
  assert.equal(only!.personaRevision, 4);
});

/** Same guidance text under a different Persona is a different subject, and stays apart. */
test("identical guidance under two Personas remains two slices", () => {
  const aggregate = aggregateTestEvidenceAudit([
    row({ runId: "run-1", personaId: "builtin:test-evidence-auditor", digest: "aaaaaaaaaaaa" }),
    row({ runId: "run-2", personaId: "persona-other", digest: "aaaaaaaaaaaa" }),
  ], WINDOW);
  assert.equal(aggregate.slices.length, 2);
  assert.deepEqual(
    aggregate.slices.map((slice) => slice.personaId).sort(),
    ["builtin:test-evidence-auditor", "persona-other"],
  );
});

/**
 * A row the reader cannot trust is reported, never coerced. A payload whose outcome is not
 * a verdict must not contribute a silent zero to a rate an operator is about to act on.
 */
test("unreadable payloads are counted as malformed instead of contributing zeros", () => {
  const aggregate = aggregateTestEvidenceAudit([
    { runId: "run-1", timestamp: 1, payload: null },
    { runId: "run-1", timestamp: 2, payload: { outcome: "maybe" } },
    row({ runId: "run-1", outcome: "pass" }),
  ], { scanLimit: 2000, truncated: true });
  assert.equal(aggregate.malformed, 2);
  assert.equal(aggregate.attempts, 1);
  assert.equal(aggregate.runs, 1);
  assert.deepEqual(aggregate.firstSubmissionAccepted, { count: 1, total: 1, rate: 1 });
  // A capped window says so, so a partial history is never read as the fleet's whole one.
  assert.equal(aggregate.truncated, true);
  assert.equal(aggregate.scanLimit, 2000);
});
