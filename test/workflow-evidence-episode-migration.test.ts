import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-workflow-evidence-episode-migration-"));
process.env.MISSION_HOME = home;

// The table shape immediately before episode-scoped evidence shipped. CREATE TABLE IF NOT
// EXISTS will leave it alone, so only migrate() can add the nullable provenance column.
const raw = new DatabaseSync(join(home, "harness.db"));
raw.exec(`
  CREATE TABLE workflow_evidence_staging (
    id                    TEXT PRIMARY KEY,
    note_key              TEXT NOT NULL,
    client_item_id        TEXT NOT NULL,
    source_kind           TEXT NOT NULL,
    evidence_kind         TEXT NOT NULL DEFAULT 'image',
    source_root           TEXT NOT NULL,
    source_locator        TEXT NOT NULL,
    inline_content        TEXT,
    display_name          TEXT NOT NULL,
    caption               TEXT NOT NULL,
    repository_scope      TEXT NOT NULL,
    mime_type             TEXT NOT NULL,
    bytes                 INTEGER NOT NULL,
    sha256                TEXT NOT NULL,
    generation            INTEGER NOT NULL,
    state                 TEXT NOT NULL,
    reserved_group_key    TEXT,
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL,
    UNIQUE(note_key, client_item_id)
  );
  INSERT INTO workflow_evidence_staging (
    id, note_key, client_item_id, source_kind, evidence_kind, source_root, source_locator,
    inline_content, display_name, caption, repository_scope, mime_type, bytes, sha256,
    generation, state, reserved_group_key, created_at, updated_at
  ) VALUES (
    'legacy', 'legacy-note', 'legacy-proof', 'agent', 'image', '/repo', 'proof.png',
    NULL, 'proof.png', 'Legacy evidence', 'repo-01', 'image/png', 68,
    '${"a".repeat(64)}', 1, 'staged', NULL, 1, 1
  );
`);
raw.close();

const { openDb } = await import("../src/server/db.ts");
const { WorkflowStore } = await import("../src/server/workflows/store.ts");
const db = openDb();

after(() => rmSync(home, { recursive: true, force: true }));

test("an upgraded evidence table gains a nullable intent-episode stamp", () => {
  const columns = db.prepare("PRAGMA table_info(workflow_evidence_staging)").all() as unknown as Array<{
    name: string;
    notnull: number;
  }>;
  const episode = columns.find((column) => column.name === "episode_key");
  assert.ok(episode, "migrate() must add episode_key to an existing staging table");
  assert.equal(episode.notnull, 0, "legacy rows must remain representable without invented provenance");
});

test("legacy unstamped evidence remains readable and explicitly has no episode", () => {
  const staged = new WorkflowStore().listWorkflowEvidence("legacy-note");
  assert.equal(staged.images[0]?.clientItemId, "legacy-proof");
  assert.equal(staged.images[0]?.episodeKey, null);
});
