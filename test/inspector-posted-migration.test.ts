import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// What is at stake: a finding recorded before posting was tracked must report only what its
// row proves. A resolved finding that was posted must not read as never posted, and one
// nothing proves either way must read as unknown rather than as a confident answer.
const home = mkdtempSync(join(tmpdir(), "mission-inspector-posted-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

// `inspector_comments` exactly as the build before this change left it: `body` and
// `resolution_pending` already migrated, no posting columns.
const legacy = new DatabaseSync(join(home, "harness.db"));
legacy.exec(`
  CREATE TABLE inspector_comments (
    id TEXT PRIMARY KEY,
    pr_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    path TEXT,
    line INTEGER,
    title TEXT NOT NULL,
    body TEXT,
    severity TEXT NOT NULL,
    round INTEGER NOT NULL,
    status TEXT NOT NULL,
    replies INTEGER NOT NULL DEFAULT 0,
    answered_comment_id INTEGER,
    created_at INTEGER NOT NULL,
    resolution_pending INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX idx_inspector_comments_fp ON inspector_comments(pr_key, fingerprint);
`);
const insert = legacy.prepare(`INSERT INTO inspector_comments
  (id, pr_key, fingerprint, path, line, title, body, severity, round, status, replies,
   answered_comment_id, created_at, updated_at)
  VALUES (?, 'o/r#7', ?, 'src/a.ts', 1, ?, 'detail', 'major', 1, ?, ?, ?, ?, ?)`);
// [fingerprint, status, replies, answered comment id, expected backfill]
const LEGACY_ROWS = [
  ["open", "open", 0, null, "posted"],
  ["open-replied", "open", 2, 9, "posted"],
  ["drafted", "drafted", 0, null, "unposted"],
  // A draft that carries replies was a thread on GitHub before it was re-raised.
  ["drafted-replied", "drafted", 1, null, "posted"],
  ["posting", "posting", 0, null, "unknown"],
  ["resolved-silent", "resolved", 0, null, "unknown"],
  ["resolved-replied", "resolved", 3, null, "posted"],
  ["resolved-answered", "resolved", 0, 55, "posted"],
] as const;
LEGACY_ROWS.forEach(([fp, status, replies, answered], i) => {
  insert.run(`id-${fp}`, fp, `Issue ${fp}`, status, replies, answered, i + 1, i + 1);
});
legacy.close();

const {
  closeDb,
  loadInspectorComments,
  openDb,
  resolveInspectorFindings,
  upsertInspectorComment,
  adoptInspectorPr,
} = await import("../src/server/db.ts");
const { findingPublication } = await import("../src/shared/inspector-findings.ts");

function byFingerprint() {
  return new Map(loadInspectorComments("o/r#7").map((row) => [row.fingerprint, row]));
}

test("the posting columns are added by migrate(), nullable, and never in the CREATE block", () => {
  const columns = openDb().prepare(`PRAGMA table_info(inspector_comments)`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
  }>;
  for (const [name, type] of [["posted_at", "INTEGER"], ["github_url", "TEXT"], ["legacy_posted", "TEXT"]]) {
    const column = columns.find((c) => c.name === name);
    assert.deepEqual(
      column && { type: column.type, notnull: column.notnull, dflt: column.dflt_value },
      { type, notnull: 0, dflt: null },
      `${name} must be a nullable ${type} with no default`,
    );
  }
  const source = readFileSync(new URL("../src/server/db.ts", import.meta.url), "utf8");
  const create = source.slice(source.indexOf("CREATE TABLE IF NOT EXISTS inspector_comments"));
  const block = create.slice(0, create.indexOf(");"));
  assert.doesNotMatch(block, /posted_at|github_url|legacy_posted/,
    "CREATE TABLE IF NOT EXISTS never reaches an upgrading database, so the columns live in migrate()");
});

test("the one-time backfill records what each legacy row proves, for every legacy status", () => {
  const rows = byFingerprint();
  for (const [fp, , , , expected] of LEGACY_ROWS) {
    const row = rows.get(fp)!;
    assert.equal(row.legacyPosted, expected, `${fp} backfills as ${expected}`);
    assert.equal(row.postedAt, null, `${fp} gets no invented post time`);
    assert.equal(row.githubUrl, null);
  }
  // And the derivation turns those answers into what the operator reads.
  assert.equal(findingPublication(rows.get("resolved-replied")!).state, "posted");
  assert.equal(findingPublication(rows.get("resolved-answered")!).state, "posted");
  assert.equal(findingPublication(rows.get("resolved-silent")!).state, "unknown");
  assert.equal(findingPublication(rows.get("drafted")!).state, "not-posted");
  assert.deepEqual(findingPublication(rows.get("drafted-replied")!), {
    state: "not-posted",
    url: null,
    postedAt: null,
    earlierPost: true,
    refusals: 0,
    reason: null,
  });
});

test("reopening an upgraded database does not run the backfill again", () => {
  const db = openDb();
  // Simulate a row whose status moved on after the upgrade. A second backfill would
  // reclassify it; the guarded `addColumn` must keep the first answer.
  const row = byFingerprint().get("drafted")!;
  upsertInspectorComment({ ...row, status: "open", postedAt: 1_000, updatedAt: 10 });
  closeDb();
  assert.notEqual(openDb(), db, "a fresh connection ran migrate() again");
  assert.equal(byFingerprint().get("drafted")!.legacyPosted, "unposted");
  assert.equal(byFingerprint().get("drafted")!.postedAt, 1_000);
});

test("rows this build creates keep legacy_posted NULL, and the upsert never touches it", () => {
  upsertInspectorComment({
    id: "id-fresh",
    prKey: "o/r#7",
    fingerprint: "fresh",
    path: "src/a.ts",
    line: 2,
    title: "Fresh issue",
    body: "detail",
    severity: "minor",
    round: 2,
    status: "drafted",
    replies: 0,
    answeredCommentId: null,
    // A caller cannot smuggle a legacy answer onto a new row.
    legacyPosted: "posted",
    createdAt: 20,
    updatedAt: 20,
  });
  assert.equal(byFingerprint().get("fresh")!.legacyPosted, null);

  const old = byFingerprint().get("resolved-replied")!;
  upsertInspectorComment({ ...old, status: "drafted", legacyPosted: null, updatedAt: 21 });
  assert.equal(byFingerprint().get("resolved-replied")!.legacyPosted, "posted",
    "re-raising a legacy finding keeps what its row proved");
});

test("posted_at and github_url are never cleared, through re-raising and resolution", () => {
  const url = "https://github.com/o/r/pull/7#discussion_r1";
  const row = byFingerprint().get("open")!;
  upsertInspectorComment({ ...row, postedAt: 500, githubUrl: url, updatedAt: 30 });

  // A writer that passes null, or omits the fields, keeps the record.
  const { postedAt: _p, githubUrl: _g, ...bare } = byFingerprint().get("open")!;
  upsertInspectorComment({ ...bare, status: "drafted", updatedAt: 31 });
  upsertInspectorComment({ ...bare, status: "drafted", postedAt: null, githubUrl: null, updatedAt: 32 });
  const reraised = byFingerprint().get("open")!;
  assert.equal(reraised.postedAt, 500);
  assert.equal(reraised.githubUrl, url);
  assert.equal(findingPublication(reraised).earlierPost, true);

  // The operator's Resolve goes through the same upsert and carries both through `...row`.
  adoptInspectorPr({
    key: "o/r#7", url: "https://github.com/o/r/pull/7", owner: "o", repo: "r", number: 7,
    repoRoot: null, cwd: null, sessionId: null, source: "hook", state: "open", headSha: null,
    reviewPosture: null, round: 1, lastReviewedAt: null, lastError: null, failCount: 0,
    lastFailKind: null, nextAttemptAt: null, lastAttemptSha: null, mergedAt: null,
    mergeBlock: null, observedHeadSha: null, observedState: null, observedAt: null,
    headRefName: null, title: null, adoptedAt: 1, updatedAt: 1,
  });
  assert.ok(resolveInspectorFindings("o/r#7", 40) > 0);
  const resolved = byFingerprint().get("open")!;
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.postedAt, 500);
  assert.equal(resolved.githubUrl, url);
  assert.equal(findingPublication(resolved).state, "posted");

  // A later confirmed post re-stamps it.
  upsertInspectorComment({ ...resolved, status: "open", postedAt: 900, updatedAt: 50 });
  assert.equal(byFingerprint().get("open")!.postedAt, 900);
});
