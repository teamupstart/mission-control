import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The task shaping record's persistence: the column and table arrive on an upgraded database,
// the one commit function settles the summary and the text together in each of the four
// combinations, and the record follows its session when the conversation resumes under a new
// session id - and only then.

const home = mkdtempSync(join(tmpdir(), "mission-shaping-record-"));
const dbPath = join(home, "harness.db");
process.env.MISSION_HOME = home;

// A database from before task shaping: a tasks table without the column, and no text table.
{
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, intent TEXT NOT NULL, kind TEXT NOT NULL,
      agent TEXT NOT NULL, priority TEXT, labels TEXT, model TEXT, source_id TEXT,
      external_id TEXT, source_url TEXT, repo_root TEXT NOT NULL, worktree_path TEXT,
      branch TEXT, provider TEXT, session_id TEXT, status TEXT NOT NULL, outcome TEXT,
      outcome_url TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      dispatched_at INTEGER, completed_at INTEGER
    );
  `);
  raw.prepare(
    `INSERT INTO tasks (id, title, intent, kind, agent, repo_root, status, created_at, updated_at)
     VALUES ('legacy', 'Legacy', 'do it', 'ship', 'claude', '/repo', 'done', 1, 1)`,
  ).run();
  raw.close();
}

const db = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { currentShaping } = await import("../src/shared/shaping.ts");
const { mkTask } = await import("./helpers/session-fixture.ts");
const flags = await import("../src/server/feature-flags/index.ts");
type TaskShaping = import("../src/shared/shaping.ts").TaskShaping;

after(() => { db.closeDb(); rmSync(home, { recursive: true, force: true }); });

function record(sessionId: string, state: TaskShaping["state"] = "ok"): TaskShaping {
  return {
    state, at: 1_700_000_000_000, sessionId, durationMs: 12, entries: state === "ok" ? 1 : 0, bytes: 40, truncated: false,
    shapers: [{
      id: "acme", label: "Acme", stage: "select", origin: "registered", sha256: null,
      outcome: state === "ok" ? "ok" : "timed_out", reason: state === "ok" ? null : "Timed out after 5 s.",
      durationMs: 12, entries: state === "ok" ? 1 : 0, bytes: 40, truncated: false, redacted: false, version: null,
    }],
  };
}

test("an upgraded database gains the column and the table, and an old row reads with no record", () => {
  db.openDb();
  const raw = new DatabaseSync(dbPath);
  const columns = raw.prepare(`PRAGMA table_info(tasks)`).all() as unknown as Array<{ name: string }>;
  assert.ok(columns.some((column) => column.name === "shaping"));
  const table = raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_shaping_text'`).get();
  assert.ok(table, "the delivered-text table exists");
  raw.close();
  const legacy = db.getTask("legacy");
  assert.ok(legacy);
  assert.equal("shaping" in legacy, false, "an unshaped task reads exactly as before");
  assert.equal(db.getTaskShapingText("legacy"), null);
});

test("a schema 41 database upgrades to 42 with the column and the table, and a second open changes nothing", () => {
  // The shaping column and table arrive at 42; a later schema version must keep them.
  assert.ok(db.CURRENT_DATABASE_SCHEMA_VERSION >= 42);
  db.upsertTask(mkTask({ id: "before-39", status: "backlog" }));
  db.closeDb();
  const old = new DatabaseSync(dbPath);
  old.exec("ALTER TABLE tasks DROP COLUMN shaping");
  old.exec("DROP TABLE task_shaping_text");
  old.exec("PRAGMA user_version = 41");
  old.close();
  const upgraded = db.openDb();
  assert.equal((upgraded.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, db.CURRENT_DATABASE_SCHEMA_VERSION);
  const columns = (upgraded.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).map((column) => column.name);
  assert.ok(columns.includes("shaping"));
  assert.ok(upgraded.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_shaping_text'`).get());
  assert.equal(db.getTask("before-39")?.shaping, undefined, "a task from before the column has no record");
  db.closeDb();
  db.openDb();
  assert.equal(db.getTask("before-39")?.status, "backlog");
});

test("the one commit settles the summary and the text together, across every transition a launch can make", () => {
  db.upsertTask(mkTask({ id: "combo", status: "running", sessionId: "s1" }));
  // A summary and text: a launch that delivered context.
  assert.equal(db.commitTaskShaping("combo", record("s1"), "## Task context\n\nbody", 10), true);
  assert.deepEqual(db.getTask("combo")?.shaping, record("s1"));
  assert.deepEqual(db.getTaskShapingText("combo"), { text: "## Task context\n\nbody", createdAt: 10 });
  // A summary and no text: a launch whose only shaper failed keeps degraded and its reason.
  assert.equal(db.commitTaskShaping("combo", record("s2", "degraded"), "", 20), true);
  assert.equal(db.getTask("combo")?.shaping?.state, "degraded");
  assert.equal(db.getTask("combo")?.shaping?.shapers[0]?.reason, "Timed out after 5 s.");
  assert.equal(db.getTaskShapingText("combo"), null);
  // A later launch that delivered context again: both are replaced, the text row recreated.
  assert.equal(db.commitTaskShaping("combo", record("s3"), "third text", 30), true);
  assert.deepEqual(db.getTask("combo")?.shaping, record("s3"));
  assert.deepEqual(db.getTaskShapingText("combo"), { text: "third text", createdAt: 30 });
  // Neither: a launch nothing shaped clears both the summary and the text an earlier one left.
  assert.equal(db.commitTaskShaping("combo", null, "", 40), true);
  assert.equal(db.getTask("combo")?.shaping, undefined);
  assert.equal(db.getTaskShapingText("combo"), null);
  // And a task with no record is not written to at all.
  assert.equal(db.commitTaskShaping("combo", null, "", 50), false);
});

test("a summary the schema refuses is rejected before anything is written", () => {
  db.upsertTask(mkTask({ id: "refused", status: "running", sessionId: "s1" }));
  assert.equal(db.commitTaskShaping("refused", record("s1"), "first text", 1), true);
  const broken = { ...record("s2"), state: "unknown" } as unknown as TaskShaping;
  assert.throws(() => db.commitTaskShaping("refused", broken, "second text", 2));
  assert.deepEqual(db.getTask("refused")?.shaping, record("s1"));
  assert.equal(db.getTaskShapingText("refused")?.text, "first text");
});

test("a text write that fails after the summary was written rolls the summary back too", () => {
  db.upsertTask(mkTask({ id: "atomic", status: "running", sessionId: "s1" }));
  assert.equal(db.commitTaskShaping("atomic", record("s1"), "first text", 1), true);
  // A valid summary, so the `UPDATE tasks` runs and succeeds; then the text write is refused by
  // SQLite itself, inside the same transaction. Both writes must be undone.
  const d = db.openDb();
  d.exec(`CREATE TRIGGER refuse_shaping_text BEFORE UPDATE ON task_shaping_text
          BEGIN SELECT RAISE(ABORT, 'disk refused the text'); END;`);
  try {
    assert.throws(() => db.commitTaskShaping("atomic", record("s2", "degraded"), "second text", 2), /disk refused the text/);
  } finally {
    d.exec("DROP TRIGGER refuse_shaping_text");
  }
  assert.equal(d.isTransaction, false, "the transaction was closed, not left open");
  assert.deepEqual(db.getTask("atomic")?.shaping, record("s1"), "the summary written before the failure was rolled back");
  assert.deepEqual(db.getTaskShapingText("atomic"), { text: "first text", createdAt: 1 }, "and the text is the previous launch's");
  // The same rollback when the second write is the delete that clears the text.
  d.exec(`CREATE TRIGGER refuse_shaping_delete BEFORE DELETE ON task_shaping_text
          BEGIN SELECT RAISE(ABORT, 'disk refused the delete'); END;`);
  try {
    assert.throws(() => db.commitTaskShaping("atomic", record("s3", "degraded"), "", 3), /disk refused the delete/);
  } finally {
    d.exec("DROP TRIGGER refuse_shaping_delete");
  }
  assert.deepEqual(db.getTask("atomic")?.shaping, record("s1"));
  assert.equal(db.getTaskShapingText("atomic")?.text, "first text");
});

test("upsertTask never writes the record, so an older snapshot cannot bring one back", () => {
  db.upsertTask(mkTask({ id: "snapshot", status: "running", sessionId: "s1" }));
  db.commitTaskShaping("snapshot", record("s1"), "text", 1);
  const stale = { ...db.getTask("snapshot")!, shaping: record("s0", "degraded") };
  db.upsertTask(stale);
  assert.deepEqual(db.getTask("snapshot")?.shaping, record("s1"));
});

test("the record follows its session across a resume in the same episode, and never onto a new launch", () => {
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "resume", status: "running", sessionId: "first" }));
  const episode = (episodeId: string, sessionId: string) => ({
    episodeId, sessionId, agentSessionId: `agent-${episodeId}`, branch: null, prUrl: null, prHeadSha: null, mergedAt: null,
    promptedAt: null, awaitingAgentRebind: false, rebindFromTranscriptPath: null, startedAt: 1, updatedAt: 1,
  });
  assert.equal(registry.bindTaskToWorkEpisode("resume", "first", episode("e1", "first")), true);
  registry.commitTaskShaping("resume", "first", record("first"), "text");
  assert.equal(registry.getTask("resume")?.shaping?.sessionId, "first");

  // The same conversation, resumed into a new session: the record moves with it.
  registry.upsertTask({ ...registry.getTask("resume")!, sessionId: "resumed" });
  assert.equal(registry.bindTaskToWorkEpisode("resume", "resumed", episode("e1", "resumed")), true);
  assert.equal(registry.getTask("resume")?.shaping?.sessionId, "resumed");
  assert.equal(db.getTask("resume")?.shaping?.sessionId, "resumed", "durably");
  assert.ok(currentShaping(registry.getTask("resume")!));
  assert.equal(db.getTaskShapingText("resume")?.text, "text", "the text belongs to the same launch");

  // A new episode is a new launch: its own commit settles its record, nothing moves.
  registry.upsertTask({ ...registry.getTask("resume")!, sessionId: "relaunched" });
  assert.equal(registry.bindTaskToWorkEpisode("resume", "relaunched", episode("e2", "relaunched")), true);
  assert.equal(registry.getTask("resume")?.shaping?.sessionId, "resumed");
  assert.equal(currentShaping(registry.getTask("resume")!), null);
});

test("a hibernated task resumed into a new session of the same episode carries its record", () => {
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "hibernate", status: "running", sessionId: "before" }));
  const episode = (sessionId: string) => ({
    episodeId: "e-hib", sessionId, agentSessionId: "agent-hib", branch: null, prUrl: null, prHeadSha: null, mergedAt: null,
    promptedAt: null, awaitingAgentRebind: false, rebindFromTranscriptPath: null, startedAt: 1, updatedAt: 1,
  });
  assert.equal(registry.bindTaskToWorkEpisode("hibernate", "before", episode("before")), true);
  registry.commitTaskShaping("hibernate", "before", record("before"), "text");
  // The resume path: the successor's episode is recorded, then the task row and its binding are
  // written in one transaction by `persistResumedTask`, and published afterwards.
  db.replaceSessionWorkEpisode(episode("after"));
  const resumed = { ...registry.getTask("hibernate")!, sessionId: "after" };
  const displaced = db.inTransaction(() => registry.persistResumedTask(resumed, "after"));
  registry.publishPersistedTask(resumed, displaced);
  assert.equal(db.getTask("hibernate")?.shaping?.sessionId, "after", "durably");
  assert.equal(registry.getTask("hibernate")?.shaping?.sessionId, "after", "and in what readers see");
  assert.ok(currentShaping(registry.getTask("hibernate")!));
});

test("a resume whose shaping re-key fails still binds its successor, and hides the old record", () => {
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "rekey-fails", status: "running", sessionId: "before" }));
  const episode = (sessionId: string) => ({
    episodeId: "e-rekey", sessionId, agentSessionId: "agent-rekey", branch: null, prUrl: null, prHeadSha: null, mergedAt: null,
    promptedAt: null, awaitingAgentRebind: false, rebindFromTranscriptPath: null, startedAt: 1, updatedAt: 1,
  });
  assert.equal(registry.bindTaskToWorkEpisode("rekey-fails", "before", episode("before")), true);
  registry.commitTaskShaping("rekey-fails", "before", record("before"), "text");
  db.replaceSessionWorkEpisode(episode("after"));
  const resumed = { ...registry.getTask("rekey-fails")!, sessionId: "after" };
  // SQLite refuses the re-key itself; every other write in the resume succeeds.
  const d = db.openDb();
  d.exec(`CREATE TRIGGER refuse_shaping_rekey BEFORE UPDATE OF shaping ON tasks
          BEGIN SELECT RAISE(ABORT, 'disk refused the re-key'); END;`);
  const warn = console.warn;
  const warnings: unknown[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args[0]); };
  try {
    const displaced = db.inTransaction(() => registry.persistResumedTask(resumed, "after"));
    registry.publishPersistedTask(resumed, displaced);
  } finally {
    console.warn = warn;
    d.exec("DROP TRIGGER refuse_shaping_rekey");
  }
  assert.match(String(warnings[0]), /could not carry task rekey-fails's shaping record/);
  assert.equal(db.getTask("rekey-fails")?.sessionId, "after", "the successor was bound");
  assert.equal(db.taskWorkEpisodeForTask("rekey-fails")?.sessionId, "after", "to the same episode");
  assert.equal(db.getTask("rekey-fails")?.shaping?.sessionId, "before", "the record still names the prior session");
  assert.equal(currentShaping(registry.getTask("rekey-fails")!), null, "so no reader shows it for the successor");
});

test("a resume whose transaction rolls back leaves the record on the original session, in memory and on disk", () => {
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "rollback-resume", status: "running", sessionId: "kept" }));
  const episode = (sessionId: string) => ({
    episodeId: "e-rb", sessionId, agentSessionId: "agent-rb", branch: null, prUrl: null, prHeadSha: null, mergedAt: null,
    promptedAt: null, awaitingAgentRebind: false, rebindFromTranscriptPath: null, startedAt: 1, updatedAt: 1,
  });
  assert.equal(registry.bindTaskToWorkEpisode("rollback-resume", "kept", episode("kept")), true);
  registry.commitTaskShaping("rollback-resume", "kept", record("kept"), "text");
  db.replaceSessionWorkEpisode(episode("lost"));
  const resumed = { ...registry.getTask("rollback-resume")!, sessionId: "lost" };
  // The carry runs inside the transaction; a later write in it fails and everything rolls back.
  assert.throws(() => db.inTransaction(() => {
    registry.persistResumedTask(resumed, "lost");
    throw new Error("a later write in the resume failed");
  }), /a later write in the resume failed/);
  assert.equal(db.getTask("rollback-resume")?.shaping?.sessionId, "kept", "the database rolled back");
  assert.equal(registry.getTask("rollback-resume")?.shaping?.sessionId, "kept", "and memory was never told otherwise");
  assert.ok(currentShaping(registry.getTask("rollback-resume")!), "so the original session still shows its context");
  // A later publish of the task reads what was committed, which is still the original session.
  registry.upsertTask({ ...registry.getTask("rollback-resume")!, priority: "high" });
  assert.equal(registry.getTask("rollback-resume")?.shaping?.sessionId, "kept");
});

test("a commit for a task deleted while its worker started writes nothing", () => {
  db.upsertTask(mkTask({ id: "deleted", status: "running", sessionId: "s1" }));
  db.deleteTask("deleted");
  assert.equal(db.commitTaskShaping("deleted", record("s1"), "late text", 1), false);
  assert.equal(db.getTaskShapingText("deleted"), null, "no delivered text outlives its task");
  assert.equal(db.getTask("deleted"), undefined);
});

function setFlag(enabled: boolean): void {
  assert.equal(flags.applyFeatureFlagIntent({ kind: "flag", id: "task-shaping", enabled }).ok, true);
}

/** Every `task_upsert` record for `taskId` while `run` runs. */
function eventRecords(registry: InstanceType<typeof Registry>, taskId: string, run: () => void): Array<TaskShaping | undefined> {
  const seen: Array<TaskShaping | undefined> = [];
  const onEvent = (event: { type: string; task?: { id: string; shaping?: TaskShaping } }) => {
    if (event.type === "task_upsert" && event.task?.id === taskId) seen.push(event.task.shaping);
  };
  registry.on("event", onEvent);
  try {
    run();
  } finally {
    registry.off("event", onEvent);
  }
  return seen;
}

test("task events and the snapshot carry only the current session's record", () => {
  setFlag(true);
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "events", status: "running", sessionId: "first" }));
  registry.commitTaskShaping("events", "first", record("first"), "text");
  // The current session's record does leave the daemon while the flag is on.
  assert.deepEqual(eventRecords(registry, "events", () => registry.upsertTask({ ...registry.getTask("events")!, priority: "high" })),
    [registry.getTask("events")?.shaping]);
  assert.equal(registry.snapshot().tasks.find((task) => task.id === "events")?.shaping?.sessionId, "first");
  // A redispatch onto another session: memory keeps the earlier record, the wire never does.
  const seen = eventRecords(registry, "events", () => registry.upsertTask({ ...registry.getTask("events")!, sessionId: "second" }));
  assert.equal(registry.getTask("events")?.shaping?.sessionId, "first", "memory still holds it");
  assert.deepEqual(seen, [undefined], "the event does not carry a record that names another session");
  const snap = registry.snapshot().tasks.find((task) => task.id === "events");
  assert.equal(snap?.shaping, undefined, "and neither does the snapshot");
});

test("with the flag off, task events and the snapshot carry no record, and turning it on shows it again", () => {
  setFlag(true);
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "flag-events", status: "running", sessionId: "s1" }));
  registry.commitTaskShaping("flag-events", "s1", record("s1"), "text");
  setFlag(false);
  try {
    const seen = eventRecords(registry, "flag-events", () => registry.upsertTask({ ...registry.getTask("flag-events")!, priority: "high" }));
    assert.deepEqual(seen, [undefined], "an edit's event hides it");
    assert.equal(registry.snapshot().tasks.find((task) => task.id === "flag-events")?.shaping, undefined, "and so does a reconnect's snapshot");
    assert.equal(db.getTask("flag-events")?.shaping?.sessionId, "s1", "nothing was deleted");
  } finally {
    setFlag(true);
  }
  assert.equal(registry.snapshot().tasks.find((task) => task.id === "flag-events")?.shaping?.sessionId, "s1");
});

test("with the flag off, a session's task card carries no record in the snapshot or its updates", () => {
  setFlag(true);
  const registry = new Registry();
  registry.registerSdkSession({ id: "sdk:card-session", agent: "claude", name: "Card", cwd: "/repo/card" });
  registry.upsertTask(mkTask({ id: "card", status: "running", sessionId: "sdk:card-session", worktreePath: "/repo/card" }));
  registry.commitTaskShaping("card", "sdk:card-session", record("sdk:card-session"), "text");
  const card = () => registry.snapshot().sessions.find((session) => session.id === "sdk:card-session")?.task;
  assert.equal(card()?.shaping?.sessionId, "sdk:card-session", "the card carries its launch's record while the flag is on");
  setFlag(false);
  const cards: unknown[] = [];
  const onEvent = (event: { type: string; session?: { id: string; task?: { shaping?: unknown } | null } }) => {
    if (event.type === "session_upsert" && event.session?.id === "sdk:card-session") cards.push(event.session.task?.shaping);
  };
  registry.on("event", onEvent);
  try {
    assert.ok(card(), "the card itself is still there");
    assert.equal(card()?.shaping, undefined, "a reconnect's snapshot hides it");
    registry.upsertTask({ ...registry.getTask("card")!, priority: "high" });
    // The card was cached while the flag was on; what leaves the daemon is gated anyway.
    registry.commitTaskShaping("card", "sdk:card-session", record("sdk:card-session", "degraded"), "");
  } finally {
    registry.off("event", onEvent);
    setFlag(true);
  }
  assert.ok(cards.length > 0, "the session was published");
  assert.deepEqual(cards.filter((shaping) => shaping !== undefined), [], "and no update carried a record");
  assert.equal(card()?.shaping?.state, "degraded", "turning the flag back on shows it again");
});

test("with the flag off, a step still running shows no progress mark in task events or the snapshot", () => {
  setFlag(true);
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "progress", status: "dispatching" }));
  registry.setTaskShapingContext("progress", true);
  assert.ok(registry.snapshot().tasks.find((task) => task.id === "progress")?.shapingContext, "shown while the flag is on");
  setFlag(false);
  const marks: unknown[] = [];
  const onEvent = (event: { type: string; task?: { id: string; shapingContext?: unknown } }) => {
    if (event.type === "task_upsert" && event.task?.id === "progress") marks.push(event.task.shapingContext);
  };
  registry.on("event", onEvent);
  try {
    assert.equal(registry.snapshot().tasks.find((task) => task.id === "progress")?.shapingContext, undefined, "a reconnect sees no step");
    registry.upsertTask({ ...registry.getTask("progress")!, priority: "high" });
  } finally {
    registry.off("event", onEvent);
    registry.setTaskShapingContext("progress", false);
    setFlag(true);
  }
  assert.ok(marks.length > 0);
  assert.deepEqual(marks.filter((mark) => mark !== undefined), [], "and no update carries it");
});

test("turning the flag back on publishes every task and session card that has a record", () => {
  setFlag(true);
  const registry = new Registry();
  registry.registerSdkSession({ id: "sdk:republish", agent: "claude", name: "Republish", cwd: "/repo/republish" });
  registry.upsertTask(mkTask({ id: "republish", status: "running", sessionId: "sdk:republish", worktreePath: "/repo/republish" }));
  registry.upsertTask(mkTask({ id: "republish-plain", status: "backlog" }));
  // A first dispatch still in its shaping step: no record yet, only the progress mark.
  registry.upsertTask(mkTask({ id: "republish-shaping", status: "dispatching" }));
  registry.setTaskShapingContext("republish-shaping", true);
  registry.commitTaskShaping("republish", "sdk:republish", record("sdk:republish"), "text");
  setFlag(false);
  registry.emitFeatureFlags(flags.getFeatureFlagsConfig());
  const tasks: Array<{ id: string; shaping: unknown; shapingContext?: unknown }> = [];
  const cards: unknown[] = [];
  const onEvent = (event: { type: string; task?: { id: string; shaping?: unknown }; session?: { id: string; task?: { shaping?: unknown } | null } }) => {
    if (event.type === "task_upsert" && event.task) tasks.push({ id: event.task.id, shaping: event.task.shaping, shapingContext: (event.task as { shapingContext?: unknown }).shapingContext });
    if (event.type === "session_upsert" && event.session?.id === "sdk:republish") cards.push(event.session.task?.shaping);
  };
  registry.on("event", onEvent);
  try {
    setFlag(true);
    registry.emitFeatureFlags(flags.getFeatureFlagsConfig());
    // A config write that leaves the flag on sends nothing more.
    registry.emitFeatureFlags({ ...flags.getFeatureFlagsConfig(), enableAll: !flags.getFeatureFlagsConfig().enableAll });
  } finally {
    registry.off("event", onEvent);
  }
  // Tasks earlier tests left in this database carry records too; these two are this test's.
  const own = tasks.filter((task) => task.id.startsWith("republish"));
  assert.deepEqual(own.map((task) => task.id).sort(), ["republish", "republish-shaping"], "the task with a record and the one still shaping, once each");
  assert.ok(own.find((task) => task.id === "republish-shaping")?.shapingContext, "the running step's mark goes out again");
  registry.setTaskShapingContext("republish-shaping", false);
  assert.ok(tasks.every((task) => task.shaping !== undefined || task.shapingContext), "a task with neither is not sent again");
  assert.equal((own[0]?.shaping as TaskShaping | undefined)?.sessionId, "sdk:republish");
  assert.equal(cards.length, 1);
  assert.equal((cards[0] as TaskShaping | undefined)?.sessionId, "sdk:republish");
});

test("a failed commit for the same session hides the record it was meant to replace", () => {
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "same-session", status: "running", sessionId: "kept" }));
  registry.commitTaskShaping("same-session", "kept", record("kept"), "first text");
  let calls = 0;
  registry.shapingCommitter = (taskId, summary, text) => {
    calls += 1;
    // The handover's write fails; the clean-up that follows it succeeds.
    if (calls === 1) throw new Error("disk full");
    return db.commitTaskShaping(taskId, summary, text);
  };
  try {
    assert.equal(registry.commitTaskShaping("same-session", "kept", record("kept", "degraded"), ""), false);
  } finally {
    registry.shapingCommitter = null;
  }
  assert.equal(registry.getTask("same-session")?.shaping, undefined, "the earlier delivery's context is not shown as this one's");
  assert.equal(db.getTask("same-session")?.shaping, undefined, "and is cleared on disk");
  assert.equal(db.getTaskShapingText("same-session"), null);
});

test("a failed unshaped commit to the same session hides that session's earlier record too", () => {
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "same-unshaped", status: "running", sessionId: "kept" }));
  registry.commitTaskShaping("same-unshaped", "kept", record("kept"), "first text");
  let cleanups = 0;
  // A handover no shaper applied to: its clearing write fails, the clean-up that follows succeeds.
  registry.shapingCommitter = () => { throw new Error("disk full"); };
  registry.shapingClearer = (taskId, sessionId) => { cleanups += 1; return db.clearTaskShapingFor(taskId, sessionId); };
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(registry.commitTaskShaping("same-unshaped", "kept", null, ""), false);
  } finally {
    console.warn = warn;
    registry.shapingCommitter = null;
    registry.shapingClearer = null;
  }
  assert.equal(cleanups, 1, "the clean-up ran although the launch carried no summary");
  assert.equal(currentShaping(registry.getTask("same-unshaped")!), null, "the earlier delivery's context is not shown as this one's");
  assert.equal(db.getTask("same-unshaped")?.shaping, undefined);
});

test("a clean-up that fails too is retried after the handover's own task write, so a restart reads nothing back", () => {
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "double-fault", status: "backlog", sessionId: null }));
  registry.upsertTask({ ...registry.getTask("double-fault")!, status: "running", sessionId: "kept" });
  registry.commitTaskShaping("double-fault", "kept", record("kept"), "first text");
  registry.upsertTask({ ...registry.getTask("double-fault")!, status: "backlog", sessionId: null });
  let clearFails = true;
  registry.shapingCommitter = () => { throw new Error("disk full"); };
  registry.shapingClearer = (taskId, sessionId) => {
    if (clearFails) throw new Error("still full");
    return db.clearTaskShapingFor(taskId, sessionId);
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    // Handed back to the session it ran on: both the commit and its clean-up fail.
    assert.equal(registry.commitTaskShaping("double-fault", "kept", null, ""), false);
    assert.equal(db.getTask("double-fault")?.shaping?.sessionId, "kept", "the earlier record is still on disk");
    clearFails = false;
    // The handover's own write, which binds the task to that session again.
    registry.upsertTask({ ...registry.getTask("double-fault")!, status: "running", sessionId: "kept" });
  } finally {
    console.warn = warn;
    registry.shapingCommitter = null;
    registry.shapingClearer = null;
  }
  assert.equal(db.getTask("double-fault")?.shaping, undefined, "the retry cleared it once writes succeeded");
  assert.equal(db.getTaskShapingText("double-fault"), null);
  assert.equal(currentShaping(new Registry().getTask("double-fault")!), null, "so a restart shows no earlier context");
});

test("a pending clean-up never removes a record a later commit wrote", () => {
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "later-commit", status: "running", sessionId: "kept" }));
  registry.commitTaskShaping("later-commit", "kept", record("kept"), "first text");
  registry.shapingCommitter = () => { throw new Error("disk full"); };
  registry.shapingClearer = () => { throw new Error("still full"); };
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(registry.commitTaskShaping("later-commit", "kept", null, ""), false);
  } finally {
    console.warn = warn;
    registry.shapingCommitter = null;
    registry.shapingClearer = null;
  }
  // The next delivery to the same session commits normally, then the task is written again.
  assert.equal(registry.commitTaskShaping("later-commit", "kept", record("kept", "degraded"), ""), true);
  registry.upsertTask({ ...registry.getTask("later-commit")!, priority: "high" });
  assert.equal(db.getTask("later-commit")?.shaping?.state, "degraded", "the later delivery's record stands");
});

test("a restart reads the record back with the task", () => {
  db.upsertTask(mkTask({ id: "restart", status: "running", sessionId: "live" }));
  db.commitTaskShaping("restart", record("live"), "text", 1);
  const registry = new Registry();
  assert.equal(registry.getTask("restart")?.shaping?.sessionId, "live");
});

test("a durable read hides a superseded record while its clean-up is pending", async () => {
  const { taskShapingForReads } = await import("../src/server/shaping/reads.ts");
  setFlag(true);
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "durable-pending", status: "running", sessionId: "kept" }));
  registry.commitTaskShaping("durable-pending", "kept", record("kept"), "first text");
  registry.shapingCommitter = () => { throw new Error("disk full"); };
  registry.shapingClearer = () => { throw new Error("still full"); };
  const warn = console.warn;
  console.warn = () => {};
  try {
    // Handed back to the same session: the commit and its clean-up both fail.
    assert.equal(registry.commitTaskShaping("durable-pending", "kept", null, ""), false);
    const durable = db.getTask("durable-pending")!;
    assert.equal(durable.shaping?.sessionId, "kept", "the stale record is still on disk and names this session");
    // What MCP's `get_task` and `list_tasks` project from that row.
    assert.equal(taskShapingForReads(durable).shaping, undefined, "and no durable read presents it as current");
  } finally {
    console.warn = warn;
    registry.shapingCommitter = null;
    registry.shapingClearer = null;
  }
  // Once the clean-up succeeds, nothing is pending and nothing stale is left to hide.
  registry.upsertTask({ ...registry.getTask("durable-pending")!, priority: "high" });
  assert.equal(db.getTask("durable-pending")?.shaping, undefined);
});

test("deleting a task drops a clean-up still pending for it", async () => {
  const reads = await import("../src/server/shaping/reads.ts");
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "deleted-pending", status: "backlog", sessionId: null }));
  reads.noteSupersededShaping("deleted-pending", "kept");
  assert.equal(reads.supersededShapingFor("deleted-pending"), "kept");
  registry.removeTask("deleted-pending");
  assert.equal(reads.supersededShapingFor("deleted-pending"), undefined, "nothing is left pending for a task that is gone");
});
