import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Phase 1 run rows open safely with the new loop columns and delivery tables.

const home = mkdtempSync(join(tmpdir(), "mission-residents-upgrade-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

// A pre-loop database with live, pending, failed and ended Phase 1 runs.
const raw = new DatabaseSync(join(home, "harness.db"));
raw.exec(`CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO app_config (key, value) VALUES ('ui', '{}');
          CREATE TABLE resident_runs (
            id TEXT PRIMARY KEY NOT NULL, profile_id TEXT NOT NULL, profile_revision INTEGER NOT NULL,
            task_id TEXT NOT NULL, launch_request_id TEXT NOT NULL, launch_input TEXT NOT NULL,
            launch_repo_spelling TEXT NOT NULL DEFAULT '', launch_state TEXT NOT NULL, launch_error TEXT,
            persona_snapshot TEXT NOT NULL, run_instructions TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, ended_at INTEGER
          );`);
for (const [id, state, ended] of [["live", "launched", null], ["pending", "pending", null], ["failed", "failed", 2], ["ended", "launched", 2]] as const) {
  raw.prepare(`INSERT INTO resident_runs (id, profile_id, profile_revision, task_id, launch_request_id, launch_input,
    launch_state, persona_snapshot, created_at, ended_at) VALUES (?, 'old-profile', 1, ?, ?, ?, ?, ?, 1, ?)`).run(
    id, id, id, JSON.stringify({ version: 1, repoRoot: "/repo", instructions: "" }), state,
    JSON.stringify({ personaId: "p", name: "Observer", guidanceMarkdown: "" }), ended);
}
raw.close();

const { openDb } = await import("../src/server/db.ts");
const store = await import("../src/server/residents/store.ts");

test("an upgraded database preserves Phase 1 runs and gains loop tables with the idempotency key enforced", () => {
  const db = openDb();
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'resident_%'`)
    .all() as Array<{ name: string }>).map((row) => row.name).sort();
  assert.deepEqual(tables, ["resident_iterations", "resident_pacing_calls", "resident_profile_revisions", "resident_profiles", "resident_runs"]);
  const runColumns = db.prepare(`PRAGMA table_info(resident_runs)`).all() as Array<{ name: string; notnull: number }>;
  for (const column of ["launch_request_id", "launch_input", "launch_repo_spelling", "launch_state", "task_id", "persona_snapshot"]) {
    assert.equal(runColumns.find((c) => c.name === column)?.notnull, 1, `${column} must be NOT NULL`);
  }
  const indexes = db.prepare(`PRAGMA index_list(resident_runs)`).all() as Array<{ name: string; unique: number }>;
  assert.equal(indexes.find((index) => index.name === "idx_resident_runs_request")?.unique, 1);
  assert.deepEqual(store.listLiveResidentProfiles(), []);
  assert.equal((db.prepare(`SELECT value FROM app_config WHERE key = 'ui'`).get() as { value: string }).value, "{}");
});

test("Phase 1 run rows receive defaults and only a launched live run is adopted once", async () => {
  const { ResidentProfileRevisionSchema } = await import("../src/shared/residents.ts");
  store.createResidentProfile({ id: "old-profile", at: 1, settings: ResidentProfileRevisionSchema.parse({ identity: { name: "Old profile" }, persona: { personaId: "p" } }) });
  for (const id of ["live", "pending", "failed", "ended"]) {
    const run = store.getResidentRun(id)!.run;
    assert.equal(run.iteration, 0); assert.equal(run.lastSeq, 0); assert.equal(run.nextWakeAt, null);
    assert.equal(run.settings.loop.delaySeconds, 300);
    store.adoptResidentLaunch(id, 100); store.adoptResidentLaunch(id, 200);
    assert.equal(store.getResidentRun(id)!.run.iteration, id === "live" ? 1 : 0);
  }
  assert.deepEqual(openDb().prepare("SELECT run_id, seq, trigger, delivery, claimed_at FROM resident_iterations").all().map(row => ({ ...row })),
    [{ run_id: "live", seq: 1, trigger: "launch", delivery: "sent", claimed_at: 100 }]);
});
