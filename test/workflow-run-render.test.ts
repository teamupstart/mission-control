import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { WorkflowRunDetail } from "../src/shared/workflow.ts";
import { WorkflowRunView } from "../src/web/workflows/WorkflowRuns.tsx";
import { workflowBindingSelection } from "../src/web/workflows/WorkflowBindingDialog.tsx";
import type { Session } from "../src/shared/types.ts";
import type { WorkflowBinding } from "../src/shared/workflow.ts";

const detail: WorkflowRunDetail = {
  summary: {
    id: "run",
    bindingId: "binding",
    workflowId: "workflow",
    workflowName: "Release review",
    workflowVersion: 2,
    sessionId: "session",
    noteKey: "note",
    status: "waiting_for_session",
    phase: "persona_feedback",
    round: 1,
    maxRepairRounds: 5,
    activePersonaNames: [],
    failedPersonaCount: 1,
    bypassedPersonaReview: false,
    updatedAt: 10,
  },
  binding: {
    id: "binding",
    workflowVersionId: "version",
    noteKey: "note",
    sessionId: "session",
    sessionAgent: "claude",
    sessionName: "work",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "manual",
    deliveryMode: "preview",
    state: "active",
    maxRepairRounds: 5,
    createdAt: 1,
    updatedAt: 1,
  },
  version: {
    id: "version",
    workflowId: "workflow",
    version: 2,
    sourceDraftRevision: 4,
    graph: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        {
          id: "persona",
          kind: "persona",
          position: { x: 150, y: 0 },
          persona: {
            sourcePersonaId: "persona",
            sourceRevision: 1,
            name: "Quality",
            description: "",
            guidanceMarkdown: "Review",
            runner: null,
            model: null,
          },
        },
      ],
      edges: [],
    },
    completionPolicy: { kind: "none" },
    bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 },
    publishedAt: 1,
  },
  run: {
    id: "run",
    bindingId: "binding",
    workflowVersionId: "version",
    status: "waiting_for_session",
    currentPhase: "persona_feedback",
    maxRepairRounds: 5,
    triggerSource: "manual",
    triggerKey: "manual:binding:req",
    inspectorPrKey: null,
    inspectorHeadSha: null,
    gateState: { outcome: "fail", requestedChanges: ["packet"] },
    startedAt: 1,
    updatedAt: 10,
    completedAt: null,
  },
  submissions: [{
    id: "submission",
    runId: "run",
    round: 1,
    mode: "full_workflow",
    triggerSource: "manual",
    triggerKey: "manual:binding:req",
    evidenceFingerprint: "fingerprint",
    context: {
      primaryGoal: { rawPrompt: "RAW GOAL", refined: "Refined goal", sourceNoteKey: "note" },
      humanDecisions: [{
        decision: "Keep compatibility",
        rationale: "Customers rely on it",
        source: { kind: "review", id: "review" },
      }],
      constraints: [],
      acceptanceCriteria: [],
      priorPersonaFeedback: [],
      session: { agent: "claude", name: "work", cwd: "/repo", branch: "feature" },
      evidence: {
        headSha: "abc",
        diffFingerprint: "diff",
        diff: "PATCH",
        diffTruncated: true,
        workingTreeDirty: true,
        workingTreeStatus: [" M file.ts"],
        transcript: [],
        transcriptAnchor: 1,
        transcriptTruncated: false,
        standards: [],
        standardsTruncated: false,
      },
      compaction: { status: "fallback", runner: "claude", model: "cheap", error: "timeout" },
    },
    evidence: {},
    prHeadSha: null,
    status: "waiting_for_session",
    createdAt: 1,
    updatedAt: 10,
    completedAt: null,
  }],
  attempts: [{
    id: "attempt",
    submissionId: "submission",
    nodeId: "persona",
    attempt: 1,
    state: "completed",
    persona: {
      sourcePersonaId: "persona",
      sourceRevision: 1,
      name: "Quality",
      description: "",
      guidanceMarkdown: "Review",
      runner: null,
      model: null,
    },
    runner: "claude",
    model: "reviewer",
    verdict: {
      verdict: "fail",
      summary: "One issue remains",
      requestedChanges: [{
        title: "Fix the race",
        rationale: "Restart can duplicate work",
        evidence: [{ kind: "diff", quote: "changed line", path: "src/engine.ts", line: 42 }],
        path: "src/engine.ts",
        line: 42,
      }],
      confidence: 0.9,
    },
    output: null,
    retryAt: null,
    inputFingerprint: "input",
    error: null,
    createdAt: 1,
    updatedAt: 2,
    startedAt: 1,
    finishedAt: 2,
  }],
  receipts: [],
  events: [{ id: 1, runId: "run", timestamp: 1, kind: "persona_verdict", payload: { verdict: "fail" } }],
};

test("run detail renders raw context, fallback, verdict, Join packet, waiting actions, and timeline", () => {
  const html = renderToStaticMarkup(
    createElement(WorkflowRunView, {
      detail,
      onResubmit: async () => {},
      onRetry: async () => {},
      onCancel: async () => {},
    }),
  );
  assert.match(html, /RAW GOAL/);
  assert.match(html, /Keep compatibility/);
  assert.match(html, /Deterministic fallback/);
  assert.match(html, /Compaction fallback: timeout/);
  assert.match(html, /Diff<\/dt><dd>truncated/);
  assert.match(html, /Fix the race/);
  assert.match(html, /changed line/);
  assert.match(html, /claude\/reviewer/);
  assert.match(html, /Join and gate packet/);
  assert.match(html, /Preview fresh evidence/);
  assert.match(html, /Preview unchanged/);
  assert.match(html, /Copy feedback/);
  assert.match(html, /Open session/);
  assert.match(html, /persona verdict/);
  assert.doesNotMatch(html, />Send</);
});

test("binding selection reuses only the requested immutable version", () => {
  const session = {
    id: "session",
    state: "idle",
    agent: "claude",
    cwd: "/repo",
    repoRoot: "/repo",
  } as Session;
  const binding = {
    id: "binding",
    workflowVersionId: "version-one",
    state: "active",
    sessionId: "session",
  } as WorkflowBinding;

  assert.equal(
    workflowBindingSelection([binding], session, "version-one").existing?.id,
    "binding",
  );
  const mismatch = workflowBindingSelection([binding], session, "version-two");
  assert.equal(mismatch.existing, undefined);
  assert.equal(mismatch.conflict?.id, "binding");

  const pausedOther = {
    ...binding,
    id: "paused-other",
    workflowVersionId: "version-two",
    state: "paused",
    sessionId: null,
    sessionAgent: "claude",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
  } as WorkflowBinding;
  const pausedExact = {
    ...pausedOther,
    id: "paused-exact",
    workflowVersionId: "version-one",
  } as WorkflowBinding;
  assert.equal(
    workflowBindingSelection([pausedOther, pausedExact], session, "version-one").existing?.id,
    "paused-exact",
  );
  assert.equal(
    workflowBindingSelection([pausedExact, binding], session, "version-two").conflict?.id,
    "binding",
  );
  assert.deepEqual(
    workflowBindingSelection([pausedOther], session, "version-one"),
    { existing: undefined, conflict: undefined },
  );
});
