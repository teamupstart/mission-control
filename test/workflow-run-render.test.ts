import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { WorkflowRunDetail } from "../src/shared/workflow.ts";
import {
  WorkflowRunView,
  workflowNodeStatuses,
} from "../src/web/workflows/WorkflowRuns.tsx";
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
        workingTreeStatusTruncated: true,
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
  deliveries: [],
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
  assert.match(html, /status truncated/);
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
  // A manually started run carries no provenance line at all rather than an empty one.
  assert.doesNotMatch(html, /Started by/);
});

test("external provenance renders as text, not as a link to a route that does not exist", () => {
  const html = renderToStaticMarkup(
    createElement(WorkflowRunView, {
      detail: {
        ...detail,
        externalSource: { kind: "ensemble" as const, sourceId: "ens-42", createdAt: 5 },
      },
      onResubmit: async () => {},
      onRetry: async () => {},
      onCancel: async () => {},
    }),
  );
  assert.match(html, /Started by Ensemble/);
  assert.match(html, /ens-42/);
  // The Ensembles route lands with the dashboard that owns it. Shipping the link first
  // would give an operator a control that goes nowhere.
  assert.doesNotMatch(html, /<a [^>]*ens-42/);
  assert.doesNotMatch(html, /#\/workflows\/ensembles/);
});

test("run canvas statuses come only from the latest repair submission", () => {
  const oldAttempt = {
    ...detail.attempts[0]!,
    id: "old-attempt-3",
    attempt: 3,
    state: "error" as const,
    verdict: null,
  };
  const latestSubmission = {
    ...detail.submissions[0]!,
    id: "submission-2",
    round: 2,
    status: "running" as const,
  };
  const latestAttempt = {
    ...detail.attempts[0]!,
    id: "latest-attempt-1",
    submissionId: latestSubmission.id,
    attempt: 1,
    state: "running" as const,
    verdict: null,
  };
  assert.deepEqual(workflowNodeStatuses({
    ...detail,
    submissions: [detail.submissions[0]!, latestSubmission],
    attempts: [oldAttempt, latestAttempt],
  }), {
    persona: "running",
  });
});

test("run detail renders exact delivery audit and only explicit recovery controls", () => {
  const delivery = {
    id: "delivery",
    runId: "run",
    submissionId: "submission",
    kind: "persona_feedback" as const,
    sessionId: "session",
    noteKey: "note",
    payload: "EXACT REPAIR PACKET",
    payloadSha256: "a".repeat(64),
    state: "uncertain" as const,
    error: "outcome_unknown",
    createdAt: 2,
    updatedAt: 3,
    deliveredAt: null,
  };
  const html = renderToStaticMarkup(createElement(WorkflowRunView, {
    detail: {
      ...detail,
      binding: { ...detail.binding, deliveryMode: "live" },
      deliveries: [delivery],
      events: [{
        id: 2,
        runId: "run",
        timestamp: 2,
        kind: "workflow_completion_claimed",
        payload: {
          completionKind: "drain",
          marker: "1234567890abcdef",
          summary: "Foreman proved the queue complete.",
          state: "resubmitted",
        },
      }],
    },
    onResubmit: async () => {},
    onRetry: async () => {},
    onCancel: async () => {},
  }));
  assert.match(html, /Live · version 2/);
  assert.match(html, /EXACT REPAIR PACKET/);
  assert.match(html, new RegExp("a".repeat(64)));
  assert.match(html, /Mark delivered/);
  assert.match(html, /Discard and send new round/);
  assert.match(html, /drain · resubmitted/);
  assert.match(html, /1234567890ab/);
  assert.match(html, /Foreman proved the queue complete/);
  assert.doesNotMatch(html, /Retry refused delivery/);
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
