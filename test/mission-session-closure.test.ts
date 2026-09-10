import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { ScheduleDefinition } from "../src/shared/schedules.ts";
import type { SdkEvent, SdkSessionHandle } from "../src/server/harness/types.ts";
import type { Session } from "../src/shared/types.ts";
import type { ActionResult } from "../src/server/actions.ts";

/**
 * What is at stake: an hourly recurring mission that Foreman concludes, whose agent keeps
 * running anyway.
 *
 * Observed over three consecutive runs of one mission. Foreman recorded an `empty` verdict on
 * each and the task went `done`; one session's driver was still recorded exiting three minutes
 * later, another more than an hour and a half later, and a third took a fresh prompt
 * thirty-five minutes after its conclusion - which reopened the task the operator had already
 * watched finish. The completion path was recording a status and nothing else: it asked
 * nobody to stop the agent, so a concluded mission kept a live runtime, its whole context, and
 * its place in the fleet, across its own next occurrence.
 *
 * The fix makes the conclusion and the closure ONE boundary, and these pin every edge of it:
 *
 *  - both runtimes an approval mission actually uses - the embedded SDK driver and a terminal
 *    pane - are closed by the same ledger, through the eviction path that already owns
 *    `session_remove`;
 *  - a closure is cleared only by an OBSERVED absence, so a stop that was serviced but did not
 *    land is retried rather than assumed;
 *  - the four-minute guarantee is measured from the completion time on the row, survives a
 *    restart, and cannot be extended by a repeat signal;
 *  - a late follow-up neither reopens the task nor reaches the session;
 *  - and a closure nobody can confirm becomes something the operator can read.
 *
 * The worktree is deliberately untouched throughout: an `empty` run committed nothing, so the
 * checkout may hold work, and the session's fate never waits on the tree's.
 */

const home = mkdtempSync(join(tmpdir(), "mission-session-closure-"));
process.env.MISSION_HOME = home;

const db = await import("../src/server/db.ts");
const store = await import("../src/server/schedules/store.ts");
const { Registry, SDK_SESSION_ID_PREFIX } = await import("../src/server/registry.ts");
const { SdkSupervisor } = await import("../src/server/sdk/supervisor.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
const { ensureToken } = await import("../src/server/auth.ts");
const {
  TaskManager,
  MISSION_SESSION_CLOSURE_DEADLINE_MS,
  MISSION_SESSION_CLOSURE_ESCALATE_MS,
  MISSION_SESSION_CLOSURE_STOP_TIMEOUT_MS,
} = await import("../src/server/tasks.ts");
after(() => rmSync(home, { recursive: true, force: true }));

db.openDb();

const HOOK_TOKEN = ensureToken();

const T0 = Date.parse("2026-09-09T14:00:00Z");
const HOUR = 3_600_000;

let seq = 0;
const uid = (p: string) => `${p}-${++seq}`;

function definition(over: Partial<ScheduleDefinition> = {}): ScheduleDefinition {
  return {
    name: "Hourly approval sweep",
    expression: "0 * * * *",
    timezone: "UTC",
    overlapPolicy: "skip-active",
    missedPolicy: "coalesce-latest",
    completionPolicy: "auto-on-conclusion",
    executionMode: "local-catchup",
    runnerId: null,
    template: {
      title: "Sweep the approvals",
      intent: "Read the approval queue and act on whatever is waiting.",
      repoRoot: "/repo",
      kind: "ship",
      agent: "claude",
      priority: null,
      labels: [],
      model: null,
      effort: null,
      // Never inherited for a mission: it fires unattended, so "no after-work Workflow" has to
      // reach `tasks.create` as an explicit null rather than as the dispatch default.
      workflowId: null,
    },
    ...over,
  };
}

/** A saved mission with one claimed occurrence, and the task id that occurrence reserved. */
function filedRun(over: Partial<ScheduleDefinition> = {}) {
  const schedule = store.createSchedule({
    id: uid("sched"),
    definition: definition(over),
    enabled: true,
    nextRunAt: T0 + HOUR,
    at: T0,
  });
  const occurrenceId = uid("occ");
  const taskId = uid("task");
  const claim = store.claimOccurrence({
    occurrenceId,
    scheduleId: schedule.id,
    scheduleRevision: schedule.revision,
    scheduledFor: T0 + HOUR,
    triggerKind: "scheduled",
    decisionKind: "create_task",
    taskId,
    coveredById: null,
    blockingTaskId: null,
    claimedAt: T0 + HOUR,
    delayMs: 0,
    advanceCursor: true,
    nextRunAt: T0 + 2 * HOUR,
  });
  assert.equal(claim.outcome, "claimed");
  return { schedule, occurrenceId, taskId };
}

function discovered(id: string): DiscoveredSession {
  return {
    syntheticId: id,
    agent: "claude",
    name: id,
    nameSource: "tmux",
    cwd: "/repo",
    gitBranch: "feat/sweep",
    gitRoot: "/repo",
    repoRoot: "/repo",
    pid: 4242,
    tty: "ttys9",
    terminals: [],
    startedAt: 0,
  } as DiscoveredSession;
}

/**
 * Records every kill the closure asks for, and answers whatever the test wants it to.
 *
 * `tearsDown` is what separates "a stop was requested" from "the agent went away", and the
 * difference is the whole point of the late-prompt case: a recorder that only counts calls
 * would pass even if production asked politely and let the turn run on. When set, the fake
 * does what a real kill does - the process is gone, so a completed discovery sweep no longer
 * sees the pane and the registry's own eviction starts.
 */
function killRecorder(
  answer: ActionResult = { ok: true },
  tearsDown?: () => void,
) {
  const killed: string[] = [];
  return {
    killed,
    deps: {
      // Never consulted on this path - the closure deliberately reclaims nothing - but the
      // constructor takes the pair, and a call would show up as an unexpected probe.
      resetWouldDestroyWork: async () => {
        throw new Error("the mission closure must not probe the checkout");
      },
      kill: async (s: Session): Promise<ActionResult> => {
        killed.push(s.id);
        tearsDown?.();
        return answer;
      },
    },
  };
}

/**
 * A live terminal agent, idle, executing the task an `auto-on-conclusion` run filed.
 *
 * Driven through the real registry and the real discovery/hook path, so the session under
 * test is the state a finished turn actually produces rather than a literal.
 */
function terminalMission(
  over: Partial<ScheduleDefinition> = {},
  kill = killRecorder(),
  taskOver: Parameters<typeof mkTask>[0] = {},
) {
  const registry = new Registry();
  const tasks = new TaskManager(registry, kill.deps);
  managers.push(tasks);
  const { schedule, occurrenceId, taskId } = filedRun(over);
  const sessionId = uid("sess");
  const agentSessionId = `${sessionId}-episode`;
  registry.applyDiscovery([discovered(sessionId)]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: agentSessionId,
    cwd: "/repo",
    transcriptPath: null,
    env: {},
  });
  registry.upsertTask(
    mkTask({
      id: taskId,
      status: "running",
      sessionId,
      repoRoot: "/repo",
      scheduleId: schedule.id,
      scheduleOccurrenceId: occurrenceId,
      scheduledFor: T0 + HOUR,
      ...taskOver,
    }),
  );
  return { registry, tasks, sessionId, agentSessionId, taskId, occurrenceId, kill };
}

/** Foreman's own settled verdict that this generation had nothing to ship. */
const EMPTY = { outcome: "empty" as const, summary: "the session changed nothing", gaps: [] };

/**
 * Every TaskManager this file builds, so its sweep is stopped when its test ends.
 *
 * The ledger is one table and the sweep reads all of it, which is exactly right for the one
 * TaskManager a daemon has - and means a manager left running past its own test would act on
 * the next test's rows against a registry that never heard of them. Production has no second
 * manager; this file does, so it cleans up after each one.
 */
const managers: Array<{ stopMissionSessionClosures(): void }> = [];
afterEach(() => {
  for (const m of managers.splice(0)) m.stopMissionSessionClosures();
});

/** Let every backgrounded completion and closure settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

/** Move an owed closure's whole window back, so its escalation point is already behind us. */
function ageClosure(taskId: string, byMs: number): void {
  const owed = db.getTaskSessionClosure(taskId)!;
  db.openDb()
    .prepare(`UPDATE task_session_closures SET requested_at = ?, deadline_at = ? WHERE task_id = ?`)
    .run(owed.requestedAt - byMs, owed.deadlineAt - byMs, taskId);
}

/** Wait for a condition the daemon's own timers are responsible for reaching. */
async function until(what: string, ready: () => boolean, budgetMs = 20_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await settle();
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(what);
}

// ---- the terminal-session path ----

test("concluding a mission run closes its terminal session and clears the ledger", async () => {
  const f = terminalMission();
  await f.tasks.concludeScheduledMissionRun(f.sessionId, EMPTY);
  await settle();

  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
  const owed = db.getTaskSessionClosure(f.taskId);
  assert.ok(owed, "the completion must record a durable closure intent");
  assert.equal(owed.sessionId, f.sessionId);

  // Already asked, by the time the conclusion returned. Nothing is scheduled-and-hoped-for
  // here: the teardown begins inside the call that concluded the run, so no window opens
  // between the run being over and something closing it.
  assert.deepEqual(f.kill.killed, [f.sessionId], "the pane's agent is asked to stop");
  // A serviced stop is not an absence. The row stays until the daemon has actually observed
  // the session leave, which is the only thing that can be wrong in the safe direction.
  assert.ok(db.getTaskSessionClosure(f.taskId), "a serviced stop does not close the ledger");

  // The eviction path that already owns `session_remove`: a completed sweep no longer sees
  // the pane, and the linger elapses. Nothing here drives the sweep by hand from this point -
  // the daemon's own timer chain has to be what closes the loop, because in production it is.
  f.registry.applyDiscovery([]);
  await until(
    "an observed absence is what closes the ledger",
    () => db.getTaskSessionClosure(f.taskId) === null,
  );
  assert.equal(f.registry.getSession(f.sessionId), undefined);
  assert.equal(f.registry.getTask(f.taskId)?.status, "done", "and the task stays done");
});

// ---- the SDK path an approval mission actually runs on ----

test("concluding a mission run stops its embedded driver and lets eviction remove it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const registry = new Registry();
  const supervisor = new SdkSupervisor(registry);
  const kill = killRecorder();
  const tasks = new TaskManager(registry, kill.deps, supervisor);
  managers.push(tasks);
  const { schedule, occurrenceId, taskId } = filedRun();
  const sessionId = `${SDK_SESSION_ID_PREFIX}${uid("00000000-0000-4000-8000-00000000")}`;

  let stops = 0;
  let done = false;
  let wake: (() => void) | null = null;
  const queue: SdkEvent[] = [];
  const events = (async function* () {
    for (;;) {
      while (queue.length > 0) yield queue.shift()!;
      if (done) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  })();
  const handle = {
    events,
    send: async () => "started" as const,
    sendIfIdle: async () => "started" as const,
    interrupt: async () => {},
    answer: async () => {},
    setPermissionMode: null,
    setEffort: null,
    setModel: null,
    clearContext: null,
    stop: async () => {
      stops += 1;
      done = true;
      wake?.();
    },
  } as unknown as SdkSessionHandle;
  supervisor.adopt({
    registration: {
      id: sessionId,
      agent: "claude",
      name: "Hourly approval sweep",
      cwd: "/repo",
      gitBranch: "feat/sweep",
      now: T0 + HOUR,
    },
    handle,
    durable: { taskId, model: null, effort: null, turnInProgress: false },
  });
  assert.equal(registry.getSession(sessionId)?.runtime, "sdk");
  // The discovery gate every closure waits behind. An SDK session is not a pane, so a
  // completed sweep that never saw one must not evict it either.
  registry.applyDiscovery([]);
  registry.upsertTask(
    mkTask({
      id: taskId,
      status: "running",
      sessionId,
      repoRoot: "/repo",
      scheduleId: schedule.id,
      scheduleOccurrenceId: occurrenceId,
      scheduledFor: T0 + HOUR,
    }),
  );

  await tasks.concludeScheduledMissionRun(sessionId, EMPTY);
  for (let i = 0; i < 200; i++) await Promise.resolve();
  assert.equal(registry.getTask(taskId)?.status, "done");

  await tasks.sweepMissionSessionClosures();
  assert.equal(stops, 1, "the embedded driver is stopped through the supervisor");
  assert.deepEqual(kill.killed, [], "and never through the terminal arm");
  for (let i = 0; i < 200; i++) await Promise.resolve();
  // Removal stays the registry's, on the same 8s linger every runtime leaves by.
  t.mock.timers.tick(9_000);
  for (let i = 0; i < 200; i++) await Promise.resolve();
  assert.equal(registry.getSession(sessionId), undefined);
  // Timers are mocked here, so the sweep the eviction kicked is driven by hand. What it
  // proves is the same thing either way: the row closes on the ABSENCE, not on the stop.
  await tasks.sweepMissionSessionClosures();
  assert.equal(db.getTaskSessionClosure(taskId), null);
});

// ---- a closure that cannot be confirmed ----

test("a refused stop keeps retrying and becomes something the operator can read", async () => {
  const f = terminalMission({}, killRecorder({ ok: false, error: "the pane is gone from tmux" }));
  await f.tasks.concludeScheduledMissionRun(f.sessionId, EMPTY);
  await settle();

  // One attempt was made by the conclusion itself; this is the sweep coming back for another.
  await f.tasks.sweepMissionSessionClosures();
  const owed = db.getTaskSessionClosure(f.taskId);
  assert.equal(owed?.attempts, 2, "an unconfirmed closure is tried again, not written off");
  assert.equal(owed?.lastError, "the pane is gone from tmux");
  assert.equal(f.registry.getTask(f.taskId)?.status, "done", "and the task stays completed");

  // The one line the board has for maintenance the daemon owns and nobody asked for.
  const summary = f.registry.getTask(f.taskId)?.automaticCleanup;
  assert.equal(summary?.state, "retrying");
  assert.match(summary?.detail ?? "", /closing this run's agent session/);
  assert.match(summary?.detail ?? "", /the pane is gone from tmux/);
});

test("a closure that will not close is retired inside its guarantee, not asked for ever", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = terminalMission({}, killRecorder({ ok: false, error: "tmux refused to kill that pane" }));
  await f.tasks.concludeScheduledMissionRun(f.sessionId, EMPTY);
  await settle();
  const owed = db.getTaskSessionClosure(f.taskId)!;
  assert.equal(
    owed.deadlineAt - owed.requestedAt,
    MISSION_SESSION_CLOSURE_DEADLINE_MS,
    "the guarantee is four minutes from the completion the operator can see",
  );

  // Inside the escalation window the daemon only asks, which is what gives a driver that is
  // genuinely on its way down the chance to leave by itself.
  await f.tasks.sweepMissionSessionClosures();
  assert.equal(f.registry.getSession(f.sessionId)?.state, "idle", "still asked, not forced");
  assert.ok(db.getTaskSessionClosure(f.taskId));

  // Past it, asking has been tried and shown not to work. Retrying a refused request for ever
  // is not "the session is gone within four minutes" - it is a promise the daemon never keeps.
  ageClosure(f.taskId, MISSION_SESSION_CLOSURE_ESCALATE_MS + 1_000);
  await f.tasks.sweepMissionSessionClosures();
  assert.equal(
    f.registry.getSession(f.sessionId)?.state,
    "exited",
    "an unstoppable agent is retired rather than asked again",
  );

  // Through the ordinary eviction, on the ordinary linger, so `session_remove` keeps its one
  // producer and every durable subscriber sees the event it is keyed on.
  t.mock.timers.tick(9_000);
  await settle();
  assert.equal(f.registry.getSession(f.sessionId), undefined);
  await f.tasks.sweepMissionSessionClosures();
  assert.equal(db.getTaskSessionClosure(f.taskId), null);
  assert.equal(f.registry.getTask(f.taskId)?.status, "done", "and the task was never disturbed");

  // The arithmetic the guarantee rests on: escalation plus the eviction linger has to land
  // INSIDE the deadline, or the promise is kept only on paper.
  assert.ok(
    MISSION_SESSION_CLOSURE_ESCALATE_MS + 9_000 < MISSION_SESSION_CLOSURE_DEADLINE_MS,
    "retirement must complete within the published guarantee",
  );
});

test("a stop the agent accepts but does not act on is escalated too, and says so", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // The quiet version of the same failure: nothing errors, the daemon is told yes, and the
  // session simply stays. Without this it would publish no reason at all, because there was no
  // error to publish - so the case most in need of an explanation would be the silent one.
  const f = terminalMission({}, killRecorder({ ok: true }));
  await f.tasks.concludeScheduledMissionRun(f.sessionId, EMPTY);
  await settle();

  ageClosure(f.taskId, MISSION_SESSION_CLOSURE_ESCALATE_MS + 1_000);
  await f.tasks.sweepMissionSessionClosures();
  assert.equal(db.getTaskSessionClosure(f.taskId)?.lastError, "the agent accepted the stop and did not leave");
  const summary = f.registry.getTask(f.taskId)?.automaticCleanup;
  assert.match(summary?.detail ?? "", /did not leave/);
  assert.equal(f.registry.getSession(f.sessionId)?.state, "exited");
});

test("a repeated signal about the same closure cannot buy it another four minutes", () => {
  const first = db.openTaskSessionClosure("task-repeat", "sess-repeat", 1_000, 1_000 + 240_000);
  const again = db.openTaskSessionClosure("task-repeat", "sess-repeat", 500_000, 740_000);
  assert.equal(again.deadlineAt, first.deadlineAt);
  assert.equal(again.requestedAt, first.requestedAt);

  // A row naming a DIFFERENT session is a different closure - the previous agent went away
  // and another took the task - and starts clean.
  const rolled = db.openTaskSessionClosure("task-repeat", "sess-other", 900_000, 1_140_000);
  assert.equal(rolled.deadlineAt, 1_140_000);
  assert.equal(rolled.attempts, 0);
  db.clearTaskSessionClosure("task-repeat");
});

// ---- the completion and the closure are one write ----

test("the completion and the closure it owes land in the same transaction", async () => {
  const f = terminalMission();
  // Watched at the exact instant the `done` row is published, because that is the window this
  // pair exists to remove. These used to be two writes - the task, then the ledger from the
  // completion's callback - and a daemon that died between them left a durable `done` task with
  // no record that anything was owed. Nothing revisits a terminal task, so that mission's agent
  // would have run on for ever, which is the whole failure over again.
  const publications: Array<{ status: string; owed: boolean }> = [];
  f.registry.subscribe((e) => {
    if (e.type === "task_upsert" && e.task.id === f.taskId && e.task.status === "done") {
      publications.push({ status: e.task.status, owed: db.getTaskSessionClosure(f.taskId) !== null });
    }
  });

  await f.tasks.concludeScheduledMissionRun(f.sessionId, EMPTY);
  await settle();

  assert.deepEqual(
    publications,
    [{ status: "done", owed: true }],
    "no observer may ever see this task done without its closure already recorded",
  );
});

test("a closure that cannot be recorded takes the completion down with it", async () => {
  const f = terminalMission();
  // Nothing may sweep while the table is out from under it; the write is the whole subject.
  f.tasks.stopMissionSessionClosures();

  // The ledger is made unwritable for the duration of one conclusion, which is the only way to
  // observe the transaction from outside it. This is the assertion the publication-ordering
  // test above cannot make: ordering says the row was there when the browser heard, and this
  // says the two are ONE COMMIT - fail the second and the first is undone, rather than leaving
  // SQLite holding a durably finished run whose agent nothing will ever close.
  db.openDb().exec("ALTER TABLE task_session_closures RENAME TO task_session_closures_hidden");
  try {
    await f.tasks.concludeScheduledMissionRun(f.sessionId, EMPTY);
    await settle();
  } finally {
    db.openDb().exec("ALTER TABLE task_session_closures_hidden RENAME TO task_session_closures");
  }

  // Rolled back to the safe direction. A mission run that is still `running` is the ordinary
  // state every other route to `done` already knows how to settle - a merge, the operator, or
  // Foreman's next verdict - whereas a `done` row with no closure is the one state nothing
  // revisits.
  assert.equal(db.getTask(f.taskId)?.status, "running");
  assert.equal(db.getTaskSessionClosure(f.taskId), null);
  assert.equal(f.registry.getSession(f.sessionId)?.state, "idle", "and the agent is untouched");
});

// ---- letting go of a closure that stopped being ours ----

test("a closure whose task is no longer its own is dropped without stopping anything", async () => {
  // Three ways a closure stops being this ledger's to act on. All three must LET GO of the
  // session rather than close it, and the distinction is not academic: a rescheduled run is
  // re-dispatched, and a rebound task means some other work is using that agent now. A sweep
  // that kept the row would eventually stop an agent that is legitimately working, on the
  // authority of a mission run that ended long ago.
  const cases: Array<[string, (f: ReturnType<typeof terminalMission>) => void]> = [
    ["the task was deleted", (f) => db.deleteTask(f.taskId)],
    // Re-filed by a reschedule: same row, back in the backlog, about to run again.
    ["the task is no longer done", (f) => {
      const t = db.getTask(f.taskId)!;
      db.upsertTask({ ...t, status: "backlog", outcome: null, completedAt: null });
    }],
    // Handed to another agent, so the session named here is nobody's to close from this row.
    ["the task moved to another session", (f) => {
      const t = db.getTask(f.taskId)!;
      db.upsertTask({ ...t, sessionId: "sess-somebody-else" });
    }],
  ];

  for (const [name, mutate] of cases) {
    const f = terminalMission();
    await f.tasks.concludeScheduledMissionRun(f.sessionId, EMPTY);
    await settle();
    assert.ok(db.getTaskSessionClosure(f.taskId), `${name}: a closure must be owed first`);
    // Stopped so only the sweep driven below can act, and the count it leaves is unambiguous.
    f.tasks.stopMissionSessionClosures();
    const before = f.kill.killed.length;

    mutate(f);
    await f.tasks.sweepMissionSessionClosures();

    assert.equal(db.getTaskSessionClosure(f.taskId), null, `${name}: the row is let go`);
    assert.equal(f.kill.killed.length, before, `${name}: and its agent is never touched`);
    assert.equal(
      f.registry.getSession(f.sessionId)?.state,
      "idle",
      `${name}: the session is still there, untouched`,
    );
  }
});

test("a session already on its way out is left to that eviction, not stopped again", async () => {
  const f = terminalMission();
  await f.tasks.concludeScheduledMissionRun(f.sessionId, EMPTY);
  await settle();
  f.tasks.stopMissionSessionClosures();
  const attempted = db.getTaskSessionClosure(f.taskId)!.attempts;
  assert.equal(attempted, 1, "the conclusion itself made the one attempt so far");
  assert.deepEqual(f.kill.killed, [f.sessionId]);

  // The stop landed: the registry has marked the card exited and is lingering it before
  // `session_remove`. Asking again in that window is answered by the runtime's own "there is
  // nothing here any more", which would be recorded as a REFUSAL - a sentence about our
  // timing rather than about anything the operator could act on, published on the board for
  // the few seconds it takes the eviction to finish.
  f.registry.applyDiscovery([]);
  assert.equal(f.registry.getSession(f.sessionId)?.state, "exited");

  await f.tasks.sweepMissionSessionClosures();
  assert.deepEqual(f.kill.killed, [f.sessionId], "no second stop against a departing session");
  const owed = db.getTaskSessionClosure(f.taskId);
  assert.equal(owed?.attempts, attempted, "and the pass records no attempt at all");
  assert.equal(owed?.lastError, null, "so nothing is published about it either");
  // Still owed: only the removal confirms a closure, which is the whole rule this defers to.
  assert.ok(owed);
});

// ---- restart recovery ----

test("a completion that lands asynchronously still gets its session closed", async () => {
  // A scout's completion awaits a verified archive before it writes anything, so the closure
  // row appears LONG after `concludeScheduledMissionRun` has looked at the ledger and found it
  // empty. Nothing in that call can settle a row that does not exist yet, which is why the
  // sweep is armed beside the write instead: a row is never committed with nothing scheduled
  // to settle it. Without that, this mission's agent stays on the fleet until some unrelated
  // event happens by.
  const registry = new Registry();
  const kill = killRecorder();
  let openGate!: () => void;
  const archiveReady = new Promise<void>((resolve) => { openGate = resolve; });
  const archives = {
    ensureReady: async () => {
      await archiveReady;
      return { ok: true as const };
    },
    settleBeforeCleanup: async () => ({ ok: true as const }),
  };
  const tasks = new TaskManager(registry, kill.deps, undefined, undefined, archives);
  managers.push(tasks);

  const { schedule, occurrenceId, taskId } = filedRun();
  const sessionId = uid("sess");
  registry.applyDiscovery([discovered(sessionId)]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: `${sessionId}-episode`,
    cwd: "/repo",
    transcriptPath: null,
    env: {},
  });
  registry.upsertTask(
    mkTask({
      id: taskId,
      kind: "scout",
      status: "running",
      sessionId,
      repoRoot: "/repo",
      scheduleId: schedule.id,
      scheduleOccurrenceId: occurrenceId,
      scheduledFor: T0 + HOUR,
    }),
  );

  await tasks.concludeScheduledMissionRun(sessionId, EMPTY);
  // The archive is not ready, so nothing has been written and nothing is owed yet.
  assert.equal(registry.getTask(taskId)?.status, "running");
  assert.equal(db.getTaskSessionClosure(taskId), null);
  assert.deepEqual(kill.killed, [], "and no agent has been touched");

  // Drained deliberately, and this is load-bearing. The fixture's own discovery sweep arms a
  // zero-delay pass, and if that timer is still pending when the row lands it settles the
  // closure by coincidence - which is exactly how an earlier version of this test passed with
  // the guard under test deleted. Letting it fire first against an empty ledger leaves the
  // sweep armed beside the write as the only thing that can act.
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(db.getTaskSessionClosure(taskId), null, "still nothing owed, and nothing pending");

  // The archive lands. The completion and its closure commit together, well after the call
  // that asked for them returned.
  openGate();
  await until("the archive settles the completion", () => registry.getTask(taskId)?.status === "done");
  assert.ok(db.getTaskSessionClosure(taskId), "which owes a closure");

  // And it is acted on, by the sweep armed beside that write.
  await until("the late completion's session is closed too", () => kill.killed.includes(sessionId));
});

test("a closure a previous daemon left owed is resumed, but never before discovery has run", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = terminalMission();
  await f.tasks.concludeScheduledMissionRun(f.sessionId, EMPTY);
  await settle();
  assert.ok(db.getTaskSessionClosure(f.taskId));

  // The daemon dies here. A new one rebuilds its registry from SQLite and starts its
  // TaskManager before any sweep of the process table has completed.
  const restarted = new Registry();
  const kill = killRecorder();
  const tasks = new TaskManager(restarted, kill.deps);
  managers.push(tasks);
  assert.equal(
    restarted.getTask(f.taskId)?.status,
    "done",
    "the completion is durable, so the restart inherits a done task",
  );
  await tasks.sweepMissionSessionClosures();
  assert.ok(
    db.getTaskSessionClosure(f.taskId),
    "before the process table has been read, a missing session is not an absent one",
  );
  assert.deepEqual(kill.killed, [], "and nothing is stopped on a guess either");

  // Discovery completes and finds the agent still there. Only now may the closure act.
  restarted.applyDiscovery([discovered(f.sessionId)]);
  await tasks.sweepMissionSessionClosures();
  assert.deepEqual(kill.killed, [f.sessionId], "the resumed closure asks the survivor to stop");

  restarted.applyDiscovery([]);
  t.mock.timers.tick(9_000);
  // The eviction timer and the sweep the completion scheduled both come due on that tick, so
  // let whichever ran first finish before driving the confirming pass by hand.
  await settle();
  assert.equal(restarted.getSession(f.sessionId), undefined);
  await tasks.sweepMissionSessionClosures();
  assert.equal(db.getTaskSessionClosure(f.taskId), null);
});

// ---- a late follow-up ----

/**
 * A pane that refuses to die until the test says so.
 *
 * Holding it alive is what makes the late-prompt case a test rather than a coincidence. A pane
 * that goes on the first ask is gone before any prompt could reach it, and a pane that goes on
 * the second is gone before it either - a stale zero-delay pass left over from the fixture's
 * own discovery sweep lands right after the conclusion and takes it. Either way the assertion
 * about the prompt would pass with the interception deleted, which is exactly what happened.
 *
 * So every kill is refused until `yieldPane()`, and only then does it do what a real kill does:
 * the process is gone, so a completed sweep no longer sees the pane and eviction starts.
 */
function stubbornPane() {
  const killed: string[] = [];
  let registry: InstanceType<typeof Registry> | null = null;
  let yielding = false;
  const deps = {
    resetWouldDestroyWork: async () => {
      throw new Error("the mission closure must not probe the checkout");
    },
    kill: async (s: Session): Promise<ActionResult> => {
      killed.push(s.id);
      if (!yielding) return { ok: false, error: "the pane did not answer" };
      registry?.applyDiscovery([]);
      return { ok: true };
    },
  };
  return {
    killed,
    deps,
    bind: (r: InstanceType<typeof Registry>) => { registry = r; },
    yieldPane: () => { yielding = true; },
  };
}

test("a late prompt's turn is ended by a real teardown, not merely asked about", async () => {
  const kill = stubbornPane();
  const f = terminalMission({}, kill);
  kill.bind(f.registry);

  await f.tasks.concludeScheduledMissionRun(f.sessionId, EMPTY);
  await settle();
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
  // Every attempt so far is refused, so the agent is still on the fleet - the window in which
  // the reported failure happened. Settled first so any pass already queued has run and the
  // count below is stable; otherwise a leftover pass would be mistaken for the interception.
  await until("the closure has started asking", () => kill.killed.length >= 1);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(f.registry.getSession(f.sessionId), "the agent is still here");
  const asked = kill.killed.length;

  // The reported failure, reproduced: the same session takes a prompt long after its
  // conclusion. It arrives as `UserPromptSubmit` because a person typed into the pane, which
  // the agent's own harness accepts without consulting Mission Control.
  f.registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: f.agentSessionId,
    cwd: "/repo",
    transcriptPath: null,
    prompt: "actually, keep going",
    env: {},
  });

  // The turn really did start, which is what makes the rest of this a test rather than a
  // tautology: the harness accepted the prompt and opened a generation on this session.
  const started = f.registry.getSession(f.sessionId)?.workCycle;
  assert.ok(started, "the accepted prompt opened a work cycle");
  assert.equal(started.active, true, "and that generation is running when the closure returns");
  // From here a kill would work. Nothing has asked for one since `asked` was taken, so the
  // next attempt can only be the one the prompt itself brought forward.
  kill.yieldPane();

  // PROMPTLY: the closure comes back within three seconds, far inside the ten-second retry
  // interval, so the transition itself is what brought it forward and not the cadence catching
  // up. This is the assertion the interception is load-bearing for.
  await until(
    "starting work on a closing session brings its close forward",
    () => kill.killed.length > asked,
    3_000,
  );
  // And FOR REAL: the agent goes away. A counting fake would have accepted a path that merely
  // asked while letting the accepted prompt's turn run on; this waits for the registry to lose
  // the session, through the ordinary eviction the second kill starts.
  await until(
    "the turn started on a concluded session ends because its agent is gone",
    () => f.registry.getSession(f.sessionId) === undefined,
  );

  // And the generation that prompt opened NEVER COMPLETES. This is the agent's own "I have
  // finished" signal, delivered exactly as it would have been had the turn run to the end -
  // and there is no longer a live session for it to complete against, so no second generation
  // is ever recorded for this run. Without this the test would pass against a path that let
  // the accepted prompt finish its work and only then tore the pane down.
  f.registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: f.agentSessionId,
    cwd: "/repo",
    transcriptPath: null,
    env: {},
  });
  await settle();
  assert.equal(
    f.registry.getSession(f.sessionId),
    undefined,
    "the departed session is not resurrected to finish the turn",
  );
  // Scoped to the generation the LATE prompt opened. The fixture's own finished turn left a
  // completed earlier generation behind, and asserting over every generation would be
  // asserting about that one instead of about this.
  assert.equal(
    f.registry.liveSessions().some(
      (s) =>
        s.workCycle != null &&
        s.workCycle.completedAt != null &&
        s.workCycle.generation >= started.generation,
    ),
    false,
    "and no session records the late generation as completed",
  );

  // Nothing survives that could produce another generation for this run. The ledger closes on
  // the sweep that `session_remove` kicks, so this waits for the daemon's own timer rather
  // than assuming it has already run.
  await until(
    "the observed absence closes the ledger",
    () => db.getTaskSessionClosure(f.taskId) === null,
  );
  const task = f.registry.getTask(f.taskId);
  assert.equal(task?.status, "done");
  assert.match(task?.outcome ?? "", /^Foreman concluded this recurring mission run: /);
});

test("a prompt arriving mid-sweep is not left waiting for the retry interval", async () => {
  // The ordering that used to lose it: a SWEEP pass is already inside a stop when the prompt
  // lands, so the request to look again arrives while `sweepingClosures` is set. Dropping it
  // there left the news of a started turn to the ordinary ten-second retry, which is the
  // opposite of what the interception is for.
  //
  // The pass has to be a sweep rather than the conclusion's own settle: a conclusion now
  // settles its own row directly and never takes that mutex, which is the whole point of the
  // change this test sits beside.
  let release!: () => void;
  // Released on a TIMER rather than straight away, because the interleaving is the subject: a
  // real stop spawns a process or waits on a driver pump, so it spans macrotasks, and the
  // zero-delay sweep the interception asks for therefore fires while the pass is still inside
  // it. Resolving on a microtask would let the pass finish first and never exercise this.
  const gate = new Promise<void>((resolve) => {
    release = () => { setTimeout(resolve, 100); };
  });
  const killed: string[] = [];
  let registry: InstanceType<typeof Registry> | null = null;
  const deps = {
    resetWouldDestroyWork: async () => {
      throw new Error("the mission closure must not probe the checkout");
    },
    kill: async (s: Session): Promise<ActionResult> => {
      killed.push(s.id);
      // The conclusion's own attempt is refused at once, so the agent is still here.
      if (killed.length === 1) return { ok: false, error: "the pane did not answer" };
      // The sweep's attempt is the one that hangs, holding the mutex.
      if (killed.length === 2) {
        await gate;
        return { ok: false, error: "the pane did not answer" };
      }
      registry?.applyDiscovery([]);
      return { ok: true };
    },
  };
  const f = terminalMission({}, { killed, deps });
  registry = f.registry;

  await f.tasks.concludeScheduledMissionRun(f.sessionId, EMPTY);
  await settle();
  assert.equal(killed.length, 1, "the conclusion asked once, and was refused");

  // A retry pass, now in flight and stuck inside its stop.
  const inFlight = f.tasks.sweepMissionSessionClosures();
  await until("the sweep is inside its stop", () => killed.length === 2);

  f.registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: f.agentSessionId,
    cwd: "/repo",
    transcriptPath: null,
    prompt: "actually, keep going",
    env: {},
  });
  release();

  await until(
    "the pass that was already running comes straight back rather than waiting ten seconds",
    () => killed.length >= 3,
    3_000,
  );
  await inFlight;
  await until("and finishes the close", () => f.registry.getSession(f.sessionId) === undefined);
});

test("a conclusion asks its own session even while another closure is mid-stop", async () => {
  // The guarantee that "the agent is asked before the concluding request returns" cannot be
  // routed through the shared, mutex-guarded, whole-table sweep. A pass already in flight makes
  // that sweep return having asked nobody, and when it does run it walks every owed row - so a
  // second mission concluding in the same moment would either be silently deferred or made to
  // wait out an unrelated closure's stop budget.
  const registry = new Registry();
  const killed: string[] = [];
  let releaseFirst!: () => void;
  const stuck = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = uid("sess");
  const deps = {
    resetWouldDestroyWork: async () => {
      throw new Error("the mission closure must not probe the checkout");
    },
    kill: async (s: Session): Promise<ActionResult> => {
      killed.push(s.id);
      // The FIRST mission's stop hangs. The second must not be behind it.
      if (s.id === first) { await stuck; return { ok: true }; }
      return { ok: true };
    },
  };
  const tasks = new TaskManager(registry, deps);
  managers.push(tasks);

  const second = uid("sess");
  registry.applyDiscovery([discovered(first), discovered(second)]);
  for (const [sessionId, over] of [[first, {}], [second, {}]] as const) {
    registry.applyHook({
      agent: "claude",
      event: "Stop",
      sessionId: `${sessionId}-episode`,
      cwd: "/repo",
      transcriptPath: null,
      env: {},
      ...over,
    });
  }
  const runs = [first, second].map((sessionId) => {
    const filed = filedRun();
    registry.upsertTask(
      mkTask({
        id: filed.taskId,
        status: "running",
        sessionId,
        repoRoot: "/repo",
        scheduleId: filed.schedule.id,
        scheduleOccurrenceId: filed.occurrenceId,
        scheduledFor: T0 + HOUR,
      }),
    );
    return { sessionId, taskId: filed.taskId };
  });

  // The first mission concludes and its stop hangs.
  const stuckConclusion = tasks.concludeScheduledMissionRun(runs[0]!.sessionId, EMPTY);
  await until("the first mission's stop is in flight", () => killed.includes(first));

  // The second concludes while that one is still hanging. Its own agent must be asked before
  // this call returns, and without waiting on the first.
  await tasks.concludeScheduledMissionRun(runs[1]!.sessionId, EMPTY);
  assert.ok(
    killed.includes(second),
    "the second run's agent was asked to stop inside its own concluding call",
  );
  assert.equal(registry.getTask(runs[1]!.taskId)?.status, "done");

  releaseFirst();
  await stuckConclusion;
});

test("a late prompt on the SDK path leaves no driver that could finish the turn", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // The runtime an approval mission actually runs on, and the one where the boundary is
  // absolute: an embedded session has no pane, so the only way in is this daemon's own routes.
  const registry = new Registry();
  const supervisor = new SdkSupervisor(registry);
  const kill = killRecorder();
  const tasks = new TaskManager(registry, kill.deps, supervisor);
  managers.push(tasks);
  const { schedule, occurrenceId, taskId } = filedRun();
  const sessionId = `${SDK_SESSION_ID_PREFIX}${uid("00000000-0000-4000-8000-00000000")}`;

  let stops = 0;
  let done = false;
  let wake: (() => void) | null = null;
  const delivered: string[] = [];
  const queue: SdkEvent[] = [];
  const events = (async function* () {
    for (;;) {
      while (queue.length > 0) yield queue.shift()!;
      if (done) return;
      await new Promise<void>((resolve) => { wake = resolve; });
    }
  })();
  const handle = {
    events,
    // A turn the driver would accept. After the stop there must be no handle left to take one.
    send: async (turn: { text: string }) => { delivered.push(turn.text); return "started" as const; },
    sendIfIdle: async (turn: { text: string }) => { delivered.push(turn.text); return "started" as const; },
    interrupt: async () => {},
    answer: async () => {},
    setPermissionMode: null,
    setEffort: null,
    setModel: null,
    clearContext: null,
    stop: async () => { stops += 1; done = true; wake?.(); },
  } as unknown as SdkSessionHandle;
  supervisor.adopt({
    registration: {
      id: sessionId,
      agent: "claude",
      name: "Hourly approval sweep",
      cwd: "/repo",
      gitBranch: "feat/sweep",
      now: T0 + HOUR,
    },
    handle,
    durable: { taskId, model: null, effort: null, turnInProgress: false },
  });
  registry.applyDiscovery([]);
  registry.upsertTask(
    mkTask({
      id: taskId,
      status: "running",
      sessionId,
      repoRoot: "/repo",
      scheduleId: schedule.id,
      scheduleOccurrenceId: occurrenceId,
      scheduledFor: T0 + HOUR,
    }),
  );

  assert.ok(supervisor.handleFor(sessionId), "the driver is here before the run is concluded");

  await tasks.concludeScheduledMissionRun(sessionId, EMPTY);
  for (let i = 0; i < 200; i++) await Promise.resolve();
  assert.equal(registry.getTask(taskId)?.status, "done");

  // The observable that matters, and it is true by the time the concluding call RETURNS: the
  // driver is gone. There is no longer anything that could accept a turn, run one, or finish
  // one - so a prompt arriving from here has nothing to reach at all, which is what makes this
  // path's boundary absolute rather than a race.
  assert.equal(stops, 1, "the driver was stopped inside the conclusion");
  assert.equal(supervisor.handleFor(sessionId), null, "and no handle survives to take a turn");
  assert.deepEqual(delivered, [], "nothing was ever delivered to it after the conclusion");

  t.mock.timers.tick(9_000);
  for (let i = 0; i < 200; i++) await Promise.resolve();
  assert.equal(registry.getSession(sessionId), undefined, "and the session leaves the registry");
  await tasks.sweepMissionSessionClosures();
  assert.equal(db.getTaskSessionClosure(taskId), null);
  assert.equal(registry.getTask(taskId)?.status, "done");
});

test("a prompt typed into a concluded pane is refused before any turn begins", async () => {
  // The boundary a delivery refusal cannot reach. A person types into the pane; the agent's
  // harness takes the keystrokes and then asks its hooks whether to go ahead. This is that
  // question arriving over the real route, and being answered no.
  const kill = stubbornPane();
  const f = terminalMission({}, kill);
  kill.bind(f.registry);
  const app = buildApp(f.registry, {} as ReviewManager, f.tasks, new QueueManager(f.registry));

  await f.tasks.concludeScheduledMissionRun(f.sessionId, EMPTY);
  await settle();
  f.tasks.stopMissionSessionClosures();
  assert.ok(db.getTaskSessionClosure(f.taskId), "a closure is owed, which is what arms this");

  const refused = await app.request("/hooks/UserPromptSubmit", {
    method: "POST",
    headers: { host: "127.0.0.1:7317", "content-type": "application/json", "x-harness-token": HOOK_TOKEN },
    body: JSON.stringify({
      agent: "claude",
      sessionId: f.agentSessionId,
      cwd: "/repo",
      prompt: "actually, keep going",
      env: {},
    }),
  });

  // Not a 204. The daemon answers with the decision Claude reads as "do not process this".
  assert.equal(refused.status, 200);
  const decision = await refused.json() as { decision: string; reason: string };
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /recurring mission run/);
  assert.match(decision.reason, /was not run/);

  // And NO TURN BEGAN. This is the difference from stopping a turn afterwards: the session
  // never went to work, no generation opened, and the board was never told otherwise.
  const session = f.registry.getSession(f.sessionId);
  assert.notEqual(session?.state, "working", "the refused prompt never started a turn");
  assert.equal(session?.workCycle?.active ?? false, false, "and opened no generation");
  assert.equal(f.registry.getTask(f.taskId)?.status, "done", "the task is untouched");
});

test("an ordinary session's prompt is never refused by that boundary", async () => {
  // The blast radius, pinned. Every prompt on every session that is NOT mid-closure has to go
  // through exactly as before - a hook that can refuse work is only safe while it is this
  // narrow, and 204 is what says nothing was decided.
  const f = terminalMission({ completionPolicy: "manual" });
  const app = buildApp(f.registry, {} as ReviewManager, f.tasks, new QueueManager(f.registry));
  assert.equal(db.getTaskSessionClosure(f.taskId), null, "nothing is owed here");

  const allowed = await app.request("/hooks/UserPromptSubmit", {
    method: "POST",
    headers: { host: "127.0.0.1:7317", "content-type": "application/json", "x-harness-token": HOOK_TOKEN },
    body: JSON.stringify({
      agent: "claude",
      sessionId: f.agentSessionId,
      cwd: "/repo",
      prompt: "carry on",
      env: {},
    }),
  });
  assert.equal(allowed.status, 204, "an ordinary prompt is not answered with a decision");
  assert.equal(f.registry.getSession(f.sessionId)?.state, "working", "and it starts its turn");
});

test("a stop that never answers cannot hold the closure open past its guarantee", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // A driver that wedges: the stop is issued and simply never comes back. This is the shape
  // that used to defeat the whole guarantee - the pass stayed in flight for ever, every later
  // pass returned early on `sweepingClosures`, and the escalation built for an agent that will
  // not go was the one thing that never ran.
  const killed: string[] = [];
  const deps = {
    resetWouldDestroyWork: async () => {
      throw new Error("the mission closure must not probe the checkout");
    },
    kill: async (s: Session): Promise<ActionResult> => {
      killed.push(s.id);
      return new Promise<ActionResult>(() => {});
    },
  };
  const f = terminalMission({}, { killed, deps });

  // Not awaited: with a stop that never answers, the conclusion cannot return until the budget
  // expires, and the budget is on a mocked clock this test owns.
  const concluding = f.tasks.concludeScheduledMissionRun(f.sessionId, EMPTY);
  await settle();
  assert.equal(killed.length, 1, "the first stop was issued");
  assert.ok(f.registry.getSession(f.sessionId), "and is hanging, with the agent still here");
  // Disarm the retry cadence so the only passes are the ones this test drives; the clock it
  // ticks below is the stop budget, and a retry timer firing on the same tick would blur which
  // pass made which attempt.
  f.tasks.stopMissionSessionClosures();

  t.mock.timers.tick(MISSION_SESSION_CLOSURE_STOP_TIMEOUT_MS + 1_000);
  await settle();
  await concluding;
  // Given up on, counted, and published rather than waited on for ever.
  const owed = db.getTaskSessionClosure(f.taskId)!;
  assert.equal(owed.attempts, 1);
  assert.equal(owed.lastError, "the stop did not answer within its budget");

  // Now past the point where asking has been shown not to work.
  ageClosure(f.taskId, MISSION_SESSION_CLOSURE_ESCALATE_MS + 1_000);
  const second = f.tasks.sweepMissionSessionClosures();
  await settle();
  assert.equal(killed.length, 2, "a second stop is attempted before giving up on asking");
  t.mock.timers.tick(MISSION_SESSION_CLOSURE_STOP_TIMEOUT_MS + 1_000);
  await settle();
  await second;

  // Retired, even though no stop ever answered. Retirement goes through the registry and needs
  // nothing from the driver, which is exactly why it works when the driver is what is stuck.
  assert.equal(
    f.registry.getSession(f.sessionId)?.state,
    "exited",
    "an unanswerable stop is escalated rather than waited on",
  );
  t.mock.timers.tick(9_000);
  await settle();
  assert.equal(f.registry.getSession(f.sessionId), undefined, "and the session leaves");
  assert.equal(f.registry.getTask(f.taskId)?.status, "done", "with the task untouched");

  // The arithmetic the guarantee rests on: a pass that begins a moment before the escalation
  // instant still gives up, retires and evicts inside the four minutes.
  assert.ok(
    MISSION_SESSION_CLOSURE_ESCALATE_MS + MISSION_SESSION_CLOSURE_STOP_TIMEOUT_MS + 9_000
      < MISSION_SESSION_CLOSURE_DEADLINE_MS,
    "a hung stop must not be able to push retirement past the deadline",
  );
});

test("an overdue closure says so even when no attempt was ever refused", async () => {
  // The quietest failure of all, and the one with no error to report: every stop was accepted,
  // nothing threw, and the session simply never left. Without the deadline arm of the summary
  // this task would sit on the board saying nothing at all while its agent outlived the run.
  const f = terminalMission();
  await f.tasks.concludeScheduledMissionRun(f.sessionId, EMPTY);
  await settle();
  f.tasks.stopMissionSessionClosures();
  const owed = db.getTaskSessionClosure(f.taskId)!;
  // The branch under test is the one with NOTHING to report: every attempt so far was
  // serviced, so there is no error to publish and only the deadline can speak.
  assert.equal(owed.lastError, null, "nothing has been refused");

  ageClosure(f.taskId, MISSION_SESSION_CLOSURE_DEADLINE_MS + 1_000);
  f.registry.refreshTaskAutomaticCleanup(f.taskId);

  const summary = f.registry.getTask(f.taskId)?.automaticCleanup;
  assert.equal(summary?.state, "retrying");
  assert.match(summary?.detail ?? "", /past its close deadline/);
  assert.match(summary?.detail ?? "", /has not gone away yet/);
});

test("retirement refuses a task and session the durable ledger does not pair", async () => {
  // `retireConcludedMissionSession` is the one call that can evict a session nobody stopped,
  // so it authorizes itself from the ledger rather than trusting its caller. A caller that has
  // confused two sessions - or is acting on a closure that has since been let go - gets a
  // refusal and no eviction, which is what keeps this from being a general-purpose kill.
  const f = terminalMission();
  await f.tasks.concludeScheduledMissionRun(f.sessionId, EMPTY);
  await settle();
  f.tasks.stopMissionSessionClosures();

  // A second live agent in the same fleet, which is what makes the refusal meaningful: a
  // session id that simply does not exist would be refused by the map lookup anyway, so it
  // could not tell a working pairing check from a missing one.
  const bystander = uid("sess");
  f.registry.applyDiscovery([discovered(f.sessionId), discovered(bystander)]);
  assert.ok(f.registry.getSession(bystander), "the bystander is live");
  assert.equal(
    f.registry.retireConcludedMissionSession(f.taskId, bystander),
    false,
    "the right task naming another live session is refused",
  );
  assert.notEqual(
    f.registry.getSession(bystander)?.state,
    "exited",
    "and that session is owed nothing, so nothing evicts it",
  );
  assert.equal(
    f.registry.retireConcludedMissionSession("task-nobody-owes", f.sessionId),
    false,
    "and a task with no owed closure cannot retire anything",
  );
  assert.notEqual(f.registry.getSession(f.sessionId)?.state, "exited", "nothing was evicted");

  // The genuine pairing still works, so the refusals above are the guard rather than a break.
  assert.equal(f.registry.retireConcludedMissionSession(f.taskId, f.sessionId), true);
  assert.equal(f.registry.getSession(f.sessionId)?.state, "exited");

  // Once the closure is let go, even the genuine pairing is refused.
  db.clearTaskSessionClosure(f.taskId);
  assert.equal(f.registry.retireConcludedMissionSession(f.taskId, f.sessionId), false);
});

// ---- what the closure does not touch ----

test("the closure completes with the run's checkout still held, and reclaims nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = terminalMission({}, killRecorder(), {
    worktreePath: "/wt/sweep",
    branch: "feat/sweep",
    provider: "mission",
    worktreeLeaseId: "lease-sweep",
  });
  await f.tasks.concludeScheduledMissionRun(f.sessionId, EMPTY);
  await settle();
  await f.tasks.sweepMissionSessionClosures();
  f.registry.applyDiscovery([]);
  t.mock.timers.tick(9_000);
  await settle();
  await f.tasks.sweepMissionSessionClosures();
  assert.equal(db.getTaskSessionClosure(f.taskId), null, "the session closed");

  const task = f.registry.getTask(f.taskId);
  // An `empty` run committed nothing, so anything in that tree is unpushed work. The 30-day
  // retention clock owns it, exactly as it owns every other terminal task's checkout.
  assert.equal(task?.worktreePath, "/wt/sweep", "and the checkout is still the operator's");
  assert.equal(task?.worktreeLeaseId, "lease-sweep");
});

test("a mission left on manual closes nothing, because it concluded nothing", async () => {
  const f = terminalMission({ completionPolicy: "manual" });
  await f.tasks.concludeScheduledMissionRun(f.sessionId, EMPTY);
  await settle();

  assert.equal(f.registry.getTask(f.taskId)?.status, "running");
  assert.equal(db.getTaskSessionClosure(f.taskId), null);
  await f.tasks.sweepMissionSessionClosures();
  assert.deepEqual(f.kill.killed, [], "a verdict alone never closes a manual mission's session");
  assert.equal(f.registry.promptResourceBlockerForSession(f.sessionId), null);
});
