import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-goal-migration-"));
process.env.MISSION_HOME = home;

const raw = new DatabaseSync(join(home, "harness.db"));
raw.exec(`
  CREATE TABLE session_goals (
    note_key   TEXT PRIMARY KEY,
    text       TEXT,
    source     TEXT NOT NULL DEFAULT 'heuristic',
    prompt     TEXT,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO session_goals (note_key, text, source, prompt, updated_at)
  VALUES ('legacy-session', 'Ship the existing feature', 'model', 'ship the feature', 1234);
`);
raw.close();

const { openDb, getSessionGoal } = await import("../src/server/db.ts");
const db = openDb();

after(() => rmSync(home, { recursive: true, force: true }));

test("an existing goal table gains the durable intent columns", () => {
  const columns = db.prepare("PRAGMA table_info(session_goals)").all() as unknown as Array<{
    name: string;
  }>;
  const names = new Set(columns.map((column) => column.name));
  for (const name of [
    "objective",
    "focus",
    "relationship",
    "rationale",
    "objective_version",
    "prompt_revision",
    "resolved_prompt_revision",
    "pending_prompts",
  ]) {
    assert.ok(names.has(name), `missing migrated column ${name}`);
  }
});

test("a legacy model goal remains a resolved initial objective after migration", () => {
  const goal = getSessionGoal("legacy-session");
  assert.ok(goal);
  assert.equal(goal.objective, "Ship the existing feature");
  assert.equal(goal.text, "Ship the existing feature");
  assert.equal(goal.objectiveVersion, 1);
  assert.equal(goal.promptRevision, 1);
  assert.equal(goal.resolvedPromptRevision, 1);
  assert.deepEqual(goal.pendingPrompts, []);
});

test("a legacy unresolved revision gap becomes a fail-closed queue barrier", () => {
  db.prepare(
    `UPDATE session_goals
        SET prompt = ?, prompt_revision = 3, resolved_prompt_revision = 1,
            pending_prompts = '[]'
      WHERE note_key = ?`,
  ).run("latest steering prompt", "legacy-session");

  const goal = getSessionGoal("legacy-session");
  assert.ok(goal);
  assert.deepEqual(goal.pendingPrompts, [
    { revision: 2, prompt: null },
    { revision: 3, prompt: "latest steering prompt" },
  ]);
  assert.equal(goal.resolvedPromptRevision, 1);
});
