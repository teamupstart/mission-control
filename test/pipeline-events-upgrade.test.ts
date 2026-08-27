/**
 * What is at stake: `pipeline_events` shipped once with a UNIQUE index over
 * `(provider, repo_root, slug, fingerprint)`, which made a repeated event impossible to
 * store - the second occurrence of a byte-identical record was refused by SQLite before any
 * code could decide what it was. Conductor stamps no sequence number, so a retried step emits
 * exactly that, and for the 28 kinds it never writes to a file this ledger is the only record
 * either occurrence ever had.
 *
 * The fix is a column and a claim (see `also_seq` in `src/server/db.ts`), and the half that
 * cannot be proven by any test against a FRESH schema is the half that matters here: a
 * database an operator already has, carrying the old index, must lose it on the next open.
 * A fixture built from today's schema would pass while every upgraded machine kept the defect.
 *
 * So this file seeds the old shape by hand, opens it with today's code, and asserts the
 * upgrade did three things: kept the rows, added the column, and dropped the index.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";

const home = mkdtempSync(join(tmpdir(), "mission-pipeline-upgrade-"));
process.env.HARNESS_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const REPO = "/w/demo";
const SLUG = "a-feature";
/** The record both occurrences carry. Identical bytes, which is the whole point. */
const BODY = { type: "gate_verdict", step: "build", satisfied: false };

/**
 * The ledger as the build that first shipped it wrote one: no `also_seq`, and the UNIQUE
 * index over the fingerprint that this change exists to remove.
 *
 * Hand-written rather than imported, on the rule every upgrade test here states - a fixture
 * built from the current schema proves nothing about the databases this change will meet.
 */
function seedCollapsingLedger(): void {
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_events (
      provider     TEXT NOT NULL,
      repo_root    TEXT NOT NULL,
      slug         TEXT NOT NULL,
      seq          INTEGER NOT NULL,
      kind         TEXT NOT NULL,
      ts           TEXT,
      source       TEXT NOT NULL,
      producer_seq INTEGER,
      fingerprint  TEXT NOT NULL,
      body         TEXT NOT NULL,
      received_at  INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_events_key
      ON pipeline_events(provider, repo_root, slug, seq);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_events_identity
      ON pipeline_events(provider, repo_root, slug, fingerprint);
  `);
  raw
    .prepare(
      `INSERT INTO pipeline_events
         (provider, repo_root, slug, seq, kind, ts, source, producer_seq, fingerprint, body,
          received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "ai-conductor",
      REPO,
      SLUG,
      1,
      "gate_verdict",
      null,
      "ingest",
      11,
      // sha256 of the record with its keys sorted, which is what today's code computes for
      // BODY. Written literally, because a fixture that called the hasher would be asserting
      // that the hasher agrees with itself - and the claim here is that a row an OLDER build
      // wrote is still recognised by this one.
      "42aae39340ca8de27532fb753d1a17aa2d3723f2c41cb84dfa8d884045569b85",
      JSON.stringify(BODY),
      1_700_000_000_000,
    );
  raw.close();
}

seedCollapsingLedger();

const { appendPipelineEvents, countPipelineEvents, openDb, pipelineEvents } = await import(
  "../src/server/db.ts"
);

test("an existing ledger keeps its rows, gains the column, and loses the old index", () => {
  const db = openDb();
  assert.equal(countPipelineEvents("ai-conductor", REPO, SLUG), 1, "the row must survive");

  const columns = db.prepare(`PRAGMA table_info(pipeline_events)`).all() as unknown as Array<{
    name: string;
    notnull: number;
  }>;
  const added = columns.find((c) => c.name === "also_seq");
  assert.ok(added, "the upgrade must add also_seq");
  assert.equal(added.notnull, 0, "and leave it nullable: the other path has not been seen yet");
  assert.equal(
    pipelineEvents("ai-conductor", REPO, SLUG)[0]?.alsoSeq,
    null,
    "an existing row is unclaimed, which is exactly true of a build that recorded no second observation",
  );

  const indexes = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pipeline_events'`)
    .all() as unknown as Array<{ name: string }>;
  const names = indexes.map((i) => i.name);
  assert.ok(
    !names.includes("idx_pipeline_events_identity"),
    "the index that made a repeat impossible must be dropped, or an upgraded database keeps the defect",
  );
  assert.ok(names.includes("idx_pipeline_events_observation"), "and its replacement must exist");
});

test("and the repeat the old index refused is storable on the upgraded database", () => {
  // The defect itself, on a database that had it. The second occurrence of the seeded event
  // arrives under a new coordinate and must become a row of its own.
  const stored = appendPipelineEvents("ai-conductor", REPO, SLUG, "ingest", [
    { kind: "gate_verdict", ts: null, producerSeq: 12, body: { ...BODY } },
  ]);
  assert.equal(stored, 1);
  assert.equal(countPipelineEvents("ai-conductor", REPO, SLUG), 2);

  // And the seeded row still converges with the file tail, so the upgrade did not buy the
  // repeat by giving up the thing convergence was for.
  const tailed = appendPipelineEvents("ai-conductor", REPO, SLUG, "tail", [
    { kind: "gate_verdict", ts: null, producerSeq: 4096, body: { ...BODY } },
    { kind: "gate_verdict", ts: null, producerSeq: 8192, body: { ...BODY } },
  ]);
  assert.equal(tailed, 0);
  assert.deepEqual(
    pipelineEvents("ai-conductor", REPO, SLUG).map((r) => [r.seq, r.producerSeq, r.alsoSeq]),
    [
      [1, 11, 4096],
      [2, 12, 8192],
    ],
  );
});
