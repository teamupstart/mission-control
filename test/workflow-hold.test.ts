import { fleetRunsBySession } from "../src/web/lib/held.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { workflowHold } from "../src/web/lib/workflow-hold.ts";
import type { SessionActionWaitReason, WorkflowRunSummary } from "../src/shared/workflow.ts";

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
      reason: "The session is waiting on an answer from you before it can continue." },
    { wait: "pull_request_wrong_branch", actor: "Operator", inProgress: false,
      reason: "This turn opened a pull request from a different branch, so it does not carry the reviewed commit. Open one from this branch, or reset the run." },
    { wait: "working", actor: "Session", inProgress: true,
      reason: "The session is working on the instruction." },
    { wait: "awaiting_pickup", actor: "Session", inProgress: true,
      reason: "Sent. Waiting for the session to pick the instruction up." },
    { wait: null, actor: "Session", inProgress: true, reason: "Session action in progress." },
  ];
  for (const { wait, ...expected } of cases) {
    assert.deepEqual(workflowHold({ ...run, status: "waiting_for_action", phase: "session_action", actionWait: wait }),
      { ...expected, runId: run.id }, String(wait));
  }
});

test("withheld resumption holds distinguish operator, session and delivery progress", () => {
  const cases = [
    { reason: "session_needs_you", actor: "Operator", inProgress: false,
      text: "The session is waiting on you - a permission prompt or a dialog - so it has not been handed another round." },
    { reason: "session_busy", actor: "Session", inProgress: true,
      text: "The session is still working. The next round opens once it settles." },
    { reason: "packet_undelivered", actor: "Workflow", inProgress: true,
      text: "The repair packet has not reached the session yet, so there is nothing for it to have repaired." },
    { reason: "session_blocked", actor: "Blocker owner", inProgress: false,
      text: "The session is blocked on someone other than you, so it has not been handed another round. The next round opens once its blocker is cleared." },
  ];
  for (const { reason, actor, inProgress, text } of cases) {
    assert.deepEqual(workflowHold({ ...run, resumptionPolicy: "auto", deliveryMode: "live",
      resumption: { reason, round: 1, resumesItself: true } }),
    { actor, reason: text, inProgress, runId: run.id }, reason);
  }
});


test("an independent blocker names its owner without assigning the action to the session", () => {
  const held = { ...run, resumptionPolicy: "auto" as const, deliveryMode: "live" as const,
    resumption: { reason: "session_blocked", round: 1, resumesItself: true } };
  const blocker = { waitingOn: "Platform team" };
  assert.deepEqual(workflowHold(held, blocker), {
    ...workflowHold(held), actor: "Blocker owner", actorLabel: "Platform team", inProgress: false,
  });
  assert.equal(workflowHold(held)?.actor, "Blocker owner", "missing blocker details must not blame the session");
  assert.deepEqual(blocker, { waitingOn: "Platform team" }, "display does not mutate the independent blocker");
});
