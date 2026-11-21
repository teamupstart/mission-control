import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

// A version-40 database, written before review-message deliveries existed: the real schema, made
// in a child process by this build, then wound back to what a version-40 daemon left on disk - no
// `session_review_deliveries` table and neither of its indexes.
const home = mkdtempSync(join(tmpdir(), "mission-review-deliveries-migration-"));
process.env.MISSION_HOME = home;
execFileSync(process.execPath, ["--import", "tsx", "-e", "await import(process.env.DB_MODULE).then(m => m.openDb())"], {
  env: { ...process.env, DB_MODULE: new URL("../src/server/db.ts", import.meta.url).href }, stdio: "pipe",
});
const INDEXES = ["idx_session_review_deliveries_key", "idx_session_review_deliveries_age"];
const old = new DatabaseSync(join(home, "harness.db"));
old.exec(`${INDEXES.map((index) => `DROP INDEX ${index};`).join("\n")}
  DROP TABLE session_review_deliveries;
  PRAGMA user_version = 40`);
assert.equal(
  old.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'session_review_deliveries'").get()!.n,
  0,
  "precondition: the wound-back database has no delivery table",
);
old.close();
const db = await import("../src/server/db.ts");
const { reserveReviewDelivery, confirmReviewDelivery } = await import("../src/server/review-deliveries.ts");
after(() => rmSync(home, { recursive: true, force: true }));

test("version 40 upgrade creates session_review_deliveries and its indexes, and a delivery can be recorded", () => {
  const d = db.openDb();
  assert.equal((d.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 41);
  assert.equal(db.CURRENT_DATABASE_SCHEMA_VERSION, 41);
  const columns = new Set((d.prepare("PRAGMA table_info(session_review_deliveries)").all() as Array<{ name: string }>).map((c) => c.name));
  for (const column of ["note_key", "fingerprint", "envelope", "review_ids", "transcript_offset", "message_id", "echo_owed", "steer_echo"]) {
    assert.ok(columns.has(column), column);
  }
  const indexes = new Set((d.prepare("PRAGMA index_list(session_review_deliveries)").all() as Array<{ name: string }>).map((i) => i.name));
  for (const index of INDEXES) assert.ok(indexes.has(index), index);

  // The first delivery after the upgrade is recorded, not refused by a missing table.
  const text = "[mission-control:answer review=1b0c9f4e-2a8d-4a43-9d3e-0f6c2b7e5a10]\n\nUse eslint";
  const id = reserveReviewDelivery({ key: "upgraded", transcript: null }, text, undefined);
  assert.ok(id);
  confirmReviewDelivery("upgraded", id!);
  const row = d.prepare("SELECT review_ids, confirmed_at FROM session_review_deliveries WHERE id = ?").get(id!) as { review_ids: string; confirmed_at: number | null };
  assert.deepEqual(JSON.parse(row.review_ids), ["1b0c9f4e-2a8d-4a43-9d3e-0f6c2b7e5a10"]);
  assert.notEqual(row.confirmed_at, null);
});
