import { test } from "node:test";
import assert from "node:assert/strict";
import { foldLineSummary, lineSummaryEqual, type LineFoldInput } from "../src/server/line-summary.ts";
import { LINE_STAGES, lineStage, type LineStageId } from "../src/shared/line.ts";
import type { WorkflowRunSummary } from "../src/shared/workflow.ts";
import type { MissionSchedule } from "../src/shared/schedules.ts";
import type { TaskSourceInstance, TaskSourceStatus } from "../src/shared/task-source.ts";
import type { FleetCost, TaskDependency } from "../src/shared/types.ts";
import type { PipelineCommission } from "../src/shared/pipeline.ts";
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
    defaults: { kind: "ship", agent: "claude", priority: null, labels: [], enabled: true },
    maxPerSweep: 25,
    writeback: { onPrOpened: false, onCompleted: false, resolve: false },
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
    completionPolicy: "manual",
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

function mkCommission(over: Partial<PipelineCommission> = {}): PipelineCommission {
  return {
    id: "commission-1",
    taskId: "pipeline-task",
    provider: "ai-conductor",
    repoRoot: "/repo",
    correlationId: "commission-1",
    lifecycle: "authoring",
    attempts: [],
    activeAttempt: 1,
    steps: [],
    currentStep: null,
    tier: null,
    track: null,
    project: null,
    authoringWorktree: null,
    authoringBranch: null,
    planSlug: null,
    handoff: null,
    linkedRun: null,
    blocker: null,
    error: null,
    createdAt: NOW,
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

test("a terminal commission with task drift remains visible and needs attention", () => {
  const stage = fold(
    {
      tasks: [mkTask({ id: "pipeline-task", status: "running", repoRoot: "/repo" })],
      pipelineCommissions: [mkCommission({ lifecycle: "cancelled" })],
    },
    "review",
  );
  assert.equal(stage.count, 1);
  assert.equal(stage.tone, "attention");
  assert.match(stage.sentence, /1 Engineer commission/);
  assert.match(stage.sentence, /1 Pipeline needs you/);
});

test("only the waits a person can end turn review amber", () => {
  // The whole reason `sessionActionWaitsOnOperator` exists. `awaiting_pickup` is the daemon
  // watching a pane it has just typed into; amber there would fire on every healthy run.
  const machineWait = fold(
    { workflowRuns: [mkRun({ status: "waiting_for_action", actionWait: "awaiting_pickup" })] },
    "review",
  );
  assert.equal(machineWait.tone, "working");
  // Retargeted at the words that replaced "waiting on you": asserting the absence of a phrase
  // the fold can no longer produce would pass trivially and prove nothing.
  assert.doesNotMatch(machineWait.sentence, /needs? you|stalled/);

  const humanWait = fold(
    { workflowRuns: [mkRun({ status: "waiting_for_action", actionWait: "needs_operator" })] },
    "review",
  );
  assert.equal(humanWait.tone, "attention");
  assert.match(humanWait.sentence, /1 needs you/);
  // And nothing is stalled: this run is alive and one answer moves it.
  assert.doesNotMatch(humanWait.sentence, /stalled/);
});

test("a blocked run needs a person even with no action wait", () => {
  const stage = fold({ workflowRuns: [mkRun({ status: "blocked", actionWait: null })] }, "review");
  assert.equal(stage.tone, "attention");
  // Stalled, not "waiting on you". Nothing a person can say restarts this run, and the whole
  // point of the split is that a fleet of thirty-one of these owes you nothing to decide.
  assert.match(stage.sentence, /1 stalled/);
  assert.doesNotMatch(stage.sentence, /needs you/);
});

test("the strip says WHY runs stalled, and refuses to name a cause it cannot claim", () => {
  /*
   * "12 stalled" is the complaint this answers, not the answer. It is true of twelve
   * unrelated failures at once, so the number alone cannot tell a reader whether the drawer
   * beneath holds one dismissal or an afternoon.
   */
  const oneCause = fold(
    {
      workflowRuns: [
        mkRun({ id: "r1", status: "blocked", phase: "image_evidence_capture" }),
        mkRun({ id: "r2", status: "blocked", phase: "image_evidence_capture" }),
      ],
    },
    "review",
  );
  // FIRST in the sentence, not last. `.ls-sub` is one clipped line about twenty-three
  // characters wide at six stages, so a clause on the end is one no reader of the strip ever
  // sees - "2 stalled" itself has been falling off that end for as long as it has been there.
  assert.match(oneCause.sentence, /^registered evidence refused · /);
  assert.match(oneCause.sentence, /2 stalled/);
  // The clause, never the phase code: this stage is one of the four surfaces the vocabulary
  // exists for, and the daemon words it - which is only possible because the map lives in
  // `@shared/`.
  assert.doesNotMatch(oneCause.sentence, /image evidence capture/);

  /*
   * Several causes are COUNTED rather than reduced to the commonest, and this is the one
   * place the fold differs from the workflow name beside it. A plurality workflow is honest
   * about a mixed pile - every run really is running some workflow. A plurality cause is not:
   * "3 stalled · session gone" would be a false statement about two of them, and the move it
   * invites - dismiss the pile - is exactly the wrong one.
   */
  const several = fold(
    {
      workflowRuns: [
        mkRun({ id: "r1", status: "blocked", phase: "session_disappeared" }),
        mkRun({ id: "r2", status: "blocked", phase: "round_limit" }),
        mkRun({ id: "r3", status: "blocked", phase: "image_evidence_capture" }),
      ],
    },
    "review",
  );
  assert.match(several.sentence, /^3 causes · /);
  assert.match(several.sentence, /3 stalled/);

  /*
   * Two DIFFERENT phase codes that say the same thing to a reader are ONE cause, not two.
   *
   * Round 1 review caught this: counting raw phase codes would answer "2 causes" for a drawer
   * showing the same sentence twice, which is the plurality this whole rule exists to refuse.
   * It is reachable without touching the map, because `phase` is a free string that
   * `cancelRun` and every `setRunState` caller mint their own values for - these two spellings
   * of one unmapped code render one identical clause through the fallback.
   *
   * No two entries in `BLOCKED_PHASE_CLAUSES` share a value today, so this is the property
   * held structurally rather than by luck - which is the point, since nothing stops a later
   * pair of phases from deserving the same three words.
   */
  const sameWords = fold(
    {
      workflowRuns: [
        mkRun({ id: "r1", status: "blocked", phase: "a_reason" }),
        mkRun({ id: "r2", status: "blocked", phase: "a reason" }),
      ],
    },
    "review",
  );
  assert.notEqual("a_reason", "a reason");
  assert.match(sameWords.sentence, /^a reason · /);
  assert.doesNotMatch(sameWords.sentence, /causes/);

  // A phase from a newer daemon still degrades to readable text here, through the same
  // fallback the notification and the triage column use.
  const unmapped = fold(
    { workflowRuns: [mkRun({ status: "blocked", phase: "a_phase_from_a_newer_daemon" })] },
    "review",
  );
  assert.match(unmapped.sentence, /^a phase from a newer daemon · /);

  // And a healthy strip is untouched: nothing blocked, nothing to explain.
  const running = fold({ workflowRuns: [mkRun({ id: "r1" })] }, "review");
  assert.equal(running.sentence, "No-Mistakes Review v8");
});

test("the split counts a run once, even when it is both blocked and asking you something", () => {
  // `workflowRunWaitsOnOperator` is a UNION, and a run can satisfy both arms: `orphanBinding`
  // blocks a run whose session action was already parked on `needs_operator`. Two independent
  // filters would report that one run twice and have the strip claim more attention than the
  // fleet owes. Blocked wins, and it is the truer word - the attempts behind that question
  // were cancelled, so answering it moves nothing.
  const both = fold(
    { workflowRuns: [mkRun({ status: "blocked", actionWait: "needs_operator" })] },
    "review",
  );
  assert.match(both.sentence, /1 stalled/);
  assert.doesNotMatch(both.sentence, /needs you/);
  assert.equal(both.tone, "attention");

  // The two halves sum to the old single total, on a fleet holding one of each plus the
  // overlap: two runs wait on a person by the shared predicate, and the strip says two.
  const fleet = fold({
    workflowRuns: [
      mkRun({ id: "r1", status: "blocked", actionWait: "needs_operator" }),
      mkRun({ id: "r2", status: "waiting_for_action", actionWait: "needs_operator" }),
      mkRun({ id: "r3", status: "running", actionWait: null }),
    ],
  }, "review");
  assert.match(fleet.sentence, /1 needs you · 1 stalled/);
});

test("the split's parts go through the separator the accessible name rewrites", () => {
  // `LineStrip.stageLabel` turns exactly " · " into ", " to build the aria-label, so a part
  // concatenated by hand would ship a middle dot into an accessible name. Both halves, the
  // workflow clause and the blocked cause have to be joined by `sentence()`.
  const stage = fold({
    workflowRuns: [
      // A real blocked phase rather than the fixture's default, which is `review` - an
      // unmapped code that the cause clause would print back verbatim and leave this
      // assertion reading as though nothing had been added.
      mkRun({ id: "r1", status: "blocked", phase: "session_disappeared" }),
      mkRun({ id: "r2", status: "waiting_for_action", actionWait: "needs_operator" }),
    ],
  }, "review");
  assert.equal(
    stage.sentence,
    "session gone · No-Mistakes Review v8 ×2 · 1 needs you · 1 stalled",
  );
});

test("more than one of either half is counted in the fleet's own plural", () => {
  const stage = fold({
    workflowRuns: [
      mkRun({ id: "r1", status: "waiting_for_action", actionWait: "needs_operator" }),
      mkRun({ id: "r2", status: "waiting_for_action", actionWait: "needs_operator" }),
      mkRun({ id: "r3", status: "blocked" }),
      mkRun({ id: "r4", status: "blocked" }),
    ],
  }, "review");
  // "need you" rather than "needs you", which is the Working stage's own plural - one fleet
  // vocabulary for the same claim rather than two.
  assert.match(stage.sentence, /2 need you · 2 stalled/);
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
