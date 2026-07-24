import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// What is at stake: findings created before Phase 5 must remain readable, while new
// repair packets need the exact already-scrubbed detail that Inspector reviewed.
const home = mkdtempSync(join(tmpdir(), "mission-inspector-body-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const legacy = new DatabaseSync(join(home, "harness.db"));
legacy.exec(`
  CREATE TABLE inspector_comments (
    id TEXT PRIMARY KEY,
    pr_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    path TEXT,
    line INTEGER,
    title TEXT NOT NULL,
    severity TEXT NOT NULL,
    round INTEGER NOT NULL,
    status TEXT NOT NULL,
    replies INTEGER NOT NULL DEFAULT 0,
    answered_comment_id INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX idx_inspector_comments_fp
    ON inspector_comments(pr_key, fingerprint);
  INSERT INTO inspector_comments (
    id, pr_key, fingerprint, path, line, title, severity, round, status,
    replies, answered_comment_id, created_at, updated_at
  ) VALUES (
    'legacy', 'owner/repo#7', 'old-fingerprint', 'old.ts', 4, 'Legacy issue',
    'major', 1, 'open', 0, NULL, 1, 1
  );
`);
legacy.close();

const {
  loadInspectorComments,
  openDb,
  upsertInspectorComment,
} = await import("../src/server/db.ts");

test("fresh SQL and upgraded databases both carry the nullable finding body", () => {
  const db = openDb();
  const columns = db.prepare(`PRAGMA table_info(inspector_comments)`).all() as Array<{
    name: string;
    notnull: number;
  }>;
  const body = columns.find((column) => column.name === "body");
  assert.deepEqual(body && { name: body.name, notnull: body.notnull }, { name: "body", notnull: 0 });

  // This pins the fresh-install half separately from migrate(): editing only one of
  // these two surfaces has caused existing-table columns to disappear before.
  const source = readFileSync(new URL("../src/server/db.ts", import.meta.url), "utf8");
  assert.match(source, /CREATE TABLE IF NOT EXISTS inspector_comments[\s\S]*body\s+TEXT/);
  assert.match(source, /addColumn\(d,\s*"inspector_comments",\s*"body",\s*"TEXT"\)/);
});

test("legacy nulls and already-scrubbed bodies round trip and survive resolution", () => {
  assert.equal(loadInspectorComments("owner/repo#7")[0]?.body, null);
  const scrubbed = "Use [REDACTED] instead of persisting the credential.";
  upsertInspectorComment({
    id: "fresh",
    prKey: "owner/repo#7",
    fingerprint: "new-fingerprint",
    path: "src/auth.ts",
    line: 18,
    title: "Credential reaches the log",
    body: scrubbed,
    severity: "blocker",
    round: 2,
    status: "open",
    replies: 0,
    answeredCommentId: null,
    createdAt: 2,
    updatedAt: 2,
  });
  const open = loadInspectorComments("owner/repo#7").find((row) => row.id === "fresh")!;
  assert.equal(open.body, scrubbed);
  assert.doesNotMatch(open.body!, /secret-token/);

  upsertInspectorComment({ ...open, status: "resolved", updatedAt: 3 });
  const resolved = loadInspectorComments("owner/repo#7").find((row) => row.id === "fresh")!;
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.body, scrubbed, "resolution must not erase the frozen repair detail");
});
