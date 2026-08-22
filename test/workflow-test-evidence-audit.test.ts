import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  PersonaSnapshot,
  PersonaVerdict,
  WorkflowContextSnapshot,
  WorkflowSubmission,
} from "../src/shared/workflow.ts";
import {
  aggregateTestEvidenceAudit,
  guidanceDigest,
  testEvidenceAuditEvent,
  testEvidenceRequestCategories,
  type TestEvidenceAuditEventRow,
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
const version = { workflowId: "workflow-review", version: 8 };

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
    submission,
    context,
    verdict,
    checkEvidence: [],
    operatorDirective: null,
    version,
  });
  assert.ok(event);
  assert.equal(event.possibleDownstreamProofOverreach, true);
  assert.deepEqual(event.downstreamProofRequests, [{ term: "remote_ci", explicitInIntent: false }]);
  assert.deepEqual(event.evidenceReadiness, {
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
  assert.equal(event.possibleDownstreamProofOverreach, false);
  assert.deepEqual(event.downstreamProofRequests, [{ term: "remote_ci", explicitInIntent: true }]);
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
    submission,
    context,
    verdict,
    checkEvidence: [],
    operatorDirective: null,
    version,
  });
  assert.ok(event);
  assert.equal(event.workflowId, "workflow-review");
  assert.equal(event.workflowVersion, 8);
  assert.deepEqual(event.guidance, {
    personaId: "builtin:test-evidence-auditor",
    revision: 1,
    digest: guidanceDigest("Review evidence."),
  });
  // The digest is identity, never prose: the guidance text itself must not be recoverable
  // from, or present anywhere in, a durable telemetry event.
  assert.doesNotMatch(JSON.stringify(event), /Review evidence\./);
  assert.match(String(event.guidance && (event.guidance as { digest: string }).digest), /^[0-9a-f]{12}$/);
  assert.notEqual(guidanceDigest("Review evidence."), guidanceDigest("Review evidence, strictly."));
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
} = {}): TestEvidenceAuditEventRow {
  const round = over.round ?? 1;
  const segment = over.segment ?? 0;
  return {
    runId: over.runId ?? "run-1",
    timestamp: over.timestamp ?? 1000,
    payload: {
      nodeId: "auditor",
      submissionId: "submission",
      workflowId: "workflow-review",
      workflowVersion: over.workflowVersion ?? 8,
      guidance: { personaId: "builtin:test-evidence-auditor", revision: 1, digest: over.digest ?? "aaaaaaaaaaaa" },
      round,
      segment,
      firstSubmission: round === 1 && segment === 0,
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
  assert.deepEqual(aggregate.firstSubmissionAccepted, { count: 0, total: 0, rate: null });
  assert.deepEqual(aggregate.attemptFailures, { count: 0, total: 0, rate: null });
  assert.deepEqual(aggregate.possibleOverreach, { count: 0, total: 0, rate: null });
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
