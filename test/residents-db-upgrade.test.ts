import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// An operator's database from before residents existed gains the three tables, empty, with
// the request-id index over a NOT NULL column - and the catalog reads as empty rather than
// failing.

const home = mkdtempSync(join(tmpdir(), "mission-residents-upgrade-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

// A pre-feature database: a real file with a table this build also creates, and no resident
// tables at all.
const raw = new DatabaseSync(join(home, "harness.db"));
raw.exec(`CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO app_config (key, value) VALUES ('ui', '{}');`);
raw.close();

const { openDb } = await import("../src/server/db.ts");
const store = await import("../src/server/residents/store.ts");

test("an upgraded database gains the resident tables empty, with the idempotency key enforced", () => {
  const db = openDb();
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'resident_%'`)
    .all() as Array<{ name: string }>).map((row) => row.name).sort();
  assert.deepEqual(tables, [
    "resident_mcp_secrets",
    "resident_profile_revisions",
    "resident_profiles",
    "resident_run_mcp_secrets",
    "resident_run_mcp_servers",
    "resident_runs",
  ]);
  const runColumns = db.prepare(`PRAGMA table_info(resident_runs)`).all() as Array<{ name: string; notnull: number }>;
  for (const column of ["launch_request_id", "launch_input", "launch_repo_spelling", "launch_state", "task_id", "persona_snapshot"]) {
    assert.equal(runColumns.find((c) => c.name === column)?.notnull, 1, `${column} must be NOT NULL`);
  }
  const indexes = db.prepare(`PRAGMA index_list(resident_runs)`).all() as Array<{ name: string; unique: number }>;
  assert.equal(indexes.find((index) => index.name === "idx_resident_runs_request")?.unique, 1);
  assert.deepEqual(store.listLiveResidentProfiles(), []);
  assert.equal((db.prepare(`SELECT value FROM app_config WHERE key = 'ui'`).get() as { value: string }).value, "{}");
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
