import test from "node:test";
import assert from "node:assert/strict";
import { WORKFLOW_RUN_PHASES, WORKFLOW_RUN_PHASE_STATUSES } from "../src/shared/workflow-lifecycle.ts";
import type { WorkflowRunDetail, WorkflowRunSummary } from "../src/shared/workflow.ts";
import { projectWorkflowRecovery, WORKFLOW_PHASE_RECOVERY, type WorkflowRecoveryContext } from "../src/server/workflows/recovery.ts";
import { runNextMove, inspectorGateActions, refusedUnchangedRequestId, runNoMoveReason } from "../src/web/workflows/run-actions.ts";
import { runPosture, runRemedy } from "../src/web/workflows/run-model.ts";

const context = (patch: Partial<WorkflowRecoveryContext> = {}): WorkflowRecoveryContext => ({
  status: "blocked", phase: "infrastructure_error", bindingId: "binding", bindingState: "active",
  sessionId: "session", external: false, round: 1, maxRepairRounds: 3,
  latest: { mode: "full_workflow", status: "failed", triggerSource: "manual", triggerKey: "manual:binding:request" },
  attempts: [{ state: "error" }], gate: null, completionPolicy: { kind: "none" }, bindingHasOtherRun: false,
  ...patch,
});

function detail(c: WorkflowRecoveryContext): WorkflowRunDetail {
  const recovery = projectWorkflowRecovery(c);
  return {
    summary: { id: "run", bindingId: "binding", workflowName: "Review", workflowVersion: 1,
      status: c.status, phase: c.phase, round: c.round, maxRepairRounds: c.maxRepairRounds, recovery },
    run: { id: "run", status: c.status, currentPhase: c.phase, recovery },
    binding: { id: "binding", state: c.bindingState, sessionId: c.sessionId, deliveryMode: "preview" },
    version: { completionPolicy: c.completionPolicy }, submissions: [], attempts: [], events: [], deliveries: [],
    inspectorGate: null,
  } as unknown as WorkflowRunDetail;
}

test("every registered phase explicitly declares recovery policy", () => {
  assert.deepEqual(Object.keys(WORKFLOW_PHASE_RECOVERY).sort(), [...WORKFLOW_RUN_PHASES].sort());
});

test("every phase/status recovery projection agrees with both dashboard surfaces", () => {
  for (const phase of WORKFLOW_RUN_PHASES) {
    for (const status of WORKFLOW_RUN_PHASE_STATUSES[phase]) {
      for (const bindingState of ["active", "orphaned"] as const) {
        const d = detail(context({ phase, status, bindingState }));
        const recovery = d.summary.recovery!;
        assert.equal(runNextMove(d)?.kind ?? null, recovery.primary, `${status}/${phase}/${bindingState}`);
        const triage = runRemedy(d.summary)?.kind ?? null;
        assert.equal(triage, recovery.triage === "cancel" ? "dismiss" : recovery.triage);
        for (const action of inspectorGateActions(d)) {
          if (action.kind !== "open-pr") assert.ok(recovery.operations.includes(action.kind));
        }
      }
    }
  }
});

test("the browser follows explicit capabilities even when phase, status and attempts disagree", () => {
  const d = detail(context());
  d.run.currentPhase = "a_new_daemon_phase";
  d.summary.phase = "a_new_daemon_phase";
  d.run.status = "running";
  d.summary.status = "running";
  assert.equal(runNextMove(d)?.kind, "retry");
  assert.equal(runRemedy(d.summary)?.kind, "retry");
  d.summary.recovery = { ...d.summary.recovery!, operations: [], primary: null, triage: null };
  assert.equal(runNextMove(d), null);
  assert.equal(runRemedy(d.summary), null);
});

test("unknown phases and old payloads cannot invent a recovery", () => {
  const d = detail(context({ phase: "a_new_daemon_phase" }));
  assert.deepEqual(d.summary.recovery?.operations, ["cancel"]);
  assert.equal(runNextMove(d), null);
  assert.equal(runRemedy(d.summary), null);
  assert.match(runNoMoveReason(d)!.cause, /does not recognize/);
  delete d.summary.recovery;
  d.run.currentPhase = "infrastructure_error";
  d.summary.phase = "infrastructure_error";
  assert.equal(runNextMove(d), null);
  assert.equal(runRemedy(d.summary), null);
  assert.deepEqual(inspectorGateActions(d), []);
  assert.equal(refusedUnchangedRequestId(d), null);
});

test("retry needs a current error, restart needs budget, and rerun needs a free binding", () => {
  assert.ok(projectWorkflowRecovery(context()).operations.includes("retry"));
  assert.ok(!projectWorkflowRecovery(context({ attempts: [{ state: "completed" }] })).operations.includes("retry"));
  const gate = { waitReason: "findings" } as WorkflowRecoveryContext["gate"];
  const latest = { ...context().latest!, mode: "inspector_only" as const };
  assert.ok(projectWorkflowRecovery(context({ status: "waiting_for_new_head", phase: "inspector_findings", gate, latest })).operations.includes("restart-full"));
  assert.ok(!projectWorkflowRecovery(context({ status: "blocked", phase: "round_limit", round: 4, gate, latest })).operations.includes("restart-full"));
  assert.ok(!projectWorkflowRecovery(context({ status: "completed", phase: "complete", bindingHasOtherRun: true })).operations.includes("run-again"));
});

test("a triage hint cannot authorize an operation missing from the allowed set", () => {
  const run = detail(context()).summary;
  run.recovery!.operations = [];
  assert.equal(runRemedy(run as WorkflowRunSummary), null);
});

test("a head-mismatch handoff retains the daemon's Inspector recheck recovery", () => {
  const d = detail(context({
    status: "waiting_for_session", phase: "inspector_head_mismatch",
    gate: { waitReason: "head_mismatch" } as WorkflowRecoveryContext["gate"],
  }));
  assert.ok(d.summary.recovery?.operations.includes("recheck-inspector"));
  assert.ok(inspectorGateActions(d).some((action) => action.kind === "recheck-inspector"));
});

test("a clean-review wait keeps the Inspector recheck available", () => {
  const d = detail(context({
    status: "waiting_for_inspector", phase: "inspector_clean_review",
    gate: { waitReason: "clean_review_pending" } as WorkflowRecoveryContext["gate"],
  }));
  assert.equal(d.summary.recovery?.phaseKnown, true);
  assert.equal(runNextMove(d)?.kind, "recheck-inspector");
});

// Reported as a dead end: an open pull request blocked as closed offered only cancel and a full
// restart, and a recheck was refused. Recheck is now the block's one non-destructive move,
// beside - never instead of - the destructive pair it used to be stranded with.
test("a closed-PR block offers the Inspector recheck as its next move", () => {
  const gate = { waitReason: "pr_closed" } as WorkflowRecoveryContext["gate"];
  const completionPolicy = {
    kind: "inspector", onFindings: "inspector_only", missingPrAction: "offer_prepare_pr",
  } as const;
  for (const mode of ["full_workflow", "inspector_only"] as const) {
    const d = detail(context({
      status: "blocked", phase: "inspector_pr_closed", gate, completionPolicy,
      latest: { ...context().latest!, mode, status: "completed" }, attempts: [],
    }));
    const recovery = d.summary.recovery!;
    assert.ok(recovery.operations.includes("recheck-inspector"), mode);
    assert.ok(recovery.operations.includes("cancel"), mode);
    assert.equal(recovery.operations.includes("restart-full"), mode === "inspector_only", mode);
    assert.equal(recovery.primary, "recheck-inspector", mode);
    assert.equal(runNextMove(d)?.label, "Check again", mode);
    assert.ok(inspectorGateActions(d).some((action) => action.kind === "recheck-inspector"), mode);
  }
});

test("a session action blocked by a lost session offers a round-free retry, even past the budget", () => {
  // The report: round 11 of a cap of 10, `resubmit` refused, `grant-rounds` absent, retry
  // refused as not an infrastructure failure, and only `cancel` left.
  const lost = context({
    phase: "session_action_blocked", round: 11, maxRepairRounds: 10,
    latest: { mode: "full_workflow", status: "running", triggerSource: "manual", triggerKey: "manual:binding:request" },
    attempts: [{ state: "error" }], recoverableSessionAction: true,
  });
  const recovery = projectWorkflowRecovery(lost);
  assert.ok(recovery.operations.includes("retry"));
  assert.equal(recovery.primary, "retry");
  assert.equal(recovery.triage, "retry");
  assert.match(recovery.resubmit?.refusal ?? "", /used every repair round/);
  const move = runNextMove(detail(lost));
  assert.equal(move?.kind, "retry");
  assert.equal(move?.label, "Check the action again");
  assert.match(move?.tooltip ?? "", /without spending a repair round/);
  assert.match(runRemedy(detail(lost).summary)?.tooltip ?? "", /no repair round is spent/);

  // Any other action block keeps its old answer, and so does a detached binding.
  assert.ok(!projectWorkflowRecovery({ ...lost, recoverableSessionAction: false }).operations.includes("retry"));
  assert.ok(!projectWorkflowRecovery({ ...lost, bindingState: "orphaned", sessionId: null }).operations.includes("retry"));
});

test("a recoverable lost-session block does not tell the operator it will never restart", () => {
  const lost = context({
    phase: "session_action_blocked",
    latest: { mode: "full_workflow", status: "running", triggerSource: "manual", triggerKey: "manual:binding:request" },
    recoverableSessionAction: true,
  });
  const recoverable = detail(lost);
  recoverable.run.gateState = { nodeId: "act", attemptId: "attempt", code: "session_lost", detail: "away" };
  const posture = runPosture(recoverable);
  assert.match(posture?.sentence ?? "", /checked again on its own when the session is running/);
  assert.match(posture?.sentence ?? "", /No repair round was spent/);
  assert.doesNotMatch(posture?.sentence ?? "", /will not restart on its own/);

  // Any other action block, or a lost session with no re-check on offer, keeps the old words.
  const other = detail({ ...lost, recoverableSessionAction: false });
  other.run.gateState = { nodeId: "act", attemptId: "attempt", code: "capture_failed", detail: "git" };
  assert.match(runPosture(other)?.sentence ?? "", /will not restart on its own/);
  const detached = detail({ ...lost, bindingState: "orphaned", sessionId: null });
  detached.run.gateState = { nodeId: "act", attemptId: "attempt", code: "session_lost", detail: "away" };
  assert.match(runPosture(detached)?.sentence ?? "", /will not restart on its own/);
});
