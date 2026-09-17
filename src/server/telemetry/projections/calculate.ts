import { ANALYTICAL_VIEWS, type AnalyticalView } from "@shared/telemetry-projections/index.ts";
import { ACTION_RESULT_SCHEMA } from "@shared/telemetry-sources/actions.ts";
import { hasReviewableDiff } from "@shared/task.ts";
import { TASK_KINDS, type TaskKind } from "@shared/types.ts";
import { MAX_SLICES, WINDOW, type AnalyticalFact, type AnalyticalState } from "./state.ts";

export interface AnalyticalSnapshot {
  view: AnalyticalView;
  sliceBy: string;
  slice: string;
  values: Record<string, number>;
  from: number;
  to: number;
  complete: boolean;
  firstObservedAt: number | null;
}
export interface ObservationQuality {
  /** Unknown is deliberately different from an observed absence of capture gaps. */
  lastGapAt: number | null | undefined;
  caughtUp: boolean;
}
const text = (f: AnalyticalFact, key: string) => String(f.values[key] ?? "unknown");
const number = (f: AnalyticalFact, key: string) => typeof f.values[key] === "number" ? f.values[key] as number : 0;
const sorted = (facts: AnalyticalFact[]) => facts.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
const between = (f: AnalyticalFact, from: number, to: number) => f.at >= from && f.at < to;
function group(facts: AnalyticalFact[], key: (f: AnalyticalFact) => string): Map<string, AnalyticalFact[]> {
  const result = new Map<string, AnalyticalFact[]>();
  for (const fact of facts) {
    const id = key(fact);
    if (!id) continue;
    const rows = result.get(id) ?? [];
    rows.push(fact);
    result.set(id, rows);
  }
  return result;
}
function unique(facts: AnalyticalFact[], key: (f: AnalyticalFact) => string): number {
  return new Set(facts.map(key).filter(Boolean)).size;
}
function authorContext(rows: AnalyticalFact[], key: string, start: AnalyticalFact): string {
  const values = new Set(rows.filter((f) => f.kind === "workflow.submission").map((f) => text(f, key)));
  if (!values.size) return text(start, key);
  if (values.size === 1) return [...values][0]!;
  const known = [...values].filter((v) => !["unknown", "unsupported", "other"].includes(v));
  if (known.length > 1) return "mixed";
  return values.size > known.length ? "unknown" : known[0]!;
}

/** Pure analytical calculation over retained facts. It never reaches an operational store. */
export function calculateAnalytics(state: AnalyticalState, now: number, quality: ObservationQuality): AnalyticalSnapshot[] {
  const cohortStart = now - 2 * WINDOW;
  const cohortEnd = now - WINDOW;
  const facts = sorted(Object.values(state.facts));
  const lossFree = quality.caughtUp && quality.lastGapAt !== undefined
    && (quality.lastGapAt === null || quality.lastGapAt < cohortStart)
    && !facts.some((f) => f.omitted && between(f, cohortStart, now))
    && state.incompleteUntil <= now;
  const continuous = lossFree && state.since !== null && state.since <= cohortStart;
  const snapshots = new Map<string, AnalyticalSnapshot>();
  const get = (view: AnalyticalView, axis = "all", value = "all") => {
    let sliceKey = `${axis}:${value}`;
    const vocabulary = state.slices[view] ??= [];
    if (axis !== "all" && !vocabulary.includes(sliceKey)) {
      if (vocabulary.length >= MAX_SLICES) {
        axis = "overflow"; value = "__overflow__"; sliceKey = `${axis}:${value}`;
        if (!state.overflowViews.includes(view)) state.overflowViews.push(view);
      }
      else vocabulary.push(sliceKey);
    }
    const key = `${view}:${sliceKey}`;
    let snapshot = snapshots.get(key);
    if (!snapshot) {
      snapshot = { view, sliceBy: axis, slice: value,
        values: Object.fromEntries(ANALYTICAL_VIEWS[view].map((field) => [field, 0])),
        from: cohortStart, to: view === "features" || view === "quality" ? now : cohortEnd,
        complete: continuous && axis !== "overflow", firstObservedAt: null };
      if (view === "usage") snapshot.values.cost = 0;
      snapshots.set(key, snapshot);
    }
    return snapshot;
  };
  const add = (targets: AnalyticalSnapshot[], field: string, amount = 1) => {
    for (const target of new Set(targets)) target.values[field] = (target.values[field] ?? 0) + amount;
  };
  const first = (targets: AnalyticalSnapshot[], at: number) => {
    for (const target of targets) target.firstObservedAt = Math.min(target.firstObservedAt ?? at, at);
  };
  for (const view of Object.keys(ANALYTICAL_VIEWS) as AnalyticalView[]) {
    get(view);
    if (state.overflowViews.includes(view)) get(view, "overflow", "__overflow__");
    for (const key of state.slices[view] ?? []) {
      const colon = key.indexOf(":");
      get(view, key.slice(0, colon), key.slice(colon + 1));
    }
  }

  const byRun = group(facts, (f) => f.run);
  const actions = facts.filter((f) => ["action.result", "session.operation", "session.kill.requested", "session.effort.selected"].includes(f.kind));
  const runCohort = new Map<string, { start: AnalyticalFact; end: number; rows: AnalyticalFact[] }>();
  for (const [run, rows] of byRun) {
    const start = rows.find((f) => f.kind === "workflow.run" && f.values.observation === "started");
    if (!start) { if (rows.some((f) => between(f, cohortStart, now))) add([get("runs")], "left_censored"); continue; }
    const targets = [get("runs"), get("runs", "workflow", text(start, "workflow")), get("runs", "app_version", start.appVersion)];
    if (start.at >= cohortEnd && start.at < now) { add(targets, "immature"); continue; }
    if (!between(start, cohortStart, cohortEnd)) continue;
    const end = start.at + WINDOW;
    const inHorizon = rows.filter((f) => f.at >= start.at && f.at <= end);
    runCohort.set(run, { start, end, rows: inHorizon });
    const author = authorContext(inHorizon, "author_model", start);
    targets.push(get("runs", "author_model", author));
    targets.push(get("runs", "author_effort", authorContext(inHorizon, "author_effort", start)));
    add(targets, "eligible"); first(targets, start.at);
    if (author === "mixed") add(targets, "mixed_author");
    const terminal = inHorizon.find((f) => f.kind === "workflow.run" && f.values.observation === "finished");
    const outcome = terminal ? text(terminal, "status") : "pending";
    add(targets, ["completed", "failed", "cancelled", "pending"].includes(outcome) ? outcome : "unknown");
    const runActions = actions.filter((f) => f.at >= start.at && f.at <= end
      && (f.run === run || !f.run && start.session && f.session === start.session));
    const human = runActions.some((f) => f.actor === "human");
    const ambiguous = runActions.some((f) => f.actor === "unknown" || f.omitted || f.values.coverage === "unknown");
    const recoveries = unique(runActions.filter((f) => f.actor === "human" && f.values.intent === "recovery"
      && f.values.outcome === "applied" && f.values.coverage === "owner_result"), (f) => f.operation);
    add(targets, "recovery_operations", recoveries);
    if (recoveries > 0) add(targets, "with_recovery");
    if (human) add(targets, "with_human");
    if (ambiguous) add(targets, "ambiguous_actor");
    const gate = text(start, "automation_eligibility");
    add(targets, gate === "eligible" ? "automation_eligible" : gate === "human_gate" ? "human_gate" : "eligibility_unknown");
    const observed = lossFree && state.since !== null && state.since <= start.at && !inHorizon.some((f) => f.omitted);
    if (!observed || ambiguous) add(targets, "observation_incomplete");
    if (outcome === "completed" && gate === "eligible" && observed && !human && !ambiguous) add(targets, "human_free");
    if (!observed || ambiguous || gate === "unknown") targets.forEach((s) => { s.complete = false; });
  }

  // Reviews use the run start cohort and each run's horizon, so their totals reconcile to
  // the six-run oracle. Event-time activity trends remain the ordinary source counters.
  const reviews: AnalyticalFact[] = [];
  const reviewTargets = (row: AnalyticalFact) => [get("reviews"),
    get("reviews", "reviewer_model", text(row, "reviewer_model")),
    get("reviews", "reviewer_effort", text(row, "reviewer_effort")), get("reviews", "app_version", row.appVersion)];
  for (const { rows } of runCohort.values()) {
    for (const row of rows) {
      if (row.kind === "workflow.review.finished") {
        reviews.push(row);
        const targets = reviewTargets(row);
        add(targets, "executed"); add(targets, text(row, "verdict")); first(targets, row.at);
      } else if (row.kind === "workflow.review.response" && row.values.observation === "finished"
        && ["parse_failure", "contract_violation"].includes(text(row, "validity"))) add(reviewTargets(row), "invalid");
      else if (row.kind === "workflow.node" && row.values.observation === "finished" && row.values.disposition === "reused") add(reviewTargets(row), "reused");
      else if (row.kind === "workflow.repair.delivery" && row.values.state === "delivered"
        && ["persona_feedback", "inspector_feedback"].includes(text(row, "kind"))) add(reviewTargets(row), "packets");
    }
  }
  for (const rows of group(reviews, (f) => f.node ? `${f.run}:${f.node}` : "").values()) {
    sorted(rows);
    const earliest = rows[0]!;
    const targets = reviewTargets(earliest);
    if (rows[1]?.at === earliest.at) { add(targets, "ordering_unknown"); targets.forEach((s) => { s.complete = false; }); }
    else { add(targets, "first"); if (earliest.values.verdict === "pass") add(targets, "first_pass"); }
    for (let i = 0; i < rows.length; i++) {
      const failed = rows[i]!;
      if (failed.values.verdict !== "fail") continue;
      const next = rows[i + 1];
      const failedTargets = reviewTargets(failed);
      if (!next) { add(failedTargets, "no_next"); continue; }
      if (next.at === failed.at || rows[i + 2]?.at === next.at) {
        add(failedTargets, "ordering_unknown"); failedTargets.forEach((s) => { s.complete = false; }); continue;
      }
      add(failedTargets, "failed_with_next");
      if (next.values.verdict === "pass") add(failedTargets, "resolved");
    }
  }
  const executed = new Set(reviews.map((f) => f.attempt).filter(Boolean));
  const findings = [...runCohort.values()].flatMap(({ rows }) =>
    rows.filter((f) => f.kind === "workflow.finding" && executed.has(f.attempt)));
  for (const [category, rows] of group(findings, (f) => text(f, "category"))) {
    const targets = [get("reasons"), get("reasons", "category", category)];
    add(targets, "findings", rows.length);
    add(targets, "unknown_basis", rows.filter((f) => f.values.basis === "unknown").length);
    get("reasons", "category", category).values.reviews = unique(rows, (f) => f.attempt);
  }
  get("reasons").values.reviews = unique(findings, (f) => f.attempt);

  const byTask = group(facts, (f) => f.task);
  const taskCohort = new Map<string, { start: AnalyticalFact; end: number; rows: AnalyticalFact[] }>();
  for (const [task, rows] of byTask) {
    const start = rows.find((f) => f.kind === "dispatch.finished" && f.values.outcome === "launched"
      || f.kind === "session.started" && f.values.start_observation === "observed_start");
    if (!start || !between(start, cohortStart, cohortEnd)) continue;
    const end = start.at + WINDOW;
    const inHorizon = rows.filter((f) => f.at >= start.at && f.at <= end);
    taskCohort.set(task, { start, end, rows: inHorizon });
    const targets = [get("tasks"), get("tasks", "task_kind", text(start, "task_kind")), get("tasks", "app_version", start.appVersion)];
    add(targets, "eligible"); first(targets, start.at);
    const outcomes = inHorizon.filter((f) => f.kind === "task.outcome");
    const outcome = outcomes.at(-1);
    if (!outcome) add(targets, "pending");
    else if (outcome.values.completion_evidence !== "recorded") {
      add(targets, "unknown"); targets.forEach((s) => { s.complete = false; });
    }
    else add(targets, outcome.values.status === "done" ? "completed" : text(outcome, "status"));
    const departure = inHorizon.find((f) => f.kind === "session.ended" && f.values.ended_while_work_open === true
      && !["handoff", "shutdown"].includes(text(f, "reason")));
    if (departure) {
      add(targets, "early_exit");
      const continuation = rows.some((f) => f.at > departure.at && f.at <= now
        && (f.kind === "session.started" || f.kind === "dispatch.finished" && f.values.outcome === "launched"));
      if (continuation) add(targets, "continued");
      if (!continuation && now >= departure.at + WINDOW && departure.values.observation_bounded === false
        && !rows.some((f) => f.at > departure.at && (f.kind === "pr.observed" && f.values.fact === "merged"
          || f.kind === "task.outcome" && f.values.status === "done" && f.values.completion_evidence === "recorded"))) {
        add(targets, "abandonment_candidate");
        targets.forEach((s) => { s.complete = false; });
      }
    }
    const prs = inHorizon.filter((f) => f.kind === "pr.observed");
    if (prs.some((f) => f.values.fact === "creation_verified")) add(targets, "with_new_pr");
    if (prs.some((f) => f.values.fact === "associated_existing")) add(targets, "with_existing_pr");
    if (prs.some((f) => f.values.fact === "merged")) add(targets, "with_merged_pr_within_horizon");
    if (rows.some((f) => f.kind === "pr.observed" && f.at >= start.at && f.at <= now && f.values.fact === "merged")) add(targets, "with_merged_pr");
    const kind = text(start, "task_kind");
    if ((TASK_KINDS as readonly string[]).includes(kind) && hasReviewableDiff(kind as TaskKind)) {
      // Diff-producing work is a candidate, not proof that the operator requested a PR.
      // The source has no negative observation contract for all task repositories yet.
      add(targets, "pr_visibility_unknown"); targets.forEach((s) => { s.complete = false; });
    }
    const usage = inHorizon.filter((f) => f.kind === "usage.recorded");
    add(targets, usage.length ? "with_usage" : "usage_missing");
    if (usage.length && (!outcome || outcome.values.status !== "done")) add(targets, "usage_unfinished");
    if (outcome?.values.status === "done" && outcome.values.completion_evidence === "recorded") add([get("usage")], "qualifying_outcomes");
    if (!usage.length) get("usage").complete = false;
  }
  const prFacts = facts.filter((f) => {
    if (f.kind !== "pr.observed") return false;
    const task = taskCohort.get(f.task);
    return task !== undefined && f.at >= task.start.at
      && f.at <= (f.values.fact === "merged" ? now : task.end);
  });
  for (const rows of group(prFacts, (f) => f.pr).values()) {
    const target = get("prs");
    add([target], "associated");
    for (const [fact, field] of [["creation_verified", "created"], ["associated_existing", "existing"], ["merged", "merged"], ["closed_unmerged", "closed_unmerged"]]) {
      if (rows.some((f) => f.values.fact === fact)) add([target], field!);
    }
    if (rows.some((f) => f.values.visibility === "unknown")) { add([target], "visibility_unknown"); target.complete = false; }
    if (rows.some((f) => f.values.fact === "merged" && f.values.delivery === "late")) add([target], "late_merges");
    if (rows.some((f) => f.values.fact === "merged" && f.at <= taskCohort.get(f.task)!.end)) add([target], "merged_within_horizon");
  }

  const uses = facts.filter((f) => f.kind === "action.result" && between(f, cohortStart, now));
  const featureRows = group(uses, (f) => {
    const parsed = ACTION_RESULT_SCHEMA.shape.feature.safeParse(f.values.feature);
    return parsed.success ? parsed.data : "other";
  });
  // Emit reserved, unobserved features as unobserved, with complete=false. No broad Phase 5
  // caller is presumed to exist just because a metric can represent its result.
  for (const feature of ACTION_RESULT_SCHEMA.shape.feature.options) get("features", "feature", feature);
  for (const [feature, rows] of featureRows) {
    const targets = [get("features"), get("features", "feature", feature)];
    const successes = rows.filter((f) => f.values.outcome === "applied");
    const earlier = successes.some((f) => f.at < cohortEnd);
    const later = successes.some((f) => f.at >= cohortEnd);
    const target = targets[1]!;
    target.values.observed = 1;
    target.values.first_period = Number(earlier);
    target.values.second_period = Number(later);
    target.values.repeat_eligible = Number(earlier && continuous);
    target.values.repeated = Number(earlier && later && continuous);
    const operations = group(rows, (f) => f.operation);
    target.values.operations = operations.size;
    target.values.successful_operations = [...operations.values()].filter((r) => r.some((f) => f.values.outcome === "applied")).length;
    target.values.failed_operations = [...operations.values()].filter((r) => r.some((f) => ["failed", "refused"].includes(text(f, "outcome")))).length;
    target.values.affected_installation = Number(target.values.failed_operations! > 0);
    if (successes.length) first(targets, Math.min(...successes.map((f) => f.at)));
  }
  const featureTotal = get("features");
  const earlierUse = uses.some((f) => f.values.outcome === "applied" && f.at < cohortEnd);
  const laterUse = uses.some((f) => f.values.outcome === "applied" && f.at >= cohortEnd);
  Object.assign(featureTotal.values, { observed: Number(uses.length > 0), first_period: Number(earlierUse), second_period: Number(laterUse),
    repeat_eligible: Number(earlierUse && continuous), repeated: Number(earlierUse && laterUse && continuous),
    operations: unique(uses, (f) => f.operation), successful_operations: unique(uses.filter((f) => f.values.outcome === "applied"), (f) => f.operation),
    failed_operations: unique(uses.filter((f) => ["failed", "refused"].includes(text(f, "outcome"))), (f) => f.operation) });
  featureTotal.values.affected_installation = Number(featureTotal.values.failed_operations! > 0);
  for (const snapshot of snapshots.values()) if (snapshot.view === "features" && !snapshot.values.observed) snapshot.complete = false;
  for (const [feature, at] of Object.entries(state.firstUse)) first([get("features"), get("features", "feature", feature)], at);

  for (const fact of facts.filter((f) => between(f, cohortStart, now))) {
    const target = get("quality");
    add([target], "facts");
    if (fact.observed - fact.at > 60_000) add([target], "late_facts");
    if (fact.omitted) { add([target], "omitted_facts"); target.complete = false; }
    if (fact.actor === "unknown") add([target], "unknown_actor");
    for (const key of ["author_model", "reviewer_model", "model_id"]) if (key in fact.values) {
      add([target], "model_observations");
      if (!["unknown", "unsupported"].includes(text(fact, key))) add([target], "known_model");
    }
    for (const key of ["author_effort", "reviewer_effort", "effort"]) if (key in fact.values) {
      add([target], "effort_observations");
      if (!["unknown", "unsupported"].includes(text(fact, key))) add([target], "known_effort");
    }
  }
  Object.assign(get("quality").values, { rejected_state: state.rejected, expired_state: state.expired });

  for (const fact of facts.filter((f) => f.kind === "usage.recorded")) {
    const task = taskCohort.get(fact.task);
    if (!task || fact.at < task.start.at || fact.at > task.end) {
      if (between(fact, cohortStart, cohortEnd)) add([get("usage")], "unattributed");
      continue;
    }
    const targets = [get("usage"), get("usage", "work_role", text(fact, "usage_origin")), get("usage", "cost_basis", text(fact, "cost_basis"))];
    add(targets, "attributed");
    for (const field of ["input", "output", "reasoning_output", "cache_read", "cache_write"]) add(targets, field, number(fact, field));
    add(targets, fact.values.cost_basis === "unpriced" ? "unpriced" : "priced");
    if (fact.values.cost_basis !== "unpriced") add(targets, "cost", number(fact, "cost_usd"));
    else targets.forEach((s) => { s.complete = false; });
  }
  if (get("usage").values.unattributed) get("usage").complete = false;
  // Each role/basis is a contribution over the SAME task population, including unfinished
  // work; replicating the outcome denominator permits cost-per-outcome contribution charts.
  for (const snapshot of snapshots.values()) if (snapshot.view === "usage") {
    snapshot.values.qualifying_outcomes = get("usage").values.qualifying_outcomes!;
    snapshot.complete &&= get("usage").complete;
  }
  return [...snapshots.values()];
}
