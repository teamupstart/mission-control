// What is at stake: the generic run detail renders members, artifacts, timeline and outcome for
// ANY strategy, while Best-of-N contributes only its scorecards and select-one decision through
// the result-renderer registry. The evaluator judged blind, but the operator view reveals which
// member each artifact came from. Destructive actions confirm inline; delete demands the id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type {
  EnsembleArtifact,
  EnsembleAttempt,
  EnsembleEvaluation,
  EnsembleMember,
  EnsembleRun,
  EnsembleStageAttempt,
  EnsembleSummary,
} from "../src/shared/ensemble.ts";
import type { EnsembleRunDetailResponse } from "../src/web/ensembles/types.ts";
import { EnsembleDetail } from "../src/web/ensembles/EnsembleDetail.tsx";
import { EnsembleActions } from "../src/web/ensembles/EnsembleActions.tsx";
import { EnsembleRuns } from "../src/web/workflows/EnsembleRuns.tsx";

const run: EnsembleRun = {
  id: "run-1",
  sourceKind: "manual",
  sourceKey: "key-1",
  sourceId: null,
  strategyId: "best_of_n",
  strategyKey: "best_of_n@1",
  strategyVersion: 1,
  strategyLabel: "Best of N",
  title: "Fix the parser",
  intent: "Fix it",
  repoRoot: "/repo",
  baseBranch: "main",
  baseSha: "abcdef0123456789",
  plan: {
    planVersion: 1,
    strategyKey: "best_of_n@1",
    budget: { maxMembers: 3, maxConcurrentMembers: 3, maxWaves: 1, maxStageAttempts: 5, deadlineMs: null },
    information: { kind: "isolated" },
    roles: [],
    stages: [],
  },
  strategyConfig: {},
  status: "awaiting_decision",
  activeStageId: "decide",
  outcome: null,
  workflowHandoff: null,
  unreadable: null,
  error: null,
  createdAt: 1000,
  updatedAt: 2000,
  completedAt: null,
};

function member(over: Partial<EnsembleMember> & { id: string; ordinal: number }): EnsembleMember {
  return {
    runId: "run-1",
    roleKey: `candidate-${over.ordinal}`,
    roleLabel: `Candidate ${over.ordinal}`,
    wave: 1,
    taskId: `task-${over.ordinal}`,
    status: "submitted",
    selectedAttemptId: null,
    resultLabel: null,
    error: null,
    createdAt: 1000,
    updatedAt: 1500,
    ...over,
  };
}

function attempt(over: Partial<EnsembleAttempt> & { id: string; memberId: string }): EnsembleAttempt {
  return {
    runId: "run-1",
    attempt: 1,
    taskId: "task-x",
    sessionId: "sess-x",
    agent: "claude",
    requestedModel: null,
    requestedEffort: null,
    observedModel: "claude-opus",
    baseSha: "abcdef0123456789",
    worktreePath: "/wt",
    branch: "b",
    status: "submitted",
    error: null,
    createdAt: 1000,
    updatedAt: 1500,
    startedAt: 1000,
    finishedAt: 1500,
    ...over,
  };
}

function artifact(over: Partial<EnsembleArtifact> & { id: string; attemptId: string }): EnsembleArtifact {
  return {
    runId: "run-1",
    kind: "commit",
    formatVersion: 1,
    attempt: 1,
    status: "ready",
    locator: { ref: "refs/mission-control/ensembles/run-1/art", snapshotSha: "1111111111", baseSha: "abcdef0123456789" },
    digest: "deadbeef00",
    metadata: {
      reported: { summary: "did the thing", checks: ["npm test"], testEvidence: null },
      observed: { filesChanged: 2, insertions: 10, deletions: 3 },
    },
    error: null,
    createdAt: 1200,
    readyAt: 1300,
    ...over,
  };
}

const stage: EnsembleStageAttempt = {
  id: "sa-1",
  runId: "run-1",
  stageId: "compare",
  driverKind: "review",
  driverKey: "comparative_review@1",
  attempt: 1,
  commandKey: "cmd-1",
  status: "succeeded",
  input: {},
  output: {},
  error: null,
  createdAt: 1400,
  updatedAt: 1500,
  startedAt: 1400,
  finishedAt: 1500,
};

const evaluation: EnsembleEvaluation = {
  id: "eval-1",
  runId: "run-1",
  stageAttemptId: "sa-1",
  attempt: 1,
  method: "comparative_review",
  runnerId: "claude",
  modelId: "claude-opus",
  inputFingerprint: "fp",
  subjectArtifactIds: ["art-1", "art-2"],
  result: {
    payloadVersion: 1,
    body: {
      version: 1,
      recommendedArtifactId: "art-1",
      comparison: "Both compile; the first is cleaner.",
      caveats: ["Neither added a regression test."],
      scorecards: [
        { artifactId: "art-1", score: 90, rank: 1, strengths: ["clean"], risks: [], rationale: "clear fix", confidence: 0.8 },
        { artifactId: "art-2", score: 70, rank: 2, strengths: [], risks: ["broad"], rationale: "works but risky", confidence: 0.5 },
      ],
      evidenceTruncated: false,
    },
  },
  status: "succeeded",
  error: null,
  createdAt: 1400,
  updatedAt: 1500,
  finishedAt: 1500,
};

const detail: EnsembleRunDetailResponse = {
  run,
  members: [member({ id: "m-1", ordinal: 1 }), member({ id: "m-2", ordinal: 2 })],
  attempts: [
    attempt({ id: "at-1", memberId: "m-1", sessionId: "sess-1" }),
    attempt({ id: "at-2", memberId: "m-2", sessionId: "sess-2", observedModel: "codex-1" }),
  ],
  artifacts: [artifact({ id: "art-1", attemptId: "at-1" }), artifact({ id: "art-2", attemptId: "at-2" })],
  stageAttempts: [stage],
  evaluations: [evaluation],
  decisions: [],
  llmCalls: [],
  events: [{ id: 1, runId: "run-1", ts: 1500, kind: "comparison_ready", payload: {} }],
  pagination: { eventsTotal: 1, eventsReturned: 1, attemptsTotal: 2, attemptsReturned: 2 },
};

function renderDetail(over: Partial<EnsembleRunDetailResponse> = {}): string {
  return renderToStaticMarkup(
    createElement(EnsembleDetail, {
      detail: { ...detail, ...over },
      actionPending: null,
      actionError: null,
      onAction: () => {},
      onDelete: () => {},
      onLoadPatch: async () => ({ error: "not loaded" }),
      onOpenSession: () => {},
      onOpenTask: () => {},
      onManualSubmit: async () => null,
      onOpenWorkflowRun: () => {},
    }),
  );
}

test("the generic detail renders the header, members with reported-vs-observed, and the timeline", () => {
  const html = renderDetail();
  assert.match(html, /Fix the parser/);
  assert.match(html, /Best of N v1/);
  assert.match(html, /Awaiting decision/);
  assert.match(html, /Pinned base/);
  assert.match(html, /abcdef0123/); // short base sha
  // Members: both, with the two distinct evidence columns.
  assert.match(html, /Candidate 1/);
  assert.match(html, /Candidate 2/);
  assert.match(html, /Reported by member/);
  assert.match(html, /Observed by Mission Control/);
  assert.match(html, /Claims, not verified/);
  // Timeline surfaces the stage and the evaluation.
  assert.match(html, /Evaluations/);
  assert.match(html, /comparative_review/);
});

test("an active member without a session offers Task focus and manual submission", () => {
  const activeMember = member({ id: "m-3", ordinal: 3, status: "active", taskId: "task-3" });
  const activeAttempt = attempt({ id: "at-3", memberId: "m-3", sessionId: null, status: "running" });
  const html = renderDetail({
    members: [activeMember],
    attempts: [activeAttempt],
    artifacts: [],
  });
  assert.match(html, /Open task/);
  assert.match(html, /Submit result…/);
});

test("the timeline renders durable finalization progress receipts", () => {
  const finalize: EnsembleStageAttempt = {
    ...stage,
    id: "sa-finalize",
    stageId: "finalize",
    driverKind: "finalize",
    driverKey: "select_one_finalize@1",
    status: "running",
    output: {
      step: "handoff",
      verifiedSnapshotSha: "1234567890abcdef",
      winner: { mode: "restored", ready: true },
      continuationInIntent: false,
      losersReaped: true,
      continuationDeliveryKey: "delivery-1",
      continuationDelivered: false,
      error: "workflow unavailable",
    },
  };
  const html = renderDetail({ stageAttempts: [finalize] });
  assert.match(html, /Finalization/);
  assert.match(html, /Resume step/);
  assert.match(html, /1234567890/);
  assert.match(html, /Restored · ready/);
  assert.match(html, /Losers reaped/);
  assert.match(html, /workflow unavailable/);
});

test("Best-of-N scorecards render anonymously-ranked but de-anonymised to their member", () => {
  const html = renderDetail();
  assert.match(html, /Comparison/);
  assert.match(html, /Recommended/);
  assert.match(html, /score 90\/100/);
  // The rank came from the blind comparison; the operator view reveals the member behind it.
  assert.match(html, /Candidate 1 \(claude · claude-opus\)/);
  assert.match(html, /Neither added a regression test/); // caveat
});

test("the decision panel appears while awaiting a person, offers no-consensus, and gates on confirmation", () => {
  const html = renderDetail();
  assert.match(html, /Confirm the outcome/);
  assert.match(html, /No consensus/);
  assert.match(html, /the other worktrees will be reaped/);
  // The confirm button is disabled until the destructive checkbox is ticked.
  assert.match(html, /Confirm winner<\/button>/);
  assert.match(html, /type="submit"[^>]*disabled/);
});

test("a completed run drops the decision panel and offers delete behind an id echo", () => {
  const terminal: EnsembleRun = { ...run, status: "completed", completedAt: 3000 };
  const html = renderToStaticMarkup(
    createElement(EnsembleActions, {
      detail: { ...detail, run: terminal },
      pending: null,
      error: null,
      onAction: () => {},
      onDelete: () => {},
    }),
  );
  assert.doesNotMatch(html, /Cancel run/); // terminal: nothing to cancel
  assert.match(html, /Delete run…/);
});

test("the actions surface offers Cancel while a run is live, but not once terminal", () => {
  const html = renderToStaticMarkup(
    createElement(EnsembleActions, {
      detail,
      pending: null,
      error: null,
      onAction: () => {},
      onDelete: () => {},
    }),
  );
  assert.match(html, /Cancel run…/);
  assert.doesNotMatch(html, /Delete run/); // not terminal
});

test("unreadable runs can still be cancelled and healthy handoffs cannot be skipped", () => {
  const unreadable = {
    ...run,
    status: null,
    unreadable: { reason: "unknown status", fields: ["status"] },
  };
  const unreadableHtml = renderToStaticMarkup(
    createElement(EnsembleActions, {
      detail: { ...detail, run: unreadable },
      pending: null,
      error: null,
      onAction: () => {},
      onDelete: () => {},
    }),
  );
  assert.match(unreadableHtml, /Cancel run…/);

  const healthyHandoff = {
    ...run,
    status: "finalizing" as const,
    workflowHandoff: {
      workflowId: "wf-1",
      workflowVersionId: "wfv-1",
      workflowVersion: 1,
      workflowName: "Review",
      triggerMode: "manual",
      deliveryMode: "reply",
      maxRepairRounds: 1,
      completionPolicy: "approve",
      state: "binding" as const,
      sourceKey: null,
      expectedHeadSha: null,
      bindingId: null,
      runId: null,
      submissionId: null,
      error: null,
    },
  };
  const healthyHtml = renderToStaticMarkup(
    createElement(EnsembleActions, {
      detail: { ...detail, run: healthyHandoff },
      pending: null,
      error: null,
      onAction: () => {},
      onDelete: () => {},
    }),
  );
  assert.doesNotMatch(healthyHtml, /Skip workflow handoff/);
});

test("decision rationale and partial review cost are explicit", () => {
  const html = renderDetail({
    llmCalls: [
      {
        id: "call-1",
        runId: run.id,
        stageAttemptId: stage.id,
        evaluationId: evaluation.id,
        purpose: "comparative_review",
        runnerId: "claude",
        modelId: "opus",
        attempt: 1,
        state: "succeeded",
        startedAt: 1000,
        finishedAt: 1100,
        durationMs: 100,
        inputBytes: 100,
        outputBytes: 100,
        costUsd: 0.1,
        errorCode: null,
      },
      {
        id: "call-2",
        runId: run.id,
        stageAttemptId: stage.id,
        evaluationId: evaluation.id,
        purpose: "comparative_review",
        runnerId: "codex",
        modelId: "gpt",
        attempt: 1,
        state: "succeeded",
        startedAt: 1000,
        finishedAt: 1100,
        durationMs: 100,
        inputBytes: 100,
        outputBytes: 100,
        costUsd: null,
        errorCode: null,
      },
    ],
  });
  assert.match(html, /Rationale \(required/);
  assert.match(html, /partial cost telemetry/);
  assert.doesNotMatch(html, /\$0\.10/);
});

test("the ensembles list sorts attention-first and marks it accessibly", () => {
  const summaries: EnsembleSummary[] = [
    summary({ id: "calm", title: "Calm run", attention: false, updatedAt: 5000 }),
    summary({ id: "urgent", title: "Needs you", attention: true, updatedAt: 1000 }),
  ];
  const html = renderToStaticMarkup(
    createElement(EnsembleRuns, {
      summaries,
      selectedId: null,
      onSelect: () => {},
    }),
  );
  // Attention-first despite the older timestamp: "Needs you" precedes "Calm run".
  assert.ok(html.indexOf("Needs you") < html.indexOf("Calm run"));
  assert.match(html, /aria-label="Needs attention"/);
});

test("the run controller refetches on a 409 and never replays automatically", () => {
  const controller = readFileSync(new URL("../src/web/workflows/EnsembleRuns.tsx", import.meta.url), "utf8");
  assert.match(controller, /result\.status === 409/);
  assert.match(controller, /never replay/i);
  // Detail is fetched per selection with a generation guard, not polled.
  assert.match(controller, /loadGeneration/);
  assert.doesNotMatch(controller, /setInterval/);
});

function summary(over: Partial<EnsembleSummary> & { id: string }): EnsembleSummary {
  return {
    title: "Run",
    repoRoot: "/repo",
    strategyId: "best_of_n",
    strategyKey: "best_of_n@1",
    strategyLabel: "Best of N",
    strategyVersion: 1,
    status: "running",
    activeStageId: null,
    memberCount: 3,
    launchedMembers: 3,
    maxMembers: 3,
    readyArtifacts: 0,
    selectedMemberId: null,
    outcomeKind: null,
    unreadable: null,
    attention: false,
    error: null,
    createdAt: 1000,
    updatedAt: 2000,
    completedAt: null,
    ...over,
  };
}
