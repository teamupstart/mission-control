import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deliverable, detectAlerts, type AlertScope } from "../src/shared/alerts.ts";
import { emptyBuffer, foldAlerts, rollupLine } from "../src/shared/away-buffer.ts";
import type { WorkflowRunSummary } from "../src/shared/workflow.ts";

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
  const buffer = foldAlerts(emptyBuffer(1), completed, 2);
  assert.match(rollupLine(buffer), /workflow update/);
});

test("notifier preserves workflow deep links and reconnect uses the shared detector", () => {
  const source = readFileSync(
    new URL("../src/web/useNotifier.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /a\.workflowRunId/);
  assert.match(source, /#\/workflows\/runs\/\$\{encodeURIComponent\(workflowRunId\)\}/);
  assert.match(
    source,
    /detectAlerts\(withKnownStalls\(prev, scope\), scope\)\.filter\(deliverable\)/,
  );
  assert.match(source, /"reconnect-catchup"/);
});
