/**
 * What is at stake: the archive library's rename touches four tables an operator's machine
 * is already using, and three of them are dropped.
 *
 * That is safe for exactly three of them and for none of the reasons that usually make a
 * drop safe. `scout_archives`, `scout_artifacts` and `scout_search_segments` are a cache of
 * bundle directories, and the reconciler rebuilds them from disk - a database with no
 * fingerprints simply sees every bundle as new. Copying their rows would carry a fingerprint
 * from a read this build never performed, and an unchanged fingerprint is precisely what
 * makes a pass skip re-reading a bundle: the cache would vouch for bytes nobody verified.
 *
 * `scout_capture_jobs` is the opposite kind of table and cannot be rebuilt from anything. It
 * is the idempotency and resume ledger, and its `repos_json` holds server-derived checkout
 * roots recorded while the session still existed - the whole reason a capture is reserved on
 * exit is that those paths are about to stop being derivable. Dropping it would strand an
 * in-flight capture whose evidence is still on disk and whose bundle was never published.
 *
 * So this file upgrades a database that looks like a machine mid-flight: a reserved job with
 * no submission, a submitted job that never published, a published one, and index rows for a
 * bundle that no longer has to exist. Every capture job must survive with its identity, its
 * submission, its retained checkout roots, and a kind of `scout` - which is what every row
 * written before archives declared a kind is.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";

const home = mkdtempSync(join(tmpdir(), "mission-archive-migration-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const PRODUCER = "7aa704fd-d2ab-48b3-a726-0c2643ed91d2";
const ARCHIVE = "9f5db6c8-79f5-4f9e-84aa-8b5dc15362f8";
const REPOS = JSON.stringify([
  { slot: "repo-01", label: "mission-control", root: "/tmp/worktree-that-is-going-away", head: null, primary: true },
]);

/**
 * A pre-rename database with a real, in-flight archive family in it.
 *
 * The schema below is the shipped scout shape verbatim, written out rather than imported for
 * the reason every upgrade test in this repository states: a fixture built with the CURRENT
 * schema proves nothing about the databases this migration will actually meet.
 */
function seedPreRenameDb(): void {
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec(`
    CREATE TABLE IF NOT EXISTS scout_archives (
      key                TEXT NOT NULL PRIMARY KEY,
      producer_id        TEXT NOT NULL,
      archive_id         TEXT NOT NULL,
      producer_label     TEXT,
      format_version     INTEGER NOT NULL DEFAULT 0,
      status             TEXT NOT NULL,
      capture_status     TEXT,
      title              TEXT NOT NULL DEFAULT '',
      question           TEXT,
      summary            TEXT,
      tags_json          TEXT,
      agent              TEXT,
      model              TEXT,
      source             TEXT,
      repositories_json  TEXT,
      repo_labels        TEXT NOT NULL DEFAULT '',
      missing_json       TEXT,
      primary_artifact_id TEXT,
      content_digest     TEXT,
      manifest_digest    TEXT NOT NULL DEFAULT '',
      relative_path      TEXT NOT NULL,
      manifest_bytes     INTEGER NOT NULL DEFAULT 0,
      manifest_mtime_ns  TEXT NOT NULL DEFAULT '',
      artifact_count     INTEGER NOT NULL DEFAULT 0,
      bytes              INTEGER NOT NULL DEFAULT 0,
      error              TEXT,
      created_at         INTEGER,
      completed_at       INTEGER,
      sort_at            INTEGER NOT NULL,
      indexed_at         INTEGER NOT NULL,
      last_seen_epoch    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_scout_archives_sort ON scout_archives(sort_at DESC, key DESC);
    CREATE TABLE IF NOT EXISTS scout_artifacts (
      key           TEXT NOT NULL,
      artifact_id   TEXT NOT NULL,
      ordinal       INTEGER NOT NULL DEFAULT 0,
      role          TEXT NOT NULL,
      repo_slot     TEXT,
      original_path TEXT,
      archive_path  TEXT NOT NULL,
      media_type    TEXT NOT NULL DEFAULT '',
      bytes         INTEGER NOT NULL DEFAULT 0,
      sha256        TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (key, artifact_id)
    );
    CREATE TABLE IF NOT EXISTS scout_search_segments (
      key         TEXT NOT NULL,
      ordinal     INTEGER NOT NULL,
      source_kind TEXT NOT NULL,
      text        TEXT NOT NULL,
      text_fold   TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (key, ordinal)
    );
    CREATE TABLE IF NOT EXISTS scout_capture_jobs (
      operation_key   TEXT NOT NULL PRIMARY KEY,
      task_id         TEXT NOT NULL,
      session_id      TEXT,
      episode_id      TEXT,
      status          TEXT NOT NULL,
      producer_id     TEXT,
      archive_id      TEXT,
      report_path     TEXT,
      summary         TEXT,
      tags_json       TEXT,
      supporting_json TEXT,
      title           TEXT,
      question        TEXT,
      origin_json     TEXT,
      repos_json      TEXT,
      relative_path   TEXT,
      capture_status  TEXT,
      error           TEXT,
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_attempt_at INTEGER,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
  `);

  const job = raw.prepare(
    `INSERT INTO scout_capture_jobs
       (operation_key, task_id, session_id, episode_id, status, producer_id, archive_id,
        report_path, summary, tags_json, supporting_json, title, question, origin_json,
        repos_json, relative_path, capture_status, error, attempts, last_attempt_at,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Reserved on exit and never submitted: the row that only exists so a resumed daemon can
  // still find the checkout the report was written in.
  job.run(
    "task-reserved:ep-1", "task-reserved", "sess-1", "ep-1", "reserved", PRODUCER, ARCHIVE,
    null, null, null, null, "Reserved on exit", "why did resume lose the grant?", null,
    REPOS, null, null, null, 0, null, 1_760_000_000_000, 1_760_000_000_000,
  );
  // Submitted but not published: the daemon died between recording the submission and
  // writing the bundle. Dropping this row loses an accepted report.
  job.run(
    "task-submitted:ep-2", "task-submitted", "sess-2", "ep-2", "submitted", PRODUCER,
    "1c2f5e6a-2f4e-4a1b-9a2b-1f0e8d7c6b5a", "docs/reports/resume/report.html", "the grant was never replayed",
    JSON.stringify(["permissions"]), JSON.stringify([{ repoSlot: "repo-01", path: "evidence/run.log" }]),
    "Submitted", null, JSON.stringify({ agent: "codex", model: "gpt-5.6", source: "manual" }),
    REPOS, null, null, "a transient I/O error", 2, 1_760_000_100_000, 1_760_000_000_000, 1_760_000_100_000,
  );
  // Already published: proves the ledger's replay answer survives, which is what stops a
  // completion click after the upgrade from publishing a second archive of one episode.
  job.run(
    "task-published:ep-3", "task-published", null, "ep-3", "published", PRODUCER,
    "3b7d9c11-5a44-4b2c-8e01-2d4f6a8b0c11", "docs/reports/pool/report.html", "the pool reaped it",
    "[]", "[]", "Published", null, null, REPOS, `${PRODUCER}/3b7d9c11-5a44-4b2c-8e01-2d4f6a8b0c11`,
    "complete", null, 1, 1_760_000_200_000, 1_760_000_000_000, 1_760_000_200_000,
  );

  raw.prepare(
    `INSERT INTO scout_archives (key, producer_id, archive_id, status, relative_path, sort_at, indexed_at)
     VALUES (?, ?, ?, 'ready', ?, 1, 1)`,
  ).run(`${PRODUCER}~${ARCHIVE}`, PRODUCER, ARCHIVE, `${PRODUCER}/${ARCHIVE}`);
  raw.close();
}

seedPreRenameDb();

const { openDb } = await import("../src/server/db.ts");
const { ArchiveCaptureStore } = await import("../src/server/archives/capture-store.ts");
const db = openDb();

function tableNames(): string[] {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as unknown as Array<{ name: string }>
  ).map((row) => row.name);
}

test("a pre-rename database opens, and the old tables are gone", () => {
  const tables = tableNames();
  for (const gone of ["scout_archives", "scout_artifacts", "scout_search_segments", "scout_capture_jobs"]) {
    assert.equal(tables.includes(gone), false, `${gone} must not survive the rename`);
  }
  for (const present of ["archives", "archive_artifacts", "archive_search_segments", "archive_capture_jobs"]) {
    assert.ok(tables.includes(present), `${present} must exist after the upgrade`);
  }
});

test("every capture job survives, with a kind of scout", () => {
  const store = new ArchiveCaptureStore(db);
  const jobs = ["task-reserved", "task-submitted", "task-published"].map((taskId) => {
    const [job] = store.forTask(taskId);
    assert.ok(job, `${taskId} lost its capture job`);
    return job;
  });
  for (const job of jobs) {
    assert.equal(job.kind, "scout", "a row written before the discriminator is a scout's, and says so");
    assert.equal(job.producerId, PRODUCER, "the reserved producer namespace is not re-minted");
    assert.deepEqual(
      job.repos.map((repo) => repo.root),
      ["/tmp/worktree-that-is-going-away"],
      "the retained checkout roots are the whole reason this table is copied rather than dropped",
    );
  }
});

test("the reserved job keeps the identity a resumed capture must publish under", () => {
  const store = new ArchiveCaptureStore(db);
  const [job] = store.forTask("task-reserved");
  assert.ok(job);
  assert.equal(job.status, "reserved");
  assert.equal(job.archiveId, ARCHIVE);
  assert.equal(job.submission, null);
  assert.equal(job.title, "Reserved on exit");
  assert.equal(job.question, "why did resume lose the grant?");
});

test("the submitted job keeps the report an agent already handed over", () => {
  const store = new ArchiveCaptureStore(db);
  const [job] = store.forTask("task-submitted");
  assert.ok(job);
  assert.equal(job.status, "submitted");
  assert.equal(job.submission?.reportPath, "docs/reports/resume/report.html");
  assert.equal(job.submission?.summary, "the grant was never replayed");
  assert.deepEqual(job.submission?.tags, ["permissions"]);
  assert.deepEqual(job.submission?.supporting, [{ repoSlot: "repo-01", path: "evidence/run.log" }]);
  assert.equal(job.attempts, 2, "the attempt count comes across, so a failing job stays visible");
  assert.equal(job.error, "a transient I/O error");
  assert.equal(job.origin.agent, "codex");
});

test("the published job keeps the answer a replay must return", () => {
  const store = new ArchiveCaptureStore(db);
  const [job] = store.forTask("task-published");
  assert.ok(job);
  assert.equal(job.status, "published");
  assert.equal(job.captureStatus, "complete");
  assert.equal(job.relativePath, `${PRODUCER}/3b7d9c11-5a44-4b2c-8e01-2d4f6a8b0c11`);
});

test("the disposable index is empty, and reopening the database is a no-op", () => {
  const count = db.prepare(`SELECT COUNT(*) AS n FROM archives`).get() as unknown as { n: number };
  assert.equal(count.n, 0, "the index is dropped and rebuilt from disk, never copied");

  // Idempotency, which is what "upgrading databases must keep opening safely" means in
  // practice: the migration runs on every open, and the second one must find nothing to do
  // rather than throwing on a table it already dropped.
  const second = new DatabaseSync(join(home, "harness.db"));
  second.close();
  const jobs = db.prepare(`SELECT COUNT(*) AS n FROM archive_capture_jobs`).get() as unknown as { n: number };
  assert.equal(jobs.n, 3);
});
