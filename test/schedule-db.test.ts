import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScheduleDefinition } from "../src/shared/schedules.ts";
import type { Task } from "../src/shared/types.ts";

// What is at stake: this is the exactly-once ledger for work that costs money. A claim
// that can run twice files the same agent task twice; a claim that can be lost drops a
// mission on the floor with nothing on screen saying so. Both failures are invisible
// until an operator counts tasks by hand, so they are pinned here.
//
// The database this runs against is deliberately an UPGRADED one, not a fresh one. It is
// seeded with the tasks table exactly as it stood before Recurring Missions and then
// handed to openDb(), so every assertion below also proves the migration path a real
// operator takes: the three schedule tables appear on a database that already had rows,
// and the three provenance columns reach a tasks table that predates them. A fresh-schema
// test would pass with the addColumn calls deleted.

// MISSION_HOME *is* the state dir, so the db lands at <home>/harness.db - the file db.ts
// opens below. It must be set before anything that resolves it is imported, which is why
// every server import in this file is dynamic.
const home = mkdtempSync(join(tmpdir(), "mission-schedule-db-"));
process.env.MISSION_HOME = home;

/**
 * The `tasks` table as current main persists it, minus the three columns this feature
 * adds - i.e. what is actually on an upgrading operator's disk.
 */
function seedPreFeatureDb(): void {
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      intent        TEXT NOT NULL,
      kind          TEXT NOT NULL,
      agent         TEXT NOT NULL,
      priority      TEXT,
      labels        TEXT,
      dependencies  TEXT,
      enabled       INTEGER NOT NULL DEFAULT 1,
      model         TEXT,
      effort        TEXT,
      source_id     TEXT,
      external_id   TEXT,
      source_url    TEXT,
      repo_root     TEXT NOT NULL,
      worktree_path TEXT,
      branch        TEXT,
      provider      TEXT,
      home_name     TEXT,
      terminal_resource_id TEXT,
      session_id    TEXT,
      status        TEXT NOT NULL,
      outcome       TEXT,
      outcome_url   TEXT,
      error         TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      dispatched_at INTEGER,
      completed_at  INTEGER
    );
  `);
  raw
    .prepare(
      `INSERT INTO tasks (id, title, intent, kind, agent, repo_root, home_name, status,
                          labels, dependencies, enabled, source_id, external_id, source_url,
                          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "legacy-task",
      "Filed before schedules existed",
      "do the thing",
      "ship",
      "claude",
      "/repo",
      "harness-legacy",
      "backlog",
      JSON.stringify(["infra"]),
      JSON.stringify([]),
      1,
      "gh-issues",
      "org/repo#7",
      "https://example.invalid/7",
      1,
      1,
    );
  raw.close();
}

seedPreFeatureDb();

const db = await import("../src/server/db.ts");
const store = await import("../src/server/schedules/store.ts");
const { SCHEDULE_STALE_CLAIM_MS, scheduleIsRunnable, revisionIsRunnable } = await import(
  "../src/shared/schedules.ts"
);

after(() => rmSync(home, { recursive: true, force: true }));

db.openDb();

const T0 = Date.parse("2026-07-23T00:00:00Z");
const HOUR = 3600_000;

function definition(over: Partial<ScheduleDefinition> = {}): ScheduleDefinition {
  return {
    name: "Dependency audit",
    expression: "0 8 * * *",
    timezone: "America/New_York",
    overlapPolicy: "skip-active",
    missedPolicy: "coalesce-latest",
    executionMode: "local-catchup",
    runnerId: null,
    template: {
      title: "Audit dependencies",
      intent: "Check for outdated packages and open a PR.",
      repoRoot: "/repo",
      kind: "ship",
      agent: "claude",
      priority: "low",
      labels: ["infra", "recurring"],
      model: null,
      effort: "high",
    },
    ...over,
  };
}

let seq = 0;
const uid = (prefix: string) => `${prefix}-${++seq}`;

function mkSchedule(
  over: Partial<ScheduleDefinition> = {},
  enabled = true,
  nextRunAt: number | null = T0 + HOUR,
) {
  return store.createSchedule({
    id: uid("sch"),
    definition: definition(over),
    enabled,
    nextRunAt,
    at: T0,
  });
}

/** A task fixture that names every current-main field, so a lost one shows up here. */
function mkTask(over: Partial<Task> = {}): Task {
  return {
    id: uid("task"),
    title: "T",
    intent: "do it",
    kind: "ship",
    agent: "claude",
    priority: "high",
    labels: ["b", "a"],
    dependencies: [
      {
        type: "task",
        taskId: "other",
        title: "Other",
        sessionId: null,
        episodeId: null,
        agentSessionId: null,
        branch: null,
        prUrl: null,
        selectedAt: 5,
        satisfiedAt: null,
      },
    ],
    enabled: false,
    model: "claude-opus-4-8",
    effort: "xhigh",
    source: { sourceId: "gh", externalId: "org/repo#1", url: "https://example.invalid/1" },
    repoRoot: "/repo",
    worktreePath: "/wt/x",
    branch: "harness/x",
    provider: "git",
    homeName: "harness-x",
    terminalResourceId: "res-1",
    sessionId: null,
    scheduleId: null,
    scheduleOccurrenceId: null,
    scheduledFor: null,
    status: "backlog",
    outcome: null,
    outcomeUrl: null,
    error: null,
    createdAt: T0,
    updatedAt: T0,
    dispatchedAt: null,
    completedAt: null,
    ...over,
  };
}

// ---- migration ----

test("a database created before the feature gains all three task provenance columns", () => {
  // Editing the CREATE TABLE block alone would not do this: it is IF NOT EXISTS, so an
  // upgrading operator keeps the table they already have and every task write afterwards
  // fails on three columns that never appeared.
  const legacy = db.getTask("legacy-task");
  assert.ok(legacy);
  assert.equal(legacy!.scheduleId, null);
  assert.equal(legacy!.scheduleOccurrenceId, null);
  assert.equal(legacy!.scheduledFor, null);
});

test("the migration reads existing rows as unscheduled without touching their other fields", () => {
  const legacy = db.getTask("legacy-task")!;
  assert.equal(legacy.homeName, "harness-legacy");
  assert.equal(legacy.enabled, true);
  assert.deepEqual(legacy.labels, ["infra"]);
  assert.deepEqual(legacy.source, {
    sourceId: "gh-issues",
    externalId: "org/repo#7",
    url: "https://example.invalid/7",
  });
});

test("the three schedule tables are created on an upgraded database, not only a fresh one", () => {
  const names = (
    db
      .openDb()
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mission_%'`)
      .all() as unknown as Array<{ name: string }>
  ).map((r) => r.name);
  assert.ok(names.includes("mission_schedules"));
  assert.ok(names.includes("mission_schedule_revisions"));
  assert.ok(names.includes("mission_schedule_occurrences"));
});

test("the occurrence identity index exists and both its columns are NOT NULL", () => {
  // SQLite treats NULLs as distinct, so a nullable column in an index you ON CONFLICT
  // against turns the upsert back into an insert - here, a duplicate agent task per tick.
  const cols = db
    .openDb()
    .prepare(`PRAGMA table_info(mission_schedule_occurrences)`)
    .all() as unknown as Array<{ name: string; notnull: number }>;
  for (const name of ["schedule_id", "scheduled_for", "trigger_kind", "decision_kind"]) {
    assert.equal(cols.find((c) => c.name === name)?.notnull, 1, `${name} must be NOT NULL`);
  }
});

// ---- ordinary tasks are undisturbed ----

test("an ordinary task still round-trips every current-main field, with null provenance", () => {
  const t = mkTask();
  db.upsertTask(t);
  const back = db.getTask(t.id)!;
  assert.deepEqual(back.dependencies, t.dependencies);
  assert.equal(back.enabled, false);
  assert.equal(back.homeName, "harness-x");
  assert.equal(back.terminalResourceId, "res-1");
  assert.deepEqual(back.source, t.source);
  assert.equal(back.effort, "xhigh");
  assert.equal(back.scheduleId, null);
  assert.equal(back.scheduleOccurrenceId, null);
  assert.equal(back.scheduledFor, null);
});

test("a generated task round-trips all three provenance fields together", () => {
  const t = mkTask({ scheduleId: "sch-x", scheduleOccurrenceId: "occ-x", scheduledFor: T0 });
  db.upsertTask(t);
  const back = db.getTask(t.id)!;
  assert.equal(back.scheduleId, "sch-x");
  assert.equal(back.scheduleOccurrenceId, "occ-x");
  assert.equal(back.scheduledFor, T0);
});

// ---- schedules and revisions ----

test("a schedule and its revision 1 round-trip policy and template intact", () => {
  const s = mkSchedule();
  const back = store.getSchedule(s.id, T0)!;
  assert.equal(back.name, "Dependency audit");
  assert.equal(back.expression, "0 8 * * *");
  assert.equal(back.timezone, "America/New_York");
  assert.equal(back.overlapPolicy, "skip-active");
  assert.equal(back.missedPolicy, "coalesce-latest");
  assert.equal(back.executionMode, "local-catchup");
  assert.equal(back.runnerId, null);
  assert.equal(back.revision, 1);
  assert.deepEqual(back.template, definition().template);

  const rev = store.activeRevision(s.id)!;
  assert.equal(rev.revision, 1);
  assert.deepEqual(rev.template, definition().template);
  assert.equal(rev.missedPolicy, "coalesce-latest");
});

test("an edit inserts revision n+1 and repoints the schedule in one transaction", () => {
  const s = mkSchedule();
  const updated = store.updateSchedule(
    s.id,
    definition({ name: "Renamed", missedPolicy: "skip" }),
    T0 + 2 * HOUR,
    T0 + HOUR,
  )!;
  assert.equal(updated.revision, 2);
  assert.equal(updated.name, "Renamed");
  assert.equal(updated.missedPolicy, "skip");
  assert.equal(updated.nextRunAt, T0 + 2 * HOUR);

  // The point of immutability: revision 1 still says what it said.
  const first = store.revisionAt(s.id, 1)!;
  assert.equal(first.missedPolicy, "coalesce-latest");
  assert.equal(store.activeRevision(s.id)!.revision, 2);
});

test("a rename does not rewrite the revision a past occurrence was claimed under", () => {
  const s = mkSchedule();
  const claim = store.claimOccurrence({
    occurrenceId: uid("occ"),
    scheduleId: s.id,
    scheduleRevision: 1,
    scheduledFor: T0 + HOUR,
    triggerKind: "scheduled",
    decisionKind: "create_task",
    taskId: uid("task"),
    coveredById: null,
    blockingTaskId: null,
    claimedAt: T0 + HOUR,
    delayMs: 0,
    advanceCursor: true,
    nextRunAt: T0 + 2 * HOUR,
  });
  assert.equal(claim.outcome, "claimed");
  store.updateSchedule(s.id, definition({ name: "Renamed" }), T0 + 3 * HOUR, T0 + 2 * HOUR);
  assert.equal(store.getOccurrence(claim.outcome === "claimed" ? claim.occurrence.id : "")!.scheduleRevision, 1);
});

test("updating a schedule that does not exist writes nothing and says so", () => {
  assert.equal(store.updateSchedule("nope", definition(), null, T0), null);
});

// ---- unreadable rows fail closed ----

test("a row written by a newer build loads into attention rather than running as local", () => {
  // The one failure that must never happen quietly: reading an unknown execution mode as
  // local catch-up would create work on this laptop that the operator scheduled for a
  // different host. The typed field goes null, so nothing downstream can reach a policy
  // without having handled the absence, and scheduleIsRunnable refuses the row.
  const s = mkSchedule();
  db.openDb()
    .prepare(`UPDATE mission_schedules SET execution_mode = ? WHERE id = ?`)
    .run("quantum-runner", s.id);

  const back = store.getSchedule(s.id, T0)!;
  assert.equal(back.executionMode, null);
  assert.ok(back.unreadable);
  assert.deepEqual(back.unreadable!.fields, ["execution_mode"]);
  assert.match(back.unreadable!.reason, /newer build/);
  assert.equal(back.health, "attention");
  assert.ok(back.healthReasons.includes("config-unreadable"));
  assert.equal(scheduleIsRunnable(back), false);
});

test("the revision fails closed on its own, because the claim path reads it and not the schedule", () => {
  // Two rows carry the policies: the schedule row is current state and answers the
  // catalog, the revision is the immutable copy a claim is taken under. They are written
  // together, so they agree - but each is read by a different caller, so each has to
  // refuse an unreadable value by itself rather than trusting the other to have noticed.
  const s = mkSchedule();
  db.openDb()
    .prepare(`UPDATE mission_schedule_revisions SET missed_policy = ? WHERE schedule_id = ?`)
    .run("coalesce-oldest-maybe", s.id);

  const rev = store.activeRevision(s.id)!;
  assert.equal(rev.missedPolicy, null);
  assert.deepEqual(rev.unreadable!.fields, ["missed_policy"]);
  assert.equal(revisionIsRunnable(rev), false);
  // The catalog row is untouched, which is the point: the two reads are independent.
  assert.equal(store.getSchedule(s.id, T0)!.missedPolicy, "coalesce-latest");
});

test("an unparseable template costs that one schedule, not the whole catalog", () => {
  const good = mkSchedule();
  const bad = mkSchedule();
  db.openDb()
    .prepare(`UPDATE mission_schedule_revisions SET template_json = ? WHERE schedule_id = ?`)
    .run("{not json", bad.id);

  const listed = store.listSchedules(T0);
  assert.ok(listed.some((s) => s.id === good.id && s.template !== null));
  const broken = listed.find((s) => s.id === bad.id)!;
  assert.equal(broken.template, null);
  assert.deepEqual(broken.unreadable!.fields, ["template"]);
});

// ---- the claim ----

test("two claims on the same instant produce exactly one winner", () => {
  const s = mkSchedule();
  const shared = {
    scheduleId: s.id,
    scheduleRevision: 1,
    scheduledFor: T0 + HOUR,
    triggerKind: "scheduled" as const,
    decisionKind: "create_task" as const,
    coveredById: null,
    blockingTaskId: null,
    claimedAt: T0 + HOUR,
    delayMs: 0,
    advanceCursor: true,
  };
  const first = store.claimOccurrence({
    ...shared,
    occurrenceId: "occ-race-a",
    taskId: "task-race-a",
    nextRunAt: T0 + 2 * HOUR,
  });
  const second = store.claimOccurrence({
    ...shared,
    occurrenceId: "occ-race-b",
    taskId: "task-race-b",
    nextRunAt: T0 + 3 * HOUR,
  });

  assert.equal(first.outcome, "claimed");
  assert.equal(second.outcome, "already_exists");
  // The loser is told who won, so it can finish the reservation that exists rather than
  // guessing that its own preallocated task id is the live one.
  assert.equal(second.outcome === "already_exists" ? second.occurrence.id : null, "occ-race-a");

  const rows = db
    .openDb()
    .prepare(`SELECT COUNT(*) AS n FROM mission_schedule_occurrences WHERE schedule_id = ?`)
    .get(s.id) as { n: number };
  assert.equal(rows.n, 1);
});

test("the claim and the cursor advance together, or not at all", () => {
  const s = mkSchedule();
  const won = store.claimOccurrence({
    occurrenceId: uid("occ"),
    scheduleId: s.id,
    scheduleRevision: 1,
    scheduledFor: T0 + HOUR,
    triggerKind: "scheduled",
    decisionKind: "create_task",
    taskId: uid("task"),
    coveredById: null,
    blockingTaskId: null,
    claimedAt: T0 + HOUR,
    delayMs: 0,
    advanceCursor: true,
    nextRunAt: T0 + 2 * HOUR,
  });
  assert.equal(won.outcome, "claimed");
  assert.equal(store.getSchedule(s.id, T0)!.nextRunAt, T0 + 2 * HOUR);

  // A losing claim leaves the cursor exactly where the winner put it: the winner already
  // advanced it in its own transaction, so touching it here could only move it backwards.
  const lost = store.claimOccurrence({
    occurrenceId: uid("occ"),
    scheduleId: s.id,
    scheduleRevision: 1,
    scheduledFor: T0 + HOUR,
    triggerKind: "scheduled",
    decisionKind: "create_task",
    taskId: uid("task"),
    coveredById: null,
    blockingTaskId: null,
    claimedAt: T0 + HOUR,
    delayMs: 0,
    advanceCursor: true,
    nextRunAt: T0 + 99 * HOUR,
  });
  assert.equal(lost.outcome, "already_exists");
  assert.equal(store.getSchedule(s.id, T0)!.nextRunAt, T0 + 2 * HOUR);
});

test("a claim against a superseded revision writes nothing at all", () => {
  const s = mkSchedule();
  store.updateSchedule(s.id, definition({ name: "Edited" }), T0 + 5 * HOUR, T0 + HOUR);

  const stale = store.claimOccurrence({
    occurrenceId: uid("occ"),
    scheduleId: s.id,
    scheduleRevision: 1, // the tick decided under revision 1; the edit landed first
    scheduledFor: T0 + HOUR,
    triggerKind: "scheduled",
    decisionKind: "create_task",
    taskId: uid("task"),
    coveredById: null,
    blockingTaskId: null,
    claimedAt: T0 + HOUR,
    delayMs: 0,
    advanceCursor: true,
    nextRunAt: T0 + 2 * HOUR,
  });
  assert.equal(stale.outcome, "schedule_changed");

  const rows = db
    .openDb()
    .prepare(`SELECT COUNT(*) AS n FROM mission_schedule_occurrences WHERE schedule_id = ?`)
    .get(s.id) as { n: number };
  assert.equal(rows.n, 0, "no reservation may be recorded against a revision that has moved");
  assert.equal(store.getSchedule(s.id, T0)!.nextRunAt, T0 + 5 * HOUR, "cursor untouched");
});

test("no new claim starts after a schedule is archived", () => {
  const s = mkSchedule();
  store.archiveSchedule(s.id, T0 + HOUR);
  const claim = store.claimOccurrence({
    occurrenceId: uid("occ"),
    scheduleId: s.id,
    scheduleRevision: 1,
    scheduledFor: T0 + HOUR,
    triggerKind: "scheduled",
    decisionKind: "create_task",
    taskId: uid("task"),
    coveredById: null,
    blockingTaskId: null,
    claimedAt: T0 + HOUR,
    delayMs: 0,
    advanceCursor: true,
    nextRunAt: T0 + 2 * HOUR,
  });
  assert.equal(claim.outcome, "schedule_changed");
});

test("Run now claims without moving the cron cursor", () => {
  const s = mkSchedule();
  const manual = store.claimOccurrence({
    occurrenceId: uid("occ"),
    scheduleId: s.id,
    scheduleRevision: 1,
    scheduledFor: T0 + 17, // a minted instant, deliberately off the cron grid
    triggerKind: "manual",
    decisionKind: "create_task",
    taskId: uid("task"),
    coveredById: null,
    blockingTaskId: null,
    claimedAt: T0 + 17,
    delayMs: 0,
    // Expressed as a flag rather than by writing the old cursor back: "write what was
    // already there" is indistinguishable from a lost update when you read it later.
    advanceCursor: false,
    nextRunAt: null,
  });
  assert.equal(manual.outcome, "claimed");
  assert.equal(manual.outcome === "claimed" ? manual.occurrence.triggerKind : null, "manual");
  assert.equal(store.getSchedule(s.id, T0)!.nextRunAt, T0 + HOUR, "cron cursor untouched");
});

test("the claim carries its immutable decision and its coverage reference", () => {
  const s = mkSchedule();
  const claim = store.claimOccurrence({
    occurrenceId: uid("occ"),
    scheduleId: s.id,
    scheduleRevision: 1,
    scheduledFor: T0 + HOUR,
    triggerKind: "scheduled",
    decisionKind: "coalesced",
    taskId: null,
    coveredById: "occ-later",
    blockingTaskId: null,
    claimedAt: T0 + 9 * HOUR,
    delayMs: 8 * HOUR,
    advanceCursor: true,
    nextRunAt: T0 + 10 * HOUR,
  });
  assert.ok(claim.outcome === "claimed");
  if (claim.outcome !== "claimed") return;
  assert.equal(claim.occurrence.decisionKind, "coalesced");
  assert.equal(claim.occurrence.coveredById, "occ-later");
  assert.equal(claim.occurrence.taskId, null);
  assert.equal(claim.occurrence.delayMs, 8 * HOUR);
  assert.equal(claim.occurrence.status, "claimed");
});

// ---- finishing and recovery ----

function claimOne(scheduleId: string, scheduledFor: number, claimedAt = scheduledFor) {
  const r = store.claimOccurrence({
    occurrenceId: uid("occ"),
    scheduleId,
    scheduleRevision: 1,
    scheduledFor,
    triggerKind: "scheduled",
    decisionKind: "create_task",
    taskId: uid("task"),
    coveredById: null,
    blockingTaskId: null,
    claimedAt,
    delayMs: claimedAt - scheduledFor,
    advanceCursor: true,
    nextRunAt: scheduledFor + HOUR,
  });
  assert.ok(r.outcome === "claimed");
  return r.outcome === "claimed" ? r.occurrence : null!;
}

test("finishing a reservation is idempotent - the second answer never overwrites the first", () => {
  const s = mkSchedule();
  const occ = claimOne(s.id, T0 + HOUR);
  const done = store.finishOccurrence({ id: occ.id, status: "created", finishedAt: T0 + 2 * HOUR })!;
  assert.equal(done.status, "created");
  assert.equal(done.finishedAt, T0 + 2 * HOUR);

  // Recovery and the tick can both reach the same row after a restart.
  const again = store.finishOccurrence({
    id: occ.id,
    status: "failed",
    finishedAt: T0 + 3 * HOUR,
    error: "should not land",
  })!;
  assert.equal(again.status, "created");
  assert.equal(again.finishedAt, T0 + 2 * HOUR);
  assert.equal(again.error, null);
});

test("stale reservations are queryable for recovery, across every schedule", () => {
  const a = mkSchedule();
  const b = mkSchedule();
  const oldA = claimOne(a.id, T0 + HOUR);
  const oldB = claimOne(b.id, T0 + HOUR);
  const fresh = claimOne(a.id, T0 + 2 * HOUR);
  store.finishOccurrence({ id: fresh.id, status: "created", finishedAt: T0 + 2 * HOUR });

  const now = T0 + HOUR + SCHEDULE_STALE_CLAIM_MS + 1;
  const stale = store.listStaleClaims(now).map((o) => o.id);
  assert.ok(stale.includes(oldA.id));
  assert.ok(stale.includes(oldB.id), "a crash loses claims across the whole catalog, not one");
  assert.ok(!stale.includes(fresh.id), "a finished reservation is not stale");
});

test("a reservation younger than the window is not yet a crash", () => {
  const s = mkSchedule();
  const occ = claimOne(s.id, T0 + HOUR);
  const stale = store.listStaleClaims(T0 + HOUR + 1000).map((o) => o.id);
  assert.ok(!stale.includes(occ.id));
  assert.ok(store.listOpenClaims().some((o) => o.id === occ.id), "but it is an open claim");
});

// ---- overlap and task links ----

test("the overlap check finds this schedule's in-flight work and ignores terminal work", () => {
  const s = mkSchedule();
  db.upsertTask(mkTask({ scheduleId: s.id, status: "done", createdAt: T0 }));
  assert.equal(store.findActiveTaskForSchedule(s.id), null, "done does not block");

  for (const status of ["backlog", "dispatching", "running"] as const) {
    const t = mkTask({ scheduleId: s.id, status, title: `live-${status}`, createdAt: T0 + 1 });
    db.upsertTask(t);
    assert.equal(store.findActiveTaskForSchedule(s.id)?.title, `live-${status}`, status);
    db.deleteTask(t.id);
  }

  for (const status of ["cancelled", "failed"] as const) {
    const t = mkTask({ scheduleId: s.id, status, createdAt: T0 + 1 });
    db.upsertTask(t);
    assert.equal(store.findActiveTaskForSchedule(s.id), null, status);
    db.deleteTask(t.id);
  }
});

test("another schedule's in-flight work does not block this one", () => {
  const mine = mkSchedule();
  const theirs = mkSchedule();
  db.upsertTask(mkTask({ scheduleId: theirs.id, status: "running" }));
  assert.equal(store.findActiveTaskForSchedule(mine.id), null);
});

test("a generated task can be traced back to the run that filed it", () => {
  const s = mkSchedule();
  const occ = claimOne(s.id, T0 + HOUR);
  assert.equal(store.occurrenceForTask(occ.taskId!)!.id, occ.id);
  assert.equal(store.occurrenceForTask("no-such-task"), null);
});

// ---- enable, archive, history ----

test("pausing clears the cursor and resuming writes the one the caller computed", () => {
  const s = mkSchedule();
  const paused = store.setScheduleEnabled(s.id, false, null, T0 + HOUR)!;
  assert.equal(paused.enabled, false);
  assert.equal(paused.nextRunAt, null);
  assert.equal(paused.health, "paused");

  // The anchor is the resume time, not the instant it was paused on: a pause accrues no
  // hidden debt to catch up on.
  const resumed = store.setScheduleEnabled(s.id, true, T0 + 50 * HOUR, T0 + 49 * HOUR)!;
  assert.equal(resumed.enabled, true);
  assert.equal(resumed.nextRunAt, T0 + 50 * HOUR);
});

test("archive is idempotent, hides the schedule, and deletes nothing", () => {
  const s = mkSchedule();
  const occ = claimOne(s.id, T0 + HOUR);
  store.finishOccurrence({ id: occ.id, status: "created", finishedAt: T0 + HOUR });
  store.updateSchedule(s.id, definition({ name: "v2" }), T0 + 2 * HOUR, T0 + HOUR);

  const archived = store.archiveSchedule(s.id, T0 + 3 * HOUR)!;
  assert.equal(archived.archivedAt, T0 + 3 * HOUR);
  assert.equal(archived.enabled, false);
  assert.equal(archived.nextRunAt, null);

  // A second Archive must not re-stamp when the mission was retired.
  const again = store.archiveSchedule(s.id, T0 + 9 * HOUR)!;
  assert.equal(again.archivedAt, T0 + 3 * HOUR);

  assert.ok(!store.listSchedules(T0).some((x) => x.id === s.id), "gone from the catalog");
  assert.ok(store.getSchedule(s.id, T0), "still reachable by id");
  assert.ok(store.revisionAt(s.id, 1), "revisions retained");
  assert.equal(store.historyPage(s.id, { before: null, limit: 10 }, T0)!.occurrences.length, 1);
});

test("an archived schedule is never handed to the tick", () => {
  const s = mkSchedule({}, true, T0 - HOUR);
  assert.ok(store.dueSchedules(T0).some((x) => x.id === s.id));
  store.archiveSchedule(s.id, T0);
  assert.ok(!store.dueSchedules(T0).some((x) => x.id === s.id));
});

test("only enabled schedules whose cursor has passed are due", () => {
  const due = mkSchedule({}, true, T0 - HOUR);
  const later = mkSchedule({}, true, T0 + HOUR);
  const paused = mkSchedule({}, false, null);
  const ids = store.dueSchedules(T0).map((s) => s.id);
  assert.ok(ids.includes(due.id));
  assert.ok(!ids.includes(later.id));
  assert.ok(!ids.includes(paused.id));
});

test("history pages newest-first and its cursor is deterministic under new writes", () => {
  const s = mkSchedule();
  const instants = [1, 2, 3, 4, 5].map((n) => T0 + n * HOUR);
  for (const at of instants) {
    const occ = claimOne(s.id, at);
    store.finishOccurrence({ id: occ.id, status: "created", finishedAt: at });
  }

  const first = store.historyPage(s.id, { before: null, limit: 2 }, T0)!;
  assert.deepEqual(
    first.occurrences.map((o) => o.scheduledFor),
    [instants[4], instants[3]],
  );
  assert.equal(first.nextCursor, instants[3]);

  // A new occurrence lands between the two requests. Paging on the unique instant rather
  // than an OFFSET means the second page cannot repeat or skip a row because of it.
  const extra = claimOne(s.id, T0 + 6 * HOUR);
  store.finishOccurrence({ id: extra.id, status: "created", finishedAt: T0 + 6 * HOUR });

  const second = store.historyPage(s.id, { before: first.nextCursor, limit: 2 }, T0)!;
  assert.deepEqual(
    second.occurrences.map((o) => o.scheduledFor),
    [instants[2], instants[1]],
  );

  const last = store.historyPage(s.id, { before: instants[1]!, limit: 10 }, T0)!;
  assert.deepEqual(
    last.occurrences.map((o) => o.scheduledFor),
    [instants[0]],
  );
  assert.equal(last.nextCursor, null, "the last page says it is the last");
});

test("a history limit is clamped rather than trusted", () => {
  const s = mkSchedule();
  for (const n of [1, 2, 3]) claimOne(s.id, T0 + n * HOUR);
  assert.equal(store.historyPage(s.id, { before: null, limit: 100_000 }, T0)!.occurrences.length, 3);
  assert.equal(store.historyPage("no-such-schedule", { before: null, limit: 5 }, T0), null);
});

// ---- derived health ----

test("health is derived from durable state, and paused wins over every alarm", () => {
  const failing = mkSchedule();
  const occ = claimOne(failing.id, T0 + HOUR);
  store.finishOccurrence({
    id: occ.id,
    status: "failed",
    finishedAt: T0 + HOUR,
    error: "repo went away",
  });

  const enabled = store.getSchedule(failing.id, T0 + 2 * HOUR)!;
  assert.equal(enabled.health, "attention");
  assert.deepEqual(enabled.healthReasons, ["last-run-failed"]);
  assert.equal(enabled.lastOccurrence!.error, "repo went away");

  // A schedule somebody deliberately switched off is not asking them for anything, and a
  // badge on a parked mission trains people to ignore the badge.
  store.setScheduleEnabled(failing.id, false, null, T0 + 2 * HOUR);
  assert.equal(store.getSchedule(failing.id, T0 + 2 * HOUR)!.health, "paused");
});

test("an overdue cursor is attention only once it is past the grace window", () => {
  const s = mkSchedule({}, true, T0);
  assert.equal(store.getSchedule(s.id, T0 + 60_000)!.health, "healthy", "one late tick is not a fault");
  const late = store.getSchedule(s.id, T0 + 30 * 60_000)!;
  assert.equal(late.health, "attention");
  assert.deepEqual(late.healthReasons, ["overdue"]);
});

test("a reservation nobody finished shows as a stale claim on the catalog row", () => {
  const s = mkSchedule({}, true, T0 + 99 * HOUR);
  claimOne(s.id, T0 + HOUR);
  const now = T0 + HOUR + SCHEDULE_STALE_CLAIM_MS + 1;
  const row = store.getSchedule(s.id, now)!;
  assert.equal(row.health, "attention");
  assert.ok(row.healthReasons.includes("stale-claim"));
});

test("lastOccurrence reports the newest TERMINAL run, not an open reservation", () => {
  const s = mkSchedule({}, true, T0 + 99 * HOUR);
  const done = claimOne(s.id, T0 + HOUR);
  store.finishOccurrence({ id: done.id, status: "created", finishedAt: T0 + HOUR });
  claimOne(s.id, T0 + 2 * HOUR); // still in flight
  assert.equal(store.getSchedule(s.id, T0 + 2 * HOUR)!.lastOccurrence!.id, done.id);
});

test("a healthy schedule reports no reasons at all", () => {
  const s = mkSchedule({}, true, T0 + HOUR);
  const row = store.getSchedule(s.id, T0)!;
  assert.equal(row.health, "healthy");
  assert.deepEqual(row.healthReasons, []);
});

test("listSchedules gathers health for every row without reading them one at a time", () => {
  // Not a performance assertion, a correctness one: the set-wide queries must attribute
  // each schedule's last run and oldest claim to the right schedule.
  const a = mkSchedule({}, true, T0 + HOUR);
  const b = mkSchedule({}, true, T0 + HOUR);
  const aOcc = claimOne(a.id, T0 + HOUR);
  store.finishOccurrence({ id: aOcc.id, status: "failed", finishedAt: T0 + HOUR, error: "a broke" });
  const bOcc = claimOne(b.id, T0 + HOUR);
  store.finishOccurrence({ id: bOcc.id, status: "created", finishedAt: T0 + HOUR });

  const listed = store.listSchedules(T0 + 2 * HOUR);
  assert.equal(listed.find((s) => s.id === a.id)!.lastOccurrence!.error, "a broke");
  assert.equal(listed.find((s) => s.id === b.id)!.lastOccurrence!.error, null);
  assert.equal(listed.find((s) => s.id === a.id)!.health, "attention");
  assert.equal(listed.find((s) => s.id === b.id)!.health, "healthy");
});
