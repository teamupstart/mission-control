import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session, SessionState, Task } from "../src/shared/types.ts";
import type { WorkflowRunRepeatOffender, WorkflowRunSummary } from "../src/shared/workflow.ts";
import type { EnsembleSummary } from "../src/shared/ensemble.ts";

// The away watcher's buffer lifecycle: when a window opens, what lands in it, and
// how it survives the moment of return. Real db for the config (as
// away-config.test.ts does) and a fake registry, so the poll loop never runs and
// each pass is driven explicitly.

const home = mkdtempSync(join(tmpdir(), "mission-away-watch-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { setAwayConfig } = await import("../src/server/away/config.ts");
const { startAwayWatcher } = await import("../src/server/away/watcher.ts");
const { digestLines, rollupLine } = await import("../src/shared/away-buffer.ts");

after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => {
  openDb().exec("DELETE FROM app_config");
});

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s",
    agent: "claude",
    name: "sess",
    runtime: "terminal",
    nameSource: "process",
    state: "working" as SessionState,
    cwd: null,
    gitBranch: null,
    gitRoot: null,
    repoRoot: null,
    pid: 1,
    tty: null,
    permissionMode: null,
    terminals: [],
    agentSessionId: null,
    transcriptPath: null,
    instrumented: true,
    stateConfirmed: true,
    hooksSeen: true,
    activity: null,
    startedAt: null,
    firstSeen: 0,
    lastSeen: 0,
    lastActivity: null,
    pendingReviews: 0,
    task: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prChecks: null,
    meta: null,
    effortBaselineReady: false,
    note: null,
    cost: null,
    goal: null,
    queue: null,
    orphanedQueue: null,
    inspector: null,
    paneDialog: null,
    ...over,
  };
}

/** A registry stand-in whose snapshot the test drives. */
function fakeRegistry(
  sessions: Session[] = [],
  tasks: Task[] = [],
  workflowRuns: WorkflowRunSummary[] = [],
  ensembleSummaries: EnsembleSummary[] = [],
) {
  const state = { sessions, tasks, workflowRuns, ensembleSummaries };
  return {
    src: {
      snapshot: () => ({
        sessions: state.sessions,
        tasks: state.tasks,
        workflowRunSummaries: state.workflowRuns,
        ensembleSummaries: state.ensembleSummaries,
      }),
    },
    set(
      next: Session[],
      nextTasks: Task[] = state.tasks,
      nextWorkflowRuns: WorkflowRunSummary[] = state.workflowRuns,
      nextEnsembles: EnsembleSummary[] = state.ensembleSummaries,
    ) {
      state.sessions = next;
      state.tasks = nextTasks;
      state.workflowRuns = nextWorkflowRuns;
      state.ensembleSummaries = nextEnsembles;
    },
  };
}

function ensembleSummary(over: Partial<EnsembleSummary> = {}): EnsembleSummary {
  return {
    id: "ens",
    title: "Compare approaches",
    repoRoot: "/repo",
    strategyId: "best_of_n",
    strategyKey: "best_of_n@1",
    strategyLabel: "Best of N",
    strategyVersion: 1,
    status: "running",
    activeStageId: null,
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
    ...over,
  };
}

function workflowRun(over: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: "run",
    bindingId: "binding",
    workflowId: "workflow",
    workflowName: "Review",
    workflowVersion: 1,
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
    ...over,
  };
}

const MIN = 60_000;

test("not away: no buffer is open", () => {
  const reg = fakeRegistry([mkSession()]);
  const w = startAwayWatcher(reg.src, () => 1000);
  assert.equal(w.buffer(), null);
  w.stop();
});

test("going away opens a buffer stamped with the away window", () => {
  const reg = fakeRegistry([mkSession()]);
  const w = startAwayWatcher(reg.src, () => 1000);
  setAwayConfig({ away: true }, 500);
  w.tick();
  assert.equal(w.buffer()?.since, 500);
  w.stop();
});

test("the FIRST pass after going away seeds silently - no history floods the buffer", () => {
  // Without a baseline every live session reads as a brand-new transition, and you
  // return to a digest describing things that happened before you left.
  const reg = fakeRegistry([mkSession({ id: "a", state: "idle" })]);
  const w = startAwayWatcher(reg.src, () => 1000);
  setAwayConfig({ away: true }, 500);
  w.tick();
  assert.equal(w.buffer()?.events.length, 0);
  w.stop();
});

test("a session finishing while away lands in the buffer", () => {
  const reg = fakeRegistry([mkSession({ id: "a", state: "working" })]);
  const w = startAwayWatcher(reg.src, () => 1000);
  setAwayConfig({ away: true }, 500);
  w.tick(); // baseline

  reg.set([mkSession({ id: "a", state: "idle" })]);
  w.tick();

  const events = w.buffer()?.events ?? [];
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "idle");
  w.stop();
});

test("workflow transitions use the same away window and coalesce stable ids", () => {
  const running = workflowRun();
  const completed = workflowRun({ status: "completed", phase: "complete", updatedAt: 2 });
  const reg = fakeRegistry([], [], [running]);
  const w = startAwayWatcher(reg.src, () => 1_000);
  setAwayConfig({ away: true }, 500);
  w.tick();

  reg.set([], [], [completed]);
  w.tick();
  w.tick();

  const events = w.buffer()?.events ?? [];
  assert.deepEqual(events.map((event) => event.key), ["workflow:run:completed"]);
  assert.equal(events[0]?.count, 1);
  assert.equal(rollupLine(w.buffer()!), "1 workflow update");
  w.stop();
});

test("an ensemble reaching its decision boundary folds into the same away digest", () => {
  const running = ensembleSummary();
  const parked = ensembleSummary({ status: "awaiting_decision", attention: true, updatedAt: 2 });
  const reg = fakeRegistry([], [], [], [running]);
  const w = startAwayWatcher(reg.src, () => 1_000);
  setAwayConfig({ away: true }, 500);
  w.tick(); // baseline

  reg.set([], [], [], [parked]);
  w.tick();
  w.tick(); // a redelivered summary must not re-announce

  const events = w.buffer()?.events ?? [];
  assert.deepEqual(events.map((event) => event.key), ["ensemble:ens:decision"]);
  assert.equal(events[0]?.count, 1);
  assert.equal(rollupLine(w.buffer()!), "1 ensemble update");
  w.stop();
});

test("nothing is buffered while you are AT THE DESK", () => {
  const reg = fakeRegistry([mkSession({ id: "a", state: "working" })]);
  const w = startAwayWatcher(reg.src, () => 1000);
  w.tick();
  reg.set([mkSession({ id: "a", state: "idle" })]);
  w.tick();
  assert.equal(w.buffer(), null);
  w.stop();
});

test("returning CLOSES the window into a pending digest rather than dropping it", () => {
  // The read that renders the summary necessarily happens after you are back, so
  // discarding on return would mean the digest never had anything to show.
  const reg = fakeRegistry([mkSession({ id: "a", state: "working" })]);
  const w = startAwayWatcher(reg.src, () => 1000);
  setAwayConfig({ away: true }, 500);
  w.tick();
  reg.set([mkSession({ id: "a", state: "idle" })]);
  w.tick();

  setAwayConfig({ away: false }, 2000);
  w.tick();

  assert.equal(w.buffer(), null);
  const pending = w.takePending();
  assert.equal(pending?.events.length, 1);
  w.stop();
});

test("flush closes the window immediately, without waiting for a tick", () => {
  // The route that flips away off calls this; the poll tick is up to 5s behind and
  // the client's follow-up digest read would otherwise beat it.
  const reg = fakeRegistry([mkSession({ id: "a", state: "working" })]);
  const w = startAwayWatcher(reg.src, () => 1000);
  setAwayConfig({ away: true }, 500);
  w.tick();
  reg.set([mkSession({ id: "a", state: "idle" })]);
  w.tick();

  w.flush();
  assert.equal(w.takePending()?.events.length, 1);
  w.stop();
});

test("the pending digest is read ONCE - a refresh doesn't re-announce it", () => {
  const reg = fakeRegistry([mkSession({ id: "a", state: "working" })]);
  const w = startAwayWatcher(reg.src, () => 1000);
  setAwayConfig({ away: true }, 500);
  w.tick();
  reg.set([mkSession({ id: "a", state: "idle" })]);
  w.tick();
  w.flush();

  assert.notEqual(w.takePending(), null);
  assert.equal(w.takePending(), null);
  w.stop();
});

test("a SECOND away window starts empty rather than inheriting the first", () => {
  const reg = fakeRegistry([mkSession({ id: "a", state: "working" })]);
  const w = startAwayWatcher(reg.src, () => 1000);
  setAwayConfig({ away: true }, 500);
  w.tick();
  reg.set([mkSession({ id: "a", state: "idle" })]);
  w.tick();
  setAwayConfig({ away: false }, 2000);
  w.tick();

  setAwayConfig({ away: true }, 3000);
  w.tick();
  assert.equal(w.buffer()?.since, 3000);
  assert.equal(w.buffer()?.events.length, 0);
  w.stop();
});

test("stalls are detected even at the desk - being told an agent is wedged always helps", () => {
  const reg = fakeRegistry([mkSession({ id: "a", state: "working", lastActivity: 0 })]);
  const w = startAwayWatcher(reg.src, () => 30 * MIN);
  w.tick();
  assert.deepEqual(w.stalls().map((s) => s.kind), ["silent-working"]);
  w.stop();
});

test("turning stall detection off silences it", () => {
  const reg = fakeRegistry([mkSession({ id: "a", state: "working", lastActivity: 0 })]);
  const w = startAwayWatcher(reg.src, () => 30 * MIN);
  setAwayConfig({ detectStalls: false });
  w.tick();
  assert.deepEqual(w.stalls(), []);
  w.stop();
});

test("a session going stuck while away is buffered as attention-worthy", () => {
  const reg = fakeRegistry([mkSession({ id: "a", state: "working", lastActivity: 0 })]);
  let clock = 1000;
  const w = startAwayWatcher(reg.src, () => clock);
  setAwayConfig({ away: true }, 500);
  w.tick(); // baseline, not yet stalled

  clock = 30 * MIN; // now well past the working threshold
  w.tick();

  const events = w.buffer()?.events ?? [];
  assert.deepEqual(events.map((e) => e.kind), ["stuck"]);
  assert.match(rollupLine(w.buffer()!), /1 stuck/);
  w.stop();
});

test("a session ALREADY stuck when you leave still makes the digest", () => {
  // The one you most want reported, and the one a plain edge-trigger is silent
  // about: the stall predates the window, so it is already in the baseline.
  const reg = fakeRegistry([mkSession({ id: "a", state: "working", lastActivity: 0 })]);
  let clock = 30 * MIN;
  const w = startAwayWatcher(reg.src, () => clock);
  w.tick(); // at the desk: the stall is detected and becomes the baseline
  assert.equal(w.stalls().length, 1);

  clock = 31 * MIN;
  setAwayConfig({ away: true }, 31 * MIN);
  w.tick();

  const events = w.buffer()?.events ?? [];
  assert.deepEqual(events.map((e) => e.kind), ["stuck"]);
  w.stop();
});

test("a stall carried into a window is reported ONCE, not once per tick", () => {
  const reg = fakeRegistry([mkSession({ id: "a", state: "working", lastActivity: 0 })]);
  let clock = 30 * MIN;
  const w = startAwayWatcher(reg.src, () => clock);
  w.tick();
  setAwayConfig({ away: true }, 31 * MIN);
  clock = 31 * MIN;
  w.tick();
  clock = 32 * MIN;
  w.tick();

  const events = w.buffer()?.events ?? [];
  assert.equal(events.length, 1);
  assert.equal(events[0]?.count, 1);
  w.stop();
});

test("a stall's digest line ages with it - you read how long it has been stuck NOW", () => {
  // The whole point of the refresh: trip the threshold at 09:12, come back at
  // 10:00, and the line must not still claim the ten minutes it had when it fired.
  const reg = fakeRegistry([mkSession({ id: "a", state: "working", lastActivity: 0 })]);
  let clock = 1000;
  const w = startAwayWatcher(reg.src, () => clock);
  setAwayConfig({ away: true }, 500);
  w.tick(); // baseline, not yet stalled

  clock = 10 * MIN; // trips the working threshold
  w.tick();
  assert.match(w.buffer()?.events[0]?.body ?? "", /silent for 10m/);

  clock = 58 * MIN; // still silent, and you are only now back at the desk
  w.tick();
  const events = w.buffer()?.events ?? [];
  assert.equal(events.length, 1);
  assert.match(events[0]?.body ?? "", /silent for 58m/);
  w.stop();
});

test("ageing a stall's wording is not a second occurrence - no x2 in the digest", () => {
  // A refresh describes one continuous stall more accurately. Counting it would
  // have the card claim the session went stuck once per poll.
  const reg = fakeRegistry([mkSession({ id: "a", state: "working", lastActivity: 0 })]);
  let clock = 1000;
  const w = startAwayWatcher(reg.src, () => clock);
  setAwayConfig({ away: true }, 500);
  w.tick();

  for (const t of [10 * MIN, 20 * MIN, 30 * MIN, 58 * MIN]) {
    clock = t;
    w.tick();
  }

  const buf = w.buffer()!;
  assert.equal(buf.events.length, 1);
  assert.equal(buf.events[0]?.count, 1);
  assert.match(rollupLine(buf), /^1 stuck$/);
  assert.deepEqual(
    digestLines(buf).map((l) => /\(x\d+\)/.test(l)),
    [false],
  );
  w.stop();
});

test("a stall that CLEARS keeps its last real wording and is not refreshed onward", () => {
  // It genuinely happened, so it stays in the digest - but frozen at the moment it
  // resolved, never re-worded from a stall that no longer exists.
  const reg = fakeRegistry([mkSession({ id: "a", state: "working", lastActivity: 0 })]);
  let clock = 1000;
  const w = startAwayWatcher(reg.src, () => clock);
  setAwayConfig({ away: true }, 500);
  w.tick();

  clock = 10 * MIN;
  w.tick();
  assert.equal(w.stalls().length, 1);

  // The agent wakes up: a fresh hook event, so nothing is silent any more.
  clock = 58 * MIN;
  reg.set([mkSession({ id: "a", state: "working", lastActivity: 58 * MIN })]);
  w.tick();

  assert.deepEqual(w.stalls(), []);
  const events = w.buffer()?.events ?? [];
  assert.equal(events.length, 1);
  assert.match(events[0]?.body ?? "", /silent for 10m/);
  w.stop();
});

test("a stall that changes KIND is genuinely new information, and alerts again", () => {
  const reg = fakeRegistry([mkSession({ id: "a", state: "working", lastActivity: 0 })]);
  let clock = 1000;
  const w = startAwayWatcher(reg.src, () => clock);
  setAwayConfig({ away: true }, 500);
  w.tick();

  clock = 10 * MIN;
  w.tick();
  assert.deepEqual(w.stalls().map((s) => s.kind), ["silent-working"]);

  // Foreman escalates: the same session, stuck for a different and more urgent
  // reason, which outranks the silence rule.
  clock = 20 * MIN;
  reg.set([
    mkSession({
      id: "a",
      state: "working",
      lastActivity: 0,
      note: {
        purpose: null,
        brief: null,
        recommendation: null,
        disposition: "escalated",
        lastAction: null,
        handledMarker: null,
        updatedAt: 0,
      },
    }),
  ]);
  w.tick();

  assert.deepEqual(w.stalls().map((s) => s.kind), ["escalated"]);
  const stuck = (w.buffer()?.events ?? []).filter((e) => e.kind === "stuck");
  assert.deepEqual(stuck.map((e) => e.key).sort(), [
    "stuck:a:escalated",
    "stuck:a:silent-working",
  ]);
  assert.deepEqual(stuck.map((e) => e.count), [1, 1]);
  w.stop();
});

test("seeding known stalls does not re-open the history gate for sessions and tasks", () => {
  // The stall seed strips only `stalls` from the baseline; a session that went idle
  // before you left is still pre-existing history and must stay out of the buffer.
  const reg = fakeRegistry([mkSession({ id: "a", state: "working" })]);
  const w = startAwayWatcher(reg.src, () => 1000);
  w.tick(); // at the desk
  reg.set([mkSession({ id: "a", state: "idle" })]);
  w.tick(); // still at the desk: it finished before you stood up

  setAwayConfig({ away: true }, 2000);
  w.tick();
  assert.equal(w.buffer()?.events.length, 0);
  w.stop();
});

test("a second window does not destroy a digest nobody has read yet", () => {
  // Read-once means there is nowhere to recover it from: go away, come back with no
  // dashboard open to claim it, go away again, and the first window would be gone.
  const reg = fakeRegistry([mkSession({ id: "a", state: "working" })]);
  let clock = 1000;
  const w = startAwayWatcher(reg.src, () => clock);
  setAwayConfig({ away: true }, 500);
  w.tick();
  reg.set([mkSession({ id: "a", state: "idle" })]);
  w.tick();
  setAwayConfig({ away: false }, 2000);
  clock = 2000;
  w.tick(); // first digest is pending, unread

  clock = 60_000;
  setAwayConfig({ away: true }, 60_000);
  reg.set([mkSession({ id: "b", state: "working" })]);
  w.tick();
  reg.set([mkSession({ id: "b", state: "idle" })]);
  w.tick();
  setAwayConfig({ away: false }, 61_000);
  clock = 61_000;
  w.tick();

  const pending = w.takePending();
  assert.deepEqual(pending?.events.map((e) => e.sessionId).sort(), ["a", "b"]);
  assert.equal(pending?.since, 500); // the merged window covers from the first exit
  // 1.5s away, then 1s away - NOT the 60.5s between leaving the first time and
  // coming back the second, most of which was spent at the desk.
  assert.equal(pending?.awayMs, 2500);
  w.stop();
});

test("stop() halts the loop", () => {
  const reg = fakeRegistry([mkSession()]);
  const w = startAwayWatcher(reg.src, () => 1000);
  w.stop();
  // No assertion on timers beyond not throwing - the unref'd timeout is cleared, so
  // this test process can exit, which is itself the check.
  assert.ok(true);
});

test("the daemon's repeat-offender channel reaches the buffer", () => {
  // The derivation walks a run's submissions and attempts, so it is detail-only and never
  // travels on the SSE summary - which is why the watcher takes it as an injected reader
  // rather than off the registry snapshot, the same shape `stalls` has.
  const reg = fakeRegistry([mkSession({ id: "a", state: "idle" })]);
  const offenders: WorkflowRunRepeatOffender[] = [];
  const w = startAwayWatcher(reg.src, () => 1000, {
    // A fresh array per call, exactly as the daemon's `repeatOffenderSignals()` returns:
    // handing the watcher the same mutable reference would alias its own baseline.
    workflowRepeatOffenders: () => offenders.map((offender) => ({ ...offender })),
  });
  setAwayConfig({ away: true }, 500);
  w.tick(); // baseline: no offenders yet

  offenders.push({
    runId: "run-1",
    workflowName: "No-Mistakes Review",
    sessionId: "a",
    round: 4,
    maxRepairRounds: 5,
    nodeId: "nmr-code-risk",
    personaName: "Code Risk Reviewer",
    rounds: 3,
  });
  w.tick();
  const events = w.buffer()?.events ?? [];
  assert.equal(events.filter((event) => event.kind === "workflow-repeat").length, 1);
  assert.match(
    events.find((event) => event.kind === "workflow-repeat")?.title ?? "",
    /failed 3 rounds running/,
  );

  // Edge-triggered: the same loop on the next pass is not news again.
  w.tick();
  assert.equal(
    (w.buffer()?.events ?? []).filter((event) => event.kind === "workflow-repeat").length,
    1,
  );
  w.stop();
});
