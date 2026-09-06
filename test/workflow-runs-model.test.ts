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
  carriedStageStatus,
  carriedStatus,
  checkOutcomeOf,
  checkStatus,
  checkStatusView,
  disabledMemberStatus,
  disabledStatusFor,
  endStatus,
  errorView,
  eventLine,
  eventsByRound,
  gateWaitSentence,
  inheritedAttempts,
  inheritedPasses,
  priorAttemptPassed,
  latestAttemptsFor,
  newestInheritedSource,
  nodeStatusesForSubmission,
  readCapturedContext,
  reviewerStatus,
  evidenceChipLabel,
  openEvidenceTray,
  roundEvidenceCountLabel,
  roundFailedCaptureCount,
  roundFailedCaptureLabel,
  roundHoldsViewedSubmission,
  roundOpensEvidenceTray,
  runRoundGroups,
  runRounds,
  selectedSubmission,
  stageStatus,
  spentInspectorGateCondition,
  spentInspectorGateStatus,
  inspectorGateSentence,
  submissionRoundLabel,
  submissionStatus,
} from "../src/web/workflows/run-model.ts";
import type { RoundGroupView } from "../src/web/workflows/run-model.ts";

const submission = (
  id: string,
  round: number,
  overrides: Partial<WorkflowSubmission> = {},
): WorkflowSubmission => ({
  id,
  runId: "run",
  round,
  segment: 0,
  parentSubmissionId: null,
  continuationNodeId: null,
  continuationNodeAttemptId: null,
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
  sessionAction: null,
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

interface SpentGateShape {
  historicalStatus?: "open" | "resolved";
  extraOpenFinding?: boolean;
  observedHead?: string | null;
  reviewedHead?: string | null;
  observedState?: "OPEN" | "CLOSED" | "MERGED" | null;
  reviewPosture?: "live" | "dry-run" | "off" | "not-allowlisted" | null;
  currentPosture?: "live" | "dry-run" | "off" | "not-allowlisted" | null;
  lastError?: string | null;
  missingInspection?: boolean;
  omitHistoricalRow?: boolean;
  tallyOffset?: number;
  latestMode?: "full_workflow" | "inspector_only";
  status?: "blocked" | "waiting_for_new_head";
}

const spentGateDetail = (shape: SpentGateShape = {}): WorkflowRunDetail => {
  const historicalStatus = shape.historicalStatus ?? "resolved";
  const findings = [
    ...(shape.omitHistoricalRow ? [] : [{
      id: "historical",
      prKey: "owner/repo#91",
      fingerprint: "historical-fingerprint",
      title: "Historical workflow finding",
      status: historicalStatus,
    }]),
    ...(shape.extraOpenFinding ? [{
      id: "current",
      prKey: "owner/repo#91",
      fingerprint: "current-fingerprint",
      title: "Current Inspector finding",
      status: "open",
    }] : []),
  ];
  const openFindings = findings.filter((finding) => finding.status !== "resolved").length;
  const resolvedFindings = findings.length - openFindings;
  const observedHead = shape.observedHead === undefined ? "current-head-123456789" : shape.observedHead;
  const reviewedHead = shape.reviewedHead === undefined ? observedHead : shape.reviewedHead;
  const status = shape.status ?? "blocked";
  return detail([
    submission("spent", 4, { mode: shape.latestMode ?? "inspector_only" }),
  ], [], {
    summary: {
      round: 4,
      maxRepairRounds: 3,
      gate: "blocked",
      gatePrNumber: 91,
    },
    run: { status, currentPhase: "round_limit" },
    inspectorGate: {
      state: {
        prKey: "owner/repo#91",
        prUrl: "https://github.com/owner/repo/pull/91",
        targetHeadSha: "failed-head-123456789",
        failedHeadSha: "failed-head-123456789",
        enteredAt: 8,
        lastObservedAt: 9,
        observedHeadSha: "failed-head-123456789",
        reviewPosture: "live",
        waitReason: "findings",
        findingFingerprints: ["historical-fingerprint"],
      },
      inspector: {
        enabled: true,
        mode: "live",
        posture: shape.currentPosture === undefined ? "live" : shape.currentPosture,
      },
      inspection: shape.missingInspection ? null : {
        key: "owner/repo#91",
        state: "open",
        observedState: shape.observedState === undefined ? "OPEN" : shape.observedState,
        observedHeadSha: observedHead,
        headSha: reviewedHead,
        reviewPosture: shape.reviewPosture === undefined ? "live" : shape.reviewPosture,
        lastError: shape.lastError ?? null,
        openFindings: openFindings + (shape.tallyOffset ?? 0),
        resolvedFindings,
      },
      findings,
    },
  } as unknown as Partial<WorkflowRunDetail>);
};

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
    "Round 3 · GitHub Inspector",
  ]);
  // The submission status alone would leave every healthy repair round unmarked, which is
  // the one round the mark exists for.
  assert.deepEqual(rounds[0]!.status, { tone: "failed", label: "Changes requested" });
  assert.deepEqual(rounds[1]!.status, { tone: "running", label: "Under review" });
  assert.equal(rounds[2]!.inspectorOnly, true);
});

test("a round's evidence snapshots collapse into one tile that keeps their tones", () => {
  // The defect: three rounds that captured evidence 3, 11 and 9 times drew twenty-three
  // tiles wrapping three rows deep, and read as twenty-three rounds.
  const submissions = [
    submission("r1s0", 1, { segment: 0, status: "waiting_for_evidence_readiness" }),
    submission("r1s1", 1, { segment: 1, status: "waiting_for_session", completedAt: null }),
    submission("r2s0", 2, { segment: 0, status: "failed" }),
    submission("r2s1", 2, { segment: 1, status: "running", completedAt: null }),
    submission("r3s0", 3, { segment: 0, mode: "inspector_only" }),
  ];
  const groups = runRoundGroups(runRounds(detail(submissions, [])));

  assert.deepEqual(groups.map((group) => group.label), [
    "Round 1",
    "Round 2",
    "Round 3 · GitHub Inspector",
  ]);
  assert.deepEqual(groups.map((group) => group.segments.length), [2, 2, 1]);
  // The tile wears the NEWEST snapshot's status, because that is what the round is doing
  // now - and the older snapshot keeps its own, which is the whole reason the tray's chips
  // carry a tone each.
  assert.deepEqual(groups[1]!.head.submissionId, "r2s1");
  assert.deepEqual(groups[1]!.status, { tone: "running", label: "Under review" });
  assert.deepEqual(
    groups[1]!.segments.map((segment) => segment.status.tone),
    ["failed", "running"],
    "a failed capture inside a collapsed round is still visible",
  );
  // Execution order survives the fold, in both directions.
  assert.deepEqual(
    groups.flatMap((group) => group.segments.map((segment) => segment.submissionId)),
    ["r1s0", "r1s1", "r2s0", "r2s1", "r3s0"],
  );

  // The tile's badge counts captures and does NOT move with the selection: the tray names
  // the snapshot, and a badge that also changed would shift this tile and every tile after
  // it on each chip a reader picks.
  assert.equal(roundEvidenceCountLabel(groups[1]!), "2 evidence");
  assert.equal(roundEvidenceCountLabel(groups[2]!), "1 evidence");
  // A chip names itself one-based, matching how the round label counts segments.
  assert.deepEqual(groups[1]!.segments.map(evidenceChipLabel), ["evidence 1", "evidence 2"]);
});

test("one tray opens, for the round being read, and never for a lone snapshot", () => {
  const submissions = [
    submission("r1s0", 1, { segment: 0 }),
    submission("r1s1", 1, { segment: 1 }),
    submission("r2s0", 2, { segment: 0 }),
  ];
  const groups = runRoundGroups(runRounds(detail(submissions, [])));

  // Whichever snapshot of round 1 is being read, round 1 owns the tray.
  assert.equal(openEvidenceTray(groups, "r1s0")?.round, 1);
  assert.equal(openEvidenceTray(groups, "r1s1")?.round, 1);
  // Round 2 captured once, so there is no choice to offer and nothing opens - even though
  // that round is perfectly well selected. Stamping a one-chip tray under it would spend a
  // panel on a distinction nobody is drawing.
  assert.equal(openEvidenceTray(groups, "r2s0"), null);
  // A submission id from another run, which is what stale component state looks like.
  assert.equal(openEvidenceTray(groups, "gone"), null);
  assert.equal(openEvidenceTray(groups, null), null);
});

test("a failed capture is counted on its round's tile, viewed or not", () => {
  /**
   * The defect this pins, found in review: only the OPEN round draws a tray, and the tile
   * wears the NEWEST capture's status - so a failure that happened mid-round vanished as soon
   * as the reader looked at a different round. Round 2 below holds a failed capture and is
   * NOT the round being read; nothing on screen said so.
   */
  const groups = runRoundGroups(runRounds(detail([
    submission("r1s0", 1, { segment: 0 }),
    // Round 2 fails at its first capture, then carries on. Its newest is healthy, so its
    // status line cannot report the failure and its tray is closed while round 3 is read.
    submission("r2s0", 2, { segment: 0, status: "failed" }),
    submission("r2s1", 2, { segment: 1, status: "running", completedAt: null }),
    submission("r3s0", 3, { segment: 0, status: "running", completedAt: null }),
  ], [])));
  const [roundOne, roundTwo, roundThree] = groups as [
    RoundGroupView, RoundGroupView, RoundGroupView,
  ];

  // The round's status says nothing about the failure - that is the whole problem.
  assert.deepEqual(roundTwo.status, { tone: "running", label: "Under review" });
  // The marker does, and it does so independently of what is selected.
  assert.equal(roundFailedCaptureCount(roundTwo), 1);
  assert.equal(roundFailedCaptureLabel(roundTwo), "1 failed");
  for (const viewed of ["r1s0", "r2s0", "r2s1", "r3s0", null]) {
    assert.equal(
      roundFailedCaptureLabel(roundTwo),
      "1 failed",
      `the marker must not depend on the selection (${viewed})`,
    );
  }

  // Rounds with nothing failed carry no marker at all, so the strip stays quiet by default.
  assert.equal(roundFailedCaptureLabel(roundOne), null);
  assert.equal(roundFailedCaptureLabel(roundThree), null);
  assert.equal(roundFailedCaptureCount(roundOne), 0);

  // Every failed capture counts, including a newest one the status line already reports.
  const parked = runRoundGroups(runRounds(detail([
    submission("p0", 1, { segment: 0, status: "failed" }),
    submission("p1", 1, { segment: 1, status: "failed" }),
  ], [])));
  assert.equal(roundFailedCaptureLabel(parked[0]!), "2 failed");
});

test("the tile's own states come from the same predicates the tray is chosen with", () => {
  // What is at stake: ONE owner per rule. The tile decides its pressed, active, badge and
  // `aria-expanded` states from these two functions, and `openEvidenceTray` is composed from
  // the same two - so a tile cannot claim to be the active round while a different round's
  // tray is the one rendered.
  const groups = runRoundGroups(runRounds(detail([
    submission("r1s0", 1, { segment: 0 }),
    submission("r1s1", 1, { segment: 1 }),
    submission("r2s0", 2, { segment: 0 }),
  ], [])));
  const [roundOne, roundTwo] = groups as [RoundGroupView, RoundGroupView];

  // Ownership follows the VIEWED submission, whichever capture of the round it is.
  assert.equal(roundHoldsViewedSubmission(roundOne, "r1s1"), true);
  assert.equal(roundHoldsViewedSubmission(roundTwo, "r1s1"), false);
  assert.equal(roundHoldsViewedSubmission(roundOne, null), false);

  // Eligibility is about the round alone and says nothing about what is selected.
  assert.equal(roundOpensEvidenceTray(roundOne), true);
  assert.equal(roundOpensEvidenceTray(roundTwo), false);

  /**
   * The composition, and the trap it exists to stop: a LONE viewed snapshot owns the view
   * while opening no tray. So the tile cannot read its own ownership off `openEvidenceTray`
   * - round 2 here is the round being read, and that function correctly answers null for it.
   * Deriving `aria-pressed` from the tray would leave the round on screen unpressed.
   */
  assert.equal(openEvidenceTray(groups, "r2s0"), null);
  assert.equal(roundHoldsViewedSubmission(roundTwo, "r2s0"), true);

  // And where a tray IS open, it is exactly the round the ownership predicate picks.
  for (const viewed of ["r1s0", "r1s1"]) {
    const open = openEvidenceTray(groups, viewed);
    assert.ok(open, `round 1 should open a tray for ${viewed}`);
    assert.equal(roundHoldsViewedSubmission(open, viewed), true);
    assert.equal(roundOpensEvidenceTray(open), true);
    assert.equal(
      groups.filter((group) => roundHoldsViewedSubmission(group, viewed)).length,
      1,
      "exactly one round may own the viewed submission",
    );
  }
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
  assert.deepEqual(checkStatus("error"), { tone: "failed", label: "Command failed to run" });
  assert.deepEqual(checkStatus("pass"), { tone: "passed", label: "Passed" });
  assert.deepEqual(checkStatus("fail"), { tone: "failed", label: "Failed" });
});

test("a check that never ran says so, and is never laundered into Passed", () => {
  // The defect this pins: three of the four check outcomes ADVANCE the graph, and only one
  // of them means the command ran and succeeded. A slot with no command configured is
  // `skipped`; a build with no execution runtime records `unavailable`. Both finish as a
  // passing attempt, so reading the attempt state alone reports a green "Passed" for a
  // command that was never spawned - which tells an operator their typecheck and tests
  // succeeded when nothing ran. That is the exact assurance the shipped No-Mistakes Review
  // v2 must not fake, so the recorded OUTCOME wins over the attempt state.
  assert.deepEqual(checkStatus("pass", "unavailable"), {
    tone: "waiting",
    label: "Not run",
    tooltip: "This Command could not run. Open the run details for its recorded reason.",
    skipKind: "unavailable_check",
    degraded: true,
  });
  assert.deepEqual(checkStatus("pass", "skipped"), {
    tone: "waiting",
    label: "Skipped",
    tooltip: "Skipped because this machine configures nothing for this Command.",
    skipKind: "unconfigured_check",
    degraded: true,
  });
  // A check that genuinely ran keeps the ordinary vocabulary, and a real failure still wins.
  assert.deepEqual(checkStatus("pass", "passed"), { tone: "passed", label: "Passed" });
  assert.deepEqual(checkStatus("fail", "failed"), { tone: "failed", label: "Failed" });
  // No outcome recorded yet (queued, running, or an attempt that carries none) is unchanged.
  assert.deepEqual(checkStatus("running", null), { tone: "running", label: "Running" });
  assert.deepEqual(checkStatus(undefined, null), { tone: "waiting", label: "Not started" });
  // Every outcome that ADVANCES the gate without running says so. `passed` and `failed` are
  // excluded because they legitimately defer to the attempt state - they are the two where
  // the attempt and the outcome cannot disagree. A newly added status cannot slip through
  // here silently either way: `CHECK_OUTCOME_STATUSES` is an exhaustive
  // `Record<WorkflowCheckStatus, …>`, so it fails to compile until it declares what it means.
  for (const status of WORKFLOW_CHECK_STATUSES) {
    if (status === "passed" || status === "failed") continue;
    assert.notEqual(
      checkStatus("pass", status).label,
      "Passed",
      `${status} renders as a plain pass`,
    );
  }
});

test("a stage says how much of its gate was real", () => {
  // A stage of checks that never ran is finished, so "Waiting" would read as still in
  // flight - and "All passed" would launder the very claim the member chips refuse to make.
  const ran = checkStatus("pass", "passed");
  const notRun = checkStatus("pass", "unavailable");
  const skipped = checkStatus("pass", "skipped");
  assert.deepEqual(stageStatus([skipped, skipped]), {
    tone: "waiting",
    label: "Skipped",
    tooltip: "Skipped because this machine configures nothing for the Commands in this stage.",
    skipKind: "unconfigured_check",
    degraded: true,
  });
  assert.deepEqual(stageStatus([notRun, skipped]), {
    tone: "waiting",
    label: "None ran",
    tooltip: "One or more Commands in this stage did not run. Hover each one for its reason.",
    degraded: true,
  });
  assert.deepEqual(stageStatus([notRun]), {
    tone: "waiting",
    label: "Did not run",
    tooltip: "One or more Commands in this stage did not run. Hover each one for its reason.",
    degraded: true,
  });
  assert.equal(stageStatus([ran, notRun]).label, "Passed, 1 not run");
  assert.equal(stageStatus([ran, notRun]).degraded, true);
  // A stage whose checks all genuinely ran is an ordinary pass, with no caveat attached.
  assert.deepEqual(stageStatus([ran, ran]), { tone: "passed", label: "All passed" });
  // A real failure still outranks a gate that did not run.
  assert.equal(stageStatus([notRun, checkStatus("fail", "failed")]).tone, "failed");
});

/** A published version holding just the node kinds `inheritedPasses` reads. */
const version = (
  nodes: Array<{ id: string; kind: "persona" | "check" | "session_action" | "all_pass" }>,
): Partial<WorkflowRunDetail> => ({ version: { graph: { nodes } } } as never);

const PIPELINE = version([
  { id: "persona-node", kind: "persona" },
  { id: "check-node", kind: "check" },
  { id: "action-node", kind: "session_action" },
  { id: "join", kind: "all_pass" },
]);

const passed = (id: string, submissionId: string, nodeId: string): WorkflowNodeAttempt =>
  attempt(id, submissionId, nodeId, { verdict: { verdict: "pass" } as never });

/**
 * A check that RAN and succeeded, which is a different attempt from one that merely passed.
 *
 * Three of the four check outcomes advance the graph and only this one was earned, so a check
 * carries its outcome in `output` and the synthetic pass verdict beside it proves nothing.
 */
const passedCheck = (id: string, submissionId: string, nodeId: string): WorkflowNodeAttempt =>
  attempt(id, submissionId, nodeId, {
    verdict: { verdict: "pass" } as never,
    output: {
      status: "passed",
      slot: "test",
      command: ["npm", "test"],
      exitCode: 0,
      output: "",
      truncatedBytes: 0,
      note: "The command exited 0.",
    },
  });

test("a carried stage reads as neutral and names the round its pass came from", () => {
  // NOT `tone: "passed"`. The stage did not run in the round being read, and a green chip on
  // it is the same false assurance `degraded` exists to prevent elsewhere. The round is in the
  // tooltip because reaching it used to mean leaving the round on screen to go and look.
  assert.deepEqual(carriedStatus("Round 1 · evidence 1"), {
    tone: "stopped",
    label: "Not re-run",
    tooltip: "Not re-run in this round. It passed in Round 1 · evidence 1, and that pass still stands.",
    skipKind: "carried_pass",
  });
  // One source named; several collapse rather than picking one and claiming it for all.
  assert.equal(carriedStageStatus(["Round 1", "Round 1"]).tooltip, carriedStatus("Round 1").tooltip);
  assert.match(carriedStageStatus(["Round 1", "Round 2"]).tooltip!, /Every member passed/);
  assert.equal(carriedStageStatus(["Round 1", "Round 2"]).skipKind, "carried_pass");
});

test("an ordinary repair round carries nothing, because it re-runs everything", () => {
  // The guard that matters most. A repair restarts the graph at Session and queues every node
  // again, so a node with no attempt YET is genuinely not started - borrowing round 1's pass
  // for it would report a review as done while it is still being re-run.
  const first = submission("full-1", 1);
  const repair = submission("full-2", 2);
  const run = detail([first, repair], [passed("a", first.id, "persona-node")], PIPELINE);
  assert.equal(inheritedPasses(run, repair).size, 0);
});

test("a continuation segment carries the parent's passes, by the recorded parent link", () => {
  const parent = submission("seg-0", 1);
  const child = submission("seg-1", 1, { segment: 1, parentSubmissionId: parent.id });
  // A sibling round that is NOT this segment's parent, to prove the walk follows the durable
  // link rather than "whatever submission came before".
  const unrelated = submission("other", 1, { createdAt: 0, updatedAt: 0 });
  const run = detail(
    [unrelated, parent, child],
    [
      passed("p", parent.id, "persona-node"),
      passedCheck("c", parent.id, "check-node"),
      passed("u", unrelated.id, "action-node"),
      // The action that authorized the segment ran in the child; it owns its own outcome.
      passed("a", child.id, "action-node"),
    ],
    PIPELINE,
  );
  const inherited = inheritedPasses(run, child);
  assert.deepEqual([...inherited.keys()].sort(), ["check-node", "persona-node"]);
  assert.equal(inherited.get("persona-node")!.submission.id, parent.id);
  assert.equal(inherited.get("persona-node")!.roundLabel, "Round 1 · evidence 1");
  // A node that ran HERE keeps its own result, whatever an ancestor said.
  assert.equal(inherited.has("action-node"), false);
});

test("a carried pass is the nearest recorded outcome, never an older one reaching past it", () => {
  // The failure this prevents: a node that passed in round 1, failed in round 2, and did not
  // run in a round-2 segment must not resurrect round 1's pass. The nearest outcome is the
  // current one, so the walk stops at it even though it is not a pass.
  const first = submission("seg-0", 1);
  const second = submission("seg-1", 1, { segment: 1, parentSubmissionId: first.id });
  const third = submission("seg-2", 1, { segment: 2, parentSubmissionId: second.id });
  const run = detail(
    [first, second, third],
    [
      passed("p1", first.id, "persona-node"),
      attempt("p2", second.id, "persona-node", { verdict: { verdict: "fail" } as never }),
      passedCheck("c1", first.id, "check-node"),
    ],
    PIPELINE,
  );
  const inherited = inheritedPasses(run, third);
  assert.equal(inherited.has("persona-node"), false);
  // The check never ran in segment 2, so its round-1 pass is still the nearest outcome.
  assert.equal(inherited.get("check-node")!.submission.id, first.id);
});

test("an Inspector-only round carries only earned outcomes from the preceding full round", () => {
  const first = submission("full-1", 1);
  const previous = submission("full-2", 2);
  const inspector = submission("inspector", 3, { mode: "inspector_only" });
  const skippedCheck = attempt("check", previous.id, "check-node", {
    verdict: { verdict: "pass" } as never,
    output: {
      status: "skipped",
      slot: "test",
      command: null,
      exitCode: null,
      output: "",
      truncatedBytes: 0,
      note: "No command is configured.",
    },
  });
  const run = detail(
    [first, previous, inspector],
    [passed("stale", first.id, "action-node"), passed("p", previous.id, "persona-node"), skippedCheck],
    PIPELINE,
  );
  const inherited = inheritedPasses(run, inspector);
  // A check that never spawned did not earn a pass, so it is not one this round can carry.
  assert.deepEqual([...inherited.keys()], ["persona-node"]);
  assert.equal(inherited.get("persona-node")!.roundLabel, "Round 2");
});

test("a completed session action is never carried, because it passed nothing", () => {
  // An action reports a LIFECYCLE, never an outcome - nothing about one may read Passed - so
  // a "✓ Passed in Round 1" line is the one thing it must never be given. It is also the wrong
  // claim about the wrong node: the continuation segment exists BECAUSE the action completed,
  // so the reader's question there is what the action DID, which its own chip already answers.
  const parent = submission("seg-0", 1);
  const child = submission("seg-1", 1, { segment: 1, parentSubmissionId: parent.id });
  const complete = attempt("act", parent.id, "action-node", {
    state: "completed" as never,
    output: { outcome: "complete" } as never,
  });
  // The fixture is a REAL completed action, proven here rather than assumed: an output the
  // completion schema rejects would make the assertion below pass while proving nothing, which
  // is exactly how this case first went green against an exclusion that was not being tested.
  assert.equal(priorAttemptPassed("session_action", complete), true);
  const run = detail(
    [parent, child],
    [complete, passed("p", parent.id, "persona-node")],
    PIPELINE,
  );
  const inherited = inheritedPasses(run, child);
  assert.deepEqual([...inherited.keys()], ["persona-node"]);
  // The attempt is still REACHABLE for a row that wants the nearest recorded outcome; it is
  // only the carried-pass treatment the action is kept out of.
  assert.ok(inheritedAttempts(run, child).has("action-node"));
});

test("display inheritance stays wider than carrying, so a skipped check keeps its reason", () => {
  // The regression this split exists for. An unconfigured command records `skipped`, never
  // `passed`, so it is correctly not carried - but reading a row's OUTCOME from the pass map
  // left the amber check with no recorded outcome at all, and the sentence saying why it is
  // amber went with it.
  const previous = submission("full-1", 1);
  const inspector = submission("inspector", 2, { mode: "inspector_only" });
  const skippedCheck = attempt("check", previous.id, "check-node", {
    verdict: { verdict: "pass" } as never,
    output: {
      status: "skipped",
      slot: "test",
      command: null,
      exitCode: null,
      output: "",
      truncatedBytes: 0,
      note: "No command is configured.",
    },
  });
  const run = detail([previous, inspector], [skippedCheck], PIPELINE);
  assert.equal(inheritedPasses(run, inspector).size, 0);
  const outcomes = inheritedAttempts(run, inspector);
  assert.deepEqual([...outcomes.keys()], ["check-node"]);
  assert.equal(checkOutcomeOf(outcomes.get("check-node")!.attempt)?.status, "skipped");
});

test("a member with no authored node, or no version at all, carries nothing", () => {
  const parent = submission("seg-0", 1);
  const child = submission("seg-1", 1, { segment: 1, parentSubmissionId: parent.id });
  const attempts = [passed("s", parent.id, "stale-node")];
  // A stale id that resolves to no graph node must keep its ordinary status rather than
  // borrowing a carried one: the bypass policy proves nothing about a malformed member.
  assert.equal(inheritedPasses(detail([parent, child], attempts, PIPELINE), child).size, 0);
  assert.equal(inheritedPasses(detail([parent, child], attempts), child).size, 0);
  assert.equal(inheritedPasses(detail([parent, child], attempts, PIPELINE), null).size, 0);
});

test("a corrupt parent chain degrades instead of hanging the reader", () => {
  const a = submission("a", 1, { segment: 1, parentSubmissionId: "b" });
  const b = submission("b", 1, { segment: 2, parentSubmissionId: "a" });
  assert.equal(inheritedPasses(detail([a, b], [], PIPELINE), a).size, 0);
  // A parent id naming a submission this run does not hold stops the walk rather than throwing.
  const orphan = submission("orphan", 1, { segment: 1, parentSubmissionId: "gone" });
  assert.equal(inheritedPasses(detail([orphan], [], PIPELINE), orphan).size, 0);
});

test("the carried source a one-slot surface names is the newest one", () => {
  const early = submission("early", 1);
  const late = submission("late", 2, { segment: 1 });
  const pass = (source: WorkflowSubmission) =>
    ({ attempt: passed("x", source.id, "n"), submission: source, roundLabel: source.id });
  assert.equal(newestInheritedSource([]), null);
  assert.equal(newestInheritedSource([pass(early), pass(late)])!.submission.id, "late");
  assert.equal(newestInheritedSource([pass(late), pass(early)])!.submission.id, "late");
});

test("a carried stage cites the round by the scrubber's own label", () => {
  // One dialect: a stage citing "Round 1 · evidence 1" and a scrubber tab reading something
  // else for the same submission would make the link between them look broken.
  const first = submission("s1", 1);
  const second = submission("s2", 1, { segment: 1, parentSubmissionId: first.id });
  const lone = submission("s3", 2);
  const run = detail([first, second, lone], []);
  assert.equal(submissionRoundLabel(run, first), "Round 1 · evidence 1");
  assert.equal(submissionRoundLabel(run, second), "Round 1 · evidence 2");
  // A round with one segment draws no distinction, so it is stamped with none.
  assert.equal(submissionRoundLabel(run, lone), "Round 2");
  assert.equal(
    submissionRoundLabel(run, lone),
    runRounds(run).find((round) => round.submissionId === lone.id)!.label,
  );
});

test("the Disabled chip follows the engine's claim-time boundary, never a reached outcome", () => {
  const set = ["judge"];
  const attempt = (over: { state: string; verdict?: unknown; output?: unknown }) => ({
    state: over.state as never,
    verdict: (over.verdict ?? null) as never,
    output: (over.output ?? null) as never,
  });
  // Work the auto-pass will convert reads Disabled: nothing yet, queued, retrying, or
  // cancelled before any verdict existed.
  assert.deepEqual(disabledStatusFor(set, "judge", undefined), disabledMemberStatus());
  assert.deepEqual(disabledStatusFor(set, "judge", attempt({ state: "queued" })), disabledMemberStatus());
  assert.deepEqual(disabledStatusFor(set, "judge", attempt({ state: "retry_wait" })), disabledMemberStatus());
  assert.deepEqual(disabledStatusFor(set, "judge", attempt({ state: "cancelled" })), disabledMemberStatus());
  // The engine's own synthetic auto-pass marks itself and reads Disabled too.
  assert.deepEqual(
    disabledStatusFor(set, "judge", attempt({
      state: "completed",
      verdict: { verdict: "pass" },
      output: { outcome: "pass", disabled: true },
    })),
    disabledMemberStatus(),
  );
  // An outcome the round already reached stands: a recorded failure, a live review, an
  // infrastructure error, and a late audit-only verdict all keep their real chips.
  assert.equal(disabledStatusFor(set, "judge", attempt({ state: "completed", verdict: { verdict: "fail" } })), null);
  assert.equal(disabledStatusFor(set, "judge", attempt({ state: "running" })), null);
  assert.equal(disabledStatusFor(set, "judge", attempt({ state: "error" })), null);
  assert.equal(disabledStatusFor(set, "judge", attempt({ state: "cancelled", verdict: { verdict: "fail" } })), null);
  // A node that is not disabled never gets the override, whatever its state.
  assert.equal(disabledStatusFor(set, "other", undefined), null);
  assert.equal(disabledStatusFor([], "judge", undefined), null);
  assert.equal(disabledStatusFor(undefined, "judge", undefined), null);
});

test("a disabled member reads red on its own chip and as not-run in the stage fold", () => {
  const disabled = disabledMemberStatus();
  // The chip itself is the red "Disabled" indicator the operator clicked for...
  assert.equal(disabled.tone, "failed");
  assert.equal(disabled.label, "Disabled");
  assert.equal(disabled.degraded, true);
  // ...but disabling is how an operator forces a stage PAST a member, so the fold must not
  // call the stage failed. With a passed sibling it counts among the not-run gates.
  const ran = checkStatus("pass", "passed");
  assert.deepEqual(stageStatus([ran, disabled]), {
    tone: "waiting",
    label: "Passed, 1 not run",
    tooltip: "One or more Commands in this stage did not run. Hover each one for its reason.",
    degraded: true,
  });
  // A wholly disabled stage is finished, not waiting on anything.
  assert.equal(stageStatus([disabled]).label, "Did not run");
  // A real failure beside a disabled member still fails the stage.
  assert.equal(stageStatus([disabled, reviewerStatus("fail")]).tone, "failed");
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

test("a spent Inspector gate reconciles historical findings with current exact-head truth", () => {
  const clean = spentGateDetail();
  assert.deepEqual(spentInspectorGateCondition(clean), {
    kind: "clean_exact_head",
    headSha: "current-head-123456789",
  });
  assert.deepEqual(spentInspectorGateStatus(clean), {
    tone: "waiting",
    label: "Clean head ready",
  });
  assert.match(inspectorGateSentence(clean), /exact open pull-request head current-head/);
  assert.match(inspectorGateSentence(clean), /workflow remains stopped until you adopt it/i);

  assert.deepEqual(
    spentInspectorGateCondition(spentGateDetail({ historicalStatus: "open" })),
    {
      kind: "historical_findings_open",
      currentOpenFindings: 1,
      historicalOpenFindings: 1,
    },
  );
  assert.deepEqual(
    spentInspectorGateCondition(spentGateDetail({ extraOpenFinding: true })),
    { kind: "current_findings_open", currentOpenFindings: 1 },
  );
  assert.deepEqual(
    spentInspectorGateCondition(spentGateDetail({ reviewedHead: null })),
    { kind: "awaiting_current_review", observedHeadSha: "current-head-123456789" },
  );
});

test("a spent Inspector gate fails closed on unavailable or inconsistent current evidence", () => {
  const cases: Array<[string, SpentGateShape, string]> = [
    ["missing inspection", { missingInspection: true }, "missing_inspection"],
    ["closed observation", { observedState: "CLOSED" }, "pull_request_closed"],
    ["missing observed head", { observedHead: null, reviewedHead: null }, "missing_observation"],
    ["mismatched reviewed head", { reviewedHead: "older-head" }, "head_mismatch"],
    ["non-live review", { reviewPosture: "dry-run" }, "review_not_live"],
    ["non-live current posture", { currentPosture: "off" }, "review_not_live"],
    ["review error", { lastError: "provider failed" }, "review_error"],
    ["missing historical row", { omitHistoricalRow: true }, "finding_ledger_inconsistent"],
    ["contradictory tallies", { tallyOffset: 1 }, "finding_ledger_inconsistent"],
  ];
  for (const [label, shape, problem] of cases) {
    assert.deepEqual(
      spentInspectorGateCondition(spentGateDetail(shape)),
      { kind: "evidence_unavailable", problem },
      label,
    );
  }
  assert.equal(spentInspectorGateCondition(spentGateDetail({ latestMode: "full_workflow" })), null);
  assert.equal(spentInspectorGateCondition(spentGateDetail({ status: "waiting_for_new_head" })), null);
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
// the verdict's two words is that four of its five statuses PASS, and they are not the same
// kind of pass: "the command ran and was satisfied", "nobody configured one", "nobody
// authorized one", and "it already ran as often as this run allows" send an operator to four
// different places. Two of them share the LABEL "Skipped", which is why the assertion below
// is on the sentence: both are genuinely skips, and what differs is the reason.

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
