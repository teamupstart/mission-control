import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// `addColumn` reports "added" once, so a `legacy_posted` column committed without its backfill
// would leave every legacy row NULL forever. A trigger fails the backfill here to prove the
// column rolls back with it and the next open classifies the rows.
const home = mkdtempSync(join(tmpdir(), "mission-inspector-legacy-atomic-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const dbPath = join(home, "harness.db");
const legacy = new DatabaseSync(dbPath);
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
  INSERT INTO inspector_comments (id, pr_key, fingerprint, title, severity, round, status, created_at, updated_at)
    VALUES ('id-open', 'o/r#7', 'open', 'Open issue', 'major', 1, 'open', 1, 1);
  CREATE TRIGGER fail_backfill BEFORE UPDATE ON inspector_comments
    BEGIN SELECT RAISE(ABORT, 'backfill interrupted'); END;
  PRAGMA user_version = 25;
`);
legacy.close();

const { openDb, loadInspectorComments } = await import("../src/server/db.ts");

test("an interrupted backfill takes the legacy_posted column with it, and the next open runs both", () => {
  assert.throws(() => openDb(), /backfill interrupted/);

  const raw = new DatabaseSync(dbPath);
  const columns = (raw.prepare(`PRAGMA table_info(inspector_comments)`).all() as { name: string }[])
    .map((c) => c.name);
  assert.ok(!columns.includes("legacy_posted"), "the column rolled back with its failed backfill");
  raw.exec("DROP TRIGGER fail_backfill;");
  raw.close();

  openDb();
  assert.equal(loadInspectorComments("o/r#7").find((row) => row.fingerprint === "open")?.legacyPosted, "posted");
});
