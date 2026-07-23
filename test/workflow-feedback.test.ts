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
import { renderWorkflowFeedback } from "../src/server/workflows/feedback.ts";

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
      persona("second", "Second reviewer"),
      persona("first", "First reviewer"),
    ],
    edges: [],
  },
  completionPolicy: { kind: "none" },
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
  assert.equal(first.payloadSha256.length, 64);
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
  assert.match(rendered.payload, /\[Workflow repair packet truncated deterministically\.\]$/);
  assert.equal(rendered.truncated, true);
});
