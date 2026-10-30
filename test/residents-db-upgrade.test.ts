import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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

test("Phase 1 rows upgrade with null workspace markers and keep their pinned revision and task repository", async () => {
  const { closeDb, upsertTask, getTask } = await import("../src/server/db.ts");
  const { mkTask } = await import("./helpers/session-fixture.ts");
  const { ResidentProfileRevisionSchema, residentLaunchInput, launchInputsMatch } = await import("../src/shared/residents.ts");
  const { taskHasRepository } = await import("../src/shared/task.ts");
  const settings = ResidentProfileRevisionSchema.parse({ identity: { name: "Existing resident" }, persona: { personaId: "p" } });
  store.createResidentProfile({ id: "phase1-profile", settings, at: 1 });
  upsertTask(mkTask({ id: "phase1-task", kind: "resident", repoRoot: "/existing/repo" }));
  store.reserveResidentRun({ id: "phase1-run", profileId: "phase1-profile", profileRevision: 1, taskId: "phase1-task",
    launchRequestId: "phase1-request", launchInput: { ...residentLaunchInput("/existing/repo", ""), version: 1 },
    repoSpelling: "/existing/repo", persona: { personaId: "p", name: "P", guidanceMarkdown: "Keep watching" }, runInstructions: "", at: 1 });
  store.markResidentRunLaunched("phase1-run", null);
  closeDb();
  // Exact Phase 1 table shapes, with real existing rows rather than an empty upgrade.
  const phase1 = new DatabaseSync(join(home, "harness.db"));
  phase1.exec("ALTER TABLE tasks DROP COLUMN workspace_kind; ALTER TABLE resident_runs DROP COLUMN workspace_dir; PRAGMA user_version = 9;");
  phase1.close();
  const backupRoot = join(home, "backups", "database");
  const previousBackups = new Set(readdirSync(backupRoot));
  const db = openDb();
  const newBackups = readdirSync(backupRoot).filter((name) => !previousBackups.has(name) && name.startsWith("pre-migration-"));
  assert.equal(newBackups.length, 1, "upgrading version 9 captures its own pre-migration recovery point");
  const recovery = new DatabaseSync(join(backupRoot, newBackups[0]!), { readOnly: true });
  try {
    assert.equal((recovery.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 9);
    assert.equal((recovery.prepare("PRAGMA table_info(resident_runs)").all() as Array<{ name: string }>).some((c) => c.name === "workspace_dir"), false);
    assert.equal((recovery.prepare("SELECT launch_state FROM resident_runs WHERE id = 'phase1-run'").get() as { launch_state: string }).launch_state, "launched");
  } finally {
    recovery.close();
  }
  const task = getTask("phase1-task")!;
  assert.equal(task.workspaceKind, null);
  assert.equal(task.repoRoot, "/existing/repo");
  assert.equal(taskHasRepository(task), true);
  const run = store.getResidentRun("phase1-run")!;
  assert.equal(run.run.workspaceDir, null);
  assert.equal(run.run.launchState, "launched");
  assert.equal(run.run.profileRevision, 1);
  assert.equal(run.run.persona.guidanceMarkdown, "Keep watching");
  assert.ok(launchInputsMatch(run.launchInput, residentLaunchInput("/existing/repo", "")));
  const columns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string; notnull: number }>;
  assert.equal(columns.find((column) => column.name === "repo_root")!.notnull, 1);
});

test("upgrading current main captures a recovery point before adding resident loop state", async () => {
  const { closeDb, CURRENT_DATABASE_SCHEMA_VERSION } = await import("../src/server/db.ts");
  closeDb();
  const previous = new DatabaseSync(join(home, "harness.db"));
  previous.exec("DROP TABLE resident_iterations; DROP TABLE resident_pacing_calls;");
  for (const column of ["loop_state", "iteration", "last_seq", "next_wake_at", "consumed_generation", "pause_reason", "wake_reason", "wake_request_delay_s", "wake_request_generation", "wake_request_reason"]) {
    previous.exec(`ALTER TABLE resident_runs DROP COLUMN ${column};`);
  }
  previous.exec("PRAGMA user_version = 10;");
  previous.close();
  const backupRoot = join(home, "backups", "database");
  const before = new Set(readdirSync(backupRoot));
  const db = openDb();
  const backups = readdirSync(backupRoot).filter(name => !before.has(name) && name.startsWith("pre-migration-"));
  assert.equal(backups.length, 1, "the Phase 7 schema receives a pre-loop recovery point");
  const recovery = new DatabaseSync(join(backupRoot, backups[0]!), { readOnly: true });
  try {
    assert.equal((recovery.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 10);
    assert.equal(recovery.prepare("SELECT name FROM sqlite_master WHERE name = 'resident_iterations'").get(), undefined);
  } finally { recovery.close(); }
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, CURRENT_DATABASE_SCHEMA_VERSION);
  const run = store.getResidentRun("phase1-run")!.run;
  assert.equal(run.workspaceDir, null);
  assert.equal(run.iteration, 0);
  assert.equal(run.loopState, "waiting");
});

test("schema 11 wakes upgrade without inventing authorship and native bindings survive reopen", async () => {
  const { closeDb, CURRENT_DATABASE_SCHEMA_VERSION } = await import("../src/server/db.ts");
  openDb().prepare(`INSERT INTO resident_iterations (run_id, seq, trigger, delivery, claimed_at)
    VALUES ('phase1-run', 2, 'loop', 'sent', 100)`).run();
  closeDb();
  const previous = new DatabaseSync(join(home, "harness.db"));
  previous.exec(`ALTER TABLE resident_iterations DROP COLUMN conversation_key;
    ALTER TABLE resident_iterations DROP COLUMN message_id;
    ALTER TABLE resident_iterations DROP COLUMN message_ts;
    PRAGMA user_version = 11;`);
  previous.close();
  const backupRoot = join(home, "backups", "database");
  const before = new Set(readdirSync(backupRoot));
  const db = openDb();
  const backups = readdirSync(backupRoot).filter(name => !before.has(name) && name.startsWith("pre-migration-"));
  assert.equal(backups.length, 1);
  const recovery = new DatabaseSync(join(backupRoot, backups[0]!), { readOnly: true });
  try {
    assert.equal((recovery.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 11);
    assert.equal(recovery.prepare("PRAGMA table_info(resident_iterations)").all().some(c => c.name === "conversation_key"), false);
    assert.equal(recovery.prepare("SELECT delivery FROM resident_iterations WHERE seq = 2").get()!.delivery, "sent");
  } finally { recovery.close(); }
  const query = "SELECT conversation_key, message_id, message_ts FROM resident_iterations WHERE run_id = 'phase1-run' AND seq = 2";
  assert.deepEqual({ ...db.prepare(query).get() }, { conversation_key: null, message_id: null, message_ts: null });
  db.prepare("UPDATE resident_iterations SET conversation_key = 'native', message_id = 'turn', message_ts = 100 WHERE seq = 2").run();
  closeDb();
  assert.deepEqual({ ...openDb().prepare(query).get() }, { conversation_key: "native", message_id: "turn", message_ts: 100 });
  assert.equal(openDb().prepare("PRAGMA user_version").get()!.user_version, CURRENT_DATABASE_SCHEMA_VERSION);
});
