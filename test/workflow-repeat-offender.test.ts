import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  PersonaSnapshot,
  WorkflowNodeAttempt,
  WorkflowSubmission,
} from "../src/shared/workflow.ts";
import { repeatOffenders } from "../src/server/workflows/repeat-offender.ts";

const PERSONA: PersonaSnapshot = {
  sourcePersonaId: "persona-risk",
  sourceRevision: 1,
  name: "Code Risk Reviewer",
  description: "",
  guidanceMarkdown: "Review code risk.",
  runner: null,
  model: null,
};

const FAIL = {
  verdict: "fail",
  summary: "The change remains risky.",
  requestedChanges: [{
    title: "Remove the risk",
    rationale: "The latest round still exposes it.",
    evidence: [{ kind: "diff", quote: "risky line" }],
  }],
  confidence: 0.9,
};

const PASS = {
  verdict: "pass",
  summary: "The risk is resolved.",
  approvalDetails: { reason: "The fix is present.", evidence: [] },
  confidence: 0.9,
};

function submission(round: number): WorkflowSubmission {
  return {
    id: `submission-${round}`,
    runId: "run",
    round,
    segment: 0,
    parentSubmissionId: null,
    continuationNodeId: null,
    continuationNodeAttemptId: null,
    mode: "full_workflow",
    triggerSource: "manual",
    triggerKey: `manual:run:${round}`,
    evidenceFingerprint: `evidence-${round}`,
    context: {},
    evidence: {},
    prHeadSha: null,
    status: "completed",
    createdAt: round,
    updatedAt: round,
    completedAt: round,
  };
}

function attempt(
  round: number,
  patch: Partial<WorkflowNodeAttempt> = {},
): WorkflowNodeAttempt {
  return {
    id: `attempt-${round}-${patch.attempt ?? 1}`,
    submissionId: `submission-${round}`,
    nodeId: "risk-review",
    attempt: 1,
    state: "completed",
    persona: PERSONA,
    sessionAction: null,
    runner: "claude",
    model: "reviewer",
    verdict: FAIL,
    output: null,
    retryAt: null,
    inputFingerprint: `input-${round}`,
    error: null,
    createdAt: round,
    updatedAt: round,
    startedAt: round,
    finishedAt: round,
    ...patch,
  };
}

test("reports three consecutive failures anchored at the latest round", () => {
  assert.deepEqual(
    repeatOffenders(
      [submission(1), submission(2), submission(3)],
      [attempt(1), attempt(2), attempt(3)],
    ),
    [{ nodeId: "risk-review", personaName: "Code Risk Reviewer", rounds: 3 }],
  );
});

test("does not report earlier failures after the member passes the latest round", () => {
  assert.deepEqual(
    repeatOffenders(
      [submission(1), submission(2), submission(3)],
      [attempt(1), attempt(2), attempt(3, { verdict: PASS })],
    ),
    [],
  );
});

test("does not report a single failing round", () => {
  assert.deepEqual(repeatOffenders([submission(1)], [attempt(1)]), []);
});

test("uses only the newest attempt per node in each round", () => {
  assert.deepEqual(
    repeatOffenders(
      [submission(1), submission(2)],
      [
        attempt(1),
        attempt(2, {
          id: "attempt-2-infrastructure",
          attempt: 1,
          state: "error",
          verdict: null,
          error: "provider_unavailable",
        }),
        attempt(2, { id: "attempt-2-retry", attempt: 2 }),
      ],
    ),
    [{ nodeId: "risk-review", personaName: "Code Risk Reviewer", rounds: 2 }],
  );
});

test("an unparsable verdict breaks rather than extends the latest streak", () => {
  assert.deepEqual(
    repeatOffenders(
      [submission(1), submission(2), submission(3)],
      [attempt(1), attempt(2, { verdict: { verdict: "fail" } }), attempt(3)],
    ),
    [],
  );
});

test("does not report check nodes that fail repeatedly", () => {
  assert.deepEqual(
    repeatOffenders(
      [submission(1), submission(2)],
      [
        attempt(1, { nodeId: "typecheck", persona: null }),
        attempt(2, { nodeId: "typecheck", persona: null }),
      ],
    ),
    [],
  );
});

test("a round in which the member did not run breaks the streak", () => {
  assert.deepEqual(
    repeatOffenders(
      [submission(1), submission(2), submission(3)],
      [attempt(1), attempt(3)],
    ),
    [],
  );
});

test("the derivation stays off the run summary and SSE event pair", () => {
  const workflowSource = readFileSync(
    new URL("../src/shared/workflow.ts", import.meta.url),
    "utf8",
  );
  const summarySource = workflowSource.slice(
    workflowSource.indexOf("export interface WorkflowRunSummary"),
    workflowSource.indexOf("export interface WorkflowInspectorGateDetail"),
  );
  assert.doesNotMatch(summarySource, /repeatOffenders/);

  const eventSource = readFileSync(
    new URL("../src/shared/types.ts", import.meta.url),
    "utf8",
  );
  const serverEvents = eventSource.slice(
    eventSource.indexOf("export type ServerEvent"),
    eventSource.indexOf("// ---- session transcript"),
  );
  assert.doesNotMatch(serverEvents, /repeatOffenders/);
  assert.match(
    serverEvents,
    /\| \{ type: "workflow_run_upsert"; run: WorkflowRunSummary \}\n  \| \{ type: "workflow_run_remove"; id: WorkflowRunId \}/,
  );
});
