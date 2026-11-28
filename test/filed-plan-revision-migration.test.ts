import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { tempDir } from "./temp-root.mjs";

// A version-46 database, written before revised plan forms: the real schema, made in a child
// process by this build, then wound back to what a version-46 daemon left on disk - the reviews
// table without `revises_review_id`, `revision` and their index, holding one open filed plan form
// and one its agent withdrew.
const home = tempDir("mission-filed-plan-revision-migration-");
process.env.MISSION_HOME = home;
execFileSync(process.execPath, ["--import", "tsx", "-e", "await import(process.env.DB_MODULE).then(m => m.openDb())"], {
  env: { ...process.env, DB_MODULE: new URL("../src/server/db.ts", import.meta.url).href }, stdio: "pipe",
});
const COLUMNS = ["revises_review_id", "revision"];
const old = new DatabaseSync(join(home, "harness.db"));
old.exec(`DROP INDEX idx_reviews_revises;
  ${COLUMNS.map((column) => `ALTER TABLE reviews DROP COLUMN ${column};`).join("\n")}
  INSERT INTO reviews (id, session_id, kind, title, body, status, response, decisions, created_at, resolved_at, wait_mode, mcp_wait_detached_at)
  VALUES ('open-plan', 'sdk:s', 'plan-decisions', 'Linter plan', '# Linter plan', 'pending', NULL, '[]', 100, NULL, 'message', 100),
         ('withdrawn-plan', 'sdk:s', 'plan-decisions', 'Old plan', '# Old plan', 'withdrawn', 'Scope changed', '[]', 50, 60, 'message', 50);
  PRAGMA user_version = 46`);
old.close();
const db = await import("../src/server/db.ts");
after(() => rmSync(home, { recursive: true, force: true }));

test("version 46 upgrade adds the revision columns and index, and every existing form revises nothing", () => {
  const d = db.openDb();
  const columns = new Set((d.prepare("PRAGMA table_info(reviews)").all() as Array<{ name: string }>).map((c) => c.name));
  for (const column of COLUMNS) assert.ok(columns.has(column), column);
  assert.ok(d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_reviews_revises'").get(), "the one-revision index");
  const fk = (d.prepare("PRAGMA foreign_key_list(reviews)").all() as Array<{ table: string; from: string; to: string; on_delete: string }>)
    .find((key) => key.from === "revises_review_id");
  assert.deepEqual(fk && { table: fk.table, to: fk.to, onDelete: fk.on_delete }, { table: "reviews", to: "id", onDelete: "SET NULL" },
    "the link is an enforced self-reference");
  assert.equal((d.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, db.CURRENT_DATABASE_SCHEMA_VERSION);
  assert.ok(db.CURRENT_DATABASE_SCHEMA_VERSION >= 47);

  const open = db.loadPendingReviews().find((r) => r.id === "open-plan")!;
  assert.equal(open.status, "pending");
  assert.equal(open.waitMode, "message", "still a filed form");
  assert.equal("revision" in open, false, "an existing form revises nothing");
  const withdrawn = db.loadReview("withdrawn-plan")!;
  assert.equal(withdrawn.status, "withdrawn");
  assert.equal("revision" in withdrawn, false);
  assert.equal(db.reviewRevisedBy("withdrawn-plan"), null);

  // A row this build writes round-trips the link, and the index keeps one revision per form.
  db.insertReview({
    id: "revised", sessionId: "sdk:s", kind: "plan-decisions", title: "Linter plan, revised", body: "# Revised", status: "pending",
    response: null, decisions: [], waitMode: "message", revision: { number: 2, previousId: "withdrawn-plan" }, createdAt: 200, resolvedAt: null,
  });
  assert.deepEqual(db.loadReview("revised")?.revision, { number: 2, previousId: "withdrawn-plan" });
  assert.equal(db.reviewRevisedBy("withdrawn-plan"), "revised");
  assert.throws(() => db.insertReview({
    id: "second-revision", sessionId: "sdk:s", kind: "plan-decisions", title: "Again", body: "# Again", status: "pending",
    response: null, decisions: [], waitMode: "message", revision: { number: 2, previousId: "withdrawn-plan" }, createdAt: 300, resolvedAt: null,
  }), /UNIQUE constraint failed/);
  // A half-written or impossible link is not shown: both halves, and a number of at least 2.
  d.exec("UPDATE reviews SET revision = 1 WHERE id = 'revised'");
  assert.equal("revision" in db.loadReview("revised")!, false);
  db.closeDb();
});
