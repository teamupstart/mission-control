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

test("the one commit settles the summary and the text together, in each of the four combinations", () => {
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
  // Text and no summary cannot come from the engine, and the function still settles both.
  assert.equal(db.commitTaskShaping("combo", null, "orphan text", 30), true);
  assert.equal(db.getTask("combo")?.shaping, undefined);
  assert.equal(db.getTaskShapingText("combo")?.text, "orphan text");
  // Neither: a launch nothing shaped clears what an earlier one left.
  assert.equal(db.commitTaskShaping("combo", null, "", 40), true);
  assert.equal(db.getTask("combo")?.shaping, undefined);
  assert.equal(db.getTaskShapingText("combo"), null);
  // And a task with no record is not written to at all.
  assert.equal(db.commitTaskShaping("combo", null, "", 50), false);
});

test("a commit that fails part-way writes nothing", () => {
  db.upsertTask(mkTask({ id: "atomic", status: "running", sessionId: "s1" }));
  assert.equal(db.commitTaskShaping("atomic", record("s1"), "first text", 1), true);
  // A summary the schema refuses throws before anything is written, inside the transaction.
  const broken = { ...record("s2"), state: "unknown" } as unknown as TaskShaping;
  assert.throws(() => db.commitTaskShaping("atomic", broken, "second text", 2));
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
  registry.commitTaskShaping("resume", record("first"), "text");
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

test("a restart reads the record back with the task", () => {
  db.upsertTask(mkTask({ id: "restart", status: "running", sessionId: "live" }));
  db.commitTaskShaping("restart", record("live"), "text", 1);
  const registry = new Registry();
  assert.equal(registry.getTask("restart")?.shaping?.sessionId, "live");
});
