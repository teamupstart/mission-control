import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// The refusal record a drafted finding carries toward the cap: `post_refusals` and
// `last_post_error`. What is at stake is the cap itself. A migration that left existing rows
// with anything but zero would start them part-way to retirement, and a writer that dropped
// the pair would hand a draft GitHub keeps refusing a fresh three tries.
const home = mkdtempSync(join(tmpdir(), "mission-inspector-refusals-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

// `inspector_comments` as the build before this change left it: posting columns migrated, no
// refusal columns.
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
    updated_at INTEGER NOT NULL,
    posted_at INTEGER,
    github_url TEXT,
    legacy_posted TEXT
  );
  CREATE UNIQUE INDEX idx_inspector_comments_fp ON inspector_comments(pr_key, fingerprint);
  INSERT INTO inspector_comments
    (id, pr_key, fingerprint, path, line, title, body, severity, round, status, replies,
     answered_comment_id, created_at, updated_at)
    VALUES ('id-1', 'o/r#7', 'fp-legacy', 'src/a.ts', 1, 'Legacy draft', 'detail', 'major', 1,
            'drafted', 0, NULL, 1, 1);
`);
legacy.close();

const { closeDb, loadInspectorComments, openDb, upsertInspectorComment } = await import("../src/server/db.ts");
after(() => closeDb());

test("an existing row migrates with no refusals and no reason", () => {
  const columns = (openDb().prepare("PRAGMA table_info(inspector_comments)").all() as { name: string }[])
    .map((c) => c.name);
  assert.ok(columns.includes("post_refusals") && columns.includes("last_post_error"));
  const row = loadInspectorComments("o/r#7")[0]!;
  assert.equal(row.postRefusals, 0);
  assert.equal(row.lastPostError, null);
});

test("the upsert writes the pair, and carries it when a writer omits it", () => {
  const [row] = loadInspectorComments("o/r#7");
  upsertInspectorComment({ ...row!, postRefusals: 2, lastPostError: "Line could not be resolved (HTTP 422)" });
  assert.deepEqual(
    (({ postRefusals, lastPostError }) => ({ postRefusals, lastPostError }))(loadInspectorComments("o/r#7")[0]!),
    { postRefusals: 2, lastPostError: "Line could not be resolved (HTTP 422)" },
  );

  // A writer that built the row without the pair keeps both stored values.
  const { postRefusals: _count, lastPostError: _reason, ...withoutPair } = loadInspectorComments("o/r#7")[0]!;
  upsertInspectorComment({ ...withoutPair, status: "resolved", updatedAt: 9 });
  const kept = loadInspectorComments("o/r#7")[0]!;
  assert.equal(kept.status, "resolved", "the rest of the row was written");
  assert.equal(kept.postRefusals, 2);
  assert.equal(kept.lastPostError, "Line could not be resolved (HTTP 422)");

  // A new row with no pair starts at zero.
  upsertInspectorComment({ ...withoutPair, id: "id-2", fingerprint: "fp-new" });
  const fresh = loadInspectorComments("o/r#7").find((r) => r.fingerprint === "fp-new")!;
  assert.equal(fresh.postRefusals, 0);
  assert.equal(fresh.lastPostError, null);
});
