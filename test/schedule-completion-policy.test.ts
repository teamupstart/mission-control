import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { Session } from "../src/shared/types.ts";
import {
  foremanConcludedMission,
  revisionIsRunnable,
  scheduleIsRunnable,
} from "../src/shared/schedules.ts";
import type { ScheduleDefinition } from "../src/shared/schedules.ts";
import { PROMPTED_COMPLETION_OUTCOMES } from "../src/shared/types.ts";

/**
 * What is at stake: a recurring mission that files work for ever, blocked for ever by one
 * task that finished.
 *
 * The failure is quiet and it compounds. A mission whose run has nothing to ship - the
 * sweep found nothing, the report was written, the audit came back clean - opens no pull
 * request, and every existing route to `done` for autonomous work reads a merge. So the
 * task stays `running`, `skip-active` refuses every later occurrence against it, and the
 * ledger dutifully records `skipped_overlap` week after week naming a task that stopped
 * doing anything in March. Nothing is broken enough to show up as an error; the mission
 * simply never runs again.
 *
 * These pin the guardrail that closes it end to end: which of Foreman's verdicts count as a
 * conclusion, that the policy is read from the revision that FILED the task rather than from
 * a schedule the operator may since have edited, that an upgrading database defaults to the
 * behaviour it already had, and that a value from a newer build is refused rather than
 * guessed at.
 *
 * The database is deliberately an UPGRADED one: the two schedule tables are seeded WITHOUT
 * `completion_policy` before `openDb()` sees them, so the migration is exercised rather than
 * assumed. A fresh-schema test would pass with both `addColumn` calls deleted.
 */

const home = mkdtempSync(join(tmpdir(), "mission-schedule-completion-"));
process.env.MISSION_HOME = home;

/**
 * The two schedule tables as they stood before this guardrail existed - i.e. what is on an
 * upgrading operator's disk. `CREATE TABLE IF NOT EXISTS` means the daemon keeps these and
 * never re-creates them, so only the ALTERs can add the column.
 */
function seedPreFeatureDb(): void {
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec(`
    CREATE TABLE IF NOT EXISTS mission_schedules (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      enabled        INTEGER NOT NULL DEFAULT 0,
      archived_at    INTEGER,
      expression     TEXT NOT NULL,
      timezone       TEXT NOT NULL,
      overlap_policy TEXT NOT NULL,
      missed_policy  TEXT NOT NULL,
      execution_mode TEXT NOT NULL,
      runner_id      TEXT,
      revision       INTEGER NOT NULL,
      next_run_at    INTEGER,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mission_schedule_revisions (
      schedule_id    TEXT NOT NULL,
      revision       INTEGER NOT NULL,
      template_json  TEXT NOT NULL,
      expression     TEXT NOT NULL,
      timezone       TEXT NOT NULL,
      overlap_policy TEXT NOT NULL,
      missed_policy  TEXT NOT NULL,
      execution_mode TEXT NOT NULL,
      runner_id      TEXT,
      created_at     INTEGER NOT NULL,
      PRIMARY KEY (schedule_id, revision)
    );
  `);
  raw
    .prepare(
      `INSERT INTO mission_schedules (
         id, name, enabled, expression, timezone, overlap_policy, missed_policy,
         execution_mode, runner_id, revision, next_run_at, created_at, updated_at
       ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?)`,
    )
    .run("sched-legacy", "Written before the guardrail", "0 8 * * *", "UTC", "skip-active",
      "coalesce-latest", "local-catchup", 1, 1, 1);
  raw
    .prepare(
      `INSERT INTO mission_schedule_revisions (
         schedule_id, revision, template_json, expression, timezone, overlap_policy,
         missed_policy, execution_mode, runner_id, created_at
       ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      "sched-legacy",
      JSON.stringify({
        title: "Sweep",
        intent: "Sweep the inbox.",
        repoRoot: "/repo",
        kind: "ship",
        agent: "claude",
        priority: null,
        labels: [],
        model: null,
        effort: null,
      }),
      "0 8 * * *",
      "UTC",
      "skip-active",
      "coalesce-latest",
      "local-catchup",
      1,
    );
  raw.close();
}

seedPreFeatureDb();

const db = await import("../src/server/db.ts");
const store = await import("../src/server/schedules/store.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { pollAndReconcilePrs } = await import("../src/server/pr.ts");
const { buildApp } = await import("../src/server/routes.ts");
type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
after(() => rmSync(home, { recursive: true, force: true }));

db.openDb();

const T0 = Date.parse("2026-07-23T00:00:00Z");
const HOUR = 3_600_000;

let seq = 0;
const uid = (p: string) => `${p}-${++seq}`;

function definition(over: Partial<ScheduleDefinition> = {}): ScheduleDefinition {
  return {
    name: "Inbox sweep",
    expression: "0 8 * * *",
    timezone: "UTC",
    overlapPolicy: "skip-active",
    missedPolicy: "coalesce-latest",
    completionPolicy: "manual",
    executionMode: "local-catchup",
    runnerId: null,
    template: {
      title: "Sweep the inbox",
      intent: "Read the inbox and file whatever needs filing.",
      repoRoot: "/repo",
      kind: "ship",
      agent: "claude",
      priority: null,
      labels: [],
      model: null,
      effort: null,
      workflowId: null,
    },
    ...over,
  };
}

/** A saved schedule with one claimed `create_task` occurrence, and the task id it reserved. */
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

// ---- which verdicts are conclusions ----

test("only Foreman's non-shipping settled verdicts conclude a mission run", () => {
  // Spelled as a partition of the whole persisted vocabulary rather than two positive
  // assertions, so an outcome appended to `PROMPTED_COMPLETION_OUTCOMES` later cannot
  // quietly default into "this completes somebody's task" without failing here first.
  const concluding = PROMPTED_COMPLETION_OUTCOMES.filter((o) => foremanConcludedMission(o));
  assert.deepEqual([...concluding].sort(), ["empty", "retired"]);
});

test("a held verdict is Foreman saying the work is unfinished, not finished", () => {
  assert.equal(foremanConcludedMission("held"), false);
  // No model judged this one at all - see `PROMPTED_COMPLETION_OUTCOMES`.
  assert.equal(foremanConcludedMission("verification_failed"), false);
  // Shipping is under way, so the merge paths still own the completion.
  assert.equal(foremanConcludedMission("workflow_claimed"), false);
  assert.equal(foremanConcludedMission("direct_handoff"), false);
  assert.equal(foremanConcludedMission("asked"), false);
});

// ---- persistence ----

test("an upgrading database reads its existing missions as manual, and keeps running them", () => {
  // The row was written before the column existed. It must not become unrunnable - a NULL
  // here would fail `readPolicies` closed and take every mission an operator already owns
  // off the clock on the first start after an upgrade.
  const legacy = store.getSchedule("sched-legacy", T0);
  assert.ok(legacy);
  assert.equal(legacy.completionPolicy, "manual");
  assert.equal(legacy.unreadable, null);
  assert.equal(scheduleIsRunnable(legacy), true);

  const revision = store.activeRevision("sched-legacy");
  assert.ok(revision);
  assert.equal(revision.completionPolicy, "manual");
  assert.equal(revisionIsRunnable(revision), true);
});

test("the completion policy round-trips onto the schedule and its revision", () => {
  const { schedule } = filedRun({ completionPolicy: "auto-on-conclusion" });
  const reread = store.getSchedule(schedule.id, T0);
  assert.equal(reread?.completionPolicy, "auto-on-conclusion");
  assert.equal(store.activeRevision(schedule.id)?.completionPolicy, "auto-on-conclusion");
});

test("a policy value from a newer build refuses the schedule rather than running it", () => {
  const { schedule } = filedRun();
  db.openDb()
    .prepare(`UPDATE mission_schedules SET completion_policy = ? WHERE id = ?`)
    .run("auto-on-something-later", schedule.id);

  const reread = store.getSchedule(schedule.id, T0);
  assert.ok(reread);
  assert.equal(reread.completionPolicy, null);
  assert.equal(scheduleIsRunnable(reread), false);
  assert.match(reread.unreadable?.reason ?? "", /completion_policy/);
  assert.ok(reread.unreadable?.fields.includes("completion_policy"));
});

test("the policy a task is judged by is the revision that filed it, not the current one", () => {
  const { schedule, occurrenceId } = filedRun({ completionPolicy: "auto-on-conclusion" });
  assert.equal(store.completionPolicyForOccurrence(occurrenceId), "auto-on-conclusion");

  // The operator changes their mind AFTER the run was filed. Work already in flight was
  // filed under the old answer and stays judged by it; only later runs get the new one.
  store.updateSchedule(
    schedule.id,
    definition({ completionPolicy: "manual" }),
    T0 + 2 * HOUR,
    T0 + HOUR,
  );
  assert.equal(store.getSchedule(schedule.id, T0)?.completionPolicy, "manual");
  assert.equal(store.completionPolicyForOccurrence(occurrenceId), "auto-on-conclusion");
});

test("an unknown or missing occurrence answers null rather than guessing a policy", () => {
  assert.equal(store.completionPolicyForOccurrence("no-such-occurrence"), null);

  const { occurrenceId, schedule } = filedRun({ completionPolicy: "auto-on-conclusion" });
  db.openDb()
    .prepare(
      `UPDATE mission_schedule_revisions SET completion_policy = ?
        WHERE schedule_id = ? AND revision = 1`,
    )
    .run("from-the-future", schedule.id);
  assert.equal(store.completionPolicyForOccurrence(occurrenceId), null);
});

// ---- the completion itself ----

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
  };
}

/**
 * Every TaskManager built here, so the closure sweep a conclusion starts is stopped with the
 * test that started it. One daemon has one manager; this file has one per fixture.
 */
const managers: Array<{ stopMissionSessionClosures(): void }> = [];
afterEach(() => {
  for (const m of managers.splice(0)) m.stopMissionSessionClosures();
});

/**
 * A stop that records rather than performs one.
 *
 * Not optional decoration. Concluding an `auto-on-conclusion` run now also closes the agent
 * that produced it, and the shipped terminal arm signals `session.pid` - which in a fixture is
 * a number this file made up. Every manager below is handed this instead.
 */
function killRecorder() {
  const killed: string[] = [];
  return {
    killed,
    deps: {
      resetWouldDestroyWork: async () => null,
      kill: async (s: Session) => {
        killed.push(s.id);
        return { ok: true as const };
      },
    },
  };
}

/**
 * A live agent, idle, executing the task a mission run filed.
 *
 * Driven through the REAL registry rather than a session literal, because idleness is what
 * the completion path reads and a hand-written `state: "idle"` would be asserting against a
 * fixture instead of against the state a finished turn actually produces.
 */
function runningMission(over: Partial<ScheduleDefinition> = {}) {
  const registry = new Registry();
  const kill = killRecorder();
  const tasks = new TaskManager(registry, kill.deps);
  managers.push(tasks);
  const { schedule, occurrenceId, taskId } = filedRun(over);
  const sessionId = uid("sess");
  const agentSessionId = `${sessionId}-episode`;
  registry.applyDiscovery([discovered(sessionId)]);
  // Discovery alone leaves a session `working` - a bare `ps` sweep cannot know better - so
  // the agent is driven idle through the same hook a real one fires when it finishes a turn.
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: agentSessionId,
    cwd: "/repo",
    transcriptPath: null,
    env: {},
  });
  assert.equal(registry.getSession(sessionId)?.state, "idle", "fixture must actually be idle");
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
  return { registry, tasks, sessionId, agentSessionId, taskId, schedule, occurrenceId, kill };
}

test("a mission set to auto-complete lands its task on Foreman's empty verdict", async () => {
  const f = runningMission({ completionPolicy: "auto-on-conclusion" });
  await f.tasks.concludeScheduledMissionRun(f.sessionId, {
    outcome: "empty",
    summary: "the session changed nothing",
    gaps: [],
  });

  const task = f.registry.getTask(f.taskId);
  assert.equal(task?.status, "done");
  // The row says who concluded it and why, because "why is this done when nothing shipped?"
  // is the first question it provokes weeks later.
  assert.match(task?.outcome ?? "", /^Foreman concluded this recurring mission run: /);
  assert.match(task?.outcome ?? "", /changed nothing/);
});

test("the conclusion is terminal, and the session that produced it is closed with it", async () => {
  const f = runningMission({ completionPolicy: "auto-on-conclusion" });
  await f.tasks.concludeScheduledMissionRun(f.sessionId, {
    outcome: "retired",
    summary: "a review-only artifact",
    gaps: [],
  });
  for (let i = 0; i < 100; i++) await Promise.resolve();
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");

  // This used to be reversible - the completion was registered as an inference, so an agent
  // typing again on this very task reopened it. For a recurring mission that was the bug:
  // the conclusion left the agent alive, and a prompt half an hour later reopened work the
  // operator had watched finish. The conclusion and the closure of the agent that produced it
  // are now one boundary. See `test/mission-session-closure.test.ts`.
  f.registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: f.agentSessionId,
    cwd: "/repo",
    transcriptPath: null,
    prompt: "actually, keep going",
    env: {},
  });
  assert.equal(f.registry.getSession(f.sessionId)?.state, "working");
  const task = f.registry.getTask(f.taskId);
  assert.equal(task?.status, "done", "a concluded mission run stays concluded");
  assert.match(task?.outcome ?? "", /review-only artifact/);
  // And nothing may be delivered to that session while its closure is owed.
  assert.match(
    f.registry.promptResourceBlockerForSession(f.sessionId) ?? "",
    /recurring mission run was concluded/,
  );
});

test("a mission left on manual keeps its task open for a merge or for the operator", async () => {
  const f = runningMission({ completionPolicy: "manual" });
  await f.tasks.concludeScheduledMissionRun(f.sessionId, {
    outcome: "empty",
    summary: "the session changed nothing",
    gaps: [],
  });
  assert.equal(f.registry.getTask(f.taskId)?.status, "running");
});

test("a verdict that is not a conclusion never completes the task, whatever the policy", async () => {
  const f = runningMission({ completionPolicy: "auto-on-conclusion" });
  for (const outcome of ["held", "asked", "workflow_claimed", "verification_failed"] as const) {
    await f.tasks.concludeScheduledMissionRun(f.sessionId, {
      outcome,
      summary: "still going",
      gaps: [],
    });
    assert.equal(f.registry.getTask(f.taskId)?.status, "running", outcome);
  }
});

test("an ordinary task's completion stays the operator's, mission policy or not", async () => {
  // The gate that keeps this feature inside Recurring Missions: a task with no occurrence
  // has no revision to read a policy from, and nothing here may invent one for it.
  const registry = new Registry();
  const tasks = new TaskManager(registry, killRecorder().deps);
  managers.push(tasks);
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
  const taskId = uid("task");
  registry.upsertTask(mkTask({ id: taskId, status: "running", sessionId, repoRoot: "/repo" }));

  await tasks.concludeScheduledMissionRun(sessionId, {
    outcome: "empty",
    summary: "the session changed nothing",
    gaps: [],
  });
  assert.equal(registry.getTask(taskId)?.status, "running");
});

// ---- the daemon's own boundary ----

test("the prompted-consumption route is what carries the verdict to the task", async () => {
  // The unit cases above call `TaskManager` directly, which proves the policy and proves
  // nothing about the wiring. Foreman never touches SQLite: it reports its verdict over
  // this one route, and a hook that is not called from there is a feature that exists only
  // in a test. So this drives the real request, against the real consumption guards.
  const registry = new Registry();
  const kill = killRecorder();
  const tasks = new TaskManager(registry, kill.deps);
  managers.push(tasks);
  const queues = new QueueManager(registry);
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues });

  const { schedule, occurrenceId, taskId } = filedRun({ completionPolicy: "auto-on-conclusion" });
  const sessionId = uid("sess");
  const agentSessionId = `${sessionId}-episode`;
  registry.applyDiscovery([discovered(sessionId)]);
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

  // One whole turn: a prompt opens the work cycle, the goal is what the consumption's
  // intent guard is checked against, and Stop completes the generation Foreman may spend.
  const objective = "sweep the inbox and file whatever needs filing";
  registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: agentSessionId,
    cwd: "/repo",
    transcriptPath: null,
    prompt: objective,
    env: {},
  });
  registry.upsertGoal(sessionId, {
    prompt: objective,
    text: objective,
    objective,
    focus: objective,
    relationship: "initial",
    rationale: "Initial objective",
    objectiveVersion: 1,
    promptRevision: 1,
    resolvedPromptRevision: 1,
    pendingPrompts: [],
    source: "heuristic",
  });
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: agentSessionId,
    cwd: "/repo",
    transcriptPath: null,
    env: {},
  });

  const goal = registry.getGoal(sessionId)!;
  const cycle = registry.getSession(sessionId)!.workCycle!;
  const res = await app.request(`/api/sessions/${sessionId}/queue/wrapup/prompted`, {
    method: "POST",
    headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
    body: JSON.stringify({
      logicalKey: cycle.logicalKey,
      generation: cycle.generation,
      expectedIntent: {
        objective: goal.objective,
        objectiveVersion: goal.objectiveVersion,
        promptRevision: goal.promptRevision,
        episodeKey: `intent:${goal.objectiveVersion}:${goal.promptRevision}`,
      },
      decision: { outcome: "empty", summary: "the session changed nothing", gaps: [] },
    }),
  });
  assert.equal(res.status, 200);
  assert.equal(registry.getTask(taskId)?.status, "done");
});

// ---- interaction with the pull-request paths ----

/** The open pull request `gh` reports for a live session's branch, on its current episode. */
function openPr(
  f: ReturnType<typeof runningMission>,
  url: string,
): void {
  f.registry.bindTaskToWorkEpisode(f.taskId, f.sessionId);
  const episode = f.registry.workEpisodeForSession(f.sessionId)!;
  f.registry.reconcilePrs(
    new Map([[f.sessionId, {
      url,
      number: 1,
      state: "open" as const,
      checks: "passing" as const,
      branch: "feat/sweep",
      agentSessionId: f.agentSessionId,
      episodeId: episode.episodeId,
      createdAt: episode.startedAt,
      mergedAt: null,
      headSha: "head",
      worktreeHeadSha: "head",
    }]]),
    new Set(),
  );
}

/** One poll pass in which `url` reports merged, and nothing is asked about any branch. */
async function pollMerged(
  f: ReturnType<typeof runningMission>,
  url: string,
): Promise<void> {
  await pollAndReconcilePrs(
    f.registry,
    async () => null,
    async (candidate) =>
      candidate === url ? { state: "merged" as const, mergedAt: T0 + 2 * HOUR } : null,
  );
}

test("a concluded run carries the pull request it opened onto the finished task", async () => {
  // The case the `empty` path never reaches and `retired` reaches often: a review-only
  // artifact whose diff still opened a pull request. `completableByMerge` excludes `done`,
  // so once this row is terminal the merge reconciler will never revisit it - this is the
  // ONLY chance to record the url, and without it the card points at nothing for ever.
  const f = runningMission({ completionPolicy: "auto-on-conclusion" });
  const url = "https://github.com/example/repo/pull/7001";
  openPr(f, url);

  await f.tasks.concludeScheduledMissionRun(f.sessionId, {
    outcome: "retired",
    summary: "a review-only artifact",
    gaps: [],
  });

  const task = f.registry.getTask(f.taskId);
  assert.equal(task?.status, "done");
  assert.equal(task?.outcomeUrl, url, "the concluded row must still name its pull request");
});

test("a mission's task still completes on a merged pull request, policy or not", async () => {
  // The guardrail adds a route to `done`; it must not take one away. A mission left on
  // `manual` is the strictest version of that question, because nothing else in this
  // feature can conclude it - only the pre-existing merge path can, and it still does.
  const f = runningMission({ completionPolicy: "manual" });
  const url = "https://github.com/example/repo/pull/7002";
  openPr(f, url);
  assert.equal(f.registry.getTask(f.taskId)?.status, "running");

  await pollMerged(f, url);

  const task = f.registry.getTask(f.taskId);
  assert.equal(task?.status, "done", "a merge still lands a mission's task");
  assert.equal(task?.outcomeUrl, url);
  // The merge path's own sentence, not the guardrail's - proof of WHICH route landed it.
  assert.equal(task?.outcome, `merged ${url}`);
  assert.doesNotMatch(task?.outcome ?? "", /Foreman concluded/);
});

test("a task the merge already landed is not re-concluded by a later verdict", async () => {
  // Ordering that really happens: the poller sees the merge while Foreman is still mid-tick,
  // so the verdict arrives against a row that is already terminal. The merge is a statement
  // about the work and an inference must never overwrite one - and the gate is structural
  // rather than a clause, because `executingTaskOn` only ever returns a running or
  // dispatching row.
  const f = runningMission({ completionPolicy: "auto-on-conclusion" });
  const url = "https://github.com/example/repo/pull/7003";
  openPr(f, url);
  await pollMerged(f, url);

  const landed = f.registry.getTask(f.taskId);
  assert.equal(landed?.status, "done");
  const outcomeFromMerge = landed?.outcome;

  await f.tasks.concludeScheduledMissionRun(f.sessionId, {
    outcome: "empty",
    summary: "the session changed nothing",
    gaps: [],
  });

  const after = f.registry.getTask(f.taskId);
  assert.equal(after?.status, "done");
  assert.equal(after?.outcome, outcomeFromMerge, "the merge's own outcome must survive");
  assert.equal(after?.outcomeUrl, url);
});

// ---- the recorded sentence ----

test("a long emoji summary is cut on characters, never through a surrogate pair", async () => {
  // The summary is model-authored prose and routinely carries emoji. A UTF-16 code-unit cut
  // can land between the halves of a surrogate pair, and the lone surrogate that leaves is
  // persisted once at completion and never revised - so it renders as a replacement glyph on
  // the board card, the rail row and the run history for ever.
  //
  // The filler is sized so a code-unit cut falls INSIDE an astral character rather than
  // between two, which is the only arrangement that reproduces the defect. The old code cut
  // at index MAX - 1, so the pair has to START at MAX - 2 for its high half to be kept and
  // its low half dropped. Verified against the previous implementation: it produced a
  // trailing "\ud83d". An off-by-one here makes this test pass on the bug.
  const f = runningMission({ completionPolicy: "auto-on-conclusion" });
  const MAX = 200;
  const prefix = "Foreman concluded this recurring mission run: ".length;
  const summary = "x".repeat(MAX - 2 - prefix) + "\u{1F680}".repeat(20);

  await f.tasks.concludeScheduledMissionRun(f.sessionId, {
    outcome: "retired",
    summary,
    gaps: [],
  });

  const outcome = f.registry.getTask(f.taskId)?.outcome ?? "";
  assert.ok(outcome.length > 0, "the run should have been concluded");
  // No unpaired surrogate survived the cut. `\p{Surrogate}` matches only code points that
  // remain unpaired after iteration, so this is the direct statement of the invariant.
  assert.doesNotMatch(outcome, /\p{Surrogate}/u, `lone surrogate in: ${JSON.stringify(outcome)}`);
  // And it really was truncated, so the assertion above is about the cut and not about a
  // string that happened to fit.
  assert.ok(outcome.endsWith("\u2026"), `expected an ellipsis, got: ${JSON.stringify(outcome)}`);
  assert.equal([...outcome].length, MAX, "bounded at 200 code points");
  // The character the cut landed on survives whole rather than as half of itself.
  assert.ok(outcome.endsWith("\u{1F680}\u2026"), JSON.stringify(outcome.slice(-4)));
});

test("a short summary is recorded whole, ellipsis and all left off", async () => {
  const f = runningMission({ completionPolicy: "auto-on-conclusion" });
  await f.tasks.concludeScheduledMissionRun(f.sessionId, {
    outcome: "empty",
    summary: "the session changed nothing \u{1F680}",
    gaps: [],
  });
  assert.equal(
    f.registry.getTask(f.taskId)?.outcome,
    "Foreman concluded this recurring mission run: the session changed nothing \u{1F680}",
  );
});
