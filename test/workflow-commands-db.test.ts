import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WORKFLOW_CHECK_SLOTS } from "../src/shared/workflow.ts";

// What is at stake: the Command catalog is where an executable argv now LIVES, and this file
// is the one that opens a database written by a build that had no such table. Two things can
// go wrong and neither is visible at runtime afterwards. The tables can fail to arrive on an
// upgraded database, which takes the daemon down for every existing operator rather than for
// nobody. Or the one-time import can run twice - and because the only marker it has is the
// catalog's own emptiness, a second run would resurrect commands an operator had deleted,
// re-authorising an argv they removed on purpose.
//
// The fixture is therefore hand-written at the OLD schema. An upgrade test that builds its
// fixture from `db.ts` would create the tables itself and then assert they exist.

const home = mkdtempSync(join(tmpdir(), "mission-workflow-commands-db-"));
process.env.MISSION_HOME = home;

/** Two overrides and one duplicate, exactly as an operator's `app_config` blob would hold them. */
const LEGACY_COMMANDS = [
  { repoRoot: "/repo", slot: "test", command: ["npm", "test"] },
  { repoRoot: "/repo/packages/web", slot: "test", command: ["pnpm", "-C", ".", "test"] },
  { repoRoot: "/repo", slot: "lint", command: ["npm", "run", "lint"] },
  // Neither of these may reach the catalog: one names a slot this build does not have, the
  // other an empty argv. The rows beside them must survive, which is the whole reason the
  // migration parses element by element rather than asking whether the blob is readable.
  { repoRoot: "/repo", slot: "nope", command: ["x"] },
  { repoRoot: "/repo", slot: "build", command: [] },
];

/**
 * The database of a build that shipped before the Command catalog: a workflow family with
 * real rows, a stored `workflows` config blob carrying commands, and no command tables.
 */
function seedPreCatalogDb(): void {
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec(`
    CREATE TABLE IF NOT EXISTS app_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS personas (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      guidance_md     TEXT NOT NULL,
      runner_id       TEXT,
      model_id        TEXT,
      revision        INTEGER NOT NULL DEFAULT 1,
      archived_at     INTEGER,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
  `);
  raw.prepare(
    `INSERT INTO personas (id, name, normalized_name, description, guidance_md, runner_id,
       model_id, revision, archived_at, created_at, updated_at)
     VALUES ('legacy-judge', 'Legacy Judge', 'legacy judge', '', '# Judge', NULL, NULL, 2, NULL, 1, 1)`,
  ).run();
  raw.prepare(`INSERT INTO app_config (key, value) VALUES ('workflows', ?)`).run(
    JSON.stringify({
      liveEnabled: false,
      repoAllowlist: ["/repo"],
      checksEnabled: true,
      defaultWorkflowId: "workflow-legacy",
      retention: { rawEvidenceDays: 7, completedRunDays: 60, maxCompletedRuns: 500 },
      checkCommands: LEGACY_COMMANDS,
    }),
  );
  raw.close();
}

seedPreCatalogDb();

const { openDb, getAppConfig } = await import("../src/server/db.ts");
const { WorkflowStore } = await import("../src/server/workflows/store.ts");
const { Registry } = await import("../src/server/registry.ts");
const { WorkflowCommandManager } = await import("../src/server/workflows/commands.ts");
const { getWorkflowPolicy } = await import("../src/server/workflows/config.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const db = openDb();

test("an upgrading database receives both command tables without losing what it held", () => {
  const tables = (db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'workflow_command%'`,
  ).all() as unknown as Array<{ name: string }>).map((row) => row.name).sort();
  assert.deepEqual(tables, ["workflow_command_overrides", "workflow_commands"]);

  assert.deepEqual(
    (db.prepare(`PRAGMA table_info(workflow_commands)`).all() as unknown as Array<{ name: string }>)
      .map((column) => column.name),
    // `max_runs` sits where `CREATE TABLE` puts it, because this fixture had no
    // `workflow_commands` table at all. A database that DID carry one gets the same column
    // appended by `addColumn` instead, which is a different order and the same schema - see
    // the upgrade case below.
    ["slot", "default_command_json", "max_runs", "revision", "created_at", "updated_at"],
  );
  assert.deepEqual(
    (db.prepare(`PRAGMA table_info(workflow_command_overrides)`)
      .all() as unknown as Array<{ name: string }>).map((column) => column.name),
    ["slot", "repo_root", "command_json", "created_at", "updated_at"],
  );
  // Nothing the database already held moved.
  assert.equal(new WorkflowStore(db).getPersona("legacy-judge")?.revision, 2);
});

test("the override key is composite and enforced by the database, not only by a schema", () => {
  const unique = (db.prepare(`PRAGMA index_list(workflow_command_overrides)`)
    .all() as unknown as Array<{ name: string; unique: number }>)
    .filter((index) => index.unique === 1)
    .map((index) => (db.prepare(`PRAGMA index_info(${index.name})`).all() as unknown as Array<{
      name: string;
    }>).map((column) => column.name).join(","));
  assert.ok(
    unique.some((columns) => columns === "slot,repo_root"),
    "two commands for one repository and slot must be impossible at the storage layer",
  );
});

test("the slot column carries no CHECK, so appending a fifth slot stays a one-line change", () => {
  // A CHECK here would be a constraint on an APPEND-ONLY list, which means the next slot this
  // product ships would require rebuilding a table full of operator data.
  const sql = (db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workflow_commands'`,
  ).get() as { sql: string }).sql;
  assert.equal(/\bCHECK\b/i.test(sql), false);
});

test("the fresh CREATE TABLE block is the upgrade path, so it names both tables", () => {
  // At RUNTIME a fresh database and a migrated one are indistinguishable - the CREATE TABLE
  // block runs on every open - so the only place an omission would be visible is the source.
  const source = readFileSync(new URL("../src/server/db.ts", import.meta.url), "utf8");
  assert.match(source, /CREATE TABLE IF NOT EXISTS workflow_commands \(/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS workflow_command_overrides \(/);
  assert.match(source, /PRIMARY KEY \(slot, repo_root\)/);
});

test("the legacy commands import once, as overrides, with no global default invented", () => {
  const registry = new Registry();
  const manager = new WorkflowCommandManager(registry, new WorkflowStore(db));

  const views = manager.list();
  assert.deepEqual(views.map((view) => view.slot), [...WORKFLOW_CHECK_SLOTS]);
  assert.deepEqual(
    views.find((view) => view.slot === "test")?.overrides,
    [
      { repoRoot: "/repo", command: ["npm", "test"] },
      { repoRoot: "/repo/packages/web", command: ["pnpm", "-C", ".", "test"] },
    ],
  );
  assert.deepEqual(
    views.find((view) => view.slot === "lint")?.overrides,
    [{ repoRoot: "/repo", command: ["npm", "run", "lint"] }],
  );
  // The two invalid rows imported nothing, and took nothing valid with them.
  assert.deepEqual(views.find((view) => view.slot === "build")?.overrides, []);
  assert.deepEqual(views.find((view) => view.slot === "typecheck")?.overrides, []);

  // NO global default is inferred. That `/repo` runs `npm test` is not evidence the same
  // argv is right, or safe, in every checkout a workflow may reach.
  assert.ok(views.every((view) => view.defaultCommand === null));

  // Policy is untouched by the import, field for field.
  const policy = getWorkflowPolicy();
  assert.equal(policy.checksEnabled, true);
  assert.equal(policy.liveEnabled, false);
  assert.deepEqual(policy.repoAllowlist, ["/repo"]);
  assert.equal(policy.defaultWorkflowId, "workflow-legacy");
  assert.deepEqual(policy.retention, {
    rawEvidenceDays: 7,
    completedRunDays: 60,
    maxCompletedRuns: 500,
  });

  // And the old list is gone from `app_config`, so there is exactly one durable copy of an
  // argv the daemon will execute.
  assert.equal(
    "checkCommands" in (getAppConfig<Record<string, unknown>>("workflows") ?? {}),
    false,
  );
});

test("a second start imports nothing, and cannot resurrect a command an operator deleted", () => {
  const store = new WorkflowStore(db);
  // The operator removes the package override and the whole lint slot.
  const before = store.getWorkflowCommand("test")!;
  assert.equal(
    store.replaceWorkflowCommandCas("test", before.revision, {
      defaultCommand: null,
      maxRuns: 1,
      overrides: [{ repoRoot: "/repo", command: ["npm", "test"] }],
    }).ok,
    true,
  );
  const lint = store.getWorkflowCommand("lint")!;
  assert.equal(
    store.replaceWorkflowCommandCas("lint", lint.revision, {
      defaultCommand: null,
      maxRuns: 1,
      overrides: [],
    }).ok,
    true,
  );

  // A restart. The catalog is non-empty, so the import is a no-op whatever the old blob said.
  new WorkflowCommandManager(new Registry(), store);

  assert.deepEqual(store.getWorkflowCommand("test")?.overrides, [
    { repoRoot: "/repo", command: ["npm", "test"] },
  ]);
  assert.deepEqual(store.getWorkflowCommand("lint")?.overrides, []);
});

test("opening twice is idempotent, as every start of the daemon is", () => {
  const again = openDb();
  assert.equal(
    (again.prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'
         AND name IN ('workflow_commands', 'workflow_command_overrides')`,
    ).get() as { n: number }).n,
    2,
  );
  assert.equal(
    (again.prepare(`SELECT COUNT(*) AS n FROM workflow_commands`).get() as { n: number }).n,
    WORKFLOW_CHECK_SLOTS.length,
  );
});
