/**
 * What is at stake: a run has to stay watchable, and it has to stay watchable in NAMES.
 *
 * The runs monitor was rebuilt around the pipeline its author drew. Two things can go
 * wrong in a rebuild like that and neither throws: an affordance the old reader exposed
 * quietly disappears (there is no other way to resolve an uncertain delivery, or to restart
 * an Inspector-only repair), or a node id leaks back into the markup and the surface is the
 * UUID wall it replaced. So this file pins the whole affordance inventory against the
 * fixtures that enable each one, and scans every rendering for the graph's own identities.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type {
  PersonaSnapshot,
  WorkflowBinding,
  WorkflowNodeAttempt,
  WorkflowRunDetail,
  WorkflowSubmission,
  WorkflowVersion,
} from "../src/shared/workflow.ts";
import { WorkflowRunView, WorkflowRunsEmpty } from "../src/web/workflows/WorkflowRuns.tsx";
import { workflowRunLoadError } from "../src/web/workflows/run-model.ts";
import { WorkflowApiError } from "../src/web/workflows/workflowApi.ts";
import { workflowBindingSelection } from "../src/web/workflows/WorkflowBindingDialog.tsx";
import type { Session } from "../src/shared/types.ts";

/**
 * Graph identities are real UUIDs on purpose: the leak this file guards against is a node
 * or edge id reaching the screen, and an id spelled "persona" would render harmlessly and
 * prove nothing. Every other durable id in the fixture is a short word, so the scan below
 * can tell "the graph leaked" from "the run id is in an export link", which it is meant
 * to be.
 */
const NODE = {
  session: "8a1f0b4e-1111-4000-8000-000000000001",
  quality: "8a1f0b4e-1111-4000-8000-000000000002",
  security: "8a1f0b4e-1111-4000-8000-000000000003",
  join: "8a1f0b4e-1111-4000-8000-000000000004",
  docs: "8a1f0b4e-1111-4000-8000-000000000005",
  end: "8a1f0b4e-1111-4000-8000-000000000006",
};
const EDGE = {
  submitQuality: "8a1f0b4e-2222-4000-8000-000000000001",
  submitSecurity: "8a1f0b4e-2222-4000-8000-000000000002",
  qualityPass: "8a1f0b4e-2222-4000-8000-000000000003",
  qualityFail: "8a1f0b4e-2222-4000-8000-000000000004",
  securityPass: "8a1f0b4e-2222-4000-8000-000000000005",
  securityFail: "8a1f0b4e-2222-4000-8000-000000000006",
  joinFail: "8a1f0b4e-2222-4000-8000-000000000007",
  joinPass: "8a1f0b4e-2222-4000-8000-000000000008",
  docsFail: "8a1f0b4e-2222-4000-8000-000000000009",
  docsPass: "8a1f0b4e-2222-4000-8000-00000000000b",
};

const snapshot = (id: string, name: string): PersonaSnapshot => ({
  sourcePersonaId: id,
  sourceRevision: 3,
  name,
  description: "",
  guidanceMarkdown: "Review",
  runner: null,
  model: null,
});

/** Session -> (Quality and Security, all-pass) -> Documentation -> End. Stage-expressible. */
const version: WorkflowVersion = {
  id: "version",
  workflowId: "workflow",
  version: 2,
  sourceDraftRevision: 4,
  graph: {
    nodes: [
      { id: NODE.session, kind: "session", position: { x: 60, y: 60 } },
      {
        id: NODE.quality,
        kind: "persona",
        position: { x: 340, y: 60 },
        persona: snapshot("p-quality", "Quality reviewer"),
      },
      {
        id: NODE.security,
        kind: "persona",
        position: { x: 340, y: 230 },
        persona: snapshot("p-security", "Security reviewer"),
      },
      { id: NODE.join, kind: "all_pass", position: { x: 620, y: 145 } },
      {
        id: NODE.docs,
        kind: "persona",
        position: { x: 900, y: 60 },
        persona: snapshot("p-docs", "Documentation steward"),
      },
      { id: NODE.end, kind: "end", outcome: "Approved", position: { x: 1180, y: 60 } },
    ],
    edges: [
      { id: EDGE.submitQuality, source: NODE.session, sourcePort: "submitted", target: NODE.quality, targetPort: "activate" },
      { id: EDGE.submitSecurity, source: NODE.session, sourcePort: "submitted", target: NODE.security, targetPort: "activate" },
      { id: EDGE.qualityPass, source: NODE.quality, sourcePort: "pass", target: NODE.join, targetPort: "result" },
      { id: EDGE.qualityFail, source: NODE.quality, sourcePort: "fail", target: NODE.join, targetPort: "result" },
      { id: EDGE.securityPass, source: NODE.security, sourcePort: "pass", target: NODE.join, targetPort: "result" },
      { id: EDGE.securityFail, source: NODE.security, sourcePort: "fail", target: NODE.join, targetPort: "result" },
      { id: EDGE.joinFail, source: NODE.join, sourcePort: "fail", target: NODE.session, targetPort: "return_for_changes" },
      { id: EDGE.joinPass, source: NODE.join, sourcePort: "pass", target: NODE.docs, targetPort: "activate" },
      { id: EDGE.docsFail, source: NODE.docs, sourcePort: "fail", target: NODE.session, targetPort: "return_for_changes" },
      { id: EDGE.docsPass, source: NODE.docs, sourcePort: "pass", target: NODE.end, targetPort: "terminal" },
    ],
  },
  completionPolicy: { kind: "none" },
  bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 },
  publishedAt: 1,
};

const binding: WorkflowBinding = {
  id: "binding",
  workflowVersionId: "version",
  noteKey: "note",
  sessionId: "session",
  sessionAgent: "claude",
  sessionName: "harness/runs-monitor",
  sessionCwd: "/repo",
  sessionRepoRoot: "/repo",
  triggerMode: "manual",
  deliveryMode: "preview",
  state: "active",
  maxRepairRounds: 5,
  createdAt: 1,
  updatedAt: 1,
};

const capturedContext = {
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
    headSha: "abcdef0123456789",
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
};

const submission = (
  id: string,
  round: number,
  overrides: Partial<WorkflowSubmission> = {},
): WorkflowSubmission => ({
  id,
  runId: "run",
  round,
  mode: "full_workflow",
  triggerSource: "manual",
  triggerKey: `manual:binding:${id}`,
  evidenceFingerprint: `fingerprint-${round}`,
  context: capturedContext,
  evidence: {},
  prHeadSha: null,
  status: "completed",
  createdAt: round,
  updatedAt: round,
  completedAt: round,
  ...overrides,
});

const attempt = (
  id: string,
  submissionId: string,
  nodeId: string,
  persona: PersonaSnapshot,
  overrides: Partial<WorkflowNodeAttempt> = {},
): WorkflowNodeAttempt => ({
  id,
  submissionId,
  nodeId,
  attempt: 1,
  state: "completed",
  persona,
  runner: "claude",
  model: "reviewer",
  verdict: null,
  output: null,
  retryAt: null,
  inputFingerprint: "input",
  error: null,
  createdAt: 1,
  updatedAt: 2,
  startedAt: 1000,
  finishedAt: 9000,
  ...overrides,
});

const failVerdict = {
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
};

const passVerdict = {
  verdict: "pass",
  summary: "No risk found",
  approvalDetails: {
    reason: "Every path is guarded",
    evidence: [{ kind: "diff", quote: "guard added", path: "src/gate.ts", line: 7 }],
  },
  requestedChanges: [],
  confidence: 0.8,
};

/**
 * A live run: round 1 asked for changes, round 2 is reviewing. That pair is what the round
 * scrubber exists for, and it is the shape every "is this scoped to the viewed round?"
 * assertion below needs.
 */
function runningDetail(): WorkflowRunDetail {
  const first = submission("submission-1", 1, {
    status: "waiting_for_session",
    completedAt: null,
  });
  const second = submission("submission-2", 2, { status: "running", completedAt: null });
  return {
    summary: {
      id: "run",
      bindingId: "binding",
      workflowId: "workflow",
      workflowName: "Release review",
      workflowVersion: 2,
      sessionId: "session",
      noteKey: "note",
      status: "running",
      phase: "persona_review",
      round: 2,
      maxRepairRounds: 5,
      activePersonaNames: ["Quality reviewer"],
      failedPersonaCount: 1,
      bypassedPersonaReview: false,
      gate: "none",
      gatePrNumber: null,
      gateHeadShort: null,
      reviewPosture: null,
      updatedAt: 10,
    },
    binding,
    version,
    run: {
      id: "run",
      bindingId: "binding",
      workflowVersionId: "version",
      status: "running",
      currentPhase: "persona_review",
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
    submissions: [first, second],
    attempts: [
      attempt("attempt-1", first.id, NODE.quality, snapshot("p-quality", "Quality reviewer"), {
        verdict: failVerdict,
      }),
      attempt("attempt-2", first.id, NODE.security, snapshot("p-security", "Security reviewer"), {
        verdict: passVerdict,
      }),
      attempt("attempt-3", second.id, NODE.quality, snapshot("p-quality", "Quality reviewer"), {
        state: "running",
        finishedAt: null,
      }),
      attempt("attempt-4", second.id, NODE.security, snapshot("p-security", "Security reviewer"), {
        state: "queued",
        startedAt: null,
        finishedAt: null,
      }),
    ],
    receipts: [{
      id: 1,
      submissionId: first.id,
      edgeId: EDGE.qualityFail,
      sourceAttemptId: "attempt-1",
      payload: { outcome: "fail", persona: "Quality reviewer" },
      createdAt: 2,
    }],
    deliveries: [],
    events: [
      { id: 1, runId: "run", timestamp: 1, kind: "run_created", payload: { triggerSource: "manual" } },
      {
        id: 2,
        runId: "run",
        timestamp: 2,
        kind: "persona_verdict",
        payload: {
          nodeId: NODE.quality,
          persona: "Quality reviewer",
          verdict: "fail",
          submissionId: first.id,
        },
      },
      {
        id: 3,
        runId: "run",
        timestamp: 3,
        kind: "submission_created",
        payload: { submissionId: second.id, round: 2 },
      },
    ],
    llmCalls: [{
      id: "call",
      runId: "run",
      submissionId: first.id,
      nodeAttemptId: "attempt-1",
      purpose: "persona_review",
      runner: "claude",
      model: "reviewer",
      attempt: 1,
      state: "succeeded",
      startedAt: 1000,
      finishedAt: 9000,
      durationMs: 8000,
      inputBytes: 12,
      outputBytes: 34,
      costUsd: 0.25,
      errorCode: null,
    }],
    llmCallCount: 1,
    nextLlmCallAfter: null,
    inspectorGate: null,
  } as WorkflowRunDetail;
}

const render = (
  detail: WorkflowRunDetail,
  props: Record<string, unknown> = {},
): string => renderToStaticMarkup(createElement(WorkflowRunView, {
  detail,
  onResubmit: async () => {},
  onRetry: async () => {},
  onCancel: async () => {},
  ...props,
}));

/** Every identity the published graph carries. None of them may reach the screen. */
const GRAPH_IDS = [...Object.values(NODE), ...Object.values(EDGE)];

function assertNoGraphIds(html: string): void {
  for (const id of GRAPH_IDS) {
    assert.doesNotMatch(html, new RegExp(id), `the graph identity ${id} reached the markup`);
  }
  // Belt and braces: nothing UUID-SHAPED at all. Every other durable id in these fixtures is
  // a word, so this catches an id arriving by a route the list above does not know about.
  assert.doesNotMatch(html, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
}

test("a live run is drawn on its authored pipeline, in persona and stage names", () => {
  const html = render(runningDetail());
  // The strip, from the same leaves the editor draws: two termini, a parallel stage with its
  // all-pass gate, and a single-reviewer stage named after its own Persona.
  assert.match(html, /wf-pipeline-strip/);
  assert.match(html, /Stage 1/);
  assert.match(html, /2 reviewers · all must pass/);
  assert.match(html, /Documentation steward/);
  assert.match(html, /Quality reviewer/);
  assert.match(html, /Security reviewer/);
  assert.match(html, /all pass/);
  assert.match(html, /Approved/);
  // Per-reviewer live status on the authored shape - the headline of the phase.
  assert.match(html, /Reviewing/);
  assert.match(html, /Queued/);
  assert.match(html, /Not started/);
  assertNoGraphIds(html);
});

test("the round scrubber defaults to the latest round and scopes what it says", () => {
  const detail = runningDetail();
  const latest = render(detail);
  assert.match(latest, /Round 1/);
  assert.match(latest, /Round 2/);
  // Round 1 is marked as the round that asked for changes even though its submission is
  // merely `waiting_for_session` - a healthy repair loop, and exactly the round an operator
  // is looking for.
  assert.match(latest, /Changes requested/);
  // Latest round selected by default, so round 1's verdict text is not on screen.
  assert.doesNotMatch(latest, /Fix the race/);
  assert.doesNotMatch(latest, /Viewing an earlier round/);

  const earlier = render(detail, { roundId: "submission-1" });
  assert.match(earlier, /Fix the race/);
  assert.match(earlier, /Restart can duplicate work/);
  assert.match(earlier, /changed line/);
  assert.match(earlier, /No risk found/);
  assert.match(earlier, /Every path is guarded/);
  assert.match(earlier, /claude · reviewer/);
  assert.match(earlier, /Viewing an earlier round/);
  // The join packet is that round's receipts, named as its stage rather than as a node id.
  assert.match(earlier, /1 of 2 reviewers reported/);
  assertNoGraphIds(earlier);
});

test("the timeline is phrased in names, not payload JSON", () => {
  const html = render(runningDetail(), { roundId: "submission-1" });
  assert.match(html, /Run-level events/);
  assert.match(html, /Persona verdict/);
  assert.match(html, /Quality reviewer/);
  assert.match(html, /verdict fail/);
  // The old reader printed `JSON.stringify(event.payload)`, which is where most of the ids
  // on this surface came from.
  assert.doesNotMatch(html, /nodeId/);
  assertNoGraphIds(html);
});

test("a waiting run offers both resubmissions, the run actions, and cancel", () => {
  const base = runningDetail();
  const html = render({
    ...base,
    summary: { ...base.summary, status: "waiting_for_session" },
    run: { ...base.run, status: "waiting_for_session" },
  });
  assert.match(html, /Preview fresh evidence/);
  assert.match(html, /Preview unchanged/);
  assert.match(html, /Copy feedback/);
  assert.match(html, /Copy run id/);
  assert.match(html, /Export run/);
  assert.match(html, /Export version/);
  assert.match(html, /Open version/);
  assert.match(html, /Cancel run/);
  assert.match(html, /Workflow-owned model calls/);
  assert.match(html, /harness\/runs-monitor/);
  // The captured evidence sections, with the compaction fallback named.
  assert.match(html, /RAW GOAL/);
  assert.match(html, /Keep compatibility/);
  assert.match(html, /Deterministic fallback/);
  assert.match(html, /Compaction fallback: timeout/);
  assert.match(html, /Diff<\/dt><dd>truncated/);
  assert.match(html, /status truncated/);
  assert.match(html, /Join and gate packet/);
  assertNoGraphIds(html);
});

test("a live delivery keeps every recovery control and says what each state means", () => {
  const base = runningDetail();
  const html = render({
    ...base,
    binding: { ...base.binding, deliveryMode: "live" },
    deliveries: [
      {
        id: "delivery-uncertain",
        runId: "run",
        submissionId: "submission-1",
        kind: "persona_feedback",
        sessionId: "session",
        noteKey: "note",
        payload: "EXACT REPAIR PACKET",
        payloadSha256: "a".repeat(64),
        state: "uncertain",
        error: "outcome_unknown",
        createdAt: 2,
        updatedAt: 3,
        deliveredAt: null,
      },
      {
        id: "delivery-refused",
        runId: "run",
        submissionId: "submission-1",
        kind: "persona_feedback",
        sessionId: "session",
        noteKey: "note",
        payload: "",
        payloadSha256: "b".repeat(64),
        state: "refused",
        error: "pane_blocked",
        createdAt: 2,
        updatedAt: 3,
        deliveredAt: null,
        payloadPrunedAt: 5,
      },
    ],
    events: [...base.events, {
      id: 9,
      runId: "run",
      timestamp: 9,
      kind: "workflow_completion_claimed",
      payload: {
        completionKind: "drain",
        marker: "1234567890abcdef",
        summary: "Foreman proved the queue complete.",
        state: "resubmitted",
      },
    }],
  } as WorkflowRunDetail);
  assert.match(html, /EXACT REPAIR PACKET/);
  assert.match(html, /Mark delivered/);
  assert.match(html, /Discard and send new round/);
  assert.match(html, /Retry refused delivery/);
  // The state is a sentence and the durable code survives beside it, never instead of it.
  assert.match(html, /Delivery uncertain/);
  assert.match(html, /may have landed/);
  assert.match(html, /outcome_unknown/);
  assert.match(html, /pane could not take the write/);
  assert.match(html, /Payload pruned/);
  assert.match(html, /drain completion/);
  assert.match(html, /Foreman proved the queue complete/);
  assertNoGraphIds(html);
});

test("an orphaned binding refuses the send-side recoveries instead of failing at the daemon", () => {
  // Both carry `expectedSessionId` / `expectedNoteKey`, which a binding with no session
  // cannot supply - the route refuses every such call. Offering them anyway is how the retry
  // became a button that silently did nothing and the discard a button that answered with a
  // raw schema dump. Marking a packet delivered needs no session and stays offered.
  const base = runningDetail();
  const deliveries = [
    {
      id: "delivery-uncertain",
      runId: "run",
      submissionId: "submission-1",
      kind: "persona_feedback" as const,
      sessionId: "session",
      noteKey: "note",
      payload: "PACKET",
      payloadSha256: "a".repeat(64),
      state: "uncertain" as const,
      error: null,
      createdAt: 2,
      updatedAt: 3,
      deliveredAt: null,
    },
    {
      id: "delivery-refused",
      runId: "run",
      submissionId: "submission-1",
      kind: "persona_feedback" as const,
      sessionId: "session",
      noteKey: "note",
      payload: "PACKET",
      payloadSha256: "b".repeat(64),
      state: "refused" as const,
      error: null,
      createdAt: 2,
      updatedAt: 3,
      deliveredAt: null,
    },
  ];
  const orphaned = render({
    ...base,
    binding: { ...base.binding, sessionId: null },
    deliveries,
  } as WorkflowRunDetail);
  assert.match(orphaned, /<button[^>]*disabled[^>]*>Retry refused delivery/);
  assert.match(orphaned, /<button[^>]*disabled[^>]*>Discard and send new round/);
  assert.doesNotMatch(orphaned, /<button[^>]*disabled[^>]*>Mark delivered/);
  assert.match(orphaned, /The bound session is gone/);

  const bound = render({ ...base, deliveries } as WorkflowRunDetail);
  assert.doesNotMatch(bound, /<button[^>]*disabled[^>]*>Retry refused delivery/);
  assert.doesNotMatch(bound, /<button[^>]*disabled[^>]*>Discard and send new round/);
});

test("the Inspector gate keeps its state, findings, actions, and bypass audit", () => {
  const base = runningDetail();
  const state = {
    prKey: "owner/repo#91",
    prUrl: "https://github.com/owner/repo/pull/91",
    targetHeadSha: "newhead0123456789",
    failedHeadSha: "oldhead0123456789",
    enteredAt: 8,
    lastObservedAt: 9,
    observedHeadSha: "newhead0123456789",
    reviewPosture: "live" as const,
    waitReason: "findings" as const,
    findingFingerprints: ["finding"],
  };
  const inspectorOnly = submission("submission-3", 3, {
    mode: "inspector_only",
    context: {
      bypassReason: "Published Inspector-only findings policy",
      failedHeadSha: "oldhead0123456789",
      newHeadSha: "newhead0123456789",
      priorFindingFingerprints: ["finding"],
    },
    evidence: { prHeadSha: "newhead0123456789" },
    prHeadSha: "newhead0123456789",
  });
  const html = render({
    ...base,
    summary: {
      ...base.summary,
      status: "waiting_for_new_head",
      round: 3,
      bypassedPersonaReview: true,
      gate: "findings",
      gatePrNumber: 91,
      gateHeadShort: "newhead",
      reviewPosture: "live",
    },
    version: {
      ...version,
      completionPolicy: {
        kind: "inspector",
        onFindings: "inspector_only",
        missingPrAction: "offer_prepare_pr",
      },
    },
    run: { ...base.run, status: "waiting_for_new_head", currentPhase: "inspector_findings" },
    submissions: [...base.submissions, inspectorOnly],
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
        headSha: "newhead0123456789",
        reviewPosture: "live",
        round: 3,
        lastReviewedAt: 9,
        lastError: "waiting on retry",
        failCount: 1,
        lastFailKind: "persistent",
        nextAttemptAt: 11,
        lastAttemptSha: "newhead0123456789",
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
  } as WorkflowRunDetail);
  assert.match(html, /Inspector final gate/);
  assert.match(html, /Inspector left findings that have to be resolved/);
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
  assert.match(html, /moved from oldhead01234 to newhead01234/);
  assert.match(html, /Recheck Inspector/);
  assert.match(html, /Restart full workflow/);
  assert.match(html, /Open Inspector settings/);
  assert.match(html, /Open PR/);
  assert.match(html, /This Inspector repair round ran no Personas/);
  assertNoGraphIds(html);
});

test("Prepare PR and Retry provider call appear only under their own conditions", () => {
  const base = runningDetail();
  const waitingForPr = render({
    ...base,
    summary: { ...base.summary, status: "waiting_for_pr", gate: "waiting_pr" },
    version: {
      ...version,
      completionPolicy: {
        kind: "inspector",
        onFindings: "restart_workflow",
        missingPrAction: "offer_prepare_pr",
      },
    },
    run: { ...base.run, status: "waiting_for_pr", currentPhase: "inspector_gate" },
    inspectorGate: {
      state: {
        prKey: null,
        prUrl: null,
        targetHeadSha: "head",
        failedHeadSha: null,
        enteredAt: 8,
        lastObservedAt: null,
        observedHeadSha: null,
        reviewPosture: null,
        waitReason: "missing_pr",
        findingFingerprints: [],
      },
      inspector: { enabled: true, mode: "live", posture: null },
      inspection: null,
      findings: [],
    },
  } as WorkflowRunDetail);
  assert.match(waitingForPr, /Prepare PR in session/);
  assert.match(waitingForPr, /No pull request has been opened/);
  assert.doesNotMatch(waitingForPr, /Retry provider call/);

  const blocked = render({
    ...base,
    summary: { ...base.summary, status: "blocked" },
    run: { ...base.run, status: "blocked", currentPhase: "infrastructure_error" },
    attempts: base.attempts.map((item) => item.id === "attempt-3"
      ? { ...item, state: "error" as const, error: "provider_timeout" }
      : item),
  } as WorkflowRunDetail);
  assert.match(blocked, /Retry provider call/);
  assert.match(blocked, /Provider timeout\./);
  assert.match(blocked, /provider_timeout/);
  assert.doesNotMatch(blocked, /Prepare PR in session/);
});

test("a version this build cannot express as stages still renders on the canvas", () => {
  const base = runningDetail();
  const html = render({
    ...base,
    version: {
      ...version,
      graph: {
        // Two End nodes: legal in the graph model, not a pipeline. The fallback is what keeps
        // a hand-built workflow's run watchable at all.
        nodes: [
          ...version.graph.nodes,
          {
            id: "8a1f0b4e-3333-4000-8000-000000000001",
            kind: "end",
            outcome: "Rejected",
            position: { x: 1180, y: 300 },
          },
        ],
        edges: version.graph.edges,
      },
    },
  } as WorkflowRunDetail);
  assert.match(html, /drawn freehand rather than as stages/);
  assert.match(html, /workflow-canvas/);
  assert.doesNotMatch(html, /wf-pipeline-strip/);
});

test("a missing immutable version blocks the strip without hiding the run", () => {
  const base = runningDetail();
  const html = render({ ...base, version: null } as WorkflowRunDetail);
  assert.match(html, /The immutable workflow version is missing or corrupt/);
  assert.match(html, /Export run/);
  assert.match(html, /Round 1/);
});

test("run detail renders not-captured and corrupt context states safely", () => {
  const base = runningDetail();
  const notCaptured = render({
    ...base,
    contextState: "not_captured",
    submissions: [{ ...base.submissions[0]!, context: {}, status: "cancelled" }],
  } as WorkflowRunDetail);
  assert.match(notCaptured, /Intent and evidence not captured/);
  assert.doesNotMatch(notCaptured, /Captured intent and evidence<\/h4>/);

  const corrupt = render({
    ...base,
    contextState: "corrupt",
    submissions: [{ ...base.submissions[0]!, context: { compaction: {} } }],
  } as WorkflowRunDetail);
  assert.match(corrupt, /Captured intent and evidence are corrupt/);
  assert.match(corrupt, /restore it from backup/);
});

test("paging controls appear exactly when the daemon says there is more", () => {
  const base = runningDetail();
  const paged = render({
    ...base,
    eventCount: 400,
    nextEventAfter: 3,
    nextLlmCallAfter: "cursor",
  } as WorkflowRunDetail);
  assert.match(paged, /Load more events/);
  assert.match(paged, /Load more model calls/);
  // An unpaged run must not offer a page that does not exist.
  assert.doesNotMatch(render(base), /Load more events/);
});

test("external provenance deep-links an ensemble source to its Ensembles-tab route", () => {
  const html = render({
    ...runningDetail(),
    externalSource: { kind: "ensemble" as const, sourceId: "ens-42", createdAt: 5 },
  } as WorkflowRunDetail);
  assert.match(html, /Started by Ensemble/);
  assert.match(html, /<a [^>]*href="#\/workflows\/ensembles\/ens-42"/);
  // A manually started run carries no provenance line at all rather than an empty one.
  assert.doesNotMatch(render(runningDetail()), /Started by/);
});

test("the empty state offers the binding dialog instead of describing it", () => {
  const withCta = renderToStaticMarkup(createElement(WorkflowRunsEmpty, {
    onBindWorkflow: () => {},
  }));
  assert.match(withCta, /No workflow runs yet/);
  assert.match(withCta, /Bind to a session/);
  // The old copy was an instruction with nothing to click.
  assert.doesNotMatch(withCta, /then submit a manual Preview/);
  // App owns the dialog, so a host that cannot open one renders no dead button.
  assert.doesNotMatch(
    renderToStaticMarkup(createElement(WorkflowRunsEmpty, {})),
    /Bind to a session/,
  );
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

test("binding selection reuses only the requested immutable version", () => {
  // The dialog the empty state's call to action opens: it must never adopt a binding that
  // points at a different published version.
  const session = {
    id: "session",
    state: "idle",
    agent: "claude",
    cwd: "/repo",
    repoRoot: "/repo",
  } as Session;
  const active = {
    id: "binding",
    workflowVersionId: "version-one",
    state: "active",
    sessionId: "session",
  } as WorkflowBinding;

  assert.equal(
    workflowBindingSelection([active], session, "version-one").existing?.id,
    "binding",
  );
  const mismatch = workflowBindingSelection([active], session, "version-two");
  assert.equal(mismatch.existing, undefined);
  assert.equal(mismatch.conflict?.id, "binding");

  const pausedOther = {
    ...active,
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
    workflowBindingSelection([pausedExact, active], session, "version-two").conflict?.id,
    "binding",
  );
  assert.deepEqual(
    workflowBindingSelection([pausedOther], session, "version-one"),
    { existing: undefined, conflict: undefined },
  );
});
