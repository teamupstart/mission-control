/**
 * The route that makes the auditor's telemetry readable without an agent.
 *
 * The aggregate's arithmetic is pinned in `workflow-test-evidence-audit.test.ts`; what is
 * pinned here is the wiring between a written event and an operator's answer - the store
 * query that finds events of one kind ACROSS runs (the run-scoped index cannot serve it, so
 * a wrong query returns an empty, entirely plausible aggregate), the newest-first window,
 * and the refusals. A partial window that did not announce itself would be the worst
 * outcome available: a rate over the newest handful of attempts, read as the fleet's whole
 * history, is exactly the mistake this telemetry exists to prevent.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestEvidenceAuditAggregate } from "../src/shared/workflow.ts";

const home = mkdtempSync(join(tmpdir(), "mission-workflow-evidence-audit-http-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { PersonaManager } = await import("../src/server/workflows/personas.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { buildApp } = await import("../src/server/routes.ts");

function app(workflows?: InstanceType<typeof WorkflowManager>) {
  const registry = new Registry();
  return buildApp(
    registry,
    new ReviewManager(registry),
    new TaskManager(registry),
    new QueueManager(registry),
    undefined,
    undefined,
    workflows,
  );
}

function get(built: ReturnType<typeof buildApp>, path: string) {
  return built.request(path, { method: "GET", headers: { host: "127.0.0.1:7317" } });
}

function auditPayload(over: {
  outcome?: "pass" | "fail";
  round?: number;
  firstAuditorAttempt?: boolean;
  readinessStatus?: "ready" | "overridden";
} = {}) {
  const round = over.round ?? 1;
  return {
    nodeId: "auditor",
    submissionKey: `opaque-submission-${round}`,
    workflowId: "workflow-review",
    workflowVersion: 8,
    guidance: { personaId: "builtin:test-evidence-auditor", revision: 1, digest: "aaaaaaaaaaaa" },
    round,
    segment: 0,
    firstSubmission: round === 1,
    firstAuditorAttempt: over.firstAuditorAttempt ?? round === 1,
    readinessSnapshot: {
      policy: "criterion_mapped_v1",
      evaluatorVersion: "criterion-mapped-v1",
      status: over.readinessStatus ?? "ready",
    },
    outcome: over.outcome ?? "fail",
    rejectionCategories: over.outcome === "pass" ? [] : ["visual_artifact"],
    evidenceReadiness: {
      imageCount: 0,
      textArtifactCount: 0,
      checkCount: 1,
      checkOmittedBytes: 40,
      transcriptMessageCount: 2,
      transcriptTruncated: false,
      transcriptOmittedHeadBytes: 0,
      transcriptMiddleOmitted: false,
    },
    downstreamProofRequests: [],
    possibleDownstreamProofOverreach: false,
  };
}

function preflightPayload(over: {
  status?: "ready" | "gaps" | "unavailable";
  workflowVersion?: number;
} = {}) {
  const status = over.status ?? "gaps";
  return {
    submissionKey: `opaque-preflight-${status}-${over.workflowVersion ?? 8}`,
    policy: "criterion_mapped_v1",
    evaluatorVersion: "criterion-mapped-v1",
    status,
    round: 1,
    segment: 0,
    refinementReason: null,
    criteriaCount: 1,
    mappedClaimCount: 1,
    warningCount: 0,
    gapCount: status === "gaps" ? 1 : 0,
    gapCodes: status === "gaps" ? [{ category: "missing_rendered_output", count: 1 }] : [],
    proofClasses: status === "gaps" ? [{ category: "visual", count: 1 }] : [],
    missingRoles: status === "gaps" ? [{ category: "rendered_output", count: 1 }] : [],
    override: false,
    workflowId: "workflow-review",
    workflowVersion: over.workflowVersion ?? 8,
    repositoryScope: "repository",
  };
}

test("the aggregate route reads events across every run and reports its own window", async () => {
  const registry = new Registry();
  const workflows = new WorkflowManager(registry, new PersonaManager(registry).store);
  const built = app(workflows);

  // Before anything has run: a real answer, with no readings rather than zero readings.
  const empty = await get(built, "/api/workflows/test-evidence-audit");
  assert.equal(empty.status, 200);
  const emptyBody = await empty.json() as TestEvidenceAuditAggregate;
  assert.equal(emptyBody.attempts, 0);
  assert.equal(emptyBody.firstAuditorAttemptAccepted.rate, null);
  assert.equal(emptyBody.firstSubmissionAccepted.rate, null);
  assert.equal(emptyBody.preflight.evaluations, 0);
  assert.equal(emptyBody.truncated, false);

  // Two runs, so a query that only reached one run's events would be visibly short. Other
  // event kinds are interleaved because they share the table this reads.
  workflows.store.appendEvent(
    "run-a",
    "evidence_readiness_evaluated",
    preflightPayload(),
    5,
    "readiness:run-a",
  );
  workflows.store.appendEvent("run-a", "evidence_preflight_refinement_reserved", {
    round: 1,
    segment: 1,
  }, 6, "refinement:run-a");
  workflows.store.appendEvent("run-a", "test_evidence_audit", auditPayload(), 10);
  workflows.store.appendEvent("run-a", "persona_verdict", { verdict: "fail" }, 11);
  workflows.store.appendEvent("run-a", "test_evidence_audit", auditPayload({
    round: 2,
    outcome: "pass",
    firstAuditorAttempt: false,
  }), 20);
  workflows.store.appendEvent(
    "run-b",
    "evidence_readiness_evaluated",
    preflightPayload({ status: "unavailable" }),
    25,
    "readiness:run-b",
  );
  workflows.store.appendEvent("run-b", "evidence_readiness_overridden", {
    acknowledgedRisk: true,
  }, 26, "override:run-b");
  workflows.store.appendEvent("run-b", "test_evidence_audit", auditPayload({
    outcome: "pass",
    readinessStatus: "overridden",
  }), 30);

  const answered = await get(built, "/api/workflows/test-evidence-audit");
  assert.equal(answered.status, 200);
  const body = await answered.json() as TestEvidenceAuditAggregate;
  assert.equal(body.attempts, 3);
  assert.equal(body.runs, 2);
  assert.equal(body.attemptsPerRun, 1.5);
  assert.deepEqual(body.firstAuditorAttemptAccepted, { count: 1, total: 2, rate: 0.5 });
  assert.deepEqual(body.firstSubmissionAccepted, { count: 1, total: 2, rate: 0.5 });
  assert.deepEqual(body.preflight.interceptions, { count: 1, total: 2, rate: 0.5 });
  assert.deepEqual(body.preflight.sameRoundRefinements, { count: 1, total: 1, rate: 1 });
  assert.deepEqual(body.preflight.overrides, { count: 0, total: 1, rate: 0 });
  assert.deepEqual(body.preflight.unavailable, { count: 1, total: 2, rate: 0.5 });
  assert.deepEqual(body.postReadyAuditorRejections, { count: 1, total: 1, rate: 1 });
  assert.deepEqual(body.postOverrideAuditorRejections, { count: 0, total: 1, rate: 0 });
  assert.equal(body.oldestAt, 10);
  assert.equal(body.newestAt, 30);
  assert.equal(body.slices.length, 1);
  assert.equal(body.slices[0]!.guidanceDigest, "aaaaaaaaaaaa");

  // A window that could not hold every attempt SAYS so, and keeps the newest ones.
  const capped = await get(built, "/api/workflows/test-evidence-audit?limit=2");
  const cappedBody = await capped.json() as TestEvidenceAuditAggregate;
  assert.equal(cappedBody.truncated, true);
  assert.equal(cappedBody.attempts, 2);
  assert.equal(cappedBody.scanLimit, 2);
  assert.equal(cappedBody.oldestAt, 20);
  assert.equal(cappedBody.newestAt, 30);
  assert.equal(cappedBody.preflight.truncated, true);
  assert.equal(cappedBody.preflight.evaluations, 1);
});

test("the aggregate route refuses an impossible window and an absent manager", async () => {
  const registry = new Registry();
  const workflows = new WorkflowManager(registry, new PersonaManager(registry).store);
  const built = app(workflows);
  for (const bad of ["0", "-1", "1.5", "abc", "99999"]) {
    const refused = await get(built, `/api/workflows/test-evidence-audit?limit=${bad}`);
    assert.equal(refused.status, 400, `limit=${bad} should be refused`);
  }
  const unavailable = await get(app(), "/api/workflows/test-evidence-audit");
  assert.equal(unavailable.status, 503);
});
