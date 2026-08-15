/**
 * What is at stake: `pipeline_events` is the first table this integration writes that is not
 * re-derivable from the engine's files. A pushed event exists nowhere else - ai-conductor's
 * daemon bus has no persister, so a daemon-scope event reaches `daemon.log` as text and
 * nothing else - which makes this the only durable record of it. Three properties therefore
 * have to hold rather than be intended:
 *
 *  1. A database from before this table, and a database from the phase that shipped
 *     `pipeline_runs` without it, both open and keep their rows.
 *  2. One event is one row however many times it is observed. The file tail and the plugin
 *     see the same events by two unrelated coordinates - a byte offset and a counter - so
 *     convergence cannot come from the key and has to come from the event itself.
 *  3. It is bounded. An append-only table in a database that is otherwise a cache is the
 *     one thing here that could grow without limit, so retention is asserted rather than
 *     assumed.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";

const home = mkdtempSync(join(tmpdir(), "mission-pipeline-events-"));
process.env.HARNESS_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

/**
 * A database as the phase that shipped `pipeline_runs` left it: the identity column present,
 * a projected run in it, and no ledger anywhere.
 *
 * Written by hand rather than by importing today's schema, on the rule every upgrade test
 * here states: a fixture built from the CURRENT schema proves nothing about the databases
 * this change will actually meet.
 */
function seedPhaseOneDb(): void {
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec(`
    CREATE TABLE IF NOT EXISTS app_config (
      key   TEXT NOT NULL PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      provider        TEXT NOT NULL,
      repo_root       TEXT NOT NULL,
      slug            TEXT NOT NULL,
      run_json        TEXT NOT NULL,
      events_offset   INTEGER NOT NULL DEFAULT 0,
      events_identity TEXT NOT NULL DEFAULT '',
      updated_at      INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_runs_key
      ON pipeline_runs(provider, repo_root, slug);
  `);
  raw
    .prepare(`INSERT INTO app_config (key, value) VALUES (?, ?)`)
    .run("pipelines", JSON.stringify({ enabled: true, repos: [] }));
  raw
    .prepare(
      `INSERT INTO pipeline_runs
         (provider, repo_root, slug, run_json, events_offset, events_identity, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
      "1:2:3:abc",
      1_700_000_000_000,
    );
  raw.close();
}

seedPhaseOneDb();

const {
  MAX_PIPELINE_EVENTS_PER_RUN,
  appendPipelineEvents,
  countPipelineEvents,
  deletePipelineEventsForRepo,
  deletePipelineEventsForRun,
  loadPipelineRuns,
  openDb,
  pipelineEvents,
} = await import("../src/server/db.ts");

const REPO = "/w/demo";
const SLUG = "a-feature";

/** An engine event, in the loose shape the ledger stores anything in. */
function event(type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, ts: "2026-08-15T10:00:00.000Z", ...extra };
}

/** Start each test from an empty ledger, leaving the seeded projection row alone. */
function clear(): void {
  openDb().exec("DELETE FROM pipeline_events");
}

test("a phase-1 database opens, keeps its run, and gains the ledger", () => {
  const db = openDb();
  const rows = loadPipelineRuns();
  assert.equal(rows.length, 1, "the projection row must survive the upgrade");
  assert.equal(rows[0]?.run.costTokens, 4242);
  assert.equal(rows[0]?.eventsOffset, 512, "and so must its resume point");
  assert.equal(rows[0]?.eventsIdentity, "1:2:3:abc");

  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pipeline_events'`)
    .all() as unknown as Array<{ name: string }>;
  assert.equal(tables.length, 1, "the upgrade must create the ledger");
});

test("every column of the ledger's key is NOT NULL", () => {
  // The change contract: SQLite treats nulls as distinct, so a nullable column under the
  // UNIQUE index an INSERT OR IGNORE answers to would let two rows describe one event.
  const columns = openDb()
    .prepare(`PRAGMA table_info(pipeline_events)`)
    .all() as unknown as Array<{ name: string; notnull: number }>;
  for (const key of ["provider", "repo_root", "slug", "seq", "kind", "fingerprint"]) {
    const column = columns.find((c) => c.name === key);
    assert.ok(column, `pipeline_events is missing ${key}`);
    assert.equal(column.notnull, 1, `${key} sits under a UNIQUE index and must be NOT NULL`);
  }
  // And the two that are deliberately nullable, because absence is a real answer for both:
  // a record may carry no instant, and the tail's own coordinate is not the plugin's.
  for (const nullable of ["ts", "producer_seq"]) {
    assert.equal(columns.find((c) => c.name === nullable)?.notnull, 0);
  }
});

test("appending assigns a gapless ordinal and stores the record verbatim", () => {
  clear();
  const stored = appendPipelineEvents("ai-conductor", REPO, SLUG, "tail", [
    { kind: "step_started", ts: "2026-08-15T10:00:00.000Z", producerSeq: 0, body: event("step_started", { step: "build" }) },
    { kind: "step_completed", ts: "2026-08-15T10:01:00.000Z", producerSeq: 180, body: event("step_completed", { step: "build", tokenUsage: { input: 10, output: 5 } }) },
  ]);
  assert.equal(stored, 2);

  const rows = pipelineEvents("ai-conductor", REPO, SLUG);
  assert.deepEqual(
    rows.map((r) => [r.seq, r.kind, r.source, r.producerSeq]),
    [
      [1, "step_started", "tail", 0],
      [2, "step_completed", "tail", 180],
    ],
  );
  // Verbatim: the engine's own record, not this build's reading of it. The step name and the
  // usage block are both fields nothing here has a schema for.
  assert.deepEqual(rows[1]?.body.tokenUsage, { input: 10, output: 5 });
});

test("a record that names no kind is stored as unknown rather than refused", () => {
  clear();
  // The tolerance rule, which is not a nicety: ai-conductor's event union is TypeScript-only
  // and unversioned, so a release that adds a kind produces records this build has never
  // seen. Refusing them would make an engine upgrade look like data loss.
  const stored = appendPipelineEvents("ai-conductor", REPO, SLUG, "ingest", [
    { kind: null, ts: null, producerSeq: 1, body: { whatever: true } },
    { kind: "a_kind_from_the_future", ts: null, producerSeq: 2, body: { type: "a_kind_from_the_future" } },
  ]);
  assert.equal(stored, 2);
  assert.deepEqual(
    pipelineEvents("ai-conductor", REPO, SLUG).map((r) => r.kind),
    ["unknown", "a_kind_from_the_future"],
  );
});

test("the same event observed by both paths is one row", () => {
  clear();
  // The convergence claim, and the reason the key alone cannot make it: the tail's
  // coordinate is a BYTE OFFSET into events.jsonl and the plugin's is a counter of its own,
  // so the identical event arrives under two unrelated numbers. What makes them one row is
  // the event, not the number.
  const body = event("step_completed", { step: "build", tokenUsage: { total: 99 } });
  const pushed = appendPipelineEvents("ai-conductor", REPO, SLUG, "ingest", [
    { kind: "step_completed", ts: "2026-08-15T10:00:00.000Z", producerSeq: 7, body },
  ]);
  const tailed = appendPipelineEvents("ai-conductor", REPO, SLUG, "tail", [
    { kind: "step_completed", ts: "2026-08-15T10:00:00.000Z", producerSeq: 4096, body: { ...body } },
  ]);
  assert.equal(pushed, 1);
  assert.equal(tailed, 0, "the file tail must not store an event the plugin already delivered");
  assert.equal(countPipelineEvents("ai-conductor", REPO, SLUG), 1);
  // And the row keeps the FIRST observation's provenance, which is the useful one: it says
  // the plugin got there first.
  assert.equal(pipelineEvents("ai-conductor", REPO, SLUG)[0]?.source, "ingest");
});

test("convergence does not depend on the key order the two paths happen to build", () => {
  clear();
  // The tail's record comes back from JSON.parse of a line; the plugin hands over an object
  // the engine's bus constructed. Same values, different insertion order - which is an
  // accident of construction and must not decide whether an event is a duplicate.
  const first = { type: "gate_checked", step: "build", ts: "2026-08-15T10:00:00.000Z", nested: { a: 1, b: 2 } };
  const second = { nested: { b: 2, a: 1 }, ts: "2026-08-15T10:00:00.000Z", step: "build", type: "gate_checked" };
  assert.notEqual(JSON.stringify(first), JSON.stringify(second), "the fixture must differ textually");
  appendPipelineEvents("ai-conductor", REPO, SLUG, "ingest", [
    { kind: "gate_checked", ts: null, producerSeq: 1, body: first },
  ]);
  const again = appendPipelineEvents("ai-conductor", REPO, SLUG, "tail", [
    { kind: "gate_checked", ts: null, producerSeq: 2048, body: second },
  ]);
  assert.equal(again, 0);
  assert.equal(countPipelineEvents("ai-conductor", REPO, SLUG), 1);
});

test("the writer's own stamp and measurements are not part of an event's identity", () => {
  clear();
  // The case this actually has to survive, measured against ai-conductor rather than
  // assumed: its `EventPersister` does not write the event it was handed. It writes
  // `{ ...event, activeInterval?, observedIntervals?, ts }`. So the plugin pushes the bus
  // object and the tail reads a strictly larger one, for the same event - and a hash over
  // either one whole could never match the other.
  const onTheBus = { type: "step_completed", step: "build", tokenUsage: { total: 12 } };
  const inTheFile = {
    ...onTheBus,
    activeInterval: { startedAtMs: 1_700_000_000_000, durationMs: 4321 },
    observedIntervals: [{ startedAtMs: 1_700_000_000_000, durationMs: 4321 }],
    ts: "2026-08-15T10:00:00.000Z",
  };
  appendPipelineEvents("ai-conductor", REPO, SLUG, "ingest", [
    { kind: "step_completed", ts: null, producerSeq: 3, body: onTheBus },
  ]);
  const tailed = appendPipelineEvents("ai-conductor", REPO, SLUG, "tail", [
    { kind: "step_completed", ts: "2026-08-15T10:00:00.000Z", producerSeq: 0, body: inTheFile },
  ]);
  assert.equal(tailed, 0, "the file record is the same event, written down");
  assert.equal(countPipelineEvents("ai-conductor", REPO, SLUG), 1);
  // The row kept is the one that arrived first, verbatim - so what is stored is still what
  // its producer said, stripping notwithstanding.
  assert.deepEqual(pipelineEvents("ai-conductor", REPO, SLUG)[0]?.body, onTheBus);
});

test("a duplicate consumes no ordinal, so the sequence stays gapless", () => {
  clear();
  const body = event("step_started", { step: "plan" });
  appendPipelineEvents("ai-conductor", REPO, SLUG, "ingest", [
    { kind: "step_started", ts: null, producerSeq: 1, body },
  ]);
  appendPipelineEvents("ai-conductor", REPO, SLUG, "ingest", [
    { kind: "step_started", ts: null, producerSeq: 1, body: { ...body } },
    { kind: "step_completed", ts: null, producerSeq: 2, body: event("step_completed", { step: "plan" }) },
  ]);
  assert.deepEqual(
    pipelineEvents("ai-conductor", REPO, SLUG).map((r) => r.seq),
    [1, 2],
    "an ignored insert must not burn the ordinal the next real event takes",
  );
});

test("two runs and two repositories keep separate sequences", () => {
  clear();
  const body = event("step_started", { step: "build" });
  // Identical events under different keys are different events. The fingerprint is scoped to
  // the run for exactly this reason: engines emit the same record shapes on every feature.
  appendPipelineEvents("ai-conductor", REPO, "a-feature", "tail", [
    { kind: "step_started", ts: null, producerSeq: 0, body },
  ]);
  appendPipelineEvents("ai-conductor", REPO, "b-feature", "tail", [
    { kind: "step_started", ts: null, producerSeq: 0, body: { ...body } },
  ]);
  appendPipelineEvents("ai-conductor", "/w/other", "a-feature", "tail", [
    { kind: "step_started", ts: null, producerSeq: 0, body: { ...body } },
  ]);
  assert.equal(countPipelineEvents("ai-conductor", REPO, "a-feature"), 1);
  assert.equal(countPipelineEvents("ai-conductor", REPO, "b-feature"), 1);
  assert.equal(countPipelineEvents("ai-conductor", "/w/other", "a-feature"), 1);
});

test("one run's ledger is bounded, keeping the newest events", () => {
  clear();
  const many = Array.from({ length: MAX_PIPELINE_EVENTS_PER_RUN + 50 }, (_, i) => ({
    kind: "tick",
    ts: null,
    producerSeq: i,
    body: { type: "tick", n: i },
  }));
  appendPipelineEvents("ai-conductor", REPO, SLUG, "tail", many);
  assert.equal(
    countPipelineEvents("ai-conductor", REPO, SLUG),
    MAX_PIPELINE_EVENTS_PER_RUN,
    "an append-only table still has to be bounded by something",
  );
  const rows = pipelineEvents("ai-conductor", REPO, SLUG);
  // The NEWEST are what survive. A cap that dropped the newest would be a ledger that stopped
  // recording once it filled, which is worse than one that forgets.
  assert.equal(rows.at(-1)?.body.n, MAX_PIPELINE_EVENTS_PER_RUN + 49);
});

test("retiring a run, and a repository, takes their ledgers with them", () => {
  clear();
  const body = event("step_started");
  appendPipelineEvents("ai-conductor", REPO, "a-feature", "tail", [
    { kind: "step_started", ts: null, producerSeq: 0, body },
  ]);
  appendPipelineEvents("ai-conductor", REPO, "b-feature", "tail", [
    { kind: "step_started", ts: null, producerSeq: 0, body: { ...body } },
  ]);
  deletePipelineEventsForRun("ai-conductor", REPO, "a-feature");
  assert.equal(countPipelineEvents("ai-conductor", REPO, "a-feature"), 0);
  assert.equal(countPipelineEvents("ai-conductor", REPO, "b-feature"), 1, "and only that run's");

  deletePipelineEventsForRepo("ai-conductor", REPO);
  assert.equal(countPipelineEvents("ai-conductor", REPO, "b-feature"), 0);
});

test("an unreadable body is skipped by the reader rather than failing the read", () => {
  clear();
  // Nothing writes this - the column is only ever filled by JSON.stringify - so this is a
  // claim about the READER: the ledger is diagnostic, and one corrupt row must not take a
  // run's whole history with it.
  openDb()
    .prepare(
      `INSERT INTO pipeline_events
         (provider, repo_root, slug, seq, kind, ts, source, producer_seq, fingerprint, body,
          received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("ai-conductor", REPO, SLUG, 1, "broken", null, "tail", 0, "deadbeef", "{not json", 1);
  appendPipelineEvents("ai-conductor", REPO, SLUG, "tail", [
    { kind: "fine", ts: null, producerSeq: 1, body: { type: "fine" } },
  ]);
  const rows = pipelineEvents("ai-conductor", REPO, SLUG);
  assert.deepEqual(rows.map((r) => r.kind), ["fine"]);
});
