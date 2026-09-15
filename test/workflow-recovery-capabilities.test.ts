import test from "node:test";
import assert from "node:assert/strict";
import { WORKFLOW_RUN_PHASES, WORKFLOW_RUN_PHASE_STATUSES } from "../src/shared/workflow-lifecycle.ts";
import type { WorkflowRunDetail, WorkflowRunSummary } from "../src/shared/workflow.ts";
import { projectWorkflowRecovery, WORKFLOW_PHASE_RECOVERY, type WorkflowRecoveryContext } from "../src/server/workflows/recovery.ts";
import { runNextMove, inspectorGateActions, refusedUnchangedRequestId, runNoMoveReason } from "../src/web/workflows/run-actions.ts";
import { runRemedy } from "../src/web/workflows/run-model.ts";

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
