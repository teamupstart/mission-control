import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

// A version-38 database, written before the asynchronous input inbox: the real schema, made in a
// child process by this build, then wound back to what a version-38 daemon left on disk - the
// reviews table without `wait_mode`, `meanwhile` and `closed_reason`, holding one open question.
const home = mkdtempSync(join(tmpdir(), "mission-async-input-migration-"));
process.env.MISSION_HOME = home;
execFileSync(process.execPath, ["--import", "tsx", "-e", "await import(process.env.DB_MODULE).then(m => m.openDb())"], {
  env: { ...process.env, DB_MODULE: new URL("../src/server/db.ts", import.meta.url).href }, stdio: "pipe",
});
const COLUMNS = ["wait_mode", "meanwhile", "closed_reason", "filed_by_voice_at", "voice_conversion_blocked"];
const old = new DatabaseSync(join(home, "harness.db"));
old.exec(`${COLUMNS.map((column) => `ALTER TABLE reviews DROP COLUMN ${column};`).join("\n")}
  INSERT INTO reviews (id, session_id, kind, title, body, status, response, snoozable, created_at, resolved_at)
  VALUES ('open-question', 'sdk:s', 'input', 'Which path?', 'Which path?', 'pending', NULL, 1, 100, NULL);
  PRAGMA user_version = 38`);
old.close();
const db = await import("../src/server/db.ts");
after(() => rmSync(home, { recursive: true, force: true }));

test("version 38 upgrade adds the async-input columns, and an open question reads as call mode with nothing closed", () => {
  const d = db.openDb();
  const columns = new Set((d.prepare("PRAGMA table_info(reviews)").all() as Array<{ name: string }>).map((c) => c.name));
  for (const column of COLUMNS) assert.ok(columns.has(column), column);
  assert.equal((d.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, db.CURRENT_DATABASE_SCHEMA_VERSION);
  // Later schemas build on 39; a 38 file goes all the way to the current one.
  assert.ok(db.CURRENT_DATABASE_SCHEMA_VERSION >= 39);

  const question = db.loadPendingReviews().find((r) => r.id === "open-question");
  assert.equal(question?.status, "pending");
  assert.equal(question?.snoozable, true);
  assert.equal(question?.waitMode, undefined, "an existing question was waited for inside the call");
  assert.equal(question?.filedByVoiceAt, undefined);
  assert.equal(db.fileReviewByVoice("open-question", 200), null, "an older daemon may have promised a call result");
  assert.equal(question?.meanwhile, undefined);
  assert.equal(question?.closedReason, undefined);
  const raw = d.prepare("SELECT mcp_wait_detached_at FROM reviews WHERE id = 'open-question'").get() as { mcp_wait_detached_at: number | null };
  assert.equal(raw.mcp_wait_detached_at, null, "the upgrade does not invent a detach");

  // A row this build writes round-trips every new field, and an unknown persisted value reads safely.
  db.insertReview({
    id: "filed", sessionId: "sdk:s", kind: "input", title: "Q?", body: "Q?", status: "pending", response: null,
    snoozable: true, waitMode: "message", meanwhile: "holding the release", createdAt: 200, resolvedAt: null,
  });
  db.updateReviewStatus("filed", "orphaned", null, 300, null, null, "merged");
  d.exec("UPDATE reviews SET wait_mode = 'telepathy', closed_reason = 'later' WHERE id = 'open-question'");
  const rows = d.prepare("SELECT * FROM reviews WHERE id IN ('filed', 'open-question') ORDER BY id").all() as Array<Record<string, unknown>>;
  assert.deepEqual(rows.map((r) => [r.id, r.wait_mode, r.meanwhile, r.closed_reason, r.mcp_wait_detached_at]), [
    ["filed", "message", "holding the release", "merged", 200],
    ["open-question", "telepathy", null, "later", null],
  ]);
  const reread = db.loadPendingReviews().find((r) => r.id === "open-question")!;
  assert.equal(reread.waitMode, undefined, "an unknown wait mode reads as call mode");
  assert.equal(reread.closedReason, undefined, "an unknown close reason is not shown");
  db.closeDb();
});
