/**
 * What is at stake: a database an operator has been using for months must open on the build
 * that introduces `pipeline_runs`, and it must open with every row they care about intact.
 *
 * The reason this is worth a file of its own, rather than being taken on trust because
 * `CREATE TABLE IF NOT EXISTS` is famously safe, is that the fixture below is a database
 * with NO pipeline table at all - which is what every existing machine is - and the thing
 * being proved is that the daemon's whole open path (base tables, `migrate()`, then the
 * projection's own reader) survives meeting one. A `CREATE` that referenced a column added
 * by a later migration, or an index created before the table it names, fails exactly here
 * and nowhere in a fresh-checkout suite.
 *
 * The second half is the direction nobody usually tests: a database written by THIS build
 * must still open in a build without the phases that come after it. `pipeline_runs` is the
 * only table this phase adds, and it holds no foreign key to anything - so this is checkable
 * by asserting what the schema does NOT reference, which is what keeps a later phase's
 * `pipeline_events` from being quietly depended on here.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";

const home = mkdtempSync(join(tmpdir(), "mission-pipeline-migration-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

/**
 * A pre-feature database with real settings in it, and no pipeline table anywhere.
 *
 * `app_config` written out by hand rather than produced by importing today's schema, for the
 * reason every upgrade test in this repository states: a fixture built with the CURRENT
 * schema proves nothing about the databases this change will actually meet. It is the one
 * table this change interacts with beyond its own, it has held the same two columns since
 * the beginning, and it is where an operator's consent will land - so its rows surviving
 * this upgrade is the fact worth pinning. Everything else `openDb` creates for itself, which
 * is exactly what it does on the machine of anyone who upgrades.
 */
function seedPreFeatureDb(): void {
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec(`
    CREATE TABLE IF NOT EXISTS app_config (
      key   TEXT NOT NULL PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  raw
    .prepare(`INSERT INTO app_config (key, value) VALUES (?, ?)`)
    .run("taskSources", JSON.stringify({ sources: [{ id: "gh", kind: "github-issues" }] }));
  raw.prepare(`INSERT INTO app_config (key, value) VALUES (?, ?)`).run("shipping", '{"autoMerge":true}');

  // A `pipeline_runs` table in the shape it FIRST shipped in - offset, no identity - with a
  // projected run in it. This is the database of an operator who enabled a repository on the
  // build before file identity was recorded, and the upgrade must neither lose their row nor
  // treat "we never recorded an identity" as "the file changed": the second would reset every
  // projected run's accumulated token total once, on upgrade, for no reason.
  raw.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      provider      TEXT NOT NULL,
      repo_root     TEXT NOT NULL,
      slug          TEXT NOT NULL,
      run_json      TEXT NOT NULL,
      events_offset INTEGER NOT NULL DEFAULT 0,
      updated_at    INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_runs_key
      ON pipeline_runs(provider, repo_root, slug);
  `);
  raw
    .prepare(
      `INSERT INTO pipeline_runs (provider, repo_root, slug, run_json, events_offset, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "ai-conductor",
      "/w/demo",
      "a-feature",
      JSON.stringify({
        provider: "ai-conductor",
        repoRoot: "/w/demo",
        slug: "a-feature",
        worktree: "/w/demo/.worktrees/a-feature",
        tier: "M",
        track: "product",
        steps: [{ name: "build", state: "done" }],
        lastStep: "build",
        halt: null,
        group: "eligible",
        prUrl: null,
        costTokens: 4242,
        updatedAt: 1_700_000_000_000,
      }),
      512,
      1_700_000_000_000,
    );
  raw.close();
}

seedPreFeatureDb();

const { openDb, loadPipelineRuns, pipelineStoredRepos } = await import("../src/server/db.ts");
const { getPipelinesConfig } = await import("../src/server/pipelines/config.ts");

test("a database from before this feature opens, and keeps its settings", () => {
  const db = openDb();
  const rows = db.prepare(`SELECT key, value FROM app_config ORDER BY key`).all() as unknown as Array<{
    key: string;
    value: string;
  }>;
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  assert.equal(stored.get("shipping"), '{"autoMerge":true}', "the upgrade must not touch rows");
  assert.match(String(stored.get("taskSources")), /github-issues/);
  // And no `pipelines` key was invented, which is what makes the read below a DEFAULT rather
  // than something the upgrade wrote.
  assert.equal(stored.has("pipelines"), false);
});

test("an upgraded machine reads the off posture, from zod defaults rather than a migration", () => {
  // The whole reason this config is a KV blob: a key nothing has written parses to the
  // shipped defaults, so there is no migration to get wrong and no state in between.
  const config = getPipelinesConfig();
  assert.equal(config.enabled, false);
  assert.deepEqual(config.repos, []);
});

test("a projection row written before file identity existed survives, with no identity", () => {
  // The row keeps its offset and its accumulated spend, and its identity reads as the empty
  // string - which the tail treats as no evidence rather than as a change, so the next pass
  // adopts whatever it finds instead of resetting the total.
  const rows = loadPipelineRuns();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.run.slug, "a-feature");
  assert.equal(rows[0]?.run.costTokens, 4242, "the accumulated spend is not reset by an upgrade");
  assert.equal(rows[0]?.eventsOffset, 512, "and neither is the resume point");
  assert.equal(rows[0]?.eventsIdentity, "", "no identity was recorded, and none is invented");
  assert.deepEqual(pipelineStoredRepos(), [
    { provider: "ai-conductor", repoRoot: "/w/demo" },
  ]);
});

test("the upgraded schema has the key the projection is addressed by", () => {
  const db = openDb();
  const indexes = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pipeline_runs'`)
    .all() as unknown as Array<{ name: string }>;
  const names = indexes.map((i) => i.name);
  assert.ok(names.includes("idx_pipeline_runs_key"), "the ON CONFLICT target must exist");

  // Every column under that unique index is NOT NULL. SQLite treats nulls as distinct, so a
  // nullable key column would let two rows describe one feature and each hold half its
  // history - the change contract this table is written against.
  const columns = db.prepare(`PRAGMA table_info(pipeline_runs)`).all() as unknown as Array<{
    name: string;
    notnull: number;
  }>;
  for (const key of ["provider", "repo_root", "slug"]) {
    const column = columns.find((c) => c.name === key);
    assert.ok(column, `pipeline_runs is missing ${key}`);
    assert.equal(column.notnull, 1, `${key} is an ON CONFLICT key and must be NOT NULL`);
  }

  // Added by `migrate()` onto a table that already existed, so the upgrade path is what put
  // it there rather than the CREATE.
  const identity = columns.find((c) => c.name === "events_identity");
  assert.ok(identity, "the upgrade must add events_identity to an existing pipeline_runs");
  assert.equal(identity.notnull, 1);
});

test("this phase's schema depends on no table a later phase owns", () => {
  // A database written by THIS build has to open in a build without phase 5's ingest ledger.
  // The way that stays true is that `pipeline_runs` references nothing - no foreign key, no
  // trigger, no index naming another table - so the check is on the DDL itself.
  const db = openDb();
  const ddl = db
    .prepare(`SELECT sql FROM sqlite_master WHERE tbl_name = 'pipeline_runs' AND sql IS NOT NULL`)
    .all() as unknown as Array<{ sql: string }>;
  const text = ddl.map((row) => row.sql).join("\n");
  assert.ok(text.length > 0, "pipeline_runs should have DDL to read");
  assert.equal(/REFERENCES/i.test(text), false, "the projection is a cache and owns no keys");
  assert.equal(
    /pipeline_events/i.test(text),
    false,
    "the ingest ledger belongs to phase 5; this phase's upgrade path must not name it",
  );
});
