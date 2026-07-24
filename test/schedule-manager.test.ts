import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MissionSchedule } from "../src/shared/schedules.ts";
import type { Task, TaskStatus } from "../src/shared/types.ts";

// What is at stake: this is the engine that spends money. Every defect it can have costs
// something real and shows up as nothing on screen - a catch-up that files fifty agent
// tasks instead of one, a crash window that drops a run on the floor, a Run now that
// wedges the cron cursor, a recovered claim that rewrites a stranger's task as a
// recurring mission.
//
// It runs against a REAL database and a real TaskManager on purpose. The exactly-once
// guarantee is a UNIQUE index and a transaction, and a test with a fake store would be
// asserting that the manager calls the functions it calls - which is true of a manager
// that gets the claim wrong too. What IS injected is only what cannot be driven
// otherwise: the clock (a fortnight of standby), uuid allocation (so a preallocated id
// can be pointed at deliberately), and the repository resolver (so a repo can vanish
// between saving a schedule and firing it).

const home = mkdtempSync(join(tmpdir(), "mission-schedule-manager-"));
process.env.MISSION_HOME = home;

const db = await import("../src/server/db.ts");
const store = await import("../src/server/schedules/store.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { ScheduleManager } = await import("../src/server/schedules/manager.ts");
const { recurrence } = await import("../src/server/schedules/recurrence.ts");
const { SCHEDULE_CATCHUP_CREATE_CAP } = await import("../src/shared/schedules.ts");
type CreateScheduleInput = import("../src/server/schedules/manager.ts").CreateScheduleInput;
type ScheduleManagerDeps = import("../src/server/schedules/manager.ts").ScheduleManagerDeps;

after(() => rmSync(home, { recursive: true, force: true }));

db.openDb();

const registry = new Registry();
const tasks = new TaskManager(registry);

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** 08:00, an hour before the daily 09:00 cadence every fixture below uses. */
const T0 = Date.parse("2026-07-23T08:00:00Z");
const NINE = Date.parse("2026-07-23T09:00:00Z");

const REPO = "/repos/main";
/** Repositories the injected resolver will accept. A test can take one away. */
const repos = new Set([REPO]);

interface Harness {
  manager: InstanceType<typeof ScheduleManager>;
  clock: { now: number };
  /** Every schedule the notifier was told about, in order. */
  notified: MissionSchedule[];
  /** Every schedule the notifier was told to remove from the live catalog. */
  removed: string[];
}

/**
 * A manager with a clock a test can move and ids a test can predict.
 *
 * `label` prefixes every allocated id, which keeps the schedules, occurrences and tasks
 * of one test apart from another's in the single shared database - and makes an assertion
 * about a preallocated id readable.
 */
function harness(
  label: string,
  deps: Partial<
    Pick<ScheduleManagerDeps, "resolveRepoRoot" | "recurrence" | "log">
  > = {},
): Harness {
  // Retire everything an earlier test left running. `tick` sweeps the WHOLE catalog by
  // design - that is the behaviour under test - so one live schedule per test is what
  // keeps a summary's counters attributable to the schedule the test is about.
  for (const existing of store.listSchedules()) store.archiveSchedule(existing.id, T0 - 1);
  const clock = { now: T0 };
  const notified: MissionSchedule[] = [];
  const removed: string[] = [];
  let n = 0;
  const manager = new ScheduleManager({
    tasks,
    now: () => clock.now,
    uuid: () => `${label}-${++n}`,
    resolveRepoRoot:
      deps.resolveRepoRoot ??
      (async (path: string) =>
        repos.has(path)
          ? { ok: true as const, repoRoot: path }
          : { ok: false as const, error: `not a git repository: ${path}` }),
    recurrence: deps.recurrence,
    notifier: {
      upsert: (schedule) => notified.push(schedule),
      remove: (id) => removed.push(id),
    },
    log: deps.log ?? (() => {}),
  });
  return { manager, clock, notified, removed };
}

function definition(over: Partial<CreateScheduleInput> = {}): CreateScheduleInput {
  return {
    name: "Nightly sweep",
    expression: "0 9 * * *",
    timezone: "UTC",
    overlapPolicy: "skip-active",
    missedPolicy: "coalesce-latest",
    template: {
      title: "Sweep the inbox",
      intent: "Read the inbox and file whatever needs filing.",
      repoRoot: REPO,
      kind: "ship",
      agent: "claude",
      priority: null,
      labels: [],
      model: null,
      effort: null,
    },
    ...over,
  };
}

/** Narrow a result union, with the refusal in the failure message when it is not ok. */
function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  assert.ok(result.ok, `expected ok, got ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
}

function occurrencesFor(scheduleId: string) {
  return store.historyPage(scheduleId, { before: null, limit: 100 })?.occurrences ?? [];
}

function allOccurrencesFor(scheduleId: string) {
  const occurrences: ReturnType<typeof occurrencesFor> = [];
  let before: number | null = null;
  do {
    const page = store.historyPage(scheduleId, { before, limit: 100 });
    if (!page) return [];
    occurrences.push(...page.occurrences);
    before = page.nextCursor;
  } while (before !== null);
  return occurrences;
}

function tasksFor(scheduleId: string): Task[] {
  return db.listTasks().filter((t) => t.scheduleId === scheduleId);
}

// ---- the ordinary path ----

test("one due instant files exactly one backlog task, with full provenance", async () => {
  const h = harness("basic");
  const created = ok(await h.manager.create(definition())).schedule;
  assert.equal(created.nextRunAt, NINE, "an enabled schedule holds a cursor from the start");

  h.clock.now = NINE + 5_000;
  const summary = await h.manager.tick();

  assert.equal(summary.created, 1);
  assert.equal(summary.due, 1);

  const filed = tasksFor(created.id);
  assert.equal(filed.length, 1);
  const task = filed[0]!;
  // A schedule files work and stops. Anything else here means a recurring mission can
  // launch an agent with none of Foreman's gates having been consulted.
  assert.equal(task.status, "backlog");
  assert.equal(task.worktreePath, null);
  assert.equal(task.homeName, null);
  assert.equal(task.sessionId, null);
  // The title comes off the template verbatim, which is what keeps the model titler out
  // of the path - it would otherwise run on every single occurrence.
  assert.equal(task.title, "Sweep the inbox");
  assert.equal(task.scheduleId, created.id);
  assert.equal(task.scheduledFor, NINE, "the instant it was FOR, not when it was filed");
  assert.equal(task.enabled, true);
  assert.deepEqual(task.dependencies, []);

  const [occurrence] = occurrencesFor(created.id);
  assert.equal(occurrence?.status, "created");
  assert.equal(occurrence?.taskId, task.id);
  assert.equal(occurrence?.triggerKind, "scheduled");
  assert.equal(occurrence?.scheduledFor, NINE);
  assert.equal(occurrence?.delayMs, 5_000, "how late the machine was, in the ledger");
  assert.equal(task.scheduleOccurrenceId, occurrence?.id);

  // The cursor moved with the claim, in the same transaction.
  assert.equal(store.getSchedule(created.id)?.nextRunAt, NINE + DAY);
});

test("running the same tick again files nothing more", async () => {
  const h = harness("idem");
  const created = ok(await h.manager.create(definition())).schedule;

  h.clock.now = NINE + 5_000;
  await h.manager.tick();
  const second = await h.manager.tick();

  assert.equal(second.due, 0, "the cursor moved, so nothing is due any more");
  assert.equal(tasksFor(created.id).length, 1);
  assert.equal(occurrencesFor(created.id).length, 1);
});

test("creating anchors the first run after asynchronous repository validation", async () => {
  let h!: Harness;
  h = harness("create-anchor", {
    resolveRepoRoot: async (path) => {
      // Validation began before today's run, but the schedule does not exist durably
      // until after it. The crossed instant must not become catch-up debt.
      h.clock.now = NINE + 30 * 60_000;
      return { ok: true, repoRoot: path };
    },
  });

  const created = ok(await h.manager.create(definition())).schedule;

  assert.equal(created.createdAt, h.clock.now);
  assert.equal(created.nextRunAt, NINE + DAY);
  assert.equal((await h.manager.tick()).due, 0);
});

test("an instant already in the ledger cannot file a second task", async () => {
  const h = harness("replay");
  const created = ok(await h.manager.create(definition())).schedule;
  h.clock.now = NINE + 5_000;
  await h.manager.tick();

  // Drag the cursor back onto the instant that has already run - the shape a restored
  // backup, or a lost cursor update, would leave behind. The unique key is what has to
  // hold here, not the cursor.
  assert.ok(store.repairScheduleCursor(created.id, NINE + DAY, NINE, h.clock.now));
  const replay = await h.manager.tick();

  assert.equal(replay.created, 0);
  assert.equal(replay.lost, 1, "the claim was refused by the row that already exists");
  assert.equal(tasksFor(created.id).length, 1);
  assert.equal(occurrencesFor(created.id).length, 1);
  assert.equal(store.getSchedule(created.id)?.nextRunAt, NINE + DAY, "and the cursor recovered");
});

// ---- missed-run policy over a real catch-up ----

test("coalesce-latest catches a five-day standby up with one task", async () => {
  const h = harness("coalesce");
  const created = ok(await h.manager.create(definition())).schedule;

  // The laptop was shut. On resume the overdue timer fires with the current wall clock,
  // which is the whole of V1's standby handling.
  h.clock.now = NINE + 5 * DAY + 90_000;
  const summary = await h.manager.tick();

  assert.equal(summary.created, 1);
  assert.equal(summary.coalesced, 5);
  assert.equal(tasksFor(created.id).length, 1);

  const history = occurrencesFor(created.id);
  assert.equal(history.length, 6);
  const createdRow = history.find((o) => o.status === "created")!;
  assert.equal(createdRow.scheduledFor, NINE + 5 * DAY, "the newest instant is the one that runs");
  // Every coalesced row names the run that stood in for it, so history explains the
  // whole window rather than starting where the work did.
  for (const row of history.filter((o) => o.status === "coalesced")) {
    assert.equal(row.coveredById, createdRow.id);
    assert.equal(row.taskId, null);
  }
});

test("coalesce-latest judges a catch-up larger than one recurrence page only once", async () => {
  const h = harness("coalesce-paged");
  const created = ok(
    await h.manager.create(
      definition({ expression: "0 * * * *", missedPolicy: "coalesce-latest" }),
    ),
  ).schedule;

  const firstHour = created.nextRunAt!;
  h.clock.now = firstHour + 599 * HOUR;
  const summary = await h.manager.tick();

  assert.equal(summary.due, 600);
  assert.equal(summary.created, 1);
  assert.equal(summary.coalesced, 599);
  assert.equal(tasksFor(created.id)[0]?.scheduledFor, firstHour + 599 * HOUR);
  assert.equal(allOccurrencesFor(created.id).length, 600);
});

test("a crash between coalesced rows leaves recoverable durable coverage", async () => {
  let armed = false;
  const coverAt = NINE + 2 * DAY;
  const h = harness("coverage-crash", {
    recurrence: {
      validate: (...args) => recurrence.validate(...args),
      nextAfter: (...args) => {
        if (armed && args[2] === NINE + DAY) {
          armed = false;
          throw new Error("simulated process crash");
        }
        return recurrence.nextAfter(...args);
      },
      between: (...args) => recurrence.between(...args),
      preview: (...args) => recurrence.preview(...args),
    },
  });
  const created = ok(await h.manager.create(definition())).schedule;
  armed = true;
  h.clock.now = coverAt + 5_000;

  const summary = await h.manager.tick();

  assert.equal(summary.coalesced, 1);
  assert.equal(summary.failed, 1);
  const history = allOccurrencesFor(created.id);
  assert.equal(history.length, 2);
  const coalesced = history.find((row) => row.status === "coalesced")!;
  const covering = store.getOccurrence(coalesced.coveredById!);
  assert.equal(covering?.scheduledFor, coverAt);
  assert.equal(covering?.status, "claimed");

  const recovery = await h.manager.recover(h.clock.now, "open");
  assert.equal(recovery.recoveredBeforeTask, 1);
  assert.equal(store.getOccurrence(covering!.id)?.status, "created");
  assert.equal(
    store.getOccurrence(coalesced.id)?.coveredById,
    covering!.id,
    "recovery closes the cover without having to reconstruct its dependents",
  );
});

test("skip records every crossed instant and files nothing", async () => {
  const h = harness("skip");
  const created = ok(await h.manager.create(definition({ missedPolicy: "skip" }))).schedule;

  h.clock.now = NINE + 3 * DAY;
  const summary = await h.manager.tick();

  assert.equal(summary.created, 0);
  assert.equal(summary.skippedPolicy, 4);
  assert.equal(tasksFor(created.id).length, 0);
  // Skipped, not forgotten: the schedule is due again tomorrow rather than stuck.
  assert.equal(store.getSchedule(created.id)?.nextRunAt, NINE + 4 * DAY);
});

test("create-all keeps one newest-task cap across recurrence pages", async () => {
  const h = harness("createall");
  const created = ok(
    await h.manager.create(
      definition({
        expression: "0 * * * *",
        missedPolicy: "create-all",
        // Overlap is a separate axis; with `skip-active` the first run would block the
        // rest and this would be measuring the wrong policy.
        overlapPolicy: "allow",
      }),
    ),
  ).schedule;

  const firstHour = created.nextRunAt!;
  h.clock.now = firstHour + 599 * HOUR;
  const summary = await h.manager.tick();

  assert.equal(summary.due, 600);
  assert.equal(summary.created, SCHEDULE_CATCHUP_CREATE_CAP);
  assert.equal(summary.coalesced, 550);
  assert.equal(summary.capped, 1);
  const filed = tasksFor(created.id);
  assert.equal(filed.length, SCHEDULE_CATCHUP_CREATE_CAP);
  assert.equal(
    Math.min(...filed.map((task) => task.scheduledFor!)),
    firstHour + 550 * HOUR,
    "the oldest run that survived the cap is still newer than every coalesced instant",
  );
  assert.equal(
    Math.max(...filed.map((task) => task.scheduledFor!)),
    firstHour + 599 * HOUR,
  );
  assert.equal(allOccurrencesFor(created.id).length, 600, "all instants reached the ledger");
});

test("create-all keeps its one cap beyond the old accounting ceiling", async () => {
  const h = harness("createall-long");
  const created = ok(
    await h.manager.create(
      definition({
        expression: "0 * * * *",
        missedPolicy: "create-all",
        overlapPolicy: "allow",
      }),
    ),
  ).schedule;

  const dueCount = 10_001;
  const firstHour = created.nextRunAt!;
  h.clock.now = firstHour + (dueCount - 1) * HOUR;
  const summary = await h.manager.tick();

  assert.equal(summary.due, dueCount);
  assert.equal(summary.created, SCHEDULE_CATCHUP_CREATE_CAP);
  assert.equal(summary.coalesced, dueCount - SCHEDULE_CATCHUP_CREATE_CAP);
  const filed = tasksFor(created.id);
  assert.equal(filed.length, SCHEDULE_CATCHUP_CREATE_CAP);
  assert.equal(
    Math.min(...filed.map((task) => task.scheduledFor!)),
    h.clock.now - (SCHEDULE_CATCHUP_CREATE_CAP - 1) * HOUR,
  );
  assert.equal(allOccurrencesFor(created.id).length, dueCount);
});

test("coalesce-latest still chooses one true latest run beyond that ceiling", async () => {
  const h = harness("coalesce-long");
  const created = ok(
    await h.manager.create(
      definition({
        expression: "0 * * * *",
        missedPolicy: "coalesce-latest",
      }),
    ),
  ).schedule;

  const dueCount = 10_001;
  const firstHour = created.nextRunAt!;
  h.clock.now = firstHour + (dueCount - 1) * HOUR;
  const summary = await h.manager.tick();

  assert.equal(summary.due, dueCount);
  assert.equal(summary.created, 1);
  assert.equal(summary.coalesced, dueCount - 1);
  assert.equal(tasksFor(created.id)[0]?.scheduledFor, h.clock.now);
  assert.equal(allOccurrencesFor(created.id).length, dueCount);
});

// ---- overlap policy ----

test("skip-active refuses while this schedule's own task is still in flight", async () => {
  const h = harness("overlap");
  const created = ok(await h.manager.create(definition())).schedule;

  h.clock.now = NINE + 5_000;
  await h.manager.tick();
  const first = tasksFor(created.id)[0]!;

  h.clock.now = NINE + DAY + 5_000;
  const blocked = await h.manager.tick();

  assert.equal(blocked.created, 0);
  assert.equal(blocked.skippedOverlap, 1);
  assert.equal(tasksFor(created.id).length, 1, "still just yesterday's task");
  const latest = occurrencesFor(created.id)[0]!;
  assert.equal(latest.status, "skipped_overlap");
  assert.equal(latest.blockingTaskId, first.id, "and history names what was in the way");

  // Finish it, and tomorrow runs normally.
  registry.upsertTask({ ...first, status: "done", completedAt: h.clock.now });
  h.clock.now = NINE + 2 * DAY + 5_000;
  assert.equal((await h.manager.tick()).created, 1);
});

test("exactly the in-flight statuses block a run; the terminal ones let it through", async () => {
  const cases: Record<TaskStatus, boolean> = {
    backlog: true,
    dispatching: true,
    running: true,
    done: false,
    cancelled: false,
    // A mission whose last run failed still runs tomorrow - the alternative parks it for
    // good on one bad night, which is the opposite of what a recurring mission is for.
    failed: false,
  };

  for (const [status, blocks] of Object.entries(cases) as [TaskStatus, boolean][]) {
    const h = harness(`status-${status}`);
    const created = ok(await h.manager.create(definition())).schedule;
    h.clock.now = NINE + 5_000;
    await h.manager.tick();
    const first = tasksFor(created.id)[0]!;
    registry.upsertTask({ ...first, status });

    h.clock.now = NINE + DAY + 5_000;
    const summary = await h.manager.tick();
    assert.equal(summary.created, blocks ? 0 : 1, `${status} should ${blocks ? "" : "not "}block`);
    assert.equal(summary.skippedOverlap, blocks ? 1 : 0, status);
  }
});

test("a task filed earlier in the SAME tick blocks the instants after it", async () => {
  const h = harness("selfblock");
  const created = ok(
    await h.manager.create(
      definition({ expression: "0 * * * *", missedPolicy: "create-all", overlapPolicy: "skip-active" }),
    ),
  ).schedule;

  h.clock.now = created.nextRunAt! + 3 * HOUR;
  const summary = await h.manager.tick();

  // Four instants due, one task. Without the in-tick check every one of them would file,
  // which is the pile-up `skip-active` exists to prevent.
  assert.equal(summary.due, 4);
  assert.equal(summary.created, 1);
  assert.equal(summary.skippedOverlap, 3);
  assert.equal(tasksFor(created.id).length, 1);
});

// ---- the repository, revalidated at fire time ----

test("a repository that vanished after saving fails the run rather than filing a doomed task", async () => {
  const h = harness("norepo");
  repos.add("/repos/temporary");
  const created = ok(
    await h.manager.create(
      definition({ template: { ...definition().template, repoRoot: "/repos/temporary" } }),
    ),
  ).schedule;
  repos.delete("/repos/temporary");

  h.clock.now = NINE + 5_000;
  const summary = await h.manager.tick();

  assert.equal(summary.created, 0);
  assert.equal(summary.failed, 1);
  assert.equal(tasksFor(created.id).length, 0, "no task, rather than one nothing can dispatch");
  const [occurrence] = occurrencesFor(created.id);
  assert.equal(occurrence?.status, "failed");
  assert.match(occurrence?.error ?? "", /not a git repository/);
  // A failure does not wedge the schedule; tomorrow still comes.
  assert.equal(store.getSchedule(created.id)?.nextRunAt, NINE + DAY);
});

test("a repository that is not a repo is refused at save time, on its own field", async () => {
  const h = harness("saverepo");
  const result = await h.manager.create(
    definition({ template: { ...definition().template, repoRoot: "/nowhere" } }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.field, "repoRoot");
  assert.equal(h.notified.length, 0, "and nothing was announced");
});

// ---- crash recovery ----

/** Reserve an instant and stop, exactly as a process dying mid-tick would leave it. */
function crashMidTick(
  scheduleId: string,
  at: number,
  over: Partial<Parameters<typeof store.claimOccurrence>[0]> = {},
) {
  const schedule = store.getSchedule(scheduleId)!;
  const result = store.claimOccurrence({
    occurrenceId: `${scheduleId}-crash-occ`,
    scheduleId,
    scheduleRevision: schedule.revision,
    scheduledFor: at,
    triggerKind: "scheduled",
    decisionKind: "create_task",
    taskId: `${scheduleId}-crash-task`,
    coveredById: null,
    blockingTaskId: null,
    claimedAt: at,
    delayMs: 0,
    advanceCursor: true,
    nextRunAt: at + DAY,
    ...over,
  });
  assert.equal(result.outcome, "claimed");
  return result.outcome === "claimed" ? result.occurrence : null!;
}

test("a crash between the claim and the task creates it on the reserved id", async () => {
  const h = harness("crash-before");
  const created = ok(await h.manager.create(definition())).schedule;
  const occurrence = crashMidTick(created.id, NINE);

  h.clock.now = NINE + 60_000;
  const summary = await h.manager.recover(h.clock.now, "open");

  assert.equal(summary.recoveredBeforeTask, 1);
  const filed = tasksFor(created.id);
  assert.equal(filed.length, 1);
  // The SAME id the claim reserved - which is why a second recovery pass cannot double it.
  assert.equal(filed[0]?.id, `${created.id}-crash-task`);
  assert.equal(filed[0]?.scheduleOccurrenceId, occurrence.id);
  assert.equal(store.getOccurrence(occurrence.id)?.status, "created");
  assert.equal(h.notified.length, 2);

  // Idempotent: run recovery again and nothing changes.
  const again = await h.manager.recover(h.clock.now, "open");
  assert.equal(again.claims, 0);
  assert.equal(tasksFor(created.id).length, 1);
});

test("a crash after the task was persisted only closes the ledger row", async () => {
  const h = harness("crash-after");
  const created = ok(await h.manager.create(definition())).schedule;
  const occurrence = crashMidTick(created.id, NINE);

  // The task made it to disk; the finishing write did not.
  const task = tasks.create(
    {
      repoRoot: REPO,
      intent: "Read the inbox and file whatever needs filing.",
      title: "Sweep the inbox",
      kind: "ship",
      agent: "claude",
      backlog: true,
    },
    {
      id: `${created.id}-crash-task`,
      schedule: {
        scheduleId: created.id,
        scheduleOccurrenceId: occurrence.id,
        scheduledFor: NINE,
      },
    },
  );

  h.clock.now = NINE + 60_000;
  const summary = await h.manager.recover(h.clock.now, "open");

  assert.equal(summary.recoveredAfterTask, 1);
  assert.equal(summary.recoveredBeforeTask, 0);
  assert.equal(tasksFor(created.id).length, 1, "not a second task");
  assert.equal(db.getTask(task.id)?.updatedAt, task.updatedAt, "and the first was not rewritten");
  assert.equal(store.getOccurrence(occurrence.id)?.status, "created");
  assert.equal(h.notified.length, 2);
});

test("recovery finds a matching durable task outside the Registry cache", async () => {
  const h = harness("durable-recovery");
  const created = ok(await h.manager.create(definition())).schedule;
  const occurrence = crashMidTick(created.id, NINE);
  const seed = tasks.create({
    repoRoot: REPO,
    intent: "Unrelated seed task",
    title: "Seed",
    kind: "ship",
    agent: "claude",
    backlog: true,
  });
  db.upsertTask({
    ...seed,
    id: occurrence.taskId!,
    scheduleId: created.id,
    scheduleOccurrenceId: occurrence.id,
    scheduledFor: occurrence.scheduledFor,
  });
  assert.equal(registry.getTask(occurrence.taskId!), undefined);

  h.clock.now = NINE + 30_000;
  await h.manager.archive(created.id);
  h.clock.now = NINE + 60_000;
  const summary = await h.manager.recover(h.clock.now, "open");

  assert.equal(summary.recoveredAfterTask, 1);
  assert.equal(summary.cancelled, 0);
  assert.equal(store.getOccurrence(occurrence.id)?.status, "created");
  assert.deepEqual(h.removed, [created.id, created.id]);
});

test("recovery refuses a reserved id that belongs to somebody else's task", async () => {
  const h = harness("collision");
  const created = ok(await h.manager.create(definition())).schedule;

  // An ordinary task nobody scheduled, whose id the reservation names.
  const stranger = tasks.create({
    repoRoot: REPO,
    intent: "Something a human filed",
    title: "Human work",
    kind: "ship",
    agent: "claude",
    backlog: true,
  });
  const occurrence = crashMidTick(created.id, NINE, { taskId: stranger.id });

  h.clock.now = NINE + 60_000;
  const summary = await h.manager.recover(h.clock.now, "open");

  assert.equal(summary.failed, 1);
  assert.equal(store.getOccurrence(occurrence.id)?.status, "failed");
  // The stranger's task is untouched - not re-provenanced, not renamed, not adopted.
  const after = db.getTask(stranger.id)!;
  assert.equal(after.scheduleId, null);
  assert.equal(after.title, "Human work");
  assert.equal(after.updatedAt, stranger.updatedAt);
  assert.equal(h.notified.length, 2);
});

test("recovery finishes a run under the revision it was CLAIMED under, not today's", async () => {
  const h = harness("revision");
  const created = ok(await h.manager.create(definition())).schedule;
  const occurrence = crashMidTick(created.id, NINE);

  // Overnight the operator rewrote the mission.
  h.clock.now = NINE + 30_000;
  const edited = ok(
    await h.manager.update(created.id, {
      ...definition(),
      name: "Rewritten",
      template: { ...definition().template, title: "Completely different work" },
    }),
  ).schedule;
  assert.equal(edited.revision, 2);

  h.clock.now = NINE + 60_000;
  await h.manager.recover(h.clock.now, "open");

  const filed = tasksFor(created.id);
  assert.equal(filed.length, 1);
  // Last night's run was for last night's mission. Recomputing from the current revision
  // would silently rewrite history to match the edit.
  assert.equal(filed[0]?.title, "Sweep the inbox");
  assert.equal(store.getOccurrence(occurrence.id)?.scheduleRevision, 1);
});

test("archiving before the task exists cancels the run and leaves the history standing", async () => {
  const h = harness("archived");
  const created = ok(await h.manager.create(definition())).schedule;
  const occurrence = crashMidTick(created.id, NINE);

  h.clock.now = NINE + 30_000;
  await h.manager.archive(created.id);

  h.clock.now = NINE + 60_000;
  const summary = await h.manager.recover(h.clock.now, "open");

  assert.equal(summary.cancelled, 1);
  assert.equal(tasksFor(created.id).length, 0, "work nobody wants any more is not filed");
  // `cancelled`, not `failed` - nothing went wrong, the mission was retired.
  assert.equal(store.getOccurrence(occurrence.id)?.status, "cancelled");
  // Archive deletes nothing: the run is still readable by id.
  assert.equal(occurrencesFor(created.id).length, 1);
  assert.equal(store.getSchedule(created.id)?.archivedAt, NINE + 30_000);
  assert.deepEqual(h.removed, [created.id, created.id]);

  // And an archived schedule never comes due again.
  h.clock.now = NINE + 2 * DAY;
  assert.equal((await h.manager.tick()).due, 0);
});

test("a terminal decision left claimed by a crash is closed as itself", async () => {
  const h = harness("terminal-claim");
  const created = ok(await h.manager.create(definition())).schedule;
  const first = crashMidTick(created.id, NINE, {
    decisionKind: "skipped_policy",
    taskId: null,
  });
  const second = crashMidTick(created.id, NINE + DAY, {
    occurrenceId: `${created.id}-second-terminal`,
    decisionKind: "skipped_policy",
    taskId: null,
  });

  h.clock.now = NINE + DAY + 60_000;
  const summary = await h.manager.recover(h.clock.now, "open");

  assert.equal(summary.finishedTerminal, 2);
  assert.equal(store.getOccurrence(first.id)?.status, "skipped_policy");
  assert.equal(store.getOccurrence(second.id)?.status, "skipped_policy");
  assert.equal(tasksFor(created.id).length, 0);
  assert.equal(h.notified.length, 2);
});

test("recovery counts an archive during repository validation as cancelled", async () => {
  let blockFire = false;
  let releaseFire!: () => void;
  let fireStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    fireStarted = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releaseFire = resolve;
  });
  const h = harness("recovery-archive-race", {
    resolveRepoRoot: async (path) => {
      if (blockFire) {
        fireStarted();
        await held;
      }
      return { ok: true, repoRoot: path };
    },
  });
  const created = ok(await h.manager.create(definition())).schedule;
  const occurrence = crashMidTick(created.id, NINE);

  blockFire = true;
  h.clock.now = NINE + 60_000;
  const recovery = h.manager.recover(h.clock.now, "open");
  await started;
  await h.manager.archive(created.id);
  releaseFire();
  const summary = await recovery;

  assert.equal(summary.cancelled, 1);
  assert.equal(summary.failed, 0);
  assert.equal(store.getOccurrence(occurrence.id)?.status, "cancelled");
  assert.deepEqual(h.removed, [created.id, created.id]);
});

test("recovery skips a snapshotted claim settled while its schedule lock is busy", async () => {
  let blockFire = false;
  let releaseFire!: () => void;
  let fireStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    fireStarted = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releaseFire = resolve;
  });
  const h = harness("recovery-fresh-read", {
    resolveRepoRoot: async (path) => {
      if (blockFire) {
        fireStarted();
        await held;
      }
      return { ok: true, repoRoot: path };
    },
  });
  const created = ok(await h.manager.create(definition())).schedule;
  const occurrence = crashMidTick(created.id, NINE);

  blockFire = true;
  h.clock.now = NINE + 10 * 60_000;
  const manual = h.manager.runNow(created.id);
  await started;
  const recovery = h.manager.recover(h.clock.now, "stale");
  store.finishOccurrence({
    id: occurrence.id,
    status: "failed",
    finishedAt: h.clock.now,
    error: "settled by the live pass",
  });
  releaseFire();

  ok(await manual);
  const summary = await recovery;
  assert.equal(summary.claims, 1);
  assert.equal(summary.alreadySettled, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.recoveredBeforeTask, 0);
  assert.equal(store.getOccurrence(occurrence.id)?.status, "failed");
  assert.equal(db.getTask(occurrence.taskId!), undefined);
  assert.equal(tasksFor(created.id).length, 1);
});

// ---- Run now ----

test("Run now works while paused, is labelled manual, and never touches the cron cursor", async () => {
  const h = harness("runnow");
  const created = ok(await h.manager.create(definition())).schedule;
  const paused = ok(await h.manager.setEnabled(created.id, false)).schedule;
  assert.equal(paused.nextRunAt, null, "a paused schedule holds no cursor at all");

  h.clock.now = NINE + 3 * DAY;
  const result = ok(await h.manager.runNow(created.id));

  assert.equal(result.occurrence.status, "created");
  assert.equal(result.occurrence.triggerKind, "manual");
  assert.equal(tasksFor(created.id).length, 1);
  assert.equal(tasksFor(created.id)[0]?.status, "backlog");
  // Still paused, still no cursor: a manual run is not a resume.
  assert.equal(result.schedule.enabled, false);
  assert.equal(result.schedule.nextRunAt, null);
});

test("Run now leaves an ENABLED schedule's cursor exactly where it was", async () => {
  const h = harness("runnow-live");
  const created = ok(await h.manager.create(definition())).schedule;
  const before = store.getSchedule(created.id)?.nextRunAt;

  h.clock.now = T0 + 60_000;
  ok(await h.manager.runNow(created.id));

  assert.equal(store.getSchedule(created.id)?.nextRunAt, before);
});

test("repeated Run now clicks in the same millisecond each get their own run", async () => {
  const h = harness("runnow-twice");
  const created = ok(await h.manager.create(definition({ overlapPolicy: "allow" }))).schedule;
  h.clock.now = T0 + 59_999;

  const first = ok(await h.manager.runNow(created.id)).occurrence;
  const second = ok(await h.manager.runNow(created.id)).occurrence;

  assert.notEqual(first.id, second.id);
  assert.notEqual(first.scheduledFor, second.scheduledFor);
  // Off the minute grid, so a manual instant can never occupy a key the cursor wants.
  assert.notEqual(first.scheduledFor % 60_000, 0);
  assert.notEqual(second.scheduledFor % 60_000, 0);
  assert.equal(tasksFor(created.id).length, 2);
});

test("scheduled and manual triggers serialize their skip-active decision", async () => {
  let blockFire = false;
  let releaseFire!: () => void;
  let fireStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    fireStarted = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releaseFire = resolve;
  });
  const h = harness("serialized", {
    resolveRepoRoot: async (path) => {
      if (blockFire) {
        fireStarted();
        await held;
      }
      return { ok: true, repoRoot: path };
    },
  });
  const created = ok(await h.manager.create(definition())).schedule;

  blockFire = true;
  h.clock.now = NINE + 5_000;
  const tick = h.manager.tick();
  await started;
  const manual = h.manager.runNow(created.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tasksFor(created.id).length, 0, "the scheduled task is still awaiting its repo");

  releaseFire();
  assert.equal((await tick).created, 1);
  const manualResult = ok(await manual);
  assert.equal(manualResult.occurrence.status, "skipped_overlap");
  assert.equal(tasksFor(created.id).length, 1);
});

test("Run now honours overlap policy and says which task blocked it", async () => {
  const h = harness("runnow-overlap");
  const created = ok(await h.manager.create(definition())).schedule;
  const first = ok(await h.manager.runNow(created.id)).occurrence;

  h.clock.now = T0 + 60_000;
  const blocked = ok(await h.manager.runNow(created.id)).occurrence;

  assert.equal(blocked.status, "skipped_overlap");
  assert.equal(blocked.blockingTaskId, first.taskId);
  assert.equal(tasksFor(created.id).length, 1);
});

test("Run now refuses an archived schedule", async () => {
  const h = harness("runnow-archived");
  const created = ok(await h.manager.create(definition())).schedule;
  await h.manager.archive(created.id);
  const result = await h.manager.runNow(created.id);
  assert.equal(result.ok, false);
});

test("archiving while a claimed run validates its repo cancels task creation", async () => {
  let blockFire = false;
  let releaseFire!: () => void;
  let fireStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    fireStarted = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releaseFire = resolve;
  });
  const h = harness("archive-race", {
    resolveRepoRoot: async (path) => {
      if (blockFire) {
        fireStarted();
        await held;
      }
      return { ok: true, repoRoot: path };
    },
  });
  const created = ok(await h.manager.create(definition())).schedule;

  blockFire = true;
  const running = h.manager.runNow(created.id);
  await started;
  await h.manager.archive(created.id);
  releaseFire();

  const result = ok(await running);
  assert.equal(result.occurrence.status, "cancelled");
  assert.equal(tasksFor(created.id).length, 0);
  assert.equal(h.removed.at(-1), created.id, "the in-flight completion cannot re-add the archive");
});

// ---- pause, resume, and the clock ----

test("pausing accrues no debt - a resumed schedule starts from the resume instant", async () => {
  const h = harness("pause");
  const created = ok(await h.manager.create(definition())).schedule;
  ok(await h.manager.setEnabled(created.id, false));

  // A fortnight parked.
  h.clock.now = NINE + 14 * DAY + HOUR;
  const resumed = ok(await h.manager.setEnabled(created.id, true)).schedule;

  // The next 09:00 after the resume, not the fourteen that went by.
  assert.equal(resumed.nextRunAt, NINE + 15 * DAY);
  const summary = await h.manager.tick();
  assert.equal(summary.due, 0, "no hidden backlog of paused instants");
  assert.equal(tasksFor(created.id).length, 0);
});

test("a clock jumped backwards cannot re-run work the ledger has settled", async () => {
  const h = harness("backwards");
  const created = ok(await h.manager.create(definition())).schedule;
  h.clock.now = NINE + 5_000;
  await h.manager.tick();

  // NTP correction, a VM restored from a snapshot, somebody's hand on the system clock.
  h.clock.now = NINE - 2 * DAY;
  const summary = await h.manager.tick();

  assert.equal(summary.due, 0);
  assert.equal(tasksFor(created.id).length, 1);
  assert.equal(store.getSchedule(created.id)?.nextRunAt, NINE + DAY, "cursor unmoved");
});

test("a due cursor that enumerates nothing is repaired instead of wedging for ever", async () => {
  const h = harness("stuck");
  const created = ok(await h.manager.create(definition())).schedule;

  // A cursor no expression on this build produces - a row written by a build whose
  // cadence evaluation differed. There is no instant to claim, so no claim can move it.
  const bogus = NINE + 17_000;
  assert.ok(store.repairScheduleCursor(created.id, NINE, bogus, T0));

  h.clock.now = bogus + 1_000;
  await h.manager.tick();

  const after = store.getSchedule(created.id)!;
  assert.notEqual(after.nextRunAt, bogus, "the schedule is not stuck permanently due");
  assert.equal(after.nextRunAt, NINE + DAY);
});

// ---- validation, preview, notification ----

test("a cadence under the minimum interval is refused on the expression field", async () => {
  const h = harness("cadence");
  const result = await h.manager.create(definition({ expression: "*/5 * * * *" }));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.field, "expression");
  assert.equal(h.notified.length, 0);
});

test("a nameless or untitled mission is refused, each on its own field", async () => {
  const h = harness("blank");
  const nameless = await h.manager.create(definition({ name: "   " }));
  assert.equal(nameless.ok === false && nameless.error.field, "name");

  const untitled = await h.manager.create(
    definition({ template: { ...definition().template, title: "  " } }),
  );
  // Not cosmetic: a blank title is what puts the model titler on the path of every run.
  assert.equal(untitled.ok === false && untitled.error.field, "title");
});

test("V1 pins execution to this machine whatever the caller had in mind", async () => {
  const h = harness("v1");
  const created = ok(await h.manager.create(definition())).schedule;
  assert.equal(created.executionMode, "local-catchup");
  assert.equal(created.runnerId, null);
});

test("the notifier is told only about writes that landed, and only after they did", async () => {
  const h = harness("notify");
  const created = ok(await h.manager.create(definition())).schedule;

  assert.equal(h.notified.length, 1);
  // What it was handed is what is on disk - not an object assembled before the write.
  assert.deepEqual(h.notified[0], store.getSchedule(created.id, h.clock.now));

  const refused = await h.manager.update(created.id, { ...definition(), expression: "bogus" });
  assert.equal(refused.ok, false);
  assert.equal(h.notified.length, 1, "a refusal announces nothing");

  h.clock.now = NINE + 5_000;
  await h.manager.tick();
  assert.deepEqual(h.notified.at(-1), store.getSchedule(created.id, h.clock.now));

  await h.manager.archive(created.id);
  assert.deepEqual(h.removed, [created.id]);
});

test("preview answers with policy and collisions, and writes nothing", async () => {
  const h = harness("preview");
  const mine = ok(await h.manager.create(definition())).schedule;

  const schedulesBefore = store.listSchedules().length;
  const tasksBefore = db.listTasks().length;

  const result = h.manager.preview({
    expression: "0 9 * * *",
    timezone: "UTC",
    after: T0,
    count: 3,
    sleepStartedAt: T0,
    resumedAt: NINE + 3 * DAY,
    missedPolicy: "coalesce-latest",
  });

  assert.ok(result.ok);
  assert.equal(result.instants.length, 3);
  assert.equal(result.instants[0]?.at, NINE);
  // The standby half is judged by the same function the scheduler decides with, so what
  // the form promises is what will happen.
  assert.equal(result.standby?.missed.length, 4);
  assert.equal(result.standby?.plan?.filter((d) => d.decisionKind === "create_task").length, 1);
  assert.equal(result.standby?.plan?.at(-1)?.at, NINE + 3 * DAY);
  // The already-saved mission fires at these instants too - advisory, never a refusal.
  assert.ok(result.collisions.some((c) => c.scheduleId === mine.id));

  const excluded = h.manager.preview({
    expression: "0 9 * * *",
    timezone: "UTC",
    after: T0,
    excludeScheduleId: mine.id,
  });
  assert.ok(excluded.ok);
  assert.ok(!excluded.collisions.some((c) => c.scheduleId === mine.id), "never collides with itself");

  assert.equal(store.listSchedules().length, schedulesBefore, "preview wrote no schedule");
  assert.equal(db.listTasks().length, tasksBefore, "and no task");
});

test("preview leaves the standby plan null when no policy was named", async () => {
  const h = harness("preview-nopolicy");
  const result = h.manager.preview({
    expression: "0 9 * * *",
    timezone: "UTC",
    after: T0,
    sleepStartedAt: T0,
    resumedAt: NINE + 2 * DAY,
  });
  assert.ok(result.ok);
  assert.equal(result.standby?.missed.length, 3);
  // Null, not an empty list: nobody judged these, which is not the same as "none of them
  // would do anything".
  assert.equal(result.standby?.plan, null);
});

test("preview leaves a truncated standby plan null even when a policy was named", async () => {
  const h = harness("preview-truncated");
  const result = h.manager.preview({
    expression: "0 * * * *",
    timezone: "UTC",
    after: T0,
    sleepStartedAt: T0,
    resumedAt: T0 + 600 * HOUR,
    missedPolicy: "coalesce-latest",
  });

  assert.ok(result.ok);
  assert.equal(result.standby?.missed.length, 500);
  assert.equal(result.standby?.truncated, true);
  assert.equal(result.standby?.plan, null);
});

test("preview reports dense schedule collisions beyond the accounting ceiling", async () => {
  const h = harness("preview-collision-pages");
  const dense = ok(
    await h.manager.create(definition({ expression: "0 * * * *" })),
  ).schedule;
  const result = h.manager.preview({
    expression: "0 0 1 1 *",
    timezone: "UTC",
    after: T0,
    count: 3,
  });

  assert.ok(result.ok);
  const collision = result.collisions.find((item) => item.scheduleId === dense.id);
  assert.deepEqual(collision?.at, result.instants.map((instant) => instant.at));
});

test("editing a live schedule recomputes the cursor from the edit, not the old cadence", async () => {
  const h = harness("edit");
  const created = ok(await h.manager.create(definition())).schedule;
  assert.equal(created.nextRunAt, NINE);

  h.clock.now = NINE - 30 * 60_000;
  const edited = ok(
    await h.manager.update(created.id, { ...definition(), expression: "0 17 * * *" }),
  ).schedule;

  assert.equal(edited.revision, 2);
  assert.equal(edited.nextRunAt, Date.parse("2026-07-23T17:00:00Z"));

  // And the cadence it replaced does not fire once more on the way out.
  h.clock.now = NINE + 60_000;
  assert.equal((await h.manager.tick()).due, 0);
});

test("an edit uses the enabled state that remains after repository validation", async () => {
  let blockUpdate = false;
  let releaseUpdate!: () => void;
  let updateStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    updateStarted = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releaseUpdate = resolve;
  });
  const h = harness("edit-resume-race", {
    resolveRepoRoot: async (path) => {
      if (blockUpdate) {
        updateStarted();
        await held;
      }
      return { ok: true, repoRoot: path };
    },
  });
  const created = ok(await h.manager.create(definition({ enabled: false }))).schedule;
  h.clock.now = NINE - 30 * 60_000;
  blockUpdate = true;
  const editing = h.manager.update(created.id, {
    ...definition(),
    expression: "0 17 * * *",
  });
  await started;
  h.clock.now = NINE + DAY + HOUR;
  const resumed = ok(await h.manager.setEnabled(created.id, true)).schedule;
  assert.equal(resumed.nextRunAt, NINE + 2 * DAY);
  releaseUpdate();

  const edited = ok(await editing).schedule;
  assert.equal(edited.enabled, true);
  assert.equal(edited.nextRunAt, Date.parse("2026-07-24T17:00:00Z"));
});

test("an edit cannot commit after the schedule is archived during validation", async () => {
  let blockUpdate = false;
  let releaseUpdate!: () => void;
  let updateStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    updateStarted = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releaseUpdate = resolve;
  });
  const h = harness("edit-archive-race", {
    resolveRepoRoot: async (path) => {
      if (blockUpdate) {
        updateStarted();
        await held;
      }
      return { ok: true, repoRoot: path };
    },
  });
  const created = ok(await h.manager.create(definition())).schedule;
  blockUpdate = true;
  const editing = h.manager.update(created.id, {
    ...definition(),
    expression: "0 17 * * *",
  });
  await started;
  await h.manager.archive(created.id);
  releaseUpdate();

  const result = await editing;
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.message, "this schedule is archived");
  const archived = store.getSchedule(created.id)!;
  assert.equal(archived.revision, 1);
  assert.notEqual(archived.archivedAt, null);
});
