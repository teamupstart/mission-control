import { fleetRunsBySession } from "../src/web/lib/held.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { workflowHold } from "../src/web/lib/workflow-hold.ts";
import type { SessionActionWaitReason, WorkflowGateWaitReason, WorkflowResumptionWithheldReason, WorkflowRunSummary } from "../src/shared/workflow.ts";
import { WORKFLOW_GATE_WAIT_REASONS, WORKFLOW_RESUMPTION_WITHHELD_REASONS } from "../src/shared/workflow.ts";

const run: WorkflowRunSummary = {
  id: "run", bindingId: "binding", workflowId: "workflow", workflowName: "Review",
  workflowVersion: 1, sessionId: "session", noteKey: "note", status: "waiting_for_session",
  phase: "repair_wait", round: 1, maxRepairRounds: 3, activePersonaNames: [],
  failedPersonaCount: 0, bypassedPersonaReview: false, gate: "none", gatePrNumber: null,
  gateHeadShort: null, reviewPosture: null, updatedAt: 1,
};

test("manual and preview reviews name the operator, automatic repairs name the session", () => {
  for (const settings of [{ resumptionPolicy: "manual" as const }, { deliveryMode: "preview" as const }]) {
    assert.equal(workflowHold({ ...run, ...settings })?.actor, "Operator");
    assert.equal(workflowHold({ ...run, ...settings })?.inProgress, false);
  }
  assert.equal(workflowHold({ ...run, resumptionPolicy: "auto", deliveryMode: "live" })?.actor, "Session");
  assert.equal(workflowHold({ ...run, resumption: { reason: "session_needs_you", round: 1, resumesItself: true } })?.actor, "Operator");
  assert.match(workflowHold({ ...run, resumption: { reason: "session_blocked", round: 1, resumesItself: true } })!.reason, /blocker is cleared/);
});

test("Inspector association gaps differ from healthy automatic reviews", () => {
  const missing = workflowHold({ ...run, status: "waiting_for_pr", gateWaitReason: "unadopted_pr" })!;
  assert.equal(missing.actor, "Operator");
  assert.match(missing.reason, /not adopted/);
  for (const gateWaitReason of ["review_pending", "awaiting_fresh_observation", "review_backoff"] as const) {
    const hold = workflowHold({ ...run, status: "waiting_for_inspector", gateWaitReason })!;
    assert.equal(hold.actor, "GitHub Inspector");
    assert.equal(hold.inProgress, true);
  }
  assert.match(workflowHold({ ...run, status: "running", activePersonaNames: ["Auditor"] })!.reason, /Auditor/);
});

test("every gate reason has an explicit next actor and progress state", () => {
  const expected: Record<WorkflowGateWaitReason, [string, boolean, RegExp]> = {
    missing_pr: ["Operator", false, /No pull request/],
    unadopted_pr: ["Operator", false, /not adopted/],
    inspector_disabled: ["Operator", false, /switched off/],
    awaiting_fresh_observation: ["GitHub Inspector", true, /next sweep/],
    working_tree_not_pushed: ["Session", true, /commit and push/],
    head_mismatch: ["Session", true, /not the commit/],
    review_pending: ["GitHub Inspector", true, /not finished reviewing/],
    review_backoff: ["GitHub Inspector", true, /retry backoff/],
    review_error: ["GitHub Inspector", true, /attempt errored/],
    findings: ["Session", true, /findings.*resolved/],
    pr_closed: ["Operator", false, /closed or switched/],
    clean_review_pending: ["GitHub Inspector", true, /confirm its final clean review/],
    reviewed_tree_changed: ["Operator", false, /Review the pushed head/],
  };
  for (const gateWaitReason of WORKFLOW_GATE_WAIT_REASONS) {
    const hold = workflowHold({ ...run, status: "waiting_for_inspector", gateWaitReason })!;
    const [actor, inProgress, sentence] = expected[gateWaitReason];
    assert.deepEqual([hold.actor, hold.inProgress, hold.runId], [actor, inProgress, run.id], gateWaitReason);
    assert.match(hold.reason, sentence, gateWaitReason);
  }
});

test("a retained gate reason cannot mask current capture or review progress", () => {
  for (const status of ["capturing", "running", "waiting_for_evidence_readiness"] as const) {
    const current = { ...run, status, activePersonaNames: ["Auditor"] };
    const hold = workflowHold({ ...current, gateWaitReason: "findings" })!;
    assert.deepEqual(hold, workflowHold(current), status);
    assert.equal(hold.actor, "Workflow", status);
    assert.equal(hold.inProgress, true, status);
  }
});

test("unknown stored wait reasons remain inspectable without claiming healthy progress", () => {
  for (const unknown of ["future_operator_wait", "toString", "__proto__"]) {
    for (const held of [
      { ...run, status: "waiting_for_inspector" as const, gateWaitReason: unknown as WorkflowGateWaitReason },
      { ...run, resumption: { reason: unknown, round: 1, resumesItself: true } },
    ]) {
      const hold = workflowHold(held)!;
      assert.equal(hold.actor, "Operator", unknown);
      assert.equal(hold.inProgress, false, unknown);
      assert.match(hold.reason, /unrecognized.*Open the run for details/);
      assert.equal(hold.runId, run.id);
    }
  }
});

test("the queue links its actual owning run, and ending a run removes the projection", () => {
  const queued = { ...run, deliveryHold: { runId: "owner", deliveryId: "packet", repoRoot: "/repos/backend",
    kind: "evidence_readiness" as const, state: "delivered" as const } };
  assert.equal(workflowHold(queued)?.runId, "owner");
  assert.match(workflowHold(queued)!.reason, /backend/);
  for (const status of ["completed", "cancelled", "failed"] as const) {
    assert.equal(workflowHold({ ...queued, status }), null);
  }
  assert.equal(workflowHold({ ...queued, deliveryHold: null })?.runId, "run");
});

test("unknown blocked phases stay inspectable without claiming automatic progress", () => {
  const hold = workflowHold({ ...run, status: "blocked", phase: "future_wait" })!;
  assert.equal(hold.reason, "future wait");
  assert.equal(hold.actor, "Operator");
  assert.equal(hold.inProgress, false);
});


test("a newer completed run cannot hide an open wait from the same repository", () => {
  const runs = fleetRunsBySession([run, { ...run, id: "finished", status: "completed", updatedAt: 2 }]);
  assert.deepEqual(runs.get("session")?.map(r => r.id), ["run"]);
  assert.deepEqual(fleetRunsBySession([{ ...run, status: "completed" },
    { ...run, id: "finished", status: "completed", updatedAt: 2 }]).get("session")?.map(r => r.id), ["finished"]);
});


test("session action holds name the actor, reason and progress for human and automatic waits", () => {
  const cases: Array<{
    wait: SessionActionWaitReason | null;
    actor: "Operator" | "Session";
    reason: string;
    inProgress: boolean;
  }> = [
    { wait: "needs_operator", actor: "Operator", inProgress: false,
      reason: "The session is waiting on an answer from you before it can continue. Next: you must answer the session's question." },
    { wait: "pull_request_wrong_branch", actor: "Operator", inProgress: false,
      reason: "This turn opened a pull request from a different branch, so it does not carry the reviewed commit. Open one from this branch, or reset the run. Next: the session must publish from the reviewed branch, or you can recover the run." },
    { wait: "working", actor: "Session", inProgress: true,
      reason: "The session is working on the instruction. Next: the session must finish the instruction." },
    { wait: "awaiting_pickup", actor: "Session", inProgress: true,
      reason: "Sent. Waiting for the session to pick the instruction up. Next: the session must pick up the delivered instruction." },
    { wait: null, actor: "Session", inProgress: true, reason: "Session action in progress." },
  ];
  for (const { wait, ...expected } of cases) {
    assert.deepEqual(workflowHold({ ...run, status: "waiting_for_action", phase: "session_action", actionWait: wait }),
      { ...expected, runId: run.id }, String(wait));
  }
});

test("withheld resumption holds distinguish operator, session and delivery progress", () => {
  const cases: Record<WorkflowResumptionWithheldReason, { actor: string; inProgress: boolean; text: string }> = {
    policy_manual: { actor: "Operator", inProgress: false,
      text: "This workflow version was published before automatic resumption existed, so the next round waits for you rather than for the session." },
    binding_inactive: { actor: "Operator", inProgress: false,
      text: "The review is no longer attached to a live session, so nothing is watching for the repair." },
    session_unavailable: { actor: "Operator", inProgress: false,
      text: "The bound session is gone or has been replaced, so the repair packet has no reader." },
    session_needs_you: { actor: "Operator", inProgress: false,
      text: "The session is waiting on you - a permission prompt or a dialog - so it has not been handed another round." },
    session_busy: { actor: "Session", inProgress: true,
      text: "The session is still working. The next round opens once it settles." },
    packet_undelivered: { actor: "Workflow", inProgress: true,
      text: "The repair packet has not reached the session yet, so there is nothing for it to have repaired." },
    repository_unchanged: { actor: "Session", inProgress: false,
      text: "Waiting on the session: the repository has not changed since round 1. Reviewing it again would return the same verdicts, so no round has been spent." },
    session_blocked: { actor: "Blocker owner", inProgress: false,
      text: "The session is blocked on someone other than you, so it has not been handed another round. The next round opens once its blocker is cleared." },
  };
  for (const reason of WORKFLOW_RESUMPTION_WITHHELD_REASONS) {
    const { actor, inProgress, text } = cases[reason];
    assert.deepEqual(workflowHold({ ...run, resumptionPolicy: "auto", deliveryMode: "live",
      resumption: { reason, round: 1, resumesItself: true } }),
    { actor, reason: text, inProgress, runId: run.id }, reason);
  }
});


test("an independent blocker names its owner without assigning the action to the session", () => {
  const blocker = { waitingOn: "Platform team" };
  for (const deliveryMode of ["live", "preview"] as const) {
    const held = { ...run, resumptionPolicy: "auto" as const, deliveryMode,
      resumption: { reason: "session_blocked", round: 1, resumesItself: deliveryMode === "live" } };
    assert.deepEqual(workflowHold(held, blocker), {
      actor: "Blocker owner", actorLabel: "Platform team", inProgress: false, runId: run.id,
      reason: "The session is blocked on someone other than you, so it has not been handed another round. The next round opens once its blocker is cleared.",
    }, deliveryMode);
    assert.equal(workflowHold(held)?.actor, "Blocker owner", `${deliveryMode}: missing blocker details must not blame the session`);
  }
  assert.deepEqual(blocker, { waitingOn: "Platform team" }, "display does not mutate the independent blocker");
});

test("only unsent Preview session actions require operator delivery", () => {
  for (const deliveryMode of ["live", "preview"] as const) {
    const waiting = { ...run, status: "waiting_for_action" as const, deliveryMode };
    assert.deepEqual(workflowHold({ ...waiting, actionWait: "awaiting_send" }), {
      actor: deliveryMode === "preview" ? "Operator" : "Workflow",
      reason: deliveryMode === "preview"
        ? "The instruction is ready in preview; send it to the session from the run."
        : "The instruction is ready and has not been sent to the session yet. Next: Mission Control sends the authorized instruction; in Preview, you send it from the run's delivery controls.",
      inProgress: deliveryMode === "live", runId: run.id,
    }, deliveryMode);
    for (const actionWait of ["awaiting_pickup", "working"] as const) {
      const hold = workflowHold({ ...waiting, actionWait })!;
      assert.equal(hold.actor, "Session", `${deliveryMode}: ${actionWait}`);
      assert.equal(hold.inProgress, true, `${deliveryMode}: ${actionWait}`);
    }
  }
});
