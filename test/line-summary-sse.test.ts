import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "../src/shared/types.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { EnsembleSummary } from "../src/shared/ensemble.ts";
import type { MissionSchedule } from "../src/shared/schedules.ts";
import type { WorkflowRunSummary } from "../src/shared/workflow.ts";
import { lineStage } from "../src/shared/line.ts";
import { mkEnsembleSummary, mkTask } from "./helpers/session-fixture.ts";

// What is at stake: the strip is the fleet page's permanent header, so it has exactly two
// ways to be wrong on the wire, and this file pins both.
//
// Too quiet. A store mutation that refreshes nothing leaves a stale strip on every open
// dashboard until something unrelated happens to move - an operator watching "nothing
// waiting" over a backlog they filed thirty seconds ago. The hook is in `emitEvent` rather
// than in each of the ten setters precisely so this cannot rot, and the wiring test below
// is what says so for every store at once.
//
// Too loud. The fold runs on every session upsert, and a discovery sweep emits one per
// session; without coalescing and a change gate that is a fold - two zod parses and a
// `COUNT` - plus an SSE frame per session per 1.5 seconds, forever, carrying numbers that
// never moved. `cost_fleet` learned this the hard way (see `statusline-ratelimits.test.ts`);
// the suppression tests here are its Line counterpart.
//
// Coalescing is on `setImmediate`, so every assertion about emission has to let the turn end
// first - that is what `settle()` is, and a missing `await` on it asserts on a fold that has
// not run.

const home = mkdtempSync(join(tmpdir(), "mission-line-sse-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");

after(() => rmSync(home, { recursive: true, force: true }));
// A fresh DB per test. `tasks` matters as much as `app_config` here and is easy to miss:
// `Registry.upsertTask` writes THROUGH to the table, and every `new Registry()` hydrates
// from it - so without this, each test's registry would open holding every task the tests
// before it filed, and a suppression assertion would be measuring a fold over someone
// else's fleet.
beforeEach(() => openDb().exec("DELETE FROM app_config; DELETE FROM tasks;"));

const isLine = (e: ServerEvent): e is Extract<ServerEvent, { type: "line_summary" }> =>
  e.type === "line_summary";

/** Let the coalescer's `setImmediate` fire. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function setup() {
  const registry = new Registry();
  const events: ServerEvent[] = [];
  registry.subscribe((e) => events.push(e));
  return { registry, frames: () => events.filter(isLine) };
}

function discovered(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    syntheticId: "sess-1",
    agent: "claude",
    name: "atlas",
    nameSource: "process",
    cwd: "/repo",
    gitBranch: null,
    gitRoot: null,
    repoRoot: null,
    pid: 1,
    tty: "ttys1",
    terminals: [],
    startedAt: 0,
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
    sessionId: null,
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
    updatedAt: 2000,
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
    nextRunAt: Date.now() + 3_600_000,
    lastOccurrence: null,
    unreadable: null,
    health: "healthy",
    healthReasons: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

const ensemble = (over: Partial<EnsembleSummary> = {}): EnsembleSummary =>
  mkEnsembleSummary({ id: "ens-1", ...over });

// ---- the snapshot ----

test("the snapshot carries a whole strip, so a fresh dashboard is not six blanks", () => {
  const { registry } = setup();
  const line = registry.snapshot().lineSummary;
  assert.equal(line.stages.length, 6);
  // Every stage says something. A quiet fleet is an answer, not an absence - which is why
  // this field is non-nullable where `fleetCost` beside it is not.
  for (const stage of line.stages) assert.ok(stage.sentence.length > 0, `${stage.stage} was blank`);
});

test("the snapshot is folded fresh, not served from the last emitted value", () => {
  // `lastLineSummary` is null until the first mutation. A snapshot served from it would give
  // a dashboard opened onto an established fleet an empty strip over real work.
  const { registry } = setup();
  registry.upsertTask(mkTask({ id: "t1", title: "Filed before anyone connected" }));
  assert.equal(lineStage(registry.snapshot().lineSummary, "backlog")?.count, 1);
});

// ---- emission ----

test("a store mutation refreshes the strip without its setter knowing about the Line", async () => {
  const { registry, frames } = setup();
  await settle();
  const before = frames().length;

  registry.upsertTask(mkTask({ id: "t1", title: "Fix pane focus stealing" }));
  await settle();

  assert.equal(frames().length, before + 1, "filing a task moved the backlog stage");
  const backlog = lineStage(frames().at(-1)!.line, "backlog")!;
  assert.equal(backlog.count, 1);
  assert.equal(backlog.sentence, "next up: Fix pane focus stealing");
});

test("every store the fold reads is wired, not just the one that was easy", async () => {
  // The point of hooking `emitEvent` is that all five stores arrive for free. If a later
  // change moves the hook back into individual setters, this is what notices the one it
  // forgot - and a sixth store added to `LineFoldInput` without a matching entry in
  // `LINE_INPUT_EVENTS` fails here rather than shipping a stage that never refreshes.
  const { registry, frames } = setup();
  await settle();

  const moves: Array<[stage: string, move: () => void]> = [
    ["tasks", () => registry.upsertTask(mkTask({ id: "t1", title: "A task" }))],
    ["sessions", () => registry.applyDiscovery([discovered()])],
    ["workflow runs", () => registry.upsertWorkflowRun(mkRun())],
    ["ensembles", () => registry.upsertEnsemble(ensemble())],
    ["schedules", () => registry.upsertSchedule(mkSchedule())],
  ];
  for (const [name, move] of moves) {
    const before = frames().length;
    move();
    await settle();
    assert.ok(frames().length > before, `a ${name} mutation left the strip stale`);
  }

  // And the removals, which are the half that goes wrong quietly: a stage that counts up
  // and never down is a strip that only ever grows.
  const populated = frames().at(-1)!.line;
  assert.equal(lineStage(populated, "review")?.count, 1);
  assert.equal(lineStage(populated, "decide")?.count, 1);

  registry.removeWorkflowRun("run-1");
  registry.removeEnsemble("ens-1");
  await settle();
  const emptied = frames().at(-1)!.line;
  assert.equal(lineStage(emptied, "review")?.count, 0);
  assert.equal(lineStage(emptied, "decide")?.count, 0);
});

test("a burst collapses to one fold rather than one per mutation", async () => {
  // A discovery sweep emits a session upsert per session. Without coalescing, a twelve
  // session fleet would run the whole fold twelve times to produce one answer, and put up
  // to twelve frames on every browser.
  const { registry, frames } = setup();
  await settle();
  const before = frames().length;

  for (let i = 0; i < 12; i++) registry.upsertTask(mkTask({ id: `t${i}`, title: `Task ${i}` }));
  await settle();

  assert.equal(frames().length, before + 1, "twelve mutations in one turn are one fold");
  assert.equal(lineStage(frames().at(-1)!.line, "backlog")?.count, 12);
});

test("a mutation that moves nothing on the strip wakes no browser", async () => {
  const { registry, frames } = setup();
  registry.upsertTask(mkTask({ id: "t1", title: "Waiting" }));
  await settle();
  const after = frames().length;
  assert.equal(after, 1, "the first fold is news");

  // Re-upserting the identical row still emits `task_upsert` - the browser needs it - but
  // the strip says exactly what it said before, so it must not be re-sent.
  for (let i = 0; i < 20; i++) registry.upsertTask(mkTask({ id: "t1", title: "Waiting" }));
  await settle();
  assert.equal(frames().length, after, "restating the same fleet is not news");

  registry.upsertTask(mkTask({ id: "t2", title: "Second" }));
  await settle();
  assert.equal(frames().length, after + 1, "a figure that actually moved still gets through");
});

test("a synchronous recompute is idempotent, so a caller may settle the strip itself", async () => {
  const { registry, frames } = setup();
  registry.recomputeLineSummary();
  await settle();
  const after = frames().length;
  registry.recomputeLineSummary();
  registry.recomputeLineSummary();
  assert.equal(frames().length, after, "nothing changed between the three folds");
});

// ---- the fold reads the daemon's own stores ----

test("a discovered session lands on the Working stage, counted the way the sitrep counts", async () => {
  // Straight through `reportBucket`: a freshly discovered agent has no confirmed lifecycle
  // reading, so it is neither "working" nor "needs you" - it is open and unconfirmed. A
  // strip that claimed it was busy would be inventing evidence the daemon does not have.
  const { registry, frames } = setup();
  registry.applyDiscovery([discovered(), discovered({ syntheticId: "sess-2", pid: 2, tty: "ttys2" })]);
  await settle();

  const working = lineStage(frames().at(-1)!.line, "working")!;
  assert.equal(working.count, 2);
  assert.match(working.sentence, /2 idle/);
  assert.equal(working.tone, "idle");
});
