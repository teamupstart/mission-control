import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deliverable, detectAlerts, type AlertScope } from "../src/shared/alerts.ts";
import { emptyBuffer, foldAlerts, rollupLine } from "../src/shared/away-buffer.ts";
import type { WorkflowRunRepeatOffender, WorkflowRunSummary } from "../src/shared/workflow.ts";

function run(patch: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: "run-1",
    bindingId: "binding",
    workflowId: "workflow",
    workflowName: "Security review",
    workflowVersion: 2,
    sessionId: "session",
    noteKey: "note",
    status: "running",
    phase: "persona_review",
    round: 1,
    maxRepairRounds: 5,
    activePersonaNames: [],
    failedPersonaCount: 0,
    bypassedPersonaReview: false,
    gate: "none",
    gatePrNumber: null,
    gateHeadShort: null,
    reviewPosture: null,
    uncertainDeliveryCount: 0,
    refusedDeliveryCount: 0,
    updatedAt: 1,
    ...patch,
  };
}

function scope(workflowRun: WorkflowRunSummary): AlertScope {
  return { sessions: [], tasks: [], workflowRuns: [workflowRun] };
}

test("workflow attention transitions alert once with stable deep-link ids", () => {
  const previous = scope(run());
  const uncertain = scope(run({
    status: "blocked",
    phase: "delivery_uncertain",
    uncertainDeliveryCount: 1,
  }));
  const alerts = detectAlerts(previous, uncertain);
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0], {
    id: "workflow:run-1:uncertain",
    kind: "workflow",
    title: "Security review delivery is uncertain",
    body: "Confirm whether the packet arrived before choosing a resolution.",
    sessionId: "session",
    workflowRunId: "run-1",
    severity: "attention",
  });
  assert.equal(deliverable(alerts[0]!), true);
  assert.deepEqual(detectAlerts(uncertain, uncertain), []);
  assert.deepEqual(detectAlerts(
    uncertain,
    scope(run({ status: "blocked", phase: "delivery_uncertain", uncertainDeliveryCount: 0 })),
  ), []);
});

test("completion and resumed transitions are digest-only, and parking is not an alert", () => {
  const completed = detectAlerts(scope(run()), scope(run({ status: "completed", phase: "complete" })));
  assert.equal(completed[0]?.id, "workflow:run-1:completed");
  assert.equal(completed[0]?.severity, "info");
  assert.equal(deliverable(completed[0]!), false);

  // Parking says nothing. The packet has only just been prepared, so a `manual-resubmit`
  // alert here would name a resubmit the agent has not yet made necessary - and on the
  // shipped `auto` + `live` posture the observer reopens the round about fifteen seconds
  // later, with nobody having had to do anything. See `stall.ts`'s `workflow-parked` kind
  // for where this moved to, and `alerts.test.ts` for the two halves asserted together.
  const waitingRun = run({ status: "waiting_for_session", phase: "unchanged_evidence" });
  assert.deepEqual(detectAlerts(scope(run()), scope(waitingRun)), []);

  const resumed = detectAlerts(
    scope(run({ status: "blocked", phase: "infrastructure_error" })),
    scope(run()),
  );
  assert.equal(resumed[0]?.id, "workflow:run-1:resumed");
  assert.equal(resumed[0]?.severity, "info");
  const inspectorResumed = detectAlerts(
    scope(run({ status: "blocked", phase: "inspector_disabled", gate: "blocked" })),
    scope(run({
      status: "waiting_for_inspector",
      phase: "inspector_review",
      gate: "waiting_inspector",
    })),
  );
  assert.equal(inspectorResumed[0]?.id, "workflow:run-1:resumed");
  assert.equal(inspectorResumed[0]?.severity, "info");
  const buffer = foldAlerts(emptyBuffer(1), completed, 2);
  assert.match(rollupLine(buffer), /workflow update/);
});

test("new reconnect summaries retain attention and Inspector transition semantics", () => {
  const empty: AlertScope = { sessions: [], tasks: [], workflowRuns: [] };
  const blocked = detectAlerts(
    empty,
    scope(run({ status: "blocked", phase: "infrastructure_error" })),
  );
  assert.equal(blocked[0]?.id, "workflow:run-1:blocked");
  assert.equal(blocked[0]?.severity, "attention");

  const uncertain = detectAlerts(
    empty,
    scope(run({
      status: "blocked",
      phase: "delivery_uncertain",
      uncertainDeliveryCount: 1,
    })),
  );
  assert.equal(uncertain[0]?.id, "workflow:run-1:uncertain");

  const inspectorDisabled = detectAlerts(
    scope(run()),
    scope(run({
      status: "blocked",
      phase: "inspector_disabled",
      gate: "blocked",
    })),
  );
  assert.equal(inspectorDisabled[0]?.id, "workflow:run-1:inspector-enablement");
  assert.match(inspectorDisabled[0]?.title ?? "", /Inspector enabled/);
});

test("notifier preserves workflow deep links and reconnect uses the shared detector", () => {
  const source = readFileSync(
    new URL("../src/web/useNotifier.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /a\.workflowRunId/);
  assert.match(source, /#\/runs\/\$\{encodeURIComponent\(deepLink\.workflowRunId\)\}/);
  assert.match(
    source,
    /detectAlerts\(withKnownStalls\(prev, scope\), scope\)\.filter\(deliverable\)/,
  );
  assert.match(source, /"reconnect-catchup"/);
});

// ---- repeat offenders ----

function offender(patch: Partial<WorkflowRunRepeatOffender> = {}): WorkflowRunRepeatOffender {
  return {
    runId: "run-1",
    workflowName: "Security review",
    sessionId: "session",
    round: 3,
    maxRepairRounds: 5,
    nodeId: "code-risk",
    personaName: "Code Risk Reviewer",
    rounds: 2,
    ...patch,
  };
}

test("a repeat offender alerts once per round it burns, not once per tick", () => {
  // Auto-resumption can spend a whole repair budget unattended, so a member rejecting the
  // same work round after round has to reach a human. Edge-triggered on the STREAK GROWING:
  // a loop that persists across ticks must not re-announce, and the third failure must still
  // be news after the second was reported.
  const base: AlertScope = { sessions: [], tasks: [], workflowRuns: [] };
  const first = detectAlerts(
    { ...base, workflowRepeatOffenders: [] },
    { ...base, workflowRepeatOffenders: [offender()] },
  );
  assert.equal(first.length, 1);
  assert.equal(first[0]?.kind, "workflow-repeat");
  assert.equal(first[0]?.id, "workflow-repeat:run-1:code-risk");
  assert.equal(first[0]?.workflowRunId, "run-1");
  assert.equal(first[0]?.severity, "attention");
  assert.equal(deliverable(first[0]!), true);
  assert.match(first[0]?.title ?? "", /Code Risk Reviewer has failed 2 rounds running/);
  assert.match(first[0]?.body ?? "", /round 3 of 5/);

  const unchanged = detectAlerts(
    { ...base, workflowRepeatOffenders: [offender()] },
    { ...base, workflowRepeatOffenders: [offender()] },
  );
  assert.deepEqual(unchanged, []);

  const grew = detectAlerts(
    { ...base, workflowRepeatOffenders: [offender()] },
    { ...base, workflowRepeatOffenders: [offender({ rounds: 3, round: 4 })] },
  );
  assert.equal(grew.length, 1);
  assert.match(grew[0]?.title ?? "", /failed 3 rounds running/);

  // Two members stuck on one run are two things to look at, so they carry distinct ids.
  const both = detectAlerts(
    { ...base, workflowRepeatOffenders: [] },
    {
      ...base,
      workflowRepeatOffenders: [offender(), offender({ nodeId: "docs", personaName: "Documentation Steward" })],
    },
  );
  assert.deepEqual(
    both.map((alert) => alert.id),
    ["workflow-repeat:run-1:code-risk", "workflow-repeat:run-1:docs"],
  );
});

test("an absent repeat-offender channel means NOT READ YET, not resolved", () => {
  // Same reading `stalls` gets. A browser scope carries none of these (the derivation is
  // detail-only and never travels on the SSE summary), and it must emit nothing rather than
  // treat every offender as new or as cleared.
  const base: AlertScope = { sessions: [], tasks: [], workflowRuns: [] };
  assert.deepEqual(detectAlerts(base, base), []);
  assert.deepEqual(detectAlerts({ ...base, workflowRepeatOffenders: [offender()] }, base), []);
});

test("the repeat-offender digest names the loop rather than counting workflow updates", () => {
  const folded = foldAlerts(
    emptyBuffer(0),
    detectAlerts(
      { sessions: [], tasks: [], workflowRepeatOffenders: [] },
      { sessions: [], tasks: [], workflowRepeatOffenders: [offender()] },
    ),
    1,
  );
  assert.match(rollupLine(folded), /1 review loop/);
});

/*
 * The notification fired at the MOMENT a run blocks, and whether it names the cause.
 *
 * This is the surface the reported incident was invisible on. A No-Mistakes run stopped 1.27
 * seconds in on `image_evidence_capture`, the daemon wrote an exact human sentence into the
 * run's gate state, and the alert that fired said "image evidence capture" - a pipeline stage,
 * not a reason. It printed the phase through its own hand-rolled `replaceAll` because the
 * clause map lived in `src/web/` and `alerts.ts` runs in the daemon too.
 *
 * Asserted here rather than only through `blockedPhaseClause`'s own test because the defect
 * was never in the map: it was that this reader did not consult it.
 */
test("a blocked run's alert body is the cause, not the phase code", () => {
  const blocked = detectAlerts(
    scope(run()),
    scope(run({ status: "blocked", phase: "image_evidence_capture" })),
  );
  assert.equal(blocked[0]?.title, "Security review blocked");
  assert.equal(blocked[0]?.body, "registered evidence refused");
  assert.notEqual(blocked[0]?.body, "image evidence capture");

  // The live example from the operator's own state database, and the second surface this
  // vocabulary reaches: a run parked on the evidence-preflight cap.
  const exhausted = detectAlerts(
    scope(run()),
    scope(run({ status: "blocked", phase: "preflight_refinement_exhausted" })),
  );
  assert.equal(exhausted[0]?.body, "out of evidence refinements");

  // A phase this build has never heard of still degrades to readable text rather than to
  // `undefined`, which is the property the triage column depends on too - and now the same
  // function produces it for both, so they cannot drift apart again.
  const unknown = detectAlerts(
    scope(run()),
    scope(run({ status: "failed", phase: "a_phase_from_a_newer_daemon" })),
  );
  assert.equal(unknown[0]?.body, "a phase from a newer daemon");

  // Leaving a block reads the same map. Most phases reachable on the way out are running ones
  // with no entry, so the text is unchanged - `inspector_head_mismatch` is the exception,
  // because it declares `waiting_for_inspector` alongside `blocked` and a run can leave the
  // block still parked on it.
  const resumed = detectAlerts(
    scope(run({ status: "blocked", phase: "inspector_head_mismatch" })),
    scope(run({ status: "waiting_for_inspector", phase: "inspector_head_mismatch" })),
  );
  assert.equal(resumed[0]?.id, "workflow:run-1:resumed");
  assert.equal(resumed[0]?.body, "head moved");
});
