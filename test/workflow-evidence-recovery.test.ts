import test from "node:test";
import assert from "node:assert/strict";
import { fallbackWorkflowContext, reconcileWorkflowCoverage } from "../src/server/workflows/context.ts";
import { selectWorkflowCoverageClaims, evaluateWorkflowEvidenceReadiness, type WorkflowEvidenceCoverageClaim } from "../src/shared/workflow.ts";
import { personaContractViolation, personaReviewInput, personaReviewInputDigest } from "../src/server/workflows/persona-contract.ts";
import { buildPersonaPrompt } from "../src/server/workflows/prompt.ts";
import { normalizePersonaVerdict } from "../src/server/workflows/verdict.ts";
import type { WorkflowContextSnapshot, WorkflowSubmission, WorkflowVersion, PersonaSnapshot } from "../src/shared/workflow.ts";

const criteria = ["A", "B"].map((id) => ({ id, text: `Verify ${id}`, material: true, suggestedProofClass: null }));
const claim = (id: string, target: string, inherited = false): WorkflowEvidenceCoverageClaim => ({
  clientCriterionId: id, criterion: `Verify ${target}`, proofClass: "focused_execution", repositoryScope: "repo-01",
  links: [{ clientItemId: `proof-${id}`, role: "execution" }],
  ...(inherited ? { inheritedFromSubmissionId: "root" } : {}),
});
function context(): WorkflowContextSnapshot {
  return { ...fallbackWorkflowContext({
    primaryGoal: { rawPrompt: "Verify A and B", refined: null, sourceNoteKey: "note" }, humanDecisions: [], priorPersonaFeedback: [],
    session: { agent: "codex", name: "Test", cwd: null, branch: null },
    evidence: { headSha: null, diffFingerprint: "diff", diff: "", diffTruncated: false, workingTreeDirty: false, workingTreeStatus: [], workingTreeStatusTruncated: false, transcript: [], transcriptAnchor: null, transcriptTruncated: false, standards: [], standardsTruncated: false },
  }, null), canonicalCriteria: criteria, criterionMappings: [], compaction: { status: "model", runner: "codex", model: "fake", error: null } };
}

test("repair A, then B retains the selected A claim and never resurrects discarded proof", () => {
  const old = [claim("old-a", "A"), claim("old-b", "B")];
  const mapping = (coverage: WorkflowEvidenceCoverageClaim[]) => criteria.map((c) => ({ criterionId: c.id, matchedClientCriterionIds: coverage.filter((v) => v.criterion === c.text).map((v) => v.clientCriterionId) }));
  const root = selectWorkflowCoverageClaims({ canonicalCriteria: criteria, criterionMappings: mapping(old), coverage: old });
  const roundA = [...old.map((v) => ({ ...v, inheritedFromSubmissionId: "root" })), claim("new-a", "A")];
  const selectedA = selectWorkflowCoverageClaims({ canonicalCriteria: criteria, criterionMappings: mapping(roundA), coverage: roundA, previous: root, sourceSubmissionId: "root" });
  const roundB = [...roundA.map((v) => ({ ...v, inheritedFromSubmissionId: "repair-a" })), claim("new-b", "B")];
  const selectedB = selectWorkflowCoverageClaims({ canonicalCriteria: criteria, criterionMappings: mapping(roundB), coverage: roundB, previous: selectedA, sourceSubmissionId: "repair-a" });
  assert.deepEqual(selectedB.criteria.map((c) => c.matchedClientCriterionIds), [["new-a"], ["new-b"]]);
  const readiness = (coverage = roundB) => evaluateWorkflowEvidenceReadiness({ canonicalCriteria: criteria, criterionMappings: mapping(coverage), coverage, selection: selectedB,
    evidence: coverage.map((c) => ({ clientItemId: `proof-${c.clientCriterionId}`, evidenceId: c.clientCriterionId, repositoryScope: "repo-01" })) });
  assert.equal(readiness().status, "ready");
  assert.equal(readiness(roundB.filter((c) => c.clientCriterionId !== "new-a")).criteria[0]?.matchedClientCriterionId, null);
  assert.deepEqual(readiness(roundB.filter((c) => c.clientCriterionId !== "new-a")).gapCodes, ["missing_coverage"]);
  const competing = [...roundB, claim("another-a", "A"), claim("also-a", "A")];
  const ambiguous = selectWorkflowCoverageClaims({ canonicalCriteria: criteria, criterionMappings: mapping(competing), coverage: competing, previous: selectedB });
  const missingCompetitor = competing.filter((c) => c.clientCriterionId !== "also-a").map((c) => ({ ...c, inheritedFromSubmissionId: "later" }));
  const carried = selectWorkflowCoverageClaims({ canonicalCriteria: criteria, criterionMappings: mapping(missingCompetitor), coverage: missingCompetitor, previous: ambiguous });
  assert.deepEqual(carried.criteria[0]?.matchedClientCriterionIds, ["also-a", "another-a"]);
});

test("mapping retries transport and parse once, checkpoints consumption, preserves exact matches and caches successful no-match", async () => {
  const coverage = [claim("a", "A"), { ...claim("b", "B"), criterion: "B is shown correctly" }];
  let calls = 0;
  const checkpoints: WorkflowContextSnapshot[] = [];
  const failed = await reconcileWorkflowCoverage(context(), coverage, { reconcile: async () => {
    calls++; return { kind: "failed", cause: calls === 1 ? "transport" : "parse", reason: "unavailable" };
  }, onProgress: (c) => checkpoints.push(c) });
  assert.equal(calls, 2);
  assert.deepEqual(checkpoints.filter((c) => c.reconciliation?.status === "pending").map((c) => c.reconciliation?.attempts), [1, 2]);
  assert.deepEqual(failed.criterionMappings?.[0]?.matchedClientCriterionIds, ["a"]);
  assert.equal(failed.reconciliation?.status, "failed");
  await reconcileWorkflowCoverage(context(), coverage, { previous: failed, reconcile: async () => { throw new Error("must not execute after restart"); } });
  const complete = await reconcileWorkflowCoverage(context(), coverage, { reconcile: async () => { calls++; return { kind: "ok", value: { criterionMappings: [] } }; } });
  assert.equal(complete.reconciliation?.status, "complete");
  assert.deepEqual(complete.criterionMappings?.[1]?.matchedClientCriterionIds, []);
  const cached = await reconcileWorkflowCoverage(context(), [...coverage].reverse(), { previous: complete, reconcile: async () => { throw new Error("must use successful cache"); } });
  assert.deepEqual(cached.reconciliation, complete.reconciliation);
  assert.equal(calls, 3);
});

test("cancellation stops reconciliation after its in-flight call without a second call", async () => {
  let active = true;
  let calls = 0;
  const result = await reconcileWorkflowCoverage(context(), [{ ...claim("b", "B"), criterion: "Paraphrased" }], {
    active: () => active, reconcile: async () => { calls++; active = false; return { kind: "ok", value: { criterionMappings: [] } }; },
  });
  assert.equal(calls, 1);
  assert.equal(result.reconciliation?.cause, "cancelled");
});

const substantive = (basis?: string) => ({ verdict: "fail", summary: "Evidence is insufficient", requestedChanges: [{ title: "Show behavior", rationale: "The screenshot is stale", ...(basis ? { basis } : {}), evidence: [{ kind: "goal", quote: "Verify A" }] }], confidence: 1 });
test("typed contract rejects registration, access and mixed findings without manufacturing approval", () => {
  for (const basis of ["coverage_registration", "evidence_access"]) {
    const verdict = normalizePersonaVerdict(substantive(basis))!;
    assert.equal(personaContractViolation(verdict), basis);
    const mixed = normalizePersonaVerdict({ ...substantive("substantive"), requestedChanges: [...substantive("substantive").requestedChanges, ...substantive(basis).requestedChanges] })!;
    assert.equal(personaContractViolation(mixed), basis);
  }
  assert.equal(personaContractViolation(normalizePersonaVerdict(substantive())!), "missing_finding_basis");
  assert.equal(normalizePersonaVerdict(substantive("invented")), null);
  for (const rationale of ["stale screenshots", "unrelated output", "unexecuted changed code", "inadequate measurement", "missing registration wording with substantive basis"]) {
    const value = substantive("substantive"); value.requestedChanges[0]!.rationale = rationale;
    assert.equal(personaContractViolation(normalizePersonaVerdict(value)!), null);
  }
});

test("Persona projection preserves status, policy, identity and historical origins without trusting captions", () => {
  const ctx = context();
  ctx.priorPersonaFeedback = [{ personaName: "Earlier reviewer", summary: "Coverage missing", requestedChanges: ["Declare proof"], origin: { submissionId: "old", round: 1, segment: 0, attemptId: "old-attempt", createdAt: 1 } }];
  const submission = { id: "current", round: 2, segment: 3, context: ctx } as unknown as WorkflowSubmission;
  for (const policy of ["off", "criterion_mapped_v1"] as const) {
    for (const status of ["ready", "gaps", "overridden", "unavailable", "not_evaluated", null] as const) {
      submission.readiness = status ? { evaluatorVersion: "criterion_mapped_v1", status, criteria: criteria.map((c) => ({ criterionId: c.id, criterion: c.text, material: c.material, matchedClientCriterionId: `claim-${c.id}`, authorProofClass: "focused_execution", suggestedProofClass: null, links: [], gaps: [], warnings: [] })), gapCodes: [], warningCodes: [], unavailableReason: null } : null;
      const input = personaReviewInput(submission, { evidenceReadinessPolicy: policy } as WorkflowVersion);
      assert.equal(input.status, status ?? "unknown"); assert.equal(input.policy, policy);
      assert.equal(personaReviewInputDigest(input), personaReviewInputDigest({ ...input, operationId: "retry" }));
      assert.notEqual(personaReviewInputDigest(input), personaReviewInputDigest({ ...input, segment: 4 }));
      const prompt = buildPersonaPrompt({ guidanceMarkdown: "Review the evidence" } as PersonaSnapshot, ctx, null, [], input);
      assert.match(prompt, /Historical observation: submission old, round 1, segment 0/);
      assert.match(prompt, /"submissionId":"current"/);
      assert.match(prompt, /Ready establishes structural completeness, not substantive sufficiency/);
    }
  }
});

test("readiness input refuses duplicate, oversized and contradictory authority metadata", async () => {
  const { WorkflowPersonaReviewInputSchema } = await import("../src/shared/protocol.ts");
  const base = { version: 1, operationId: "operation", submissionId: "submission", round: 1, segment: 0, policy: "criterion_mapped_v1", status: "ready", evaluatorVersion: "criterion_mapped_v1", criteria: [{ criterionId: "A", material: true, claimId: "claim", evidenceIds: ["proof"], gaps: [] }] };
  assert.equal(WorkflowPersonaReviewInputSchema.safeParse(base).success, true);
  assert.equal(WorkflowPersonaReviewInputSchema.safeParse({ ...base, criteria: [base.criteria[0], base.criteria[0]] }).success, false);
  assert.equal(WorkflowPersonaReviewInputSchema.safeParse({ ...base, criteria: [{ ...base.criteria[0], gaps: ["missing_execution"] }] }).success, false);
  assert.equal(WorkflowPersonaReviewInputSchema.safeParse({ ...base, evaluatorVersion: null }).success, false);
  const maximumCount = { ...base, criteria: Array.from({ length: 100 }, (_, i) => ({ ...base.criteria[0], criterionId: `criterion-${i}` })) };
  assert.equal(WorkflowPersonaReviewInputSchema.safeParse(maximumCount).success, true);
  const oversized = { ...maximumCount, criteria: maximumCount.criteria.map((row) => ({ ...row, evidenceIds: Array.from({ length: 32 }, (_, i) => `${i}${"界".repeat(190)}`) })) };
  assert.equal(WorkflowPersonaReviewInputSchema.safeParse(oversized).success, false);
  const conflicting = evaluateWorkflowEvidenceReadiness({ canonicalCriteria: criteria, coverage: [claim("a", "A"), claim("b", "B")], criterionMappings: [{ criterionId: "A", matchedClientCriterionIds: ["a"] }, { criterionId: "B", matchedClientCriterionIds: ["b"] }], selection: { version: 1, sourceSubmissionId: "parent", criteria: [{ criterionId: "A", matchedClientCriterionIds: ["absent"] }] }, evidence: [] });
  assert.notEqual(conflicting.status, "ready");
});
