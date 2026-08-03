/**
 * What is at stake: `inspector_prs` is a ledger on machines that are already running, and
 * the adoption INSERT names every column it knows about. Add `title` to the fresh schema
 * without migrating an existing database and the fresh-install tests stay green while every
 * adoption on every upgraded machine dies with "table inspector_prs has no column named
 * title" - the Inspector silently ceasing to adopt pull requests, on the one path that has
 * no other way to notice.
 *
 * The second thing pinned here is what NULL means. The title is written by the poll, never
 * by adoption, so a row can truthfully carry no title; every reader owes it a fallback to
 * the branch name. A migration that defaulted the column to '' would make "GitHub says this
 * PR has no title" and "nobody has looked yet" the same value on the wire, and the fallback
 * would have nothing left to key on.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const home = mkdtempSync(join(tmpdir(), "mission-inspector-title-migration-"));
process.env.MISSION_HOME = home;

const KEY = "owner/repo#7";

/**
 * A pre-title `inspector_prs`, written out verbatim rather than imported.
 *
 * An upgrade fixture built from the CURRENT schema proves nothing: it would create the
 * very column the migration is supposed to add.
 */
function seedPreTitleDb(): void {
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
      observed_head_sha TEXT,
      observed_state    TEXT,
      observed_at       INTEGER,
      head_ref_name     TEXT,
      adopted_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
  `);
  raw.prepare(
    `INSERT INTO inspector_prs
       (key, url, owner, repo, number, repo_root, cwd, session_id, source, state,
        head_sha, review_posture, round, last_reviewed_at, last_error, fail_count,
        last_fail_kind, next_attempt_at, last_attempt_sha, merged_at, merge_block,
        observed_head_sha, observed_state, observed_at, head_ref_name,
        adopted_at, updated_at)
     VALUES (?, ?, 'owner', 'repo', 7, '/repo', '/repo', 'sess-1', 'hook', 'open',
             'reviewed-head', 'live', 1, 700, NULL, 0, NULL, NULL, 'attempted-head',
             NULL, NULL, 'observed-head', 'OPEN', 800, 'feature/legacy', 500, 800)`,
  ).run(KEY, "https://github.com/owner/repo/pull/7");
  raw.close();
}

seedPreTitleDb();

const { openDb, adoptInspectorPr, getInspectorPr, updateInspectorPr } = await import(
  "../src/server/db.ts"
);

after(() => rmSync(home, { recursive: true, force: true }));

openDb();

test("a row written before the column existed keeps every fact it was carrying", () => {
  const row = getInspectorPr(KEY);
  assert.ok(row, "the adoption ledger lost a row it was already holding");
  assert.equal(row.url, "https://github.com/owner/repo/pull/7");
  assert.equal(row.headSha, "reviewed-head");
  assert.equal(row.headRefName, "feature/legacy");
  assert.equal(row.observedState, "OPEN");
  assert.equal(row.adoptedAt, 500);
});

test("and reads as UNTITLED rather than as a pull request with an empty title", () => {
  // Null is the only truthful answer for a pull request nothing has polled since the column
  // arrived, and it is what obliges the renderers to fall back to the branch. A DEFAULT ''
  // here would have made a legacy row indistinguishable from one GitHub reported blank.
  assert.equal(getInspectorPr(KEY)?.title, null);
});

test("adoption still works on an upgraded database, which the INSERT's column list requires", () => {
  // The failure this file exists for: the adoption INSERT names `title`, so a missing
  // migration takes out every future adoption on every upgraded machine while the
  // fresh-install path stays green.
  const adopted = adoptInspectorPr({
    key: "owner/repo#8",
    url: "https://github.com/owner/repo/pull/8",
    owner: "owner",
    repo: "repo",
    number: 8,
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
    title: null,
    adoptedAt: 900,
    updatedAt: 900,
  });
  assert.equal(adopted, true);
  assert.equal(getInspectorPr("owner/repo#8")?.title, null, "adoption is not an observation");
});

test("a poll titles the row without disturbing the reviewed head beside it", () => {
  updateInspectorPr(
    KEY,
    {
      observedHeadSha: "f".repeat(40),
      observedState: "OPEN",
      observedAt: 1_000,
      headRefName: "feature/legacy",
      title: "Give the adoption ledger PR titles",
    },
    1_000,
  );
  const row = getInspectorPr(KEY)!;
  assert.equal(row.title, "Give the adoption ledger PR titles");
  assert.equal(row.headSha, "reviewed-head", "the reviewed head must not move on a poll");
  assert.equal(row.round, 1, "a poll is not a completed review round");
});

test("a retitled pull request is retitled here, because every tick re-records it", () => {
  // Written once at first sighting, the ledger would keep the placeholder title an author
  // opened the PR with and never learn its real one. The observer patch is not a
  // fill-if-empty.
  updateInspectorPr(KEY, { title: "feat(inspector): ledger titles" }, 2_000);
  assert.equal(getInspectorPr(KEY)?.title, "feat(inspector): ledger titles");
});

test("an update that says nothing about the title leaves it alone", () => {
  // `updateInspectorPr` writes every column on every call, merging the patch over the
  // current row. A field omitted from the patch type's SET list, or dropped from the args,
  // would silently blank the title on the next unrelated write - a backoff, a retirement.
  updateInspectorPr(KEY, { failCount: 2, lastError: "boom" }, 3_000);
  assert.equal(getInspectorPr(KEY)?.title, "feat(inspector): ledger titles");
});

test("opening twice is idempotent, as every start of the daemon is", () => {
  const again = openDb();
  const columns = (again.prepare(`PRAGMA table_info(inspector_prs)`).all() as { name: string }[])
    .map((column) => column.name);
  assert.equal(columns.filter((name) => name === "title").length, 1, "title was added twice");
  assert.equal(getInspectorPr(KEY)?.title, "feat(inspector): ledger titles");
});

test("the poll writes the title in the same statement as the observation it came from", () => {
  // The one thing about the capture that a database test cannot reach: `fetchPr` shells out
  // to `gh` and `processPr` is unexported, so the seam is the source. What matters is not
  // that a title is written somewhere, but that it is written by THE observer patch - the
  // statement `processPr` runs before any branch decides to retire the row, take the
  // backoff, or sit the tick out. A separate write placed after those returns would title
  // only the pull requests that get all the way to a review.
  //
  // `|| null` is the other half: `normalizePr` yields '' for a missing title, and the
  // ledger must have exactly one reading of "we do not know what this is called".
  const worker = readFileSync(new URL("../src/server/inspector/worker.ts", import.meta.url), "utf8");
  const patch = worker.slice(
    worker.indexOf("observedHeadSha: s.headSha || null"),
    worker.indexOf("onObserved?.(s, now)"),
  );
  assert.ok(patch.length > 0, "the observer patch moved; this test needs rewriting, not deleting");
  assert.match(patch, /title: s\.title \|\| null/);
});
