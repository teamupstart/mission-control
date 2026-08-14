/**
 * What is at stake: every operator who has ever saved a Persona has rows in the table this
 * change adds a column to. A migration that only edited the `CREATE TABLE IF NOT EXISTS` block
 * would pass its own fresh-database test and then fail on every real machine, because that block
 * is a no-op once the table exists - the daemon would open and then every Persona read would ask
 * for a column that is not there.
 *
 * The second half is what the column MEANS on an upgraded database. A pre-feature row was
 * authored in the editor and genuinely has no source file, so it must read as `provenance: null`
 * rather than as anything a drift check would then go looking for on disk.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const home = mkdtempSync(join(tmpdir(), "mission-persona-migration-"));
process.env.MISSION_HOME = home;

const LEGACY_PERSONA_ID = "legacy-persona";
const LEGACY_GUIDANCE = "# Legacy Reviewer\r\n\r\nJudge the change.  \r\n";

/**
 * A `personas` table exactly as it shipped before provenance existed.
 *
 * Written out by hand rather than imported from `db.ts`, for the reason
 * `session-action-migration.test.ts` states about its own fixture: an upgrade test that builds
 * its fixture with the CURRENT schema proves nothing - it would create the new column itself and
 * then assert that the column exists.
 */
function seedPreProvenanceDb(): void {
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec(`
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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_personas_normalized_name
      ON personas(normalized_name);
  `);
  raw.prepare(
    `INSERT INTO personas (id, name, normalized_name, description, guidance_md, runner_id,
       model_id, revision, archived_at, created_at, updated_at)
     VALUES (?, 'Legacy Reviewer', 'legacy reviewer', 'Reads the diff', ?, NULL, NULL, 4, NULL,
             100, 200)`,
  ).run(LEGACY_PERSONA_ID, LEGACY_GUIDANCE);
  raw.close();
}

seedPreProvenanceDb();

const { openDb } = await import("../src/server/db.ts");
const { WorkflowStore } = await import("../src/server/workflows/store.ts");
const { normalizePersonaName } = await import("../src/shared/workflow.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const db = openDb();
const store = new WorkflowStore(db, []);

function personaColumns(handle = db): string[] {
  return (handle.prepare(`PRAGMA table_info(personas)`).all() as unknown as Array<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>).map((column) => column.name);
}

test("the migration adds the provenance column to a table that already existed", () => {
  assert.ok(personaColumns().includes("import_provenance_json"));
  const column = (db.prepare(`PRAGMA table_info(personas)`).all() as unknown as Array<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>).find((candidate) => candidate.name === "import_provenance_json");
  // Nullable with no default, which is the idiom for "a pre-feature row genuinely had nothing
  // here". A default would have invented a provenance record for every Persona ever authored.
  assert.equal(column?.notnull, 0);
  assert.equal(column?.dflt_value, null);
});

test("a pre-feature Persona reads back unchanged, with no provenance", () => {
  const persona = store.getPersona(LEGACY_PERSONA_ID);
  assert.equal(persona?.name, "Legacy Reviewer");
  assert.equal(persona?.description, "Reads the diff");
  // Byte-for-byte, CRLF and trailing space included: the migration is about a new column and
  // must not have been an opportunity to normalize the one that matters.
  assert.equal(persona?.guidanceMarkdown, LEGACY_GUIDANCE);
  assert.equal(persona?.revision, 4);
  assert.equal(persona?.createdAt, 100);
  assert.equal(persona?.updatedAt, 200);
  assert.equal(persona?.provenance, null);
  // And it is still in the catalog every draft and Publish resolves against.
  assert.equal(store.personaCatalog().some((row) => row.id === LEGACY_PERSONA_ID), true);
});

test("an upgraded database still takes ordinary writes, including a provenance-bearing insert", () => {
  const updated = store.updatePersonaCas(LEGACY_PERSONA_ID, 4, { description: "Edited after upgrade" });
  assert.equal(updated.ok, true);
  if (updated.ok) {
    assert.equal(updated.persona.revision, 5);
    // An edit that says nothing about provenance leaves the column alone rather than clearing it.
    assert.equal(updated.persona.provenance, null);
  }

  const imported = store.insertPersona({
    id: "imported-after-upgrade",
    name: "Imported Reviewer",
    normalizedName: normalizePersonaName("Imported Reviewer"),
    description: "",
    guidanceMarkdown: "# Imported Reviewer\n\nJudge it.",
    runner: null,
    model: null,
    createdAt: 300,
    updatedAt: 300,
    provenance: {
      sourcePath: "/plugins/agent-team/references/roles/reviewer.md",
      sourceRepo: "/plugins",
      pluginVersion: "0.1.1",
      sourceKey: null,
      catalogLabel: null,
      contentSha256: "a".repeat(64),
      importedAt: 300,
    },
  });
  assert.equal(imported.ok, true);
  if (imported.ok) {
    assert.equal(imported.persona.provenance?.pluginVersion, "0.1.1");
  }
});

/**
 * The fresh schema and the migrated one, checked where they can actually disagree.
 *
 * Not by opening a second database: `openDb` is a per-process singleton over a path resolved at
 * import, so a "fresh" open in this file is the same handle. And at RUNTIME the two cases are
 * indistinguishable anyway - `migrate()` runs on every open, so a fresh database missing the
 * column from its `CREATE TABLE` would silently be given one by `addColumn` and every behavioural
 * assertion would pass. The only place the omission is visible is the source, so that is where
 * this looks. A first-ever start must create the column, and every later start must add it.
 */
test("the fresh CREATE TABLE and the migration both name the provenance column", () => {
  const source = readFileSync(new URL("../src/server/db.ts", import.meta.url), "utf8");
  const createBlock = /CREATE TABLE IF NOT EXISTS personas \(([\s\S]*?)\);/.exec(source)?.[1];
  assert.ok(createBlock, "the personas CREATE TABLE block was not found");
  assert.match(createBlock, /import_provenance_json\s+TEXT/);
  assert.match(source, /addColumn\(d, "personas", "import_provenance_json", "TEXT"\)/);
});

test("opening twice is idempotent, as every start of the daemon is", () => {
  const again = openDb();
  assert.equal(
    personaColumns(again).filter((name) => name === "import_provenance_json").length,
    1,
  );
  assert.equal(
    (again.prepare(`SELECT COUNT(*) AS n FROM personas`).get() as { n: number }).n,
    2,
  );
});
