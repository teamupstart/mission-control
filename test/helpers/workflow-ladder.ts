import type {
  PersonaSnapshot,
  WorkflowNodeAttempt,
  WorkflowRunDetail,
  WorkflowRunSummary,
  WorkflowSubmission,
  WorkflowVersion,
} from "../../src/shared/workflow.ts";

export const LADDER_NODE = {
  session: "10000000-0000-4000-8000-000000000001",
  typecheck: "10000000-0000-4000-8000-000000000002",
  test: "10000000-0000-4000-8000-000000000003",
  checksJoin: "10000000-0000-4000-8000-000000000004",
  intent: "10000000-0000-4000-8000-000000000005",
  risk: "10000000-0000-4000-8000-000000000006",
  evidence: "10000000-0000-4000-8000-000000000007",
  docs: "10000000-0000-4000-8000-000000000008",
  reviewJoin: "10000000-0000-4000-8000-000000000009",
  end: "10000000-0000-4000-8000-00000000000a",
} as const;

const persona = (id: string, name: string): PersonaSnapshot => ({
  sourcePersonaId: id,
  sourceRevision: 1,
  name,
  description: "",
  guidanceMarkdown: "Review the submitted change.",
  runner: null,
  model: null,
});

const PERSONAS = {
  intent: persona("persona-intent", "Intent Conformance Judge"),
  risk: persona("persona-risk", "Code Risk Reviewer"),
  evidence: persona("persona-evidence", "Test Evidence Auditor"),
  docs: persona("persona-docs", "Documentation Steward"),
};

let edge = 0;
const route = (
  source: string,
  sourcePort: "submitted" | "pass" | "fail",
  target: string,
  targetPort: "activate" | "result" | "return_for_changes" | "terminal",
) => ({
  id: `20000000-0000-4000-8000-${String(++edge).padStart(12, "0")}`,
  source,
  sourcePort,
  target,
  targetPort,
});

export const LADDER_VERSION: WorkflowVersion = {
  id: "version",
  workflowId: "workflow",
  version: 4,
  sourceDraftRevision: 4,
  resumptionPolicy: "manual",
  evidenceReadinessPolicy: "off",
  graph: {
    nodes: [
      { id: LADDER_NODE.session, kind: "session", position: { x: 0, y: 0 } },
      {
        id: LADDER_NODE.typecheck,
        kind: "check",
        slot: "typecheck",
        position: { x: 200, y: 0 },
      },
      {
        id: LADDER_NODE.test,
        kind: "check",
        slot: "test",
        position: { x: 200, y: 140 },
      },
      { id: LADDER_NODE.checksJoin, kind: "all_pass", position: { x: 400, y: 70 } },
      {
        id: LADDER_NODE.intent,
        kind: "persona",
        persona: PERSONAS.intent,
        position: { x: 600, y: 70 },
      },
      {
        id: LADDER_NODE.risk,
        kind: "persona",
        persona: PERSONAS.risk,
        position: { x: 800, y: 0 },
      },
      {
        id: LADDER_NODE.evidence,
        kind: "persona",
        persona: PERSONAS.evidence,
        position: { x: 800, y: 140 },
      },
      {
        id: LADDER_NODE.docs,
        kind: "persona",
        persona: PERSONAS.docs,
        position: { x: 800, y: 280 },
      },
      { id: LADDER_NODE.reviewJoin, kind: "all_pass", position: { x: 1000, y: 140 } },
      {
        id: LADDER_NODE.end,
        kind: "end",
        outcome: "Complete",
        position: { x: 1200, y: 140 },
      },
    ],
    edges: [
      route(LADDER_NODE.session, "submitted", LADDER_NODE.typecheck, "activate"),
      route(LADDER_NODE.session, "submitted", LADDER_NODE.test, "activate"),
      route(LADDER_NODE.typecheck, "pass", LADDER_NODE.checksJoin, "result"),
      route(LADDER_NODE.typecheck, "fail", LADDER_NODE.checksJoin, "result"),
      route(LADDER_NODE.test, "pass", LADDER_NODE.checksJoin, "result"),
      route(LADDER_NODE.test, "fail", LADDER_NODE.checksJoin, "result"),
      route(LADDER_NODE.checksJoin, "fail", LADDER_NODE.session, "return_for_changes"),
      route(LADDER_NODE.checksJoin, "pass", LADDER_NODE.intent, "activate"),
      route(LADDER_NODE.intent, "fail", LADDER_NODE.session, "return_for_changes"),
      route(LADDER_NODE.intent, "pass", LADDER_NODE.risk, "activate"),
      route(LADDER_NODE.intent, "pass", LADDER_NODE.evidence, "activate"),
      route(LADDER_NODE.intent, "pass", LADDER_NODE.docs, "activate"),
      route(LADDER_NODE.risk, "pass", LADDER_NODE.reviewJoin, "result"),
      route(LADDER_NODE.risk, "fail", LADDER_NODE.reviewJoin, "result"),
      route(LADDER_NODE.evidence, "pass", LADDER_NODE.reviewJoin, "result"),
      route(LADDER_NODE.evidence, "fail", LADDER_NODE.reviewJoin, "result"),
      route(LADDER_NODE.docs, "pass", LADDER_NODE.reviewJoin, "result"),
      route(LADDER_NODE.docs, "fail", LADDER_NODE.reviewJoin, "result"),
      route(LADDER_NODE.reviewJoin, "fail", LADDER_NODE.session, "return_for_changes"),
      route(LADDER_NODE.reviewJoin, "pass", LADDER_NODE.end, "terminal"),
    ],
  },
  completionPolicy: {
    kind: "inspector",
    onFindings: "inspector_only",
    missingPrAction: "offer_prepare_pr",
  },
  bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 },
  publishedAt: 1,
};

export const LADDER_SUMMARY: WorkflowRunSummary = {
  id: "run",
  bindingId: "binding",
  workflowId: "workflow",
  workflowName: "No-Mistakes Review",
  workflowVersion: 4,
  sessionId: "session",
  noteKey: "note",
  status: "running",
  phase: "persona_review",
  round: 2,
  maxRepairRounds: 5,
  activePersonaNames: ["Test Evidence Auditor", "Documentation Steward"],
  failedPersonaCount: 0,
  bypassedPersonaReview: false,
  gate: "none",
  gatePrNumber: null,
  gateHeadShort: null,
  reviewPosture: null,
  uncertainDeliveryCount: 0,
  refusedDeliveryCount: 0,
  updatedAt: 10,
};

const PASS = {
  verdict: "pass",
  summary: "The reviewed evidence satisfies this role.",
  approvalDetails: { reason: "The relevant paths are covered.", evidence: [] },
  confidence: 0.92,
};

export const OBJECTION =
  "No end-to-end evidence shows that the alert panel renders for an away session.";

const FAIL = {
  verdict: "fail",
  summary: OBJECTION,
  requestedChanges: [{
    basis: "substantive",
    title: "Render the away state",
    rationale: "The reducer assertion does not prove the visible card.",
    evidence: [{ kind: "diff", quote: "reducer only" }],
  }],
  confidence: 0.96,
};

export const submission = (
  patch: Partial<WorkflowSubmission> = {},
): WorkflowSubmission => ({
  id: "submission",
  runId: "run",
  round: 2,
  segment: 0,
  parentSubmissionId: null,
  continuationNodeId: null,
  continuationNodeAttemptId: null,
  mode: "full_workflow",
  triggerSource: "manual",
  triggerKey: "manual:binding:submission",
  evidenceFingerprint: "fingerprint",
  context: {},
  evidence: {},
  prHeadSha: "4f2ab19c00000000000000000000000000000000",
  status: "running",
  createdAt: 1,
  updatedAt: 10,
  completedAt: null,
  ...patch,
});

export const attempt = (
  nodeId: string,
  patch: Partial<WorkflowNodeAttempt> = {},
): WorkflowNodeAttempt => ({
  id: `attempt-${nodeId}`,
  submissionId: "submission",
  nodeId,
  attempt: 1,
  state: "completed",
  persona: null,
  sessionAction: null,
  runner: null,
  model: null,
  verdict: PASS,
  output: null,
  retryAt: null,
  inputFingerprint: "input",
  error: null,
  createdAt: 1,
  updatedAt: 2,
  startedAt: 1_000,
  finishedAt: 42_000,
  ...patch,
});

const checkAttempt = (nodeId: string, slot: "typecheck" | "test"): WorkflowNodeAttempt =>
  attempt(nodeId, {
    verdict: PASS,
    output: {
      status: "passed",
      slot,
      command: ["npm", slot === "test" ? "test" : "run", slot === "test" ? "" : "typecheck"]
        .filter(Boolean),
      exitCode: 0,
      output: "",
      truncatedBytes: 0,
      note: "The command exited zero.",
    },
  });

const personaAttempt = (
  nodeId: string,
  snapshot: PersonaSnapshot,
  patch: Partial<WorkflowNodeAttempt> = {},
): WorkflowNodeAttempt => attempt(nodeId, {
  persona: snapshot,
  runner: "claude",
  model: "reviewer",
  ...patch,
});

const baseAttempts = (): WorkflowNodeAttempt[] => [
  checkAttempt(LADDER_NODE.typecheck, "typecheck"),
  checkAttempt(LADDER_NODE.test, "test"),
  personaAttempt(LADDER_NODE.intent, PERSONAS.intent),
];

export type LadderState = "reviewing" | "changes" | "gate" | "spent-clean" | "uncertain";

export function ladderDetail(state: LadderState): WorkflowRunDetail {
  const summary: WorkflowRunSummary = { ...LADDER_SUMMARY };
  let currentSubmission = submission();
  let attempts = baseAttempts();
  let inspectorGate: WorkflowRunDetail["inspectorGate"] = null;
  let deliveries: WorkflowRunDetail["deliveries"] = [];

  if (state === "reviewing") {
    attempts.push(
      personaAttempt(LADDER_NODE.risk, PERSONAS.risk),
      personaAttempt(LADDER_NODE.evidence, PERSONAS.evidence, {
        state: "running",
        verdict: null,
        finishedAt: null,
      }),
      personaAttempt(LADDER_NODE.docs, PERSONAS.docs, {
        state: "queued",
        verdict: null,
        startedAt: null,
        finishedAt: null,
      }),
    );
  }

  if (state === "changes" || state === "uncertain") {
    summary.status = state === "uncertain" ? "blocked" : "waiting_for_session";
    summary.phase = state === "uncertain" ? "delivery_uncertain" : "repair_wait";
    summary.failedPersonaCount = state === "uncertain" ? 1 : 2;
    currentSubmission = submission({ status: "waiting_for_session" });
    attempts.push(
      personaAttempt(LADDER_NODE.risk, PERSONAS.risk),
      personaAttempt(LADDER_NODE.evidence, PERSONAS.evidence, { verdict: FAIL }),
      personaAttempt(LADDER_NODE.docs, PERSONAS.docs, {
        verdict: state === "changes" ? { ...FAIL, summary: "The README omits the new chord." } : PASS,
      }),
    );
  }

  if (state === "gate") {
    summary.status = "waiting_for_inspector";
    summary.phase = "inspector_gate";
    summary.round = 3;
    summary.gate = "waiting_inspector";
    summary.gatePrNumber = 301;
    summary.gateHeadShort = "4f2ab19c";
    summary.reviewPosture = "live";
    currentSubmission = submission({ round: 3, status: "completed", completedAt: 10 });
    attempts.push(
      personaAttempt(LADDER_NODE.risk, PERSONAS.risk),
      personaAttempt(LADDER_NODE.evidence, PERSONAS.evidence),
      personaAttempt(LADDER_NODE.docs, PERSONAS.docs),
    );
    inspectorGate = {
      state: {
        prKey: "owner/repo#301",
        prUrl: "https://example.test/pull/301",
        targetHeadSha: "4f2ab19c00000000000000000000000000000000",
        failedHeadSha: null,
        enteredAt: 9,
        lastObservedAt: 10,
        observedHeadSha: "4f2ab19c00000000000000000000000000000000",
        reviewPosture: "live",
        waitReason: "review_pending",
        findingFingerprints: [],
      },
      inspection: null,
      findings: [],
      inspector: { enabled: true, mode: "live", posture: "live" },
    };
  }

  if (state === "spent-clean") {
    const failedHead = "failed0000000000000000000000000000000000";
    const currentHead = "clean00000000000000000000000000000000000";
    summary.status = "blocked";
    summary.phase = "round_limit";
    summary.round = 4;
    summary.maxRepairRounds = 3;
    summary.bypassedPersonaReview = true;
    summary.gate = "blocked";
    summary.gatePrNumber = 301;
    summary.gateHeadShort = failedHead;
    summary.reviewPosture = "live";
    currentSubmission = submission({
      round: 4,
      mode: "inspector_only",
      prHeadSha: failedHead,
      status: "completed",
      completedAt: 10,
    });
    inspectorGate = {
      state: {
        prKey: "owner/repo#301",
        prUrl: "https://example.test/pull/301",
        targetHeadSha: failedHead,
        failedHeadSha: failedHead,
        enteredAt: 9,
        lastObservedAt: 10,
        observedHeadSha: failedHead,
        reviewPosture: "live",
        waitReason: "findings",
        findingFingerprints: ["historical-finding"],
      },
      inspection: {
        key: "owner/repo#301",
        url: "https://example.test/pull/301",
        number: 301,
        source: "hook",
        state: "open",
        observedState: "OPEN",
        observedHeadSha: currentHead,
        headSha: currentHead,
        reviewPosture: "live",
        round: 5,
        lastError: null,
        nextAttemptAt: null,
        openFindings: 0,
        resolvedFindings: 1,
      } as never,
      findings: [{
        id: "historical-finding",
        prKey: "owner/repo#301",
        fingerprint: "historical-finding",
        path: "src/workflows.ts",
        line: 301,
        title: "Historical finding",
        body: "The finding that stopped the workflow is now resolved.",
        severity: "major",
        round: 4,
        status: "resolved",
        replies: 0,
        answeredCommentId: null,
        createdAt: 9,
        updatedAt: 10,
      }],
      inspector: { enabled: true, mode: "live", posture: "live" },
    };
  }

  if (state === "uncertain") {
    summary.uncertainDeliveryCount = 1;
    deliveries = [{
      id: "delivery",
      runId: "run",
      submissionId: "submission",
      kind: "persona_feedback",
      nodeAttemptId: null,
      sessionId: "session",
      noteKey: "note",
      payload: "repair",
      payloadSha256: "sha",
      state: "uncertain",
      error: "write_outcome_unknown",
      createdAt: 10,
      updatedAt: 11,
      deliveredAt: null,
    }];
  }

  return {
    summary,
    binding: {
      id: "binding",
      workflowVersionId: "version",
      noteKey: "note",
      sessionId: "session",
      sessionAgent: "claude",
      sessionName: "harness/workflow-ladder",
      sessionCwd: "/repo",
      sessionRepoRoot: "/repo",
      repoRoot: "",
      triggerMode: "manual",
      deliveryMode: "preview",
      state: "active",
      maxRepairRounds: summary.maxRepairRounds,
      createdAt: 1,
      updatedAt: 10,
    },
    version: LADDER_VERSION,
    run: {
      id: "run",
      bindingId: "binding",
      workflowVersionId: "version",
      status: summary.status,
      currentPhase: summary.phase,
      maxRepairRounds: summary.maxRepairRounds,
      triggerSource: "manual",
      triggerKey: "manual:binding:run",
      inspectorPrKey: summary.gatePrNumber ? "owner/repo#301" : null,
      inspectorHeadSha: summary.gateHeadShort,
      gateState: null,
      startedAt: 1,
      updatedAt: 10,
      completedAt: null,
    },
    contextState: "captured",
    submissions: [currentSubmission],
    attempts,
    receipts: [],
    deliveries,
    events: [],
    llmCalls: [],
    llmCallCount: 0,
    nextLlmCallAfter: null,
    inspectorGate,
  };
}
