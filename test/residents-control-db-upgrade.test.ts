import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// An operator's database from Phase 2 of residents - resident tables with a live, launched run,
// and no session-control columns - gains the four grant columns nullable, and every run it
// already held reads as never granted: nothing from before this phase is regranted by a restart.

const home = mkdtempSync(join(tmpdir(), "mission-residents-control-upgrade-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

// The Phase 2 resident schema, verbatim, with one profile whose revision predates the authority
// section and one open run pinned to it.
const raw = new DatabaseSync(join(home, "harness.db"));
raw.exec(`
  CREATE TABLE resident_profiles (
    id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, normalized_name TEXT NOT NULL,
    revision INTEGER NOT NULL, archived_at INTEGER, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX idx_resident_profiles_live_name
    ON resident_profiles(normalized_name) WHERE archived_at IS NULL;
  CREATE TABLE resident_profile_revisions (
    profile_id TEXT NOT NULL, revision INTEGER NOT NULL, settings_json TEXT NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY (profile_id, revision)
  );
  CREATE TABLE resident_runs (
    id TEXT PRIMARY KEY NOT NULL, profile_id TEXT NOT NULL, profile_revision INTEGER NOT NULL,
    task_id TEXT NOT NULL, launch_request_id TEXT NOT NULL, launch_input TEXT NOT NULL,
    launch_repo_spelling TEXT NOT NULL DEFAULT '', launch_state TEXT NOT NULL, launch_error TEXT,
    persona_snapshot TEXT NOT NULL, run_instructions TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL, ended_at INTEGER
  );
  CREATE UNIQUE INDEX idx_resident_runs_request ON resident_runs(launch_request_id);
  CREATE INDEX idx_resident_runs_task ON resident_runs(task_id);
  CREATE INDEX idx_resident_runs_open ON resident_runs(launch_state) WHERE ended_at IS NULL;
  INSERT INTO resident_profiles VALUES ('p1', 'Triage Bot', 'triage bot', 1, NULL, 1, 1);
  INSERT INTO resident_profile_revisions VALUES ('p1', 1,
    '{"board":{"colorId":"cyan","label":null,"pin":true},"execution":{"agent":"claude","effort":null,"model":null},"identity":{"description":"","name":"Triage Bot"},"instructions":{"markdown":""},"persona":{"personaId":"builtin:fleet-triage"},"workspace":{"defaultRepoRoot":"/work/repo"}}',
    1);
  INSERT INTO resident_runs VALUES ('r1', 'p1', 1, 't1', 'req-1',
    '{"instructions":"","repoRoot":"/work/repo","version":1}', '/work/repo', 'launched', NULL,
    '{"guidanceMarkdown":"Watch.","name":"Fleet Triage","personaId":"builtin:fleet-triage"}', '', 1, NULL);
`);
raw.close();

const { openDb } = await import("../src/server/db.ts");
const store = await import("../src/server/residents/store.ts");
const { residentRunControlRecorded } = await import("../src/shared/residents.ts");

test("a Phase 2 database gains nullable grant columns and its runs stay ungranted", () => {
  const columns = openDb().prepare(`PRAGMA table_info(resident_runs)`).all() as Array<{
    name: string;
    notnull: number;
    dflt_value: unknown;
  }>;
  for (const column of ["control_authorized_at", "control_conversation_id", "control_cwd", "control_episode_id"]) {
    const found = columns.find((c) => c.name === column);
    assert.ok(found, `${column} was added`);
    assert.equal(found.notnull, 0, `${column} is nullable`);
    assert.equal(found.dflt_value, null, `${column} has no default`);
  }
  const [open] = store.listOpenResidentRuns();
  assert.ok(open, "the existing run still reads");
  assert.equal(open.run.id, "r1");
  assert.deepEqual(open.run.control, { authorizedAt: null, conversationId: null, cwd: null, episodeId: null });
  assert.equal(residentRunControlRecorded(open.run.control), false);
  // Its pinned revision predates the authority section, so it reads as off.
  assert.equal(open.run.settings.authority.controlOtherSessions, false);
  // Re-opening runs the migration again without changing anything.
  assert.deepEqual(store.getResidentRun("r1")!.run.control, open.run.control);
});
