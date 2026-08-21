import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  PersonaSnapshot,
  PersonaVerdict,
  WorkflowContextSnapshot,
  WorkflowSubmission,
} from "../src/shared/workflow.ts";
import {
  testEvidenceAuditEvent,
  testEvidenceRequestCategories,
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
  });
  assert.ok(event);
  assert.equal(event.possibleDownstreamProofOverreach, false);
  assert.deepEqual(event.downstreamProofRequests, [{ term: "remote_ci", explicitInIntent: true }]);
});
