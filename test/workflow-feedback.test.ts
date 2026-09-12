import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  WorkflowContextSnapshot,
  WorkflowNodeAttempt,
  WorkflowRun,
  WorkflowSubmission,
  WorkflowVersion,
  WorkflowJson,
} from "../src/shared/workflow.ts";
import { WORKFLOW_LIMITS } from "../src/shared/workflow.ts";
import {
  renderEvidenceReadinessPacket,
  renderPrHandoff,
  renderUnchangedEvidenceNudge,
  renderWorkflowFeedback,
} from "../src/server/workflows/feedback.ts";

const context: WorkflowContextSnapshot = {
  primaryGoal: { rawPrompt: "Keep the original intent", refined: "Do not use me", sourceNoteKey: "note" },
  humanDecisions: [],
  constraints: [],
  acceptanceCriteria: [],
  priorPersonaFeedback: [],
  session: { agent: "claude", name: "work", cwd: "/repo", branch: "feature" },
  evidence: {
    headSha: "abc",
    diffFingerprint: "fingerprint",
    diff: "",
    diffTruncated: false,
    workingTreeDirty: true,
    workingTreeStatus: [],
    workingTreeStatusTruncated: false,
    transcript: [],
    transcriptAnchor: 12,
    transcriptTruncated: false,
    standards: [],
    standardsTruncated: false,
  },
  compaction: { status: "fallback", runner: null, model: null, error: null },
};

const persona = (id: string, name: string) => ({
  id,
  kind: "persona" as const,
  position: { x: 0, y: 0 },
  persona: {
    sourcePersonaId: id,
    sourceRevision: 1,
    name,
    description: "",
    guidanceMarkdown: "Review.",
    runner: null,
    model: null,
  },
});
const version: WorkflowVersion = {
  id: "version",
  workflowId: "workflow",
  version: 3,
  sourceDraftRevision: 1,
  graph: {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      persona("evidence", "Test Evidence Auditor"),
      persona("second", "Second reviewer"),
      persona("first", "First reviewer"),
    ],
    edges: [],
  },
  completionPolicy: { kind: "none" },
  resumptionPolicy: "manual",
  evidenceReadinessPolicy: "off",
  bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 },
  publishedAt: 1,
};
const run = {
  id: "run",
  bindingId: "binding",
  workflowVersionId: "version",
  status: "waiting_for_session",
  currentPhase: "persona_feedback",
  maxRepairRounds: 5,
  triggerSource: "manual",
  triggerKey: "manual:key",
  inspectorPrKey: null,
  inspectorHeadSha: null,
  gateState: null,
  startedAt: 1,
  updatedAt: 1,
  completedAt: null,
} satisfies WorkflowRun;
const submission = {
  id: "submission",
  runId: run.id,
  round: 2,
  mode: "full_workflow",
  triggerSource: "manual",
  triggerKey: "manual:key",
  evidenceFingerprint: "1234567890abcdefmore",
  context: context as unknown as WorkflowJson,
  evidence: context.evidence as unknown as WorkflowJson,
  segment: 0,
  parentSubmissionId: null,
  continuationNodeId: null,
  continuationNodeAttemptId: null,
  prHeadSha: null,
  status: "waiting_for_session",
  createdAt: 1,
  updatedAt: 1,
  completedAt: null,
} satisfies WorkflowSubmission;

function attempt(nodeId: string, name: string, summary: string): WorkflowNodeAttempt {
  return {
    id: `attempt-${nodeId}`,
    submissionId: submission.id,
    nodeId,
    attempt: 1,
    state: "completed",
    persona: (version.graph.nodes.find((node) => node.id === nodeId) as ReturnType<typeof persona>).persona,
    sessionAction: null,
    runner: "claude",
    model: "review",
    verdict: {
      verdict: "fail",
      summary,
      requestedChanges: [{
        title: `Fix ${name}`,
        rationale: "Because it is required.\u001b[31m",
        evidence: [{ kind: "diff", quote: "unsafe\u0000text", path: `src/${nodeId}.ts`, line: 4 }],
      }],
      confidence: 1,
    },
    output: null,
    retryAt: null,
    inputFingerprint: nodeId,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    startedAt: 1,
    finishedAt: 1,
  };
}

test("repair feedback is deterministic, graph ordered, intent preserving, and control safe", () => {
  const attempts = [
    attempt("first", "first", "reported later"),
    attempt("second", "second", "reported first"),
  ];
  const first = renderWorkflowFeedback({ workflowName: "Review", version, run, submission, attempts });
  const second = renderWorkflowFeedback({ workflowName: "Review", version, run, submission, attempts });
  assert.deepEqual(second, first);
  assert.ok(first.payload.indexOf("Second reviewer") < first.payload.indexOf("First reviewer"));
  assert.match(first.payload, /Keep the original intent/);
  assert.doesNotMatch(first.payload, /Do not use me/);
  assert.doesNotMatch(first.payload, /[\u0000\u001b]/);
  assert.match(first.payload, /already authorized you to commit the scoped work/);
  assert.match(first.payload, /already authorized `submit_workflow_evidence`/);
  assert.match(first.payload, /do not ask the human to resubmit the workflow/);
  assert.match(first.payload, /does not authorize merge/);
  assert.doesNotMatch(first.payload, /Evidence registration recipe:/);
  assert.equal(first.payloadSha256.length, 64);
});

test("Test Evidence repairs name the native channel that can satisfy the rejection", () => {
  const evidenceAttempt = attempt("evidence", "evidence", "The submitted proof is incomplete");
  evidenceAttempt.verdict = {
    verdict: "fail",
    summary: "The UI and focused command are not reviewer-visible",
    requestedChanges: [{
      title: "Register the final screenshot and completed command output",
      rationale: "The snapshot has no rendered pixels or actual test output with an exit code.",
      evidence: [{ kind: "transcript", quote: "The agent only summarized the run." }],
    }],
    confidence: 1,
  };
  const rendered = renderWorkflowFeedback({
    workflowName: "Review",
    version,
    run,
    submission,
    attempts: [evidenceAttempt],
  });
  assert.match(rendered.payload, /Evidence registration recipe:/);
  assert.match(rendered.payload, /`images`/);
  assert.match(rendered.payload, /`commandOutputs`/);
  assert.match(rendered.payload, /Confirm registration succeeded/);
  assert.match(rendered.payload, /ordinary tool-result bodies/);
  assert.match(rendered.payload, /pull-request attachments are not visible/);
});

test("repair feedback caps fields and total bytes with a stable truncation notice", () => {
  const huge = attempt("second", "second", "large goal");
  const rendered = renderWorkflowFeedback({
    workflowName: "Review",
    version,
    run,
    submission: {
      ...submission,
      context: {
        ...context,
        primaryGoal: { ...context.primaryGoal, rawPrompt: "g".repeat(16_000) },
      } as unknown as WorkflowJson,
    },
    attempts: [huge],
  });
  assert.ok(Buffer.byteLength(rendered.payload) <= WORKFLOW_LIMITS.feedbackPayloadBytes);
  assert.match(rendered.payload, /Preserve the user's explicit intent\./);
  assert.match(rendered.payload, /already authorized you to commit the scoped work/);
  assert.match(rendered.payload, /do not ask the human to resubmit the workflow/);
  assert.match(rendered.payload, /\[Workflow repair packet truncated deterministically\.\]$/);
  assert.equal(rendered.truncated, true);
});

test("unchanged-evidence nudges retain scoped authorization and engine-owned resubmission", () => {
  const rendered = renderUnchangedEvidenceNudge({
    workflowName: "No-Mistakes Review",
    workflowVersion: 10,
    runId: "run-1",
    round: 2,
    originalGoal: "Ship the safe change",
    evidenceFingerprint: "1234567890abcdef",
    priorPacket: "Fix the failing assertion.",
    nudge: 1,
    nudgeLimit: 2,
    workflowEvidence: true,
  });
  assert.match(rendered.payload, /already authorized `submit_workflow_evidence`/);
  assert.match(rendered.payload, /do not ask the human to resubmit the workflow/);
  assert.match(rendered.payload, /Exactly two responses are acceptable/);
});

// ---- the PR preparation handoff ----
//
// The handoff asks for a pull request, and phase 3 made a run one REPOSITORY. Two of a
// session's runs can offer this at once into one pane, so the packet has to say which
// repository it means - and a single-repo session must go on reading exactly as it did.

test("a handoff for one repository of a multi-repo task names it and scopes the ask", () => {
  const rendered = renderPrHandoff({
    workflowName: "No-Mistakes Review",
    workflowVersion: 8,
    runId: "run-2",
    originalGoal: "Rename the shared field",
    skillCommand: "/pull-request",
    repoRoot: "/work/beta",
    workflowEvidence: true,
  });
  assert.match(rendered.payload, /Repository: \/work\/beta/);
  assert.match(rendered.payload, /the repository named above/);
  assert.match(rendered.payload, /Leave the task's other repositories alone/);
  assert.match(rendered.payload, /already authorized you to commit the scoped work/);
  assert.match(rendered.payload, /does not authorize merge/);
  assert.match(rendered.payload, /do not ask the human to resubmit the workflow/);
});

test("a handoff on the session's own checkout names no repository and keeps its scoped ask", () => {
  const rendered = renderPrHandoff({
    workflowName: "No-Mistakes Review",
    workflowVersion: 8,
    runId: "run-1",
    originalGoal: "Rename the shared field",
    skillCommand: "/pull-request",
    repoRoot: null,
    workflowEvidence: false,
  });
  assert.doesNotMatch(rendered.payload, /Repository:/);
  assert.match(
    rendered.payload,
    /Use the invoked pull-request skill to commit all reviewed work, push it, and open the pull request/,
  );
  assert.doesNotMatch(rendered.payload, /submit_workflow_evidence/);
  assert.match(rendered.payload, /do not ask the human to resubmit the workflow/);
});

test("an evidence preflight packet names the criteria, their ids, and what contests one", () => {
  const packet = renderEvidenceReadinessPacket({
    workflowName: "No Mistakes",
    workflowVersion: 16,
    runId: "run-1",
    repository: "mission-control",
    round: 1,
    segment: 0,
    workflowEvidence: true,
    readiness: {
      evaluatorVersion: "criterion_mapped_v1",
      status: "gaps",
      criteria: [
        {
          criterionId: "criterion-1-aaaa",
          criterion: "Update modals match the application theme",
          material: true,
          matchedClientCriterionId: null,
          contestedClientCriterionIds: ["themed-modals", "themed-shell"],
          authorProofClass: null,
          suggestedProofClass: "visual",
          links: [],
          gaps: ["ambiguous_mapping"],
          warnings: [],
        },
        {
          criterionId: "criterion-2-bbbb",
          criterion: "Check for updates reflects the theme",
          material: true,
          matchedClientCriterionId: "themed-modals",
          authorProofClass: "visual",
          suggestedProofClass: "visual",
          links: [
            { clientItemId: "shot-available", evidenceId: "img-1", role: "rendered_output" },
          ],
          gaps: [],
          warnings: [],
        },
      ],
      gapCodes: ["ambiguous_mapping"],
      warningCodes: [],
      unavailableReason: null,
    },
  });

  // The identity the author is asked to cite, for the criterion that needs repair.
  assert.match(packet.payload, /Criterion id: criterion-1-aaaa/);
  // The cause, named. An author cannot withdraw a claim it was never told about.
  assert.match(
    packet.payload,
    /Claims currently matched to it: themed-modals, themed-shell/,
  );
  // The two rules that resolve the commonest repair, and the fact evidence is already held.
  assert.match(packet.payload, /one claim may answer several criteria/);
  assert.match(packet.payload, /linked from as many claims as apply/);
  assert.match(packet.payload, /carried into this repair segment/);
  // The rubric, whole: a criterion that passed is still shown, so the author can see the shape
  // it was matched against rather than inferring it from the holes.
  assert.match(
    packet.payload,
    /criterion-2-bbbb: Check for updates reflects the theme \(covered by themed-modals\)/,
  );
});

test("a contested criterion tells the author to withdraw, not to capture more proof", () => {
  const packet = renderEvidenceReadinessPacket({
    workflowName: "No Mistakes",
    workflowVersion: 16,
    runId: "run-1",
    repository: "mission-control",
    round: 1,
    segment: 0,
    workflowEvidence: true,
    readiness: {
      evaluatorVersion: "criterion_mapped_v1",
      status: "gaps",
      criteria: [{
        criterionId: "criterion-1-aaaa",
        criterion: "Update modals match the application theme",
        material: true,
        matchedClientCriterionId: null,
        contestedClientCriterionIds: ["one", "two"],
        authorProofClass: null,
        suggestedProofClass: null,
        links: [],
        gaps: ["ambiguous_mapping"],
        warnings: [],
      }],
      gapCodes: ["ambiguous_mapping"],
      warningCodes: [],
      unavailableReason: null,
    },
  });
  assert.match(packet.payload, /Leave exactly one of the claims listed above on this criterion/);
  assert.doesNotMatch(packet.payload, /match exactly one author-controlled coverage claim/);
});

test("a citation that matched nothing is named before the criteria it left uncovered", () => {
  const packet = renderEvidenceReadinessPacket({
    workflowName: "No Mistakes",
    workflowVersion: 16,
    runId: "run-1",
    repository: "mission-control",
    round: 2,
    segment: 0,
    workflowEvidence: true,
    readiness: {
      evaluatorVersion: "criterion_mapped_v1",
      status: "gaps",
      criteria: [{
        criterionId: "criterion-1-aaaa",
        criterion: "Update modals match the application theme",
        material: true,
        matchedClientCriterionId: null,
        authorProofClass: null,
        suggestedProofClass: null,
        links: [],
        gaps: ["missing_coverage"],
        warnings: [],
      }],
      rejectedCitations: [{ clientCriterionId: "themed-modals", criterionId: "criterion-1-stale" }],
      gapCodes: ["missing_coverage", "unknown_criterion_id"],
      warningCodes: [],
      unavailableReason: null,
    },
  });
  assert.match(
    packet.payload,
    /Claim themed-modals cited criterion-1-stale, which is not a criterion of this run/,
  );
  assert.match(packet.payload, /matched by nothing, including its own text/);
  assert.match(packet.payload, /Copy an id exactly as it appears under a criterion below/);
  // Before the criteria, because it is the reason one of them reports no coverage.
  assert.ok(
    packet.payload.indexOf("Criterion ids that matched nothing")
      < packet.payload.indexOf("## Update modals match the application theme"),
  );
});
