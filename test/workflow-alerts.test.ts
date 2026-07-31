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

test("completion and resumed transitions are digest-only while manual waits need attention", () => {
  const completed = detectAlerts(scope(run()), scope(run({ status: "completed", phase: "complete" })));
  assert.equal(completed[0]?.id, "workflow:run-1:completed");
  assert.equal(completed[0]?.severity, "info");
  assert.equal(deliverable(completed[0]!), false);

  const waitingRun = run({ status: "waiting_for_session", phase: "unchanged_evidence" });
  const waiting = detectAlerts(scope(run()), scope(waitingRun));
  assert.equal(waiting[0]?.id, "workflow:run-1:manual-resubmit");
  assert.equal(waiting[0]?.severity, "attention");

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
  assert.match(source, /#\/workflows\/runs\/\$\{encodeURIComponent\(deepLink\.workflowRunId\)\}/);
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
