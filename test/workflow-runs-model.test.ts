/**
 * What is at stake: which ROUND a statement is about.
 *
 * The runs monitor shows one run through several submissions, and almost every wrong answer
 * it could give is a right answer about the wrong round - a reviewer shown as passed while
 * it is being re-run, an End marked reached on the round that failed, a repair round with no
 * mark on it because its submission is merely `waiting_for_session`. Those are decisions, not
 * markup, so they are checked here directly rather than by rendering and reading back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { WORKFLOW_CHECK_STATUSES, WORKFLOW_GATE_WAIT_REASONS } from "../src/shared/workflow.ts";
import type {
  WorkflowNodeAttempt,
  WorkflowRunDetail,
  WorkflowSubmission,
} from "../src/shared/workflow.ts";
import {
  checkOutcomeOf,
  checkStatus,
  checkStatusView,
  endStatus,
  errorView,
  eventLine,
  eventsByRound,
  gateWaitSentence,
  latestAttemptsFor,
  nodeStatusesForSubmission,
  readCapturedContext,
  reviewerStatus,
  runRounds,
  selectedSubmission,
  stageStatus,
  submissionStatus,
} from "../src/web/workflows/run-model.ts";

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
  triggerKey: `manual:${id}`,
  evidenceFingerprint: "fingerprint",
  context: {},
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
  overrides: Partial<WorkflowNodeAttempt> = {},
): WorkflowNodeAttempt => ({
  id,
  submissionId,
  nodeId,
  attempt: 1,
  state: "completed",
  persona: null,
  runner: "claude",
  model: "reviewer",
  verdict: null,
  output: null,
  retryAt: null,
  inputFingerprint: "input",
  error: null,
  createdAt: 1,
  updatedAt: 1,
  startedAt: 1,
  finishedAt: 2,
  ...overrides,
});

const detail = (
  submissions: WorkflowSubmission[],
  attempts: WorkflowNodeAttempt[],
  overrides: Partial<WorkflowRunDetail> = {},
): WorkflowRunDetail => ({
  submissions,
  attempts,
  events: [],
  receipts: [],
  deliveries: [],
  summary: { gate: "none" },
  run: { status: "running" },
  ...overrides,
} as unknown as WorkflowRunDetail);

test("an unknown or absent round falls back to the newest one", () => {
  const rounds = [submission("s1", 1), submission("s2", 2)];
  const run = detail(rounds, []);
  assert.equal(selectedSubmission(run, null)?.id, "s2");
  assert.equal(selectedSubmission(run, "s1")?.id, "s1");
  // Run detail is reloaded on every mutation, so a round id held in component state can
  // outlive the run it came from. Showing an empty round would look like data loss.
  assert.equal(selectedSubmission(run, "gone")?.id, "s2");
  assert.equal(selectedSubmission(detail([], []), "s1"), null);
});

test("rounds are listed in execution order and a repair round is marked", () => {
  const rounds = runRounds(detail(
    [
      submission("s2", 2, { status: "running", completedAt: null }),
      submission("s1", 1, { status: "waiting_for_session", completedAt: null }),
      submission("s3", 3, { mode: "inspector_only" }),
    ],
    [attempt("a1", "s1", "node", { verdict: { verdict: "fail" } as never })],
  ));
  assert.deepEqual(rounds.map((round) => round.label), [
    "Round 1",
    "Round 2",
    "Round 3 · Inspector",
  ]);
  // The submission status alone would leave every healthy repair round unmarked, which is
  // the one round the mark exists for.
  assert.deepEqual(rounds[0]!.status, { tone: "failed", label: "Changes requested" });
  assert.deepEqual(rounds[1]!.status, { tone: "running", label: "Under review" });
  assert.equal(rounds[2]!.inspectorOnly, true);
});

test("a round with no fail verdict is waiting, not failed", () => {
  assert.deepEqual(
    submissionStatus(submission("s", 1, { status: "waiting_for_session" }), false),
    { tone: "waiting", label: "Waiting for the session" },
  );
});

test("node statuses come from one submission, newest attempt, verdict first", () => {
  const run = detail(
    [submission("s1", 1), submission("s2", 2)],
    [
      attempt("old", "s1", "quality", { verdict: { verdict: "pass" } as never }),
      attempt("stale", "s2", "quality", { attempt: 1, state: "error" }),
      attempt("fresh", "s2", "quality", { attempt: 2, state: "running" }),
      attempt("done", "s2", "security", {
        state: "completed",
        verdict: { verdict: "fail" } as never,
      }),
    ],
  );
  assert.deepEqual(nodeStatusesForSubmission(run, "s2"), {
    quality: "running",
    security: "fail",
  });
  assert.deepEqual(nodeStatusesForSubmission(run, "s1"), { quality: "pass" });
  assert.deepEqual(nodeStatusesForSubmission(run, null), {});
});

test("the newest attempt answers for a node - its state AND its provider", () => {
  // One map, two readers: the strip's chip and its `runner · model` line. Read apart, a
  // retry that resolved a different provider shows a live status beside metadata about the
  // call that already failed.
  const run = detail(
    [submission("s1", 1)],
    [
      attempt("first", "s1", "quality", { attempt: 1, state: "error", runner: "claude", model: "old" }),
      attempt("retry", "s1", "quality", { attempt: 2, state: "running", runner: "codex", model: "new" }),
      attempt("only", "s1", "security", { attempt: 1, state: "queued" }),
    ],
  );
  const latest = latestAttemptsFor(run, "s1");
  assert.equal(latest.get("quality")?.id, "retry");
  assert.equal(latest.get("quality")?.model, "new");
  assert.equal(latest.get("security")?.id, "only");
  assert.deepEqual(nodeStatusesForSubmission(run, "s1"), { quality: "running", security: "queued" });
  assert.equal(latestAttemptsFor(run, null).size, 0);
  assert.equal(latestAttemptsFor(run, "gone").size, 0);
});

test("a reviewer with no attempt this round has not started, which is not 'nothing to say'", () => {
  assert.deepEqual(reviewerStatus(undefined), { tone: "waiting", label: "Not started" });
  assert.deepEqual(reviewerStatus("pass"), { tone: "passed", label: "Passed" });
  assert.deepEqual(reviewerStatus("fail"), { tone: "failed", label: "Changes requested" });
  assert.deepEqual(reviewerStatus("retry_wait"), { tone: "waiting", label: "Retrying" });
  // A state a newer daemon invented still renders as words rather than as nothing.
  assert.deepEqual(reviewerStatus("some_new_state"), { tone: "waiting", label: "some new state" });
});

test("a check uses deterministic status vocabulary", () => {
  assert.deepEqual(checkStatus(undefined), { tone: "waiting", label: "Not started" });
  assert.deepEqual(checkStatus("running"), { tone: "running", label: "Running" });
  assert.deepEqual(checkStatus("error"), { tone: "failed", label: "Check failed to run" });
  assert.deepEqual(checkStatus("pass"), { tone: "passed", label: "Passed" });
  assert.deepEqual(checkStatus("fail"), { tone: "failed", label: "Failed" });
});

test("a stage passes only when all of it passed, and any failure wins", () => {
  const pass = reviewerStatus("pass");
  const fail = reviewerStatus("fail");
  const running = reviewerStatus("running");
  const queued = reviewerStatus("queued");
  assert.equal(stageStatus([pass, pass]).label, "All passed");
  assert.equal(stageStatus([pass]).label, "Passed");
  assert.equal(stageStatus([pass, fail]).tone, "failed");
  // A failure outranks work still in flight: the stage cannot pass any more.
  assert.equal(stageStatus([fail, running]).tone, "failed");
  assert.equal(stageStatus([pass, running]).tone, "running");
  assert.equal(stageStatus([pass, queued]).tone, "waiting");
  assert.equal(stageStatus([fail]).label, "Failed");
  assert.equal(stageStatus([running]).label, "Running");
  assert.equal(stageStatus([]).label, "No members");
});

test("the End terminus never reads the live run onto an older round", () => {
  const completed = detail([submission("s1", 1)], [], {
    run: { status: "completed" },
    summary: { gate: "none" },
  } as unknown as Partial<WorkflowRunDetail>);
  const failedRound = submission("s0", 0, { status: "waiting_for_session" });
  assert.deepEqual(endStatus(completed, submission("s1", 1), true), {
    tone: "passed",
    label: "Completed",
  });
  assert.deepEqual(endStatus(completed, failedRound, false), {
    tone: "waiting",
    label: "Not reached",
  });
});

test("every gate wait reason has a sentence, and a satisfied gate says so", () => {
  for (const reason of WORKFLOW_GATE_WAIT_REASONS) {
    const text = gateWaitSentence(reason);
    assert.ok(text.length > 20, `${reason} has no sentence`);
    assert.doesNotMatch(text, /_/, `${reason}'s sentence still reads as a code`);
  }
  assert.match(gateWaitSentence(null), /has reviewed/);
});

test("a durable error becomes a sentence and keeps its code beside it", () => {
  assert.deepEqual(errorView("outcome_unknown"), {
    sentence: "The write may or may not have landed.",
    code: "outcome_unknown",
  });
  // A code with no written sentence still reads as words, and is still quotable.
  assert.deepEqual(errorView("provider_timeout"), {
    sentence: "Provider timeout.",
    code: "provider_timeout",
  });
  // An exception message is already a sentence; inventing a code for it would be a lie.
  assert.deepEqual(errorView("Session identity changed during capture"), {
    sentence: "Session identity changed during capture",
    code: null,
  });
  assert.equal(errorView(null), null);
  assert.equal(errorView(""), null);
});

test("a captured context is validated before it is read, field by field", () => {
  // `contextState` answers for the RUN, so a scrubbed round can be unreadable while the run's
  // verdict says captured. A shape check that only proved three fields were objects let that
  // round reach a render which does `humanDecisions.length` and maps `constraints` into JSX -
  // an exception that takes the whole Runs view down, and an object handed to React as a
  // child. Every field the render touches is checked here instead.
  const valid = {
    primaryGoal: { rawPrompt: "GOAL", refined: null, sourceNoteKey: "note" },
    humanDecisions: [{ decision: "Keep it", rationale: null, source: { kind: "review", id: "r" } }],
    constraints: ["No server change"],
    acceptanceCriteria: [],
    priorPersonaFeedback: [],
    session: { agent: "claude", name: "work", cwd: "/repo", branch: "main" },
    evidence: {
      headSha: "abc",
      diffFingerprint: "d",
      diff: "",
      diffTruncated: false,
      workingTreeDirty: false,
      workingTreeStatus: [],
      workingTreeStatusTruncated: false,
      transcript: [],
      transcriptAnchor: 0,
      transcriptTruncated: false,
      standards: [],
      standardsTruncated: false,
    },
    compaction: { status: "model", runner: "claude", model: "cheap", error: null },
  };
  assert.equal(readCapturedContext(valid), valid);
  // The exact shape the Inspector named: three objects, nothing inside them.
  assert.equal(readCapturedContext({ primaryGoal: {}, evidence: {}, compaction: {} }), null);
  assert.equal(readCapturedContext({ ...valid, humanDecisions: undefined }), null);
  // A decision is rendered with its source, so one without a source is unreadable.
  assert.equal(readCapturedContext({ ...valid, humanDecisions: [{ decision: "x" }] }), null);
  // A non-string constraint would be handed to React as a child.
  assert.equal(readCapturedContext({ ...valid, constraints: [{ text: "no" }] }), null);
  assert.equal(readCapturedContext({ ...valid, evidence: { headSha: "abc" } }), null);
  assert.equal(readCapturedContext({ ...valid, compaction: {} }), null);
  assert.equal(readCapturedContext({ ...valid, primaryGoal: { refined: "only" } }), null);
  assert.equal(readCapturedContext(null), null);
  assert.equal(readCapturedContext([]), null);
  assert.equal(readCapturedContext({}), null);
});

test("timeline events are phrased in names and carry their round forward", () => {
  const run = detail(
    [submission("s1", 1), submission("s2", 2)],
    [],
    {
      events: [
        { id: 1, runId: "run", timestamp: 1, kind: "run_created", payload: { triggerSource: "manual" } },
        {
          id: 2,
          runId: "run",
          timestamp: 2,
          kind: "persona_verdict",
          payload: { nodeId: "node-uuid", verdict: "fail", submissionId: "s1" },
        },
        // No submission and no round: it belongs to whatever round was running when it was
        // written, which is the cursor carried forward.
        { id: 3, runId: "run", timestamp: 3, kind: "delivery_prepared", payload: { deliveryId: "d" } },
        { id: 4, runId: "run", timestamp: 4, kind: "submission_created", payload: { submissionId: "s2" } },
      ],
    } as unknown as Partial<WorkflowRunDetail>,
  );
  const grouped = eventsByRound(run);
  assert.deepEqual([...grouped.keys()], [0, 1, 2]);
  assert.deepEqual(grouped.get(1)!.map((event) => event.id), [2, 3]);

  const names = { node: (id: string) => id === "node-uuid" ? "Quality reviewer" : null, round: () => 1 };
  const verdict = eventLine(grouped.get(1)![0]!, names, 1);
  assert.equal(verdict.title, "Persona verdict");
  assert.match(verdict.detail, /Quality reviewer/);
  assert.match(verdict.detail, /verdict fail/);
  // The id the name came from never survives into the line.
  assert.doesNotMatch(verdict.detail, /node-uuid/);
  // Nor does the round it is already filed under - every line repeating its own heading is
  // the noise this replaced. Read under another heading, it says so.
  assert.doesNotMatch(verdict.detail, /round 1/);
  assert.match(eventLine(grouped.get(1)![0]!, names, 0).detail, /round 1/);
  // A payload that is nothing but a durable handle says nothing at all here: the id belongs
  // to the run export.
  const prepared = eventLine(grouped.get(1)![1]!, names, 1);
  assert.equal(prepared.title, "Delivery prepared");
  assert.equal(prepared.detail, "");
});

// ---- Check outcomes ----
//
// Vocabulary lives in this module so a new durable enum value fails typecheck until somebody
// says what it means to a human. The reason a check needs its own entry rather than borrowing
// the verdict's two words is that three of its four statuses PASS, and they are not the same
// kind of pass: "the command ran and was satisfied", "nobody configured one", and "nobody
// authorized one" send an operator to three different places.

test("every check status has a distinct label and sentence", () => {
  const seen = new Map<string, string>();
  for (const status of WORKFLOW_CHECK_STATUSES) {
    const view = checkStatusView(status);
    assert.ok(view.label.length > 0, `${status} has no label`);
    assert.match(view.sentence, /\.$/, `${status}'s sentence is not a sentence`);
    assert.ok(!seen.has(view.sentence), `${status} reuses ${seen.get(view.sentence)}'s sentence`);
    seen.set(view.sentence, status);
    // The durable spelling never reaches the screen as itself.
    assert.notEqual(view.label, status);
  }
});

test("a check outcome is read from output_json, and a Persona attempt is not mistaken for one", () => {
  const outcome = {
    status: "failed",
    slot: "typecheck",
    command: ["npm", "run", "typecheck"],
    exitCode: 2,
    output: "error TS2345",
    truncatedBytes: 0,
    note: "`npm run typecheck` exited 2.",
  };
  assert.deepEqual(checkOutcomeOf(attempt("a", "s", "gate", { output: outcome })), outcome);
  // A Persona attempt's `output_json` is a feedback packet, and reading it as a check would
  // draw an exit-code card over a reviewer's verdict.
  assert.equal(
    checkOutcomeOf(attempt("b", "s", "p1", {
      output: { personaName: "Reviewer", summary: "Needs work", requestedChanges: ["Fix it"] },
    })),
    null,
  );
  assert.equal(checkOutcomeOf(attempt("c", "s", "gate", { output: null })), null);
  // A status a newer build wrote is not a check this build can draw, so it declines rather
  // than rendering an outcome it cannot describe.
  assert.equal(
    checkOutcomeOf(attempt("d", "s", "gate", { output: { ...outcome, status: "flaky" } })),
    null,
  );
});
