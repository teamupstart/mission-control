/**
 * What is at stake: `inspector_prs` is a table operators' machines are already using, and the
 * adoption INSERT names every column.
 *
 * So the four observation columns are not optional cosmetics. Add them to the fresh schema
 * without migrating an existing database and the fresh-install test still passes while every
 * adoption on every upgraded machine fails with "table inspector_prs has no column named
 * observed_head_sha" - which is the Inspector silently ceasing to adopt pull requests, on the
 * one path that has no other way to notice.
 *
 * The rows themselves are a ledger of what Mission Control opened. A migration that dropped,
 * rewrote, or re-adopted one would lose the permission to comment on a pull request that is
 * still open on GitHub.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const home = mkdtempSync(join(tmpdir(), "mission-inspector-observation-migration-"));
process.env.MISSION_HOME = home;

const KEY = "owner/repo#41";

/**
 * A pre-observation `inspector_prs`, written out verbatim rather than imported.
 *
 * An upgrade test whose fixture is built from the CURRENT schema proves nothing: it would
 * create the columns it is meant to be checking the migration adds.
 */
function seedPreObservationDb(): void {
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec(`
    CREATE TABLE IF NOT EXISTS inspector_prs (
      key              TEXT PRIMARY KEY,
      url              TEXT NOT NULL,
      owner            TEXT NOT NULL,
      repo             TEXT NOT NULL,
      number           INTEGER NOT NULL,
      repo_root        TEXT,
      cwd              TEXT,
      session_id       TEXT,
      source           TEXT NOT NULL,
      state            TEXT NOT NULL,
      head_sha         TEXT,
      review_posture   TEXT,
      round            INTEGER NOT NULL DEFAULT 0,
      last_reviewed_at INTEGER,
      last_error       TEXT,
      fail_count       INTEGER NOT NULL DEFAULT 0,
      last_fail_kind   TEXT,
      next_attempt_at  INTEGER,
      last_attempt_sha TEXT,
      merged_at        INTEGER,
      merge_block      TEXT,
      adopted_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
  `);
  raw.prepare(
    `INSERT INTO inspector_prs
       (key, url, owner, repo, number, repo_root, cwd, session_id, source, state,
        head_sha, review_posture, round, last_reviewed_at, last_error, fail_count,
        last_fail_kind, next_attempt_at, last_attempt_sha, merged_at, merge_block,
        adopted_at, updated_at)
     VALUES (?, ?, 'owner', 'repo', 41, '/repo', '/repo', 'sess-1', 'hook', 'open',
             'reviewed-head', 'live', 2, 700, NULL, 0, NULL, NULL, 'attempted-head',
             NULL, NULL, 500, 700)`,
  ).run(KEY, "https://github.com/owner/repo/pull/41");
  raw.close();
}

seedPreObservationDb();

const { openDb, getInspectorPr, adoptInspectorPr, updateInspectorPr, loadOpenInspectorPrs } =
  await import("../src/server/db.ts");

after(() => rmSync(home, { recursive: true, force: true }));

openDb();

test("an existing adoption survives the upgrade with every fact it was carrying", () => {
  const row = getInspectorPr(KEY);
  assert.ok(row, "the adoption ledger lost a row it was already holding");
  assert.equal(row.url, "https://github.com/owner/repo/pull/41");
  assert.equal(row.state, "open");
  assert.equal(row.headSha, "reviewed-head");
  assert.equal(row.reviewPosture, "live");
  assert.equal(row.round, 2);
  assert.equal(row.lastAttemptSha, "attempted-head");
  assert.equal(row.adoptedAt, 500);
});

test("a row written before the columns existed reads as UNOBSERVED, never as unchanged", () => {
  // Null is the only truthful answer for a pull request this build has not polled since the
  // columns arrived, and it is also the fail-closed one: the `pull_request` session action
  // waits when it cannot name a remote head, so an unobserved legacy row makes it wait for the
  // next tick rather than complete against a head nobody looked at.
  const row = getInspectorPr(KEY)!;
  assert.equal(row.observedHeadSha, null);
  assert.equal(row.observedState, null);
  assert.equal(row.observedAt, null);
  assert.equal(row.headRefName, null);
});

test("adoption still works on an upgraded database, which the INSERT's column list requires", () => {
  // The failure this whole file exists for. The adoption INSERT names all four columns, so a
  // missing migration takes out every future adoption on every upgraded machine while the
  // fresh-install path stays green.
  const adopted = adoptInspectorPr({
    key: "owner/repo#42",
    url: "https://github.com/owner/repo/pull/42",
    owner: "owner",
    repo: "repo",
    number: 42,
    repoRoot: "/repo",
    cwd: "/repo",
    sessionId: "sess-2",
    source: "hook",
    state: "open",
    headSha: null,
    reviewPosture: null,
    round: 0,
    lastReviewedAt: null,
    lastError: null,
    failCount: 0,
    lastFailKind: null,
    nextAttemptAt: null,
    lastAttemptSha: null,
    mergedAt: null,
    mergeBlock: null,
    observedHeadSha: null,
    observedState: null,
    observedAt: null,
    headRefName: null,
    adoptedAt: 900,
    updatedAt: 900,
  });
  assert.equal(adopted, true);
  assert.equal(getInspectorPr("owner/repo#42")?.observedHeadSha, null);
  assert.deepEqual(
    loadOpenInspectorPrs().map((pr) => pr.key).sort(),
    ["owner/repo#41", "owner/repo#42"],
  );
});

test("a poll fills the observation without disturbing the reviewed head beside it", () => {
  // The split the columns exist for: `head_sha` is what the last completed REVIEW was about,
  // and the observation is what the last POLL saw. A tick that advanced the reviewed head
  // would tell the Inspector it had already reviewed a commit it has not seen.
  updateInspectorPr(KEY, {
    observedHeadSha: "f".repeat(40),
    observedState: "OPEN",
    observedAt: 1_000,
    headRefName: "feature/x",
  }, 1_000);
  const row = getInspectorPr(KEY)!;
  assert.equal(row.observedHeadSha, "f".repeat(40));
  assert.equal(row.observedState, "OPEN");
  assert.equal(row.observedAt, 1_000);
  assert.equal(row.headRefName, "feature/x");
  assert.equal(row.headSha, "reviewed-head", "the reviewed head must not move on a poll");
  assert.equal(row.round, 2, "a poll is not a completed review round");
});

test("opening twice is idempotent, as every start of the daemon is", () => {
  const again = openDb();
  const columns = (again.prepare(`PRAGMA table_info(inspector_prs)`).all() as { name: string }[])
    .map((column) => column.name);
  for (const column of ["observed_head_sha", "observed_state", "observed_at", "head_ref_name"]) {
    assert.equal(columns.filter((name) => name === column).length, 1, `${column} was added twice`);
  }
  assert.equal(getInspectorPr(KEY)?.observedHeadSha, "f".repeat(40));
});
