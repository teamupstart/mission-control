import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  deliverable,
  detectAlerts,
  digestLine,
  hasReportable,
  type AlertScope,
} from "../src/shared/alerts.ts";
import { emptyBuffer, foldAlerts, rollupLine } from "../src/shared/away-buffer.ts";
import type { EnsembleSummary } from "../src/shared/ensemble.ts";
import { ensembleNeedsAttention } from "../src/shared/ensemble.ts";

// What is at stake: an ensemble's attention has to reach the SAME alert engine every other
// "needs you" already flows through, without a second notifier, poller or preferences panel.
// The failures this pins: a decision that should have interrupted you gets buffered; a run
// re-announces its decision on every reconnect because the trigger read a summary's presence
// instead of its transition; an Away digest carries run detail because something richer than
// the compact `EnsembleSummary` leaked into the scope; a `failed` run barges in mid-coffee when
// it is Retry/Restore/Cancel material for the digest. Modeled on workflow-alerts.test.ts.

function summary(patch: Partial<EnsembleSummary> = {}): EnsembleSummary {
  const base: EnsembleSummary = {
    id: "ens-1",
    title: "Try three approaches",
    repoRoot: "/repo",
    strategyId: "best_of_n",
    strategyKey: "best_of_n@1",
    strategyLabel: "Best of N",
    strategyVersion: 1,
    status: "running",
    activeStageId: "stage-1-candidates",
    memberCount: 3,
    launchedMembers: 3,
    maxMembers: 3,
    readyArtifacts: 0,
    membersOut: 0,
    membersNeedingInput: 0,
    membersReady: 0,
    selectedMemberId: null,
    outcomeKind: null,
    unreadable: null,
    attention: false,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
  };
  const merged = { ...base, ...patch };
  // The daemon derives `attention` from status, unreadable AND the blocked-member count; keep the
  // fixture honest so a test reading it cannot drift from what the manager would actually
  // broadcast. A member waiting on the operator is the third input, and it arrives here rather
  // than as a new alert class - see the blocked-member test below.
  merged.attention = ensembleNeedsAttention({
    status: merged.status,
    unreadable: merged.unreadable,
    membersNeedingInput: merged.membersNeedingInput,
  });
  return merged;
}

function scope(...ensembleSummaries: EnsembleSummary[]): AlertScope {
  return { sessions: [], tasks: [], ensembleSummaries };
}

test("a run reaching awaiting_decision alerts once with a stable deep-link id", () => {
  const before = scope(summary());
  const parked = scope(summary({ status: "awaiting_decision", activeStageId: "stage-3-decision" }));
  const alerts = detectAlerts(before, parked);
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0], {
    id: "ensemble:ens-1:decision",
    kind: "ensemble",
    title: "Try three approaches needs your decision",
    body: "Review the candidates and confirm a winner.",
    sessionId: null,
    ensembleId: "ens-1",
    severity: "attention",
  });
  assert.equal(deliverable(alerts[0]!), true);
  // Edge-triggered: the same summary redelivered (reconnect/recovery) says nothing new.
  assert.deepEqual(detectAlerts(parked, parked), []);
});

test("completion, cancellation and failure are digest-only; unreadable and stuck finalization interrupt", () => {
  const completed = detectAlerts(
    scope(summary({ status: "finalizing" })),
    scope(summary({ status: "completed", outcomeKind: "selected", completedAt: 9 })),
  );
  assert.equal(completed[0]?.id, "ensemble:ens-1:completed");
  assert.equal(completed[0]?.severity, "info");
  assert.equal(deliverable(completed[0]!), false);
  assert.match(completed[0]?.body ?? "", /winner was selected/);

  const cancelled = detectAlerts(scope(summary()), scope(summary({ status: "cancelled" })));
  assert.equal(cancelled[0]?.id, "ensemble:ens-1:cancelled");
  assert.equal(cancelled[0]?.severity, "info");

  const failed = detectAlerts(
    scope(summary()),
    scope(summary({ status: "failed", error: "fewer than two candidates submitted" })),
  );
  assert.equal(failed[0]?.id, "ensemble:ens-1:failed");
  assert.equal(failed[0]?.severity, "info");
  assert.equal(failed[0]?.body, "fewer than two candidates submitted");

  // A run this build cannot execute is blocked on a person to upgrade or cancel it.
  const unreadable = detectAlerts(
    scope(summary()),
    scope(summary({ status: null, unreadable: { reason: "unknown strategy key nextgen@3", fields: ["strategy_key"] } })),
  );
  assert.equal(unreadable[0]?.id, "ensemble:ens-1:unreadable");
  assert.equal(unreadable[0]?.severity, "attention");
  assert.match(unreadable[0]?.body ?? "", /nextgen@3/);

  // Finalization normally settles in milliseconds; one holding an error is stuck and needs
  // resolve_finalization. Edge-triggered on the error appearing, not on entering finalizing.
  const enteringFinalizing = detectAlerts(
    scope(summary({ status: "awaiting_decision" })),
    scope(summary({ status: "finalizing", error: null })),
  );
  assert.deepEqual(enteringFinalizing, []);
  const stuckFinalizing = detectAlerts(
    scope(summary({ status: "finalizing", error: null })),
    scope(summary({ status: "finalizing", error: "the winner's worktree is busy; retry" })),
  );
  assert.equal(stuckFinalizing[0]?.id, "ensemble:ens-1:finalizing");
  assert.equal(stuckFinalizing[0]?.severity, "attention");
});

test("a blocked member raises the run's attention without inventing a second notification", () => {
  // The whole point of the blocked-member wire: a run whose STATUS is `running` while a candidate
  // sits on an unanswered question is a run that needs the operator, so the badge, the
  // attention-first sort and the digest all light up.
  const working = summary();
  assert.equal(working.attention, false);
  const blocked = summary({ membersNeedingInput: 1 });
  assert.equal(blocked.attention, true, "a member waiting on you is the run waiting on you");
  assert.match(digestLine(scope(blocked)), /1 ensemble attention/);
  assert.equal(hasReportable(scope(blocked)), true);

  // And deliberately NO new alert class. That member's own session already fired the
  // session-level review/needs-input alert; a second OS notification for the same fact is a
  // duplicate the operator has to dismiss twice. Revisit this decision before adding one.
  assert.deepEqual(detectAlerts(scope(working), scope(blocked)), []);
  assert.deepEqual(detectAlerts(scope(blocked), scope(working)), []);
  // The classes that DO fire still fire while a member is blocked - the two are independent.
  const parked = detectAlerts(
    scope(blocked),
    scope(summary({ status: "awaiting_decision", membersNeedingInput: 1 })),
  );
  assert.deepEqual(
    parked.map((alert) => alert.id),
    ["ensemble:ens-1:decision"],
  );
});

test("a reconnect from an empty scope still surfaces an attention run, coalesced not stormed", () => {
  const empty: AlertScope = { sessions: [], tasks: [], ensembleSummaries: [] };
  const parked = detectAlerts(empty, scope(summary({ status: "awaiting_decision" })));
  assert.equal(parked[0]?.id, "ensemble:ens-1:decision");
  assert.equal(parked[0]?.severity, "attention");

  // A completed run appearing on reconnect is digest material, and folds into a rollup line.
  const completed = detectAlerts(empty, scope(summary({ status: "completed", outcomeKind: "selected" })));
  const buffer = foldAlerts(emptyBuffer(1), completed, 2);
  assert.match(rollupLine(buffer), /ensemble update/);
});

test("digestLine counts ensemble attention and hasReportable follows non-terminal runs", () => {
  const busy: AlertScope = {
    sessions: [],
    tasks: [],
    ensembleSummaries: [summary({ status: "awaiting_decision" }), summary({ id: "ens-2", status: "running" })],
  };
  assert.match(digestLine(busy), /1 ensemble attention/);
  assert.equal(hasReportable(busy), true);

  const doneOnly: AlertScope = {
    sessions: [],
    tasks: [],
    ensembleSummaries: [summary({ status: "completed", outcomeKind: "selected" })],
  };
  assert.doesNotMatch(digestLine(doneOnly), /ensemble attention/);
  assert.equal(hasReportable(doneOnly), false);
});

test("the notifier delivers the ensemble deep link through the one shared detector", () => {
  const source = readFileSync(new URL("../src/web/useNotifier.ts", import.meta.url), "utf8");
  assert.match(source, /a\.ensembleId/);
  assert.match(source, /#\/workflows\/ensembles\/\$\{encodeURIComponent\(deepLink\.ensembleId\)\}/);
  // No second detector: the ensemble path rides the same filter(deliverable) every kind does.
  assert.match(source, /detectAlerts\(withKnownStalls\(prev, scope\), scope\)\.filter\(deliverable\)/);
});
