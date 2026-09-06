import assert from "node:assert/strict";
import test from "node:test";

import {
  pipelineCommissionAttention,
  type PipelineCommission,
  type PipelineRun,
} from "../src/shared/pipeline.ts";

function commission(over: Partial<PipelineCommission> = {}): PipelineCommission {
  return {
    id: "commission-1",
    taskId: "task-1",
    provider: "ai-conductor",
    repoRoot: "/repo/demo",
    correlationId: "commission-1",
    lifecycle: "created",
    attempts: [],
    activeAttempt: 1,
    steps: [],
    currentStep: null,
    tier: null,
    track: null,
    project: null,
    authoringWorktree: null,
    authoringBranch: null,
    planSlug: null,
    handoff: null,
    linkedRun: null,
    blocker: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function run(over: Partial<PipelineRun> = {}): PipelineRun {
  return {
    provider: "ai-conductor",
    repoRoot: "/repo/demo",
    slug: "demo",
    worktree: null,
    tier: null,
    track: null,
    steps: [],
    lastStep: null,
    halt: null,
    group: "waiting",
    prUrl: null,
    costTokens: null,
    updatedAt: 1,
    ...over,
  };
}

test("status drift outranks readiness and a matching shipped run is completion-compatible", () => {
  const blocked = commission({
    readinessRequired: true,
    readiness: {
      status: "blocked",
      code: "authentication_required",
      summary: "GitHub authentication is required",
      checkedCapabilities: ["gh"],
      retryable: true,
      remedy: "Authenticate GitHub",
      diagnostic: null,
      fingerprint: "blocked",
      permitted: false,
      checkedAt: "2026-09-04T12:00:00.000Z",
    },
  });
  assert.equal(
    pipelineCommissionAttention(blocked, { status: "done", repoRoot: "/repo/demo" }, null)?.kind,
    "status_drift",
  );
  assert.equal(
    pipelineCommissionAttention(blocked, { status: "running", repoRoot: "/repo/demo" }, null)?.kind,
    "readiness",
  );
  assert.equal(
    pipelineCommissionAttention(
      commission({ lifecycle: "settled" }),
      { status: "done", repoRoot: "/repo/demo" },
      run({ group: "processed" }),
    ),
    null,
  );
});

test("repository mismatch outranks a typed provider failure", () => {
  const failed = commission({
    lifecycle: "failed",
    failure: {
      error: "provider failed",
      class: "provider",
      code: "provider_failed",
      summary: "Provider failed",
      retryable: false,
      remedy: null,
      diagnostic: null,
    },
  });
  const attention = pipelineCommissionAttention(
    failed,
    { status: "running", repoRoot: "/repo/other" },
    null,
  );
  assert.equal(attention?.kind, "status_drift");
  assert.equal(attention?.priority, 0);
});

test("an exact external successor outranks provider failure without adopting it", () => {
  const attention = pipelineCommissionAttention(
    commission({
      lifecycle: "failed",
      successorCandidate: {
        engineerRunId: "engineer-2",
        attempt: 2,
        previousEngineerRunId: "engineer-1",
        attemptKey: "external-attempt",
        providerRevision: 4,
        state: "authoring",
        integrationOwner: null,
        fingerprint: "successor-fingerprint",
        validation: "valid",
        validationReason: null,
        branch: null,
        planSlug: null,
        handoff: null,
        evidenceCommit: null,
        evidenceCommitProvenance: null,
      },
      failure: {
        error: "provider failed",
        class: "provider",
        code: "provider_failed",
        summary: "Provider failed",
        retryable: true,
        remedy: null,
        diagnostic: null,
      },
    }),
    { status: "running", repoRoot: "/repo/demo" },
    null,
  );
  assert.equal(attention?.kind, "successor");
  assert.equal(attention?.priority, 0);
});

test("contradictory retirement evidence is status drift without rewriting the lifecycle", () => {
  const attention = pipelineCommissionAttention(
    commission({
      lifecycle: "awaiting_spec_merge",
      projectionDrift: {
        kind: "retirement_commit",
        detail: "Provider retirement commit conflicts with frozen workspace evidence.",
      },
    }),
    { status: "running", repoRoot: "/repo/demo" },
    null,
  );
  assert.equal(attention?.kind, "status_drift");
  assert.equal(attention?.priority, 0);
  assert.match(attention?.detail ?? "", /frozen workspace evidence/);
});
