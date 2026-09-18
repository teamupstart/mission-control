import test from "node:test";
import assert from "node:assert/strict";
import { analyticalEvent, analyticalGoldenFixture, ANALYTICAL_DAY as DAY } from "./helpers/analytical-telemetry.ts";
import { calculateAnalytics } from "../src/server/telemetry/projections/calculate.ts";
import { initialAnalyticalState, reduceAnalyticalEvent, expireAnalyticalState, MAX_FACTS, MAX_SLICES } from "../src/server/telemetry/projections/state.ts";
import { ANALYTICAL_PROJECTION } from "../src/server/telemetry/projections/index.ts";
import { TELEMETRY_LIMITS } from "../src/shared/telemetry.ts";
import type { TelemetryEnvelope } from "../src/shared/telemetry.ts";
import { MODEL_CATALOG } from "../src/shared/model.ts";
import { ANALYTICAL_METADATA } from "../src/shared/telemetry-projections/index.ts";
import { analyticalPromName } from "../src/shared/telemetry-projections/queries.ts";
const NOW = 1_800_000_000_000;
const quality = { lastGapAt: null, caughtUp: true };
function project(events: TelemetryEnvelope[], now = NOW) {
  const state = initialAnalyticalState();
  state.since = now - 15 * DAY;
  for (const event of events) reduceAnalyticalEvent(event, state, now);
  return state;
}
function values(state: ReturnType<typeof initialAnalyticalState>, now = NOW) {
  return Object.fromEntries(calculateAnalytics(state, now, quality).filter((s) => s.sliceBy === "all").map((s) => [s.view, s.values]));
}
test("analytical query names reject fields undeclared for the requested view", () => {
  assert.throws(() => analyticalPromName("runs", "executed"), {
    name: "Error",
    message: "undeclared analytical field: mission.analytics.v1.runs.executed",
  });
});
test("six-run oracle: exact review, recovery, human-free and automation denominators", () => {
  const result = values(project(analyticalGoldenFixture(NOW)));
  assert.equal(result.reviews!.executed, 8); assert.equal(result.reviews!.pass, 6); assert.equal(result.reviews!.fail, 2);
  assert.equal(result.reviews!.invalid, 1); assert.equal(result.reviews!.reused, 1); assert.equal(result.reviews!.packets, 1);
  assert.equal(result.reviews!.failed_with_next, 1); assert.equal(result.reviews!.resolved, 1); assert.equal(result.reviews!.no_next, 1);
  assert.equal(result.runs!.eligible, 6); assert.equal(result.runs!.completed, 4);
  assert.equal(result.runs!.pending, 1); assert.equal(result.runs!.cancelled, 1);
  assert.equal(result.runs!.with_recovery, 1); assert.equal(result.runs!.recovery_operations, 1);
  assert.equal(result.runs!.human_free, 1); assert.equal(result.runs!.ambiguous_actor, 1);
  assert.equal(result.runs!.human_gate, 1); assert.equal(result.runs!.automation_eligible, 5);
});
test("reordering, semantic duplicates and serialized restart retain the same exact populations", () => {
  const events = analyticalGoldenFixture(NOW);
  const oracle = values(project(events));
  for (let seed = 1; seed <= 16; seed++) {
    let random = seed;
    const shuffled = [...events, ...events.map((e) => ({ ...e, eventId: e.eventId }))];
    for (let i = shuffled.length - 1; i > 0; i--) {
      random = (random * 1664525 + 1013904223) >>> 0;
      const j = random % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    const state = project(shuffled);
    assert.deepEqual(values(JSON.parse(JSON.stringify(state))), oracle);
  }
});
test("only actions after start and through the horizon qualify; unknown/declared actors cannot imply human-free", () => {
  const events = analyticalGoldenFixture(NOW);
  const runStart = NOW - 10 * DAY;
  events.push(analyticalEvent("action.result", "before", runStart - 1, {}, { run_id: "R2", operation_id: "before" }, { kind: "human", origin: "dashboard", basis: "owner" }));
  events.push(analyticalEvent("action.result", "late", runStart + 7 * DAY + 1, {}, { run_id: "R2", operation_id: "late" }, { kind: "human", origin: "dashboard", basis: "owner" }));
  assert.equal(values(project(events)).runs!.human_free, 1);
  events.push(analyticalEvent("action.result", "declared", runStart + 5, {}, { run_id: "R2", operation_id: "declared" }, { kind: "human", origin: "cli", basis: "declared" }));
  assert.equal(values(project(events)).runs!.human_free, 0);
  assert.equal(values(project(events)).runs!.ambiguous_actor, 2);
});
test("late facts revise current horizon results without moving original facts or rewriting task status", () => {
  const start = NOW - 10 * DAY;
  const events = [analyticalEvent("dispatch.finished", "dispatch", start, {}, { task_id: "T" }),
    analyticalEvent("task.outcome", "departure-outcome", start + 100, {}, { task_id: "T" }),
    analyticalEvent("session.ended", "departure", start + 100, {}, { task_id: "T", session_id: "S" }),
    analyticalEvent("pr.observed", "PR1", start + 50, {}, { task_id: "T", repo_key: "repo1", pr_key: "PR1" }),
    analyticalEvent("pr.observed", "PR2", start + 50, {}, { task_id: "T", repo_key: "repo2", pr_key: "PR2" })];
  const state = project(events);
  assert.equal(values(state).tasks!.eligible, 1); assert.equal(values(state).tasks!.with_new_pr, 1);
  assert.equal(values(state).prs!.created, 2); assert.equal(values(state).tasks!.unknown, 1);
  assert.equal(values(state).tasks!.pr_eligible, 0); assert.equal(values(state).tasks!.pr_visibility_unknown, 1);
  const late = analyticalEvent("pr.observed", "merge", start + 3 * DAY, { fact: "merged", delivery: "late" }, { task_id: "T", repo_key: "repo1", pr_key: "PR1" });
  late.observedAt = NOW;
  reduceAnalyticalEvent(late, state, NOW);
  reduceAnalyticalEvent({ ...late, eventId: "duplicate-delivery" }, state, NOW);
  assert.equal(values(state).tasks!.with_merged_pr, 1); assert.equal(values(state).prs!.late_merges, 1);
  assert.equal(values(state).tasks!.unknown, 1); assert.equal(values(state).tasks!.completed, 0);
  assert.equal(events[1]!.facts.status, "failed"); assert.equal(late.occurredAt, start + 3 * DAY);
});

test("PR facts stop at the task horizon except for positive merges through calculation time", () => {
  const start = NOW - 10 * DAY, end = start + 7 * DAY;
  const pr = (id: string, fact: string, at: number, key = id) => analyticalEvent("pr.observed", id, at,
    { fact, delivery: "late" }, { task_id: "T", repo_key: "repo", pr_key: key });
  const events = [analyticalEvent("dispatch.finished", "dispatch", start, {}, { task_id: "T" }),
    pr("at-start", "creation_verified", start), pr("at-end", "associated_existing", end),
    pr("closed-at-end", "closed_unmerged", end), pr("merged-at-end", "merged", end),
    pr("before-start", "creation_verified", start - 1),
    pr("created-after", "creation_verified", end + 1),
    pr("associated-after", "associated_existing", end + 1),
    pr("closed-after", "closed_unmerged", end + 1),
    pr("existing-closed-after", "closed_unmerged", end + 1, "at-start"),
    pr("merged-after", "merged", NOW)];
  // Late delivery does not move an event beyond its qualifying occurrence-time boundary.
  for (const event of events) event.observedAt = NOW;
  for (const replay of [events, [...events].reverse(), [...events, ...events]]) {
    const result = values(project(replay));
    assert.equal(result.prs!.associated, 5);
    assert.equal(result.prs!.created, 1); assert.equal(result.prs!.existing, 1);
    assert.equal(result.prs!.closed_unmerged, 1);
    assert.equal(result.prs!.merged, 2); assert.equal(result.prs!.merged_within_horizon, 1);
    assert.equal(result.prs!.late_merges, 2); assert.equal(result.prs!.visibility_unknown, 5);
    assert.equal(result.tasks!.with_new_pr, 1); assert.equal(result.tasks!.with_existing_pr, 1);
    assert.equal(result.tasks!.with_merged_pr, 1); assert.equal(result.tasks!.with_merged_pr_within_horizon, 1);
    assert.equal(result.tasks!.pending, 1);
  }
});

test("finding totals and category review denominators use only each executed run's outcome horizon", () => {
  const start = NOW - 10 * DAY, end = start + 7 * DAY;
  const events = [analyticalEvent("workflow.run", "run", start, {}, { run_id: "R" }),
    ...["A", "B"].map((attempt) => analyticalEvent("workflow.review.finished", attempt, start + 10,
      { verdict: "fail" }, { run_id: "R", node_id: attempt, attempt_id: attempt })),
    analyticalEvent("workflow.finding", "at-start", start, {}, { run_id: "R", attempt_id: "A" }),
    analyticalEvent("workflow.finding", "at-end", end, {}, { run_id: "R", attempt_id: "A" }),
    analyticalEvent("workflow.finding", "before-start", start - 1, { category: "correctness" }, { run_id: "R", attempt_id: "B" }),
    analyticalEvent("workflow.finding", "after-end", end + 1, { category: "security" }, { run_id: "R", attempt_id: "B" })];
  for (const event of events) event.observedAt = NOW;
  for (const replay of [events, [...events].reverse(), [...events, ...events]]) {
    const snapshots = calculateAnalytics(project(replay), NOW, quality);
    const reasons = snapshots.find((s) => s.view === "reasons" && s.sliceBy === "all")!.values;
    assert.equal(reasons.findings, 2); assert.equal(reasons.reviews, 1);
    const categories = snapshots.filter((s) => s.view === "reasons" && s.sliceBy === "category");
    assert.deepEqual(categories.map((s) => s.slice), ["test_coverage"]);
    assert.equal(categories[0]!.values.findings, 2); assert.equal(categories[0]!.values.reviews, 1);
  }
});
test("repeat-use denominators require the first period and consent continuity; unknown features are bounded", () => {
  const events = [analyticalEvent("action.result", "one", NOW - 10 * DAY, {}, { operation_id: "one" }),
    analyticalEvent("action.result", "two", NOW - DAY, {}, { operation_id: "two" })];
  const state = project(events);
  assert.equal(values(state).features!.repeat_eligible, 1); assert.equal(values(state).features!.repeated, 1);
  state.since = NOW - 12 * DAY;
  assert.equal(values(state).features!.repeat_eligible, 0);
  assert.equal(values(project([])).features!.observed, 0);
  assert.equal(calculateAnalytics(project([]), NOW, quality).find((s) => s.view === "features")!.complete, false);
});
test("gaps, expiry, zero eligible runs and missing starts never become a known human-free completion", () => {
  const state = project(analyticalGoldenFixture(NOW));
  const incomplete = calculateAnalytics(state, NOW, { caughtUp: true, lastGapAt: NOW - DAY });
  assert.equal(incomplete.find((s) => s.view === "runs")!.values.human_free, 0);
  assert.equal(incomplete.find((s) => s.view === "runs")!.complete, false);
  const changed = analyticalEvent("workflow.run", "pre-consent", NOW - 10 * DAY, { observation: "changed" }, { run_id: "old" });
  assert.equal(values(project([changed])).runs!.eligible, 0);
  assert.equal(values(project([changed])).runs!.left_censored, 1);
  expireAnalyticalState(state, NOW + 31 * DAY);
  assert.equal(Object.keys(state.facts).length, 0);
  assert.equal(values(state, NOW + 31 * DAY).runs!.human_free, 0);
  assert.ok(state.expired > 0);
  assert.equal(ANALYTICAL_PROJECTION.migrateState(state, 99), null);
});
test("minimal state and slice vocabularies stay bounded and reject with visible incomplete coverage", () => {
  const state = initialAnalyticalState();
  state.since = NOW - 15 * DAY;
  for (let i = 0; i < MAX_FACTS + 50; i++) {
    reduceAnalyticalEvent(analyticalEvent("action.result", `action-${i}`, NOW - DAY, {}, { operation_id: `operation-${i}` }), state, NOW);
  }
  assert.equal(Object.keys(state.facts).length, MAX_FACTS); assert.equal(state.rejected, 50);
  assert.ok(Buffer.byteLength(JSON.stringify(state)) < TELEMETRY_LIMITS.maxProjectionStateBytes);
  console.log(`Quota fixture: ${state.size} retained facts, ${state.rejected} rejected with incomplete coverage, ${Buffer.byteLength(JSON.stringify(state))} state bytes of ${TELEMETRY_LIMITS.maxProjectionStateBytes}.`);
  const result = calculateAnalytics(state, NOW, quality);
  assert.ok(result.every((s) => !s.complete));
  assert.ok(Object.values(state.slices).every((slices) => slices.length <= MAX_SLICES));
  assert.equal(JSON.stringify(result).includes("operation-"), false);
});

test("mixed authors and unknown attribution remain distinct, reviewer context is independent", () => {
  const models = [...new Set(Object.values(MODEL_CATALOG).flatMap((entries) => entries.map((m) => m.id)))];
  const start = NOW - 10 * DAY;
  const events = [analyticalEvent("workflow.run", "run", start, {}, { run_id: "R" }),
    analyticalEvent("workflow.submission", "s1", start + 1, { author_model: models[0], author_effort: "low" }, { run_id: "R" }),
    analyticalEvent("workflow.submission", "s2", start + 2, { author_model: models[1], author_effort: "high" }, { run_id: "R" }),
    analyticalEvent("workflow.review.finished", "review", start + 3, { reviewer_model: models[0], reviewer_effort: "low" }, { run_id: "R", node_id: "N", attempt_id: "A" })];
  const result = calculateAnalytics(project(events), NOW, quality);
  assert.equal(result.find((s) => s.view === "runs" && s.sliceBy === "all")!.values.mixed_author, 1);
  assert.equal(result.find((s) => s.view === "runs" && s.sliceBy === "author_effort" && s.slice === "mixed")!.values.eligible, 1);
  assert.equal(result.find((s) => s.view === "reviews" && s.sliceBy === "reviewer_model" && s.slice === models[0])!.values.pass, 1);
  events[2]!.facts.author_model = "unknown";
  const unknown = calculateAnalytics(project(events), NOW, quality);
  assert.equal(unknown.find((s) => s.view === "runs" && s.sliceBy === "all")!.values.mixed_author, 0);
  assert.equal(unknown.find((s) => s.view === "runs" && s.sliceBy === "author_model" && s.slice === "unknown")!.values.eligible, 1);
});

test("cohort edges, review ordering ambiguity and omitted join context are explicit", () => {
  const start = NOW - 14 * DAY;
  const events = [analyticalEvent("workflow.run", "inclusive", start, {}, { run_id: "R" }),
    analyticalEvent("workflow.run", "exclusive", NOW - 7 * DAY, {}, { run_id: "immature" }),
    analyticalEvent("workflow.run", "finished", start + 7 * DAY, { observation: "finished", status: "completed" }, { run_id: "R" }),
    ...["fail", "pass", "fail"].map((verdict, i) => analyticalEvent("workflow.review.finished", `review-${i}`, start + (i ? 2 : 1), { verdict }, { run_id: "R", node_id: "N", attempt_id: `A${i}` }))];
  const state = project(events);
  assert.equal(values(state).runs!.eligible, 1); assert.equal(values(state).runs!.immature, 1);
  assert.equal(values(state).runs!.completed, 1); assert.equal(values(state).reviews!.resolved, 0);
  assert.ok(values(state).reviews!.ordering_unknown! > 0);
  const omitted = analyticalEvent("action.result", "missing-join", start + 3, {}, { operation_id: "O" });
  omitted.refsOmitted = 1;
  reduceAnalyticalEvent(omitted, state, NOW);
  assert.equal(values(state).runs!.human_free, 0);
  assert.equal(values(state).quality!.omitted_facts, 1);
});

test("usage includes unfinished work and reports missing/unpriced attribution with matched outcome denominators", () => {
  const start = NOW - 10 * DAY;
  const events = ["done", "unfinished", "missing"].map((task) => analyticalEvent("dispatch.finished", task, start, {}, { task_id: task }));
  events.push(analyticalEvent("task.outcome", "done-outcome", start + 100, { status: "done", completion_evidence: "recorded" }, { task_id: "done" }),
    analyticalEvent("usage.recorded", "priced", start + 1, {}, { task_id: "done" }),
    analyticalEvent("usage.recorded", "unpriced", start + 1, { usage_origin: "automation", cost_basis: "unpriced", cost_usd: 0 }, { task_id: "unfinished" }),
    analyticalEvent("usage.recorded", "unattributed", start + 1));
  const snapshots = calculateAnalytics(project(events), NOW, quality);
  const usage = snapshots.filter((s) => s.view === "usage");
  const all = usage.find((s) => s.sliceBy === "all")!.values;
  assert.equal(all.input, 20); assert.equal(all.cost, 0.01);
  assert.equal(all.attributed, 2); assert.equal(all.unattributed, 1); assert.equal(all.unpriced, 1);
  assert.ok(usage.every((s) => s.values.qualifying_outcomes === 1 && !s.complete));
  const tasks = snapshots.find((s) => s.view === "tasks" && s.sliceBy === "all")!.values;
  assert.equal(tasks.usage_missing, 1); assert.equal(tasks.usage_unfinished, 1);
});

test("operation outcomes, repeat continuity and first observed use survive restart and fact expiry", () => {
  const start = NOW - 10 * DAY;
  const events = [analyticalEvent("action.result", "refused", start, { outcome: "refused" }, { operation_id: "same" }),
    analyticalEvent("action.result", "applied", start + 1, {}, { operation_id: "same" }),
    analyticalEvent("action.result", "later", NOW - DAY, {}, { operation_id: "later" })];
  const state = project(events);
  const features = values(state).features!;
  assert.equal(features.operations, 2); assert.equal(features.failed_operations, 1); assert.equal(features.successful_operations, 2);
  const restarted = JSON.parse(JSON.stringify(state));
  expireAnalyticalState(restarted, NOW + 31 * DAY);
  const snapshot = calculateAnalytics(restarted, NOW + 31 * DAY, quality).find((s) => s.view === "features" && s.sliceBy === "all")!;
  assert.equal(snapshot.firstObservedAt, start + 1); assert.equal(snapshot.values.observed, 0); assert.equal(snapshot.complete, false);
});

test("original versions and custom dimensions are bounded, overflow later exports zeros", () => {
  const state = initialAnalyticalState(NOW - 15 * DAY);
  for (let i = 0; i < 50; i++) {
    reduceAnalyticalEvent(analyticalEvent("workflow.run", `run-${i}`, NOW - 10 * DAY,
      { workflow: "custom", author_model: `custom-${i}` }, { run_id: `R${i}` }), state, NOW, `original-${i}`);
  }
  const snapshots = calculateAnalytics(state, NOW, quality);
  assert.ok(snapshots.some((s) => s.sliceBy === "app_version" && s.slice.startsWith("original-")));
  assert.ok(snapshots.some((s) => s.sliceBy === "author_model" && s.slice === "other"));
  assert.ok(snapshots.some((s) => s.sliceBy === "overflow" && !s.complete && s.values.eligible! > 0));
  assert.ok(Object.values(state.slices).every((s) => s.length <= MAX_SLICES));
  const series = snapshots.reduce((n, s) => n + Object.keys(s.values).length + ANALYTICAL_METADATA.length, 0);
  assert.ok(series < TELEMETRY_LIMITS.maxSeriesPerProfile);
  expireAnalyticalState(state, NOW + 31 * DAY);
  const empty = calculateAnalytics(state, NOW + 31 * DAY, quality);
  assert.equal(empty.find((s) => s.view === "runs" && s.sliceBy === "overflow")!.values.eligible, 0);
  console.log(`Bounded analytical fixture: ${series} series, ${Buffer.byteLength(JSON.stringify(state))} retained bytes after expiry; limits ${TELEMETRY_LIMITS.maxSeriesPerProfile} series / ${TELEMETRY_LIMITS.maxProjectionStateBytes} state bytes.`);
});
