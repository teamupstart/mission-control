import { renderEvidenceReadinessPacket } from "../src/server/workflows/feedback.ts";
import { personaReviewInput } from "../src/server/workflows/persona-contract.ts";
import type { WorkflowSubmission } from "../src/shared/workflow.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_MISTAKES_REVIEW_WORKFLOW_ID } from "../src/shared/builtin-workflow.ts";
import { BUILTIN_WORKFLOWS } from "../src/server/workflows/builtin-workflows.ts";
import { classifyWorkflowCriterionFulfillment, compactWorkflowContext, fallbackWorkflowContext, reuseWorkflowContextCriteria, workflowRunCriteriaFrom } from "../src/server/workflows/context.ts";
import { evaluateWorkflowEvidenceReadiness, workflowHasPendingPullRequestAction } from "../src/shared/workflow.ts";
import { WorkflowCanonicalCriterionSchema, WorkflowEvidenceReadinessResultSchema } from "../src/shared/protocol.ts";

const graph = BUILTIN_WORKFLOWS.find((workflow) => workflow.definition.id === NO_MISTAKES_REVIEW_WORKFLOW_ID)!.versions.at(-1)!.graph;
const publication = graph.nodes.find((node) => node.kind === "session_action" && node.action.completion.kind === "pull_request")!;
const pr = { id: "pr", text: "Pull request opened documenting implementation, verification, and deviations", material: true,
  suggestedProofClass: null, fulfilledByAction: "pull_request" as const };
const implementation = { id: "code", text: "Implementation verified", material: true, suggestedProofClass: null };
const evaluate = (pendingPullRequestAction: boolean, includeImplementation = false) => evaluateWorkflowEvidenceReadiness({
  canonicalCriteria: includeImplementation ? [implementation, pr] : [pr], criterionMappings: [], coverage: [], evidence: [],
  pendingPullRequestAction, enforceCoverage: true,
});

test("only a forward reachable PR completion contract permits deferral, never its name or repair route", () => {
  assert.equal(workflowHasPendingPullRequestAction(graph), true);
  const reportedVersion = BUILTIN_WORKFLOWS.find((workflow) => workflow.definition.id === NO_MISTAKES_REVIEW_WORKFLOW_ID)!.versions[21]!;
  assert.equal(workflowHasPendingPullRequestAction(reportedVersion.graph), true, "reported No-Mistakes v22 owns publication");
  assert.equal(workflowHasPendingPullRequestAction(graph, publication.id), false);
  assert.equal(workflowHasPendingPullRequestAction(graph, "missing-node"), false);
  assert.equal(workflowHasPendingPullRequestAction({ ...graph, edges: [] }), false);
  assert.equal(workflowHasPendingPullRequestAction({ ...graph, nodes: graph.nodes.map((node) => node.id === publication.id && node.kind === "session_action"
    ? { ...node, action: { ...node.action, completion: { kind: "session_turn" } } } : node) }), false);
  assert.equal(workflowHasPendingPullRequestAction({ ...graph, edges: graph.edges.map((edge) => edge.target === publication.id
    ? { ...edge, sourcePort: "fail" } : edge) }), false);
});

test("publication deferral leaves material work owed and blocks all ordinary evidence gaps", () => {
  const ready = WorkflowEvidenceReadinessResultSchema.parse(evaluate(true));
  assert.equal(ready.status, "ready");
  assert.equal(ready.criteria[0]?.material, true);
  assert.equal(ready.criteria[0]?.matchedClientCriterionId, null);
  assert.equal(ready.criteria[0]?.deferredToAction, "pull_request");
  assert.equal(evaluate(false).status, "gaps", "PR proof is required after the action or without it");
  const missingCode = evaluate(true, true);
  assert.equal(missingCode.status, "gaps");
  assert.deepEqual(missingCode.criteria[0]?.gaps, ["missing_coverage"]);
  assert.deepEqual(missingCode.criteria[1]?.gaps, []);
  const legacy = WorkflowCanonicalCriterionSchema.parse({ ...pr, fulfilledByAction: undefined });
  assert.equal(evaluateWorkflowEvidenceReadiness({ canonicalCriteria: [legacy], criterionMappings: [], coverage: [], evidence: [],
    pendingPullRequestAction: true }).status, "gaps", "historical criteria are not silently reclassified");
});

test("publication classification survives frozen run criteria and later round reuse without changing stable ids", async () => {
  const raw = {
    primaryGoal: { rawPrompt: "Implement and verify the change, then open a PR", refined: null, sourceNoteKey: "test" },
    humanDecisions: [], priorPersonaFeedback: [], session: { agent: "claude" as const, name: "test", cwd: "/repo", branch: "feature" },
    evidence: { headSha: "abc", diffFingerprint: "diff", diff: "patch", diffTruncated: false, workingTreeDirty: true,
      workingTreeStatus: [], workingTreeStatusTruncated: false, transcript: [], transcriptAnchor: 1, transcriptTruncated: false,
      standards: [], standardsTruncated: false },
  };
  const context = await compactWorkflowContext(raw, { deferReconciliation: true, execute: async (prompt) => {
    assert.match(prompt, /Split mixed requirements/);
    assert.match(prompt, /explicitly requires the PR before review/);
    return { kind: "ok", value: { constraints: [], acceptanceCriteria: [implementation.text, pr.text], canonicalCriteria: [implementation, pr] } };
  } });
  const frozen = workflowRunCriteriaFrom(context, "first", 1)!;
  assert.ok(frozen);
  for (const round of [2, 3, 8]) {
    const next = reuseWorkflowContextCriteria(raw, frozen, `round-${round}`, []);
    assert.deepEqual(next.canonicalCriteria, context.canonicalCriteria);
    assert.equal(next.canonicalCriteria?.[1]?.fulfilledByAction, "pull_request");
  }
  assert.deepEqual(fallbackWorkflowContext(raw, "failure").canonicalCriteria, []);
});


test("repair packets distinguish deferred publication from matched criteria and required repairs", () => {
  const packet = renderEvidenceReadinessPacket({ workflowName: "Review", workflowVersion: 22,
    runId: "run", repository: "repo", round: 8, segment: 0, workflowEvidence: true,
    readiness: evaluate(true, true) });
  assert.match(packet.payload, /Criteria deferred to the Pull Request action/);
  assert.match(packet.payload, /No publication proof or coverage claim is required before that action/);
  assert.match(packet.payload, /Declare and link an author-controlled coverage claim/);
  assert.doesNotMatch(packet.payload, /Criteria already matched/);
});

test("a forged deferral cannot enter Persona input without a matching canonical classification and pending action", () => {
  const context = fallbackWorkflowContext({
    primaryGoal: { rawPrompt: "Open a PR", refined: null, sourceNoteKey: "test" }, humanDecisions: [], priorPersonaFeedback: [],
    session: { agent: "claude", name: "test", cwd: "/repo", branch: "feature" },
    evidence: { headSha: "abc", diffFingerprint: "diff", diff: "patch", diffTruncated: false, workingTreeDirty: true,
      workingTreeStatus: [], workingTreeStatusTruncated: false, transcript: [], transcriptAnchor: 1, transcriptTruncated: false,
      standards: [], standardsTruncated: false },
  }, null);
  context.canonicalCriteria = [pr];
  const submission = { id: "submission", round: 1, segment: 0, context, readiness: evaluate(true), continuationNodeId: null } as unknown as WorkflowSubmission;
  const version = BUILTIN_WORKFLOWS.find((workflow) => workflow.definition.id === NO_MISTAKES_REVIEW_WORKFLOW_ID)!.versions.at(-1)!;
  assert.equal(personaReviewInput(submission, version).criteria[0]?.deferredToAction, "pull_request");
  assert.throws(() => personaReviewInput({ ...submission, continuationNodeId: publication.id }, version), /no pending publication action/);
  context.canonicalCriteria = [{ ...pr, fulfilledByAction: undefined }];
  assert.throws(() => personaReviewInput(submission, version), /no pending publication action/);
});


test("deferring publication never excuses incomplete execution proof or a rejected criterion citation", () => {
  const input = {
    canonicalCriteria: [implementation, pr], criterionMappings: [], evidence: [], pendingPullRequestAction: true,
    coverage: [{ clientCriterionId: "code-proof", criterionId: "code", criterion: implementation.text,
      proofClass: "focused_execution" as const, repositoryScope: "all" as const, links: [] }],
  };
  assert.deepEqual(evaluateWorkflowEvidenceReadiness(input).criteria[0]?.gaps, ["missing_execution"]);
  const invalid = evaluateWorkflowEvidenceReadiness({ ...input, coverage: [{ ...input.coverage[0]!, criterionId: "unknown" }] });
  assert.ok(invalid.gapCodes.includes("unknown_criterion_id"));
  assert.ok(invalid.gapCodes.includes("missing_coverage"));
});


test("legacy timing classification rejects missing, duplicate, foreign, malformed, and failed answers without changing criteria", async () => {
  const context = fallbackWorkflowContext({
    primaryGoal: { rawPrompt: "Implement the change and open a PR", refined: null, sourceNoteKey: "legacy" },
    humanDecisions: [], priorPersonaFeedback: [], session: { agent: "claude", name: "test", cwd: "/repo", branch: "feature" },
    evidence: { headSha: "abc", diffFingerprint: "diff", diff: "patch", diffTruncated: false, workingTreeDirty: true,
      workingTreeStatus: [], workingTreeStatusTruncated: false, transcript: [], transcriptAnchor: 1, transcriptTruncated: false,
      standards: [], standardsTruncated: false },
  }, null);
  context.canonicalCriteria = [implementation, { ...pr, fulfilledByAction: undefined }];
  const before = structuredClone(context);
  const valid = [{ criterionId: "code", fulfilledByAction: null }, { criterionId: "pr", fulfilledByAction: "pull_request" as const }];
  for (const classifications of [[], [valid[0]!], [valid[0]!, valid[0]!], [...valid, valid[0]!],
    [valid[0]!, { criterionId: "foreign", fulfilledByAction: "pull_request" as const }]]) {
    assert.equal(await classifyWorkflowCriterionFulfillment(context, { execute: async () => ({ kind: "ok", value: { classifications } }) }), null);
  }
  assert.equal(await classifyWorkflowCriterionFulfillment(context, { execute: async () => ({ kind: "failed", cause: "transport", reason: "Unavailable" }) }), null);
  assert.equal(await classifyWorkflowCriterionFulfillment(context, { execute: async () => { throw new Error("Interrupted"); } }), null);
  assert.deepEqual(await classifyWorkflowCriterionFulfillment(context, { execute: async (prompt) => {
    assert.match(prompt, /do not split, combine, add, remove, or reword/);
    assert.match(prompt, /explicitly requires the PR before review/);
    return { kind: "ok", value: { classifications: valid } };
  } }), valid);
  assert.deepEqual(context, before);
  context.canonicalCriteria = [{ ...implementation, fulfilledByAction: null }, pr];
  assert.deepEqual(await classifyWorkflowCriterionFulfillment(context, { execute: async () => { throw new Error("Already classified"); } }), []);
});
