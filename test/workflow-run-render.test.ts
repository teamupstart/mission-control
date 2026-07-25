import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { WorkflowRunDetail } from "../src/shared/workflow.ts";
import {
  WorkflowRunView,
  workflowNodeStatuses,
  workflowRunLoadError,
} from "../src/web/workflows/WorkflowRuns.tsx";
import { WorkflowApiError } from "../src/web/workflows/workflowApi.ts";
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
    gate: "none",
    gatePrNumber: null,
    gateHeadShort: null,
    reviewPosture: null,
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
  contextState: "captured",
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
  inspectorGate: null,
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

test("run detail distinguishes malformed durable data from expired history", () => {
  const corrupt = workflowRunLoadError(new WorkflowApiError(
    "workflow run data is malformed",
    500,
    { code: "workflow_run_corrupt" },
  ));
  const expired = workflowRunLoadError(new WorkflowApiError(
    "no such workflow run",
    404,
    { code: "workflow_run_not_found" },
  ));
  assert.match(corrupt, /malformed durable data/);
  assert.match(corrupt, /restore it from backup/);
  assert.match(expired, /no longer retained/);
  assert.notEqual(corrupt, expired);
});

test("run detail renders not-captured and corrupt context states safely", () => {
  const notCaptured = renderToStaticMarkup(
    createElement(WorkflowRunView, {
      detail: {
        ...detail,
        contextState: "not_captured",
        submissions: [{
          ...detail.submissions[0]!,
          context: {},
          status: "cancelled",
        }],
      },
      onResubmit: async () => {},
      onRetry: async () => {},
      onCancel: async () => {},
    }),
  );
  assert.match(notCaptured, /Intent and evidence not captured/);
  assert.doesNotMatch(notCaptured, /Captured intent and evidence<\/h4>/);

  const corrupt = renderToStaticMarkup(
    createElement(WorkflowRunView, {
      detail: {
        ...detail,
        contextState: "corrupt",
        submissions: [{
          ...detail.submissions[0]!,
          context: { compaction: {} },
        }],
      },
      onResubmit: async () => {},
      onRetry: async () => {},
      onCancel: async () => {},
    }),
  );
  assert.match(corrupt, /Captured intent and evidence are corrupt/);
  assert.match(corrupt, /restore it from backup/);
});

test("external provenance deep-links an ensemble source to its Ensembles-tab route", () => {
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
  // The Ensembles route landed with the Phase 7 dashboard, so the source id is now a deep link
  // into the run that started this workflow - not dead text.
  assert.match(html, /<a [^>]*href="#\/workflows\/ensembles\/ens-42"/);
  assert.match(html, /ens-42/);
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

test("Inspector final gate renders provenance, heads, policies, findings, actions, and bypass audit", () => {
  const state = {
    prKey: "owner/repo#91",
    prUrl: "https://github.com/owner/repo/pull/91",
    targetHeadSha: "new-head",
    failedHeadSha: "new-head",
    enteredAt: 8,
    lastObservedAt: 9,
    observedHeadSha: "new-head",
    reviewPosture: "live" as const,
    waitReason: "findings" as const,
    findingFingerprints: ["finding"],
  };
  const inspectorOnly = {
    ...detail.submissions[0]!,
    id: "inspector-only",
    round: 2,
    mode: "inspector_only" as const,
    context: {
      bypassReason: "Published Inspector-only findings policy",
      failedHeadSha: "old-head",
      newHeadSha: "new-head",
      priorFindingFingerprints: ["finding"],
    },
    evidence: { prHeadSha: "new-head" },
    prHeadSha: "new-head",
    status: "completed" as const,
  };
  const gated: WorkflowRunDetail = {
    ...detail,
    summary: {
      ...detail.summary,
      status: "waiting_for_new_head",
      phase: "inspector_findings",
      round: 2,
      bypassedPersonaReview: true,
      gate: "findings",
      gatePrNumber: 91,
      gateHeadShort: "new-head",
      reviewPosture: "live",
    },
    version: {
      ...detail.version!,
      completionPolicy: {
        kind: "inspector",
        onFindings: "inspector_only",
        missingPrAction: "offer_prepare_pr",
      },
    },
    run: {
      ...detail.run,
      status: "waiting_for_new_head",
      currentPhase: "inspector_findings",
      inspectorPrKey: state.prKey,
      inspectorHeadSha: state.targetHeadSha,
      gateState: state,
    },
    submissions: [detail.submissions[0]!, inspectorOnly],
    inspectorGate: {
      state,
      inspector: { enabled: true, mode: "live", posture: "live" },
      inspection: {
        key: state.prKey,
        url: state.prUrl,
        owner: "owner",
        repo: "repo",
        number: 91,
        repoRoot: "/repo",
        cwd: "/repo",
        sessionId: "session",
        source: "no-mistakes",
        state: "open",
        headSha: "new-head",
        reviewPosture: "live",
        round: 3,
        lastReviewedAt: 9,
        lastError: "waiting on retry",
        failCount: 1,
        lastFailKind: "persistent",
        nextAttemptAt: 11,
        lastAttemptSha: "new-head",
        mergedAt: null,
        mergeBlock: "workflow-gate-pending",
        adoptedAt: 2,
        updatedAt: 9,
        openFindings: 1,
        postedOpenFindings: 1,
        resolvedFindings: 0,
      },
      findings: [{
        id: "finding",
        prKey: state.prKey,
        fingerprint: "finding",
        path: "src/gate.ts",
        line: 42,
        title: "Preserve provenance",
        body: null,
        severity: "major",
        round: 3,
        status: "open",
        replies: 0,
        answeredCommentId: null,
        createdAt: 9,
        updatedAt: 9,
      }],
    },
  };
  const html = renderToStaticMarkup(createElement(WorkflowRunView, {
    detail: gated,
    onResubmit: async () => {},
    onRetry: async () => {},
    onCancel: async () => {},
  }));
  assert.match(html, /Final gate/);
  assert.match(html, /#91/);
  assert.match(html, /no-mistakes/);
  assert.match(html, /Target head/);
  assert.match(html, /Observed head/);
  assert.match(html, /Reviewed head/);
  assert.match(html, /inspector only/);
  assert.match(html, /offer prepare pr/);
  assert.match(html, /Preserve provenance/);
  assert.match(html, /Legacy finding: detail was not persisted/);
  assert.match(html, /Persona review bypassed for Inspector repair/);
  assert.match(html, /audited repair submission moved from old-head to new-head/);
  assert.match(html, /Recheck Inspector/);
  assert.match(html, /Restart full workflow/);
  assert.match(html, /Open Inspector settings/);
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
