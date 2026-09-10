import assert from "node:assert/strict";
import test from "node:test";
import { readinessReviewDisagreementEvent } from "../src/server/workflows/readiness-disagreement.ts";
import type {
  PersonaVerdict,
  WorkflowEvidenceReadinessResult,
  WorkflowEvidenceReadinessStatus,
} from "../src/shared/workflow.ts";

const FAIL: PersonaVerdict = {
  verdict: "fail",
  summary: "The coverage declaration is missing",
  requestedChanges: [{
    title: "Declare coverage",
    rationale: "No acceptance criterion coverage was declared",
    evidence: [{ kind: "goal", quote: "prove the fix" }],
  }],
  confidence: 1,
};

const PASS: PersonaVerdict = {
  verdict: "pass",
  summary: "Proven",
  approvalDetails: { reason: "The focused run demonstrates the behavior", evidence: [] },
  confidence: 1,
};

function readiness(status: WorkflowEvidenceReadinessStatus): WorkflowEvidenceReadinessResult {
  return {
    evaluatorVersion: "criterion_mapped_v1",
    status,
    criteria: [],
    gapCodes: [],
    warningCodes: [],
    unavailableReason: null,
  };
}

function submission(status: WorkflowEvidenceReadinessStatus | null) {
  return {
    id: "submission-1",
    round: 3,
    segment: 1,
    readiness: status === null ? null : readiness(status),
  };
}

const call = (input: {
  readinessStatus: WorkflowEvidenceReadinessStatus | null;
  verdict?: PersonaVerdict;
  policy?: "off" | "criterion_mapped_v1";
}) => readinessReviewDisagreementEvent({
  submission: submission(input.readinessStatus),
  nodeId: "quality",
  attemptId: "attempt-9",
  persona: "Code Quality Judge",
  verdict: input.verdict ?? FAIL,
  version: { evidenceReadinessPolicy: input.policy ?? "criterion_mapped_v1" },
});

test("a Persona failing a submission the preflight passed is a durable disagreement", () => {
  const event = call({ readinessStatus: "ready" });
  assert.ok(event, "a ready submission failed under an enforcing policy is the disagreement");
  // Keyed by the attempt: a replayed write of the same verdict records one disagreement.
  assert.equal(event.eventId, "readiness-review-disagreement:attempt-9");
  assert.deepEqual(event.payload, {
    submissionId: "submission-1",
    nodeId: "quality",
    persona: "Code Quality Judge",
    round: 3,
    segment: 1,
    policy: "criterion_mapped_v1",
    evaluatorVersion: "criterion_mapped_v1",
    readiness: "ready",
    summary: "The coverage declaration is missing",
  });
});

test("only a fail against a ready evaluation disagrees with anything", () => {
  // A pass is the two readings agreeing, which is the ordinary case and not worth an event.
  assert.equal(call({ readinessStatus: "ready", verdict: PASS }), null);
  // The remaining statuses are the preflight NOT saying the packet was ready.
  for (const status of ["gaps", "overridden", "unavailable"] as const) {
    assert.equal(call({ readinessStatus: status }), null, status);
  }
  assert.equal(call({ readinessStatus: null }), null);
});

test("an advisory ready evaluation that a Persona fails is the same disagreement", () => {
  // The condition is the readiness EVALUATION, not the policy that did or did not enforce it.
  // An advisory `ready` gated nothing and therefore means something weaker, but it is the same
  // contradiction and just as reachable, so the signal fires and the payload says which it was.
  const advisory = call({ readinessStatus: "ready", policy: "off" });
  assert.ok(advisory, "an advisory ready evaluation a Persona failed still disagrees");
  assert.equal((advisory.payload as { policy: string }).policy, "off");
  assert.equal((advisory.payload as { readiness: string }).readiness, "ready");

  const enforced = call({ readinessStatus: "ready" });
  assert.ok(enforced);
  assert.equal((enforced.payload as { policy: string }).policy, "criterion_mapped_v1");
  // One attempt is one disagreement whatever the policy was: the id never encodes it.
  assert.equal(advisory.eventId, enforced.eventId);
});

test("the recorded summary is bounded so one verdict cannot flood the run's event log", () => {
  const event = readinessReviewDisagreementEvent({
    submission: submission("ready"),
    nodeId: "quality",
    attemptId: "attempt-9",
    persona: "Code Quality Judge",
    verdict: { ...FAIL, summary: "x".repeat(5_000) },
    version: { evidenceReadinessPolicy: "criterion_mapped_v1" },
  });
  assert.ok(event);
  assert.equal(
    (event.payload as { summary: string }).summary.length,
    400,
  );
});
