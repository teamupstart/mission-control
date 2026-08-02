import { test } from "node:test";
import assert from "node:assert/strict";
import { foldLineSummary, lineSummaryEqual, type LineFoldInput } from "../src/server/line-summary.ts";
import { LINE_STAGES, lineStage, type LineStageId } from "../src/shared/line.ts";
import type { WorkflowRunSummary } from "../src/shared/workflow.ts";
import type { MissionSchedule } from "../src/shared/schedules.ts";
import type { TaskSourceInstance, TaskSourceStatus } from "../src/shared/task-source.ts";
import type { FleetCost, TaskDependency } from "../src/shared/types.ts";
import { mkEnsembleSummary, mkSession, mkTask } from "./helpers/session-fixture.ts";

// What is at stake: the Line is the fleet's front page, and every number on it is an
// ASSERTION about work an operator is responsible for. Two failure modes, and they are
// opposite:
//
//  - Silence. A stage that reads "nothing waiting" over a backlog nobody can start, or
//    "no runs live" over a run parked on a question, is worse than no strip at all - the
//    operator has been told, in a permanent surface, that there is nothing to do.
//  - Noise. Amber that fires for the daemon waiting on itself teaches the eye to skip the
//    strip, and then it is furniture. Most of `SESSION_ACTION_WAIT_REASONS` is exactly that
//    kind of wait, which is why only three of them may light a stage.
//
// The fold is pure, so both are testable as a table: state in, six sentences out. No daemon
// is started here and no database is opened - if either becomes necessary, the fold has
// grown a dependency it was built not to have.

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

function input(over: Partial<LineFoldInput> = {}): LineFoldInput {
  return {
    now: NOW,
    sessions: [],
    tasks: [],
    backlogPlan: null,
    schedules: [],
    taskSources: [],
    workflowRuns: [],
    ensembles: [],
    prsThisWeek: 0,
    cost: null,
    ...over,
  };
}

function fold(over: Partial<LineFoldInput> = {}, stage: LineStageId) {
  const summary = foldLineSummary(input(over));
  return lineStage(summary, stage)!;
}

function mkSource(over: Partial<TaskSourceInstance> = {}): TaskSourceInstance {
  return {
    id: "src-1",
    kind: "github-issues",
    label: "mission-control bugs",
    enabled: true,
    repoRoot: "/repo",
    intervalMs: 15 * 60_000,
    defaults: { kind: "ship", agent: "claude", priority: null, labels: [] },
    maxPerSweep: 25,
    config: {},
    ...over,
  };
}

function mkStatus(over: Partial<TaskSourceStatus> = {}): TaskSourceStatus {
  return {
    sourceId: "src-1",
    lastSweepAt: NOW - 4 * MINUTE,
    lastError: null,
    lastFiled: 2,
    seenCount: 40,
    sweeping: false,
    ...over,
  };
}

function mkSchedule(over: Partial<MissionSchedule> = {}): MissionSchedule {
  return {
    id: "sched-1",
    name: "Monday triage",
    enabled: true,
    archivedAt: null,
    expression: "0 8 * * 1",
    timezone: "UTC",
    overlapPolicy: "skip-active",
    missedPolicy: "skip",
    executionMode: "local-catchup",
    runnerId: null,
    revision: 1,
    template: null,
    nextRunAt: NOW + 3 * 60 * MINUTE,
    lastOccurrence: null,
    unreadable: null,
    health: "healthy",
    healthReasons: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

function mkRun(over: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: "run-1",
    bindingId: "b-1",
    workflowId: "wf-1",
    workflowName: "No-Mistakes Review",
    workflowVersion: 8,
    sessionId: "s1",
    noteKey: "k1",
    status: "running",
    phase: "review",
    round: 1,
    maxRepairRounds: 3,
    activePersonaNames: [],
    failedPersonaCount: 0,
    bypassedPersonaReview: false,
    gate: "none",
    gatePrNumber: null,
    gateHeadShort: null,
    reviewPosture: null,
    updatedAt: NOW,
    ...over,
  };
}

/** A declared prerequisite, as the dispatch route writes one onto a backlog task. */
function dependsOn(taskId: string, title: string): TaskDependency {
  return {
    type: "task",
    taskId,
    title,
    sessionId: null,
    episodeId: null,
    agentSessionId: null,
    branch: null,
    prUrl: null,
    selectedAt: null,
    satisfiedAt: null,
  };
}

function mkCost(over: Partial<FleetCost> = {}): FleetCost {
  return {
    estimatedCostToday: 12.15,
    estimatedBurnPerHour: 3.1,
    tokensToday: 4_000_000,
    prsToday: 3,
    rateLimits: null,
    automation: { estimatedCostToday: 0, tokensToday: 0, roles: [] },
    updatedAt: NOW,
    ...over,
  };
}

// ---- shape ----

test("every stage is present, once, in pipeline order", () => {
  const summary = foldLineSummary(input());
  assert.deepEqual(
    summary.stages.map((s) => s.stage),
    [...LINE_STAGES],
    "the strip renders positionally; a missing or reordered stage redraws the pipeline",
  );
});

test("an empty fleet says six true things rather than six blanks", () => {
  // The strip is permanent chrome. A fresh install opens onto it, and "no sessions open"
  // is a fact where an empty stage is a bug the operator has to diagnose.
  for (const stage of foldLineSummary(input()).stages) {
    assert.equal(stage.count, 0);
    assert.ok(stage.sentence.length > 0, `${stage.stage} said nothing`);
    assert.equal(stage.tone, "neutral", `${stage.stage} claimed a state on an empty fleet`);
  }
});

// ---- intake ----

test("intake counts channels and names the last sweep and the next mission", () => {
  const stage = fold(
    {
      taskSources: [{ source: mkSource(), status: mkStatus() }],
      schedules: [mkSchedule()],
    },
    "intake",
  );
  assert.equal(stage.count, 2, "one source plus one enabled mission");
  assert.match(stage.sentence, /mission-control bugs swept 4m ago/);
  assert.match(stage.sentence, /next mission in 3h/);
  assert.equal(stage.tone, "idle");
});

test("a source that failed its last sweep turns intake amber", () => {
  const stage = fold(
    {
      taskSources: [{ source: mkSource(), status: mkStatus({ lastError: "403 from github" }) }],
    },
    "intake",
  );
  assert.equal(stage.tone, "attention");
  assert.match(stage.sentence, /1 needs a look/);
});

test("a mission the schedule store flagged is amber on the daemon's derivation, not a second one", () => {
  // `health` is `deriveScheduleHealth`'s answer. The fold reads it; it does not re-derive
  // overdue-ness from `nextRunAt`, which would be a second threshold to keep in step.
  const stage = fold({ schedules: [mkSchedule({ health: "attention" })] }, "intake");
  assert.equal(stage.tone, "attention");
});

test("disabled sources and archived missions are not intake", () => {
  const stage = fold(
    {
      taskSources: [{ source: mkSource({ enabled: false }), status: mkStatus() }],
      schedules: [mkSchedule({ enabled: false }), mkSchedule({ id: "s2", archivedAt: NOW })],
    },
    "intake",
  );
  assert.equal(stage.count, 0);
  assert.match(stage.sentence, /no sources or missions/);
});

// ---- backlog ----

test("backlog names what autopilot would take next", () => {
  const stage = fold(
    {
      tasks: [
        mkTask({ id: "a", title: "Fix pane focus stealing", priority: "high" }),
        mkTask({ id: "b", title: "Later thing", priority: "low" }),
      ],
    },
    "backlog",
  );
  assert.equal(stage.count, 2);
  assert.equal(stage.sentence, "next up: Fix pane focus stealing");
  assert.equal(stage.tone, "idle");
});

test("a backlog nobody can start is the one backlog state that needs a person", () => {
  // Both items are parked: one is switched off, the other waits on it. Capacity will never
  // clear this, so a strip that read "2 waiting" in calm grey would be describing a queue
  // that is actually stuck.
  const stage = fold(
    {
      tasks: [
        mkTask({ id: "a", title: "Parked", enabled: false }),
        mkTask({
          id: "b",
          title: "Waits on a",
          dependencies: [dependsOn("a", "Parked")],
        }),
      ],
    },
    "backlog",
  );
  assert.equal(stage.count, 2);
  assert.equal(stage.tone, "attention");
  // Named separately because the remedies are opposite: "parked" is someone's decision to
  // reverse, "blocked" is a prerequisite to move.
  assert.equal(stage.sentence, "nothing ready · 1 blocked, 1 parked");
});

test("a backlog that is only parked says so, and only blocked says that", () => {
  const parked = fold(
    { tasks: [mkTask({ id: "a", title: "Off", enabled: false })] },
    "backlog",
  );
  assert.equal(parked.sentence, "nothing ready · 1 parked");

  const blocked = fold(
    {
      tasks: [
        mkTask({ id: "a", title: "Running", status: "running" }),
        mkTask({ id: "b", title: "Waits", dependencies: [dependsOn("a", "Running")] }),
      ],
    },
    "backlog",
  );
  assert.equal(blocked.sentence, "nothing ready · 1 blocked");
});

test("backlog counts only backlogged tasks, never running ones", () => {
  const stage = fold(
    {
      tasks: [mkTask({ id: "a", status: "running" }), mkTask({ id: "b", title: "Waiting" })],
    },
    "backlog",
  );
  assert.equal(stage.count, 1, "a running task is one stage further along");
});

// ---- working ----

test("working splits the fleet the way the sitrep does", () => {
  const stage = fold(
    {
      sessions: [
        mkSession({ id: "a", state: "awaiting_input", stateConfirmed: true }),
        mkSession({ id: "b", state: "working", stateConfirmed: true }),
        mkSession({ id: "c", state: "working", stateConfirmed: true }),
        mkSession({ id: "d", state: "idle", stateConfirmed: true }),
      ],
    },
    "working",
  );
  assert.equal(stage.count, 4);
  assert.equal(stage.sentence, "1 needs you · 2 working · 1 idle");
  assert.equal(stage.tone, "attention");
});

test("a pending review is what makes a session need you, through the shared predicate", () => {
  const stage = fold(
    { sessions: [mkSession({ id: "a", state: "idle", stateConfirmed: true, pendingReviews: 1 })] },
    "working",
  );
  assert.equal(stage.tone, "attention");
  assert.match(stage.sentence, /1 needs you/);
});

test("exited sessions have left the stage", () => {
  const stage = fold(
    {
      sessions: [
        mkSession({ id: "a", state: "exited" }),
        mkSession({ id: "b", state: "working", stateConfirmed: true }),
      ],
    },
    "working",
  );
  assert.equal(stage.count, 1);
  assert.equal(stage.tone, "working");
});

// ---- review ----

test("review names the workflow doing the most of it and counts the runs", () => {
  const stage = fold(
    {
      workflowRuns: [mkRun({ id: "r1" }), mkRun({ id: "r2" }), mkRun({ id: "r3" })],
    },
    "review",
  );
  assert.equal(stage.count, 3);
  assert.equal(stage.sentence, "No-Mistakes Review v8 ×3");
  assert.equal(stage.tone, "working");
});

test("terminal runs are not live", () => {
  const stage = fold(
    {
      workflowRuns: [
        mkRun({ id: "r1", status: "completed" }),
        mkRun({ id: "r2", status: "cancelled" }),
        mkRun({ id: "r3", status: "failed" }),
        mkRun({ id: "r4", status: "waiting_for_inspector" }),
      ],
    },
    "review",
  );
  assert.equal(stage.count, 1);
});

test("only the waits a person can end turn review amber", () => {
  // The whole reason `sessionActionWaitsOnOperator` exists. `awaiting_pickup` is the daemon
  // watching a pane it has just typed into; amber there would fire on every healthy run.
  const machineWait = fold(
    { workflowRuns: [mkRun({ status: "waiting_for_action", actionWait: "awaiting_pickup" })] },
    "review",
  );
  assert.equal(machineWait.tone, "working");
  assert.doesNotMatch(machineWait.sentence, /waiting on you/);

  const humanWait = fold(
    { workflowRuns: [mkRun({ status: "waiting_for_action", actionWait: "needs_operator" })] },
    "review",
  );
  assert.equal(humanWait.tone, "attention");
  assert.match(humanWait.sentence, /1 waiting on you/);
});

test("a blocked run needs a person even with no action wait", () => {
  const stage = fold({ workflowRuns: [mkRun({ status: "blocked", actionWait: null })] }, "review");
  assert.equal(stage.tone, "attention");
});

// ---- decide ----

test("an ensemble parked on a decision says whose turn it is", () => {
  const stage = fold(
    { ensembles: [mkEnsembleSummary({ status: "awaiting_decision", attention: true })] },
    "decide",
  );
  assert.equal(stage.count, 1);
  assert.equal(stage.sentence, "Best of N · waiting on you");
  assert.equal(stage.tone, "attention");
});

test("decide counts runs, not members - members race under Working", () => {
  const stage = fold(
    {
      ensembles: [
        mkEnsembleSummary({ id: "e1", launchedMembers: 3, readyArtifacts: 1 }),
        mkEnsembleSummary({ id: "e2", launchedMembers: 4, readyArtifacts: 2 }),
      ],
    },
    "decide",
  );
  assert.equal(stage.count, 2, "seven members, two runs");
  assert.match(stage.sentence, /2 runs/);
  assert.match(stage.sentence, /3 artifacts ready/);
});

test("decide reads the daemon's own attention flag rather than inventing a threshold", () => {
  const stage = fold(
    { ensembles: [mkEnsembleSummary({ status: "running", attention: true })] },
    "decide",
  );
  assert.equal(stage.tone, "attention");
  assert.match(stage.sentence, /1 needs a look/);
});

test("a finished ensemble has left the stage", () => {
  const stage = fold({ ensembles: [mkEnsembleSummary({ status: "completed" })] }, "decide");
  assert.equal(stage.count, 0);
});

// ---- shipped ----

test("shipped counts the week and prices the day, and says which is which", () => {
  const stage = fold({ prsThisWeek: 7, cost: mkCost() }, "shipped");
  assert.equal(stage.count, 7);
  // 12.15 over 3 pull requests today.
  assert.equal(stage.sentence, "this week · ≈$4.05 per PR today");
  assert.equal(stage.tone, "idle");
});

test("no priceable estimate produces no per-PR figure rather than a zero", () => {
  // A null estimate means some usage in the window is unpriced. `$0.00 per PR` would be a
  // subtotal wearing a total's clothes - the same gate the FleetStrip already applies.
  const unpriced = fold({ prsThisWeek: 2, cost: mkCost({ estimatedCostToday: null }) }, "shipped");
  assert.doesNotMatch(unpriced.sentence, /\$/);
  assert.match(unpriced.sentence, /3 today/);

  const noneToday = fold({ prsThisWeek: 2, cost: mkCost({ prsToday: 0 }) }, "shipped");
  assert.doesNotMatch(noneToday.sentence, /\$/, "a division by zero must not become a price");
  assert.match(noneToday.sentence, /none today/);
});

test("money is spelled the way the chips spell it", () => {
  // `fmtUsd` moved to @shared/cost.ts precisely so this sentence and the cost chip beside
  // it cannot disagree. Sub-cent is the case a second `toFixed(2)` would get wrong.
  const stage = fold(
    { prsThisWeek: 1, cost: mkCost({ estimatedCostToday: 0.004, prsToday: 1 }) },
    "shipped",
  );
  assert.match(stage.sentence, /<\$0\.01/);
});

// ---- the change gate ----

test("two folds of the same state are equal, so a quiet fleet wakes no browser", () => {
  const state = input({
    sessions: [mkSession({ id: "a", state: "working", stateConfirmed: true })],
    tasks: [mkTask({ id: "t", title: "Waiting" })],
  });
  assert.ok(lineSummaryEqual(foldLineSummary(state), foldLineSummary(state)));
});

test("the gate compares what is drawn - a moved count, sentence or tone is news", () => {
  const before = foldLineSummary(input({ tasks: [mkTask({ id: "t", title: "Waiting" })] }));
  const count = foldLineSummary(
    input({ tasks: [mkTask({ id: "t", title: "Waiting" }), mkTask({ id: "u", title: "Also" })] }),
  );
  assert.ok(!lineSummaryEqual(before, count), "a count moved");

  const sentence = foldLineSummary(input({ tasks: [mkTask({ id: "t", title: "Renamed" })] }));
  assert.ok(!lineSummaryEqual(before, sentence), "the next-up task changed name");

  const tone = foldLineSummary(
    input({ tasks: [mkTask({ id: "t", title: "Waiting", enabled: false })] }),
  );
  assert.ok(!lineSummaryEqual(before, tone), "the stage went amber");

  assert.ok(!lineSummaryEqual(null, before), "nothing yet emitted is always news");
});

test("relative times are quantised to the minute so the strip cannot emit every second", () => {
  // The gate compares sentences, so a "13s ago" that ticked would be a frame per second on
  // every open dashboard. Under a minute must read as one fixed string.
  const source = { source: mkSource(), status: mkStatus({ lastSweepAt: NOW }) };
  const a = fold({ now: NOW, taskSources: [source] }, "intake");
  const b = fold({ now: NOW + 30_000, taskSources: [source] }, "intake");
  assert.equal(a.sentence, b.sentence);
  assert.match(a.sentence, /swept just now/);
});
