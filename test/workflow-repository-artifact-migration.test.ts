import assert from "node:assert/strict";
import test from "node:test";
import { openDb, closeDb } from "../src/server/db.ts";

test("pre-artifact submissions reopen twice with the fresh artifact tables, indexes and triggers and no synthetic claims", () => {
  const db = openDb();
  function schema() {
    return openDb()
      .prepare(
        `SELECT type,name,sql FROM sqlite_master
      WHERE name LIKE '%repository_artifact%' OR name LIKE '%repository_snapshot_claim%'
        OR name LIKE 'repository_%' OR name LIKE 'idx_repository_claim_%' ORDER BY name`,
      )
      .all();
  }
  const fresh = schema();
  db.prepare(
    `INSERT INTO workflow_submissions(id,run_id,round,mode,trigger_source,trigger_key,
    evidence_fingerprint,context_json,evidence_json,status,created_at,updated_at)
    VALUES('legacy','run',1,'full_workflow','manual','legacy','unchanged','{}','{}','running',1,1)`,
  ).run();
  db.exec(`DROP TRIGGER repository_activation_required;
    DROP TRIGGER repository_capture_failed;
    DROP TABLE workflow_repository_snapshot_claims;
    DROP TABLE workflow_repository_artifacts;
    PRAGMA user_version=50;`);
  for (let i = 0; i < 2; i++) {
    closeDb();
    assert.deepEqual(schema(), fresh);
    const upgraded = openDb();
    assert.equal(
      upgraded.prepare("SELECT evidence_fingerprint FROM workflow_submissions WHERE id='legacy'").get()
        ?.evidence_fingerprint,
      "unchanged",
    );
    assert.equal(
      upgraded.prepare("SELECT count(*) AS n FROM workflow_repository_snapshot_claims").get()?.n,
      0,
    );
  }
});
