// Upgrade and execution contract for run-scoped Persona feedback. A fresh database alone
// cannot prove either new column reaches an existing operator database.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "workflow-persona-directive-db-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const persona = JSON.stringify({
  sourcePersonaId: "persona",
  sourceRevision: 1,
  name: "Judge",
  description: "",
  guidanceMarkdown: "Judge the change",
  runner: "claude",
  model: "fake-model",
});

function seedPreFeatureDb(): void {
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec(`
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY, binding_id TEXT NOT NULL, workflow_version_id TEXT NOT NULL,
      status TEXT NOT NULL, current_phase TEXT NOT NULL, max_repair_rounds INTEGER NOT NULL,
      trigger_source TEXT NOT NULL, trigger_key TEXT NOT NULL, inspector_pr_key TEXT,
      inspector_head_sha TEXT, gate_state_json TEXT, started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, completed_at INTEGER, evidence_pruned_at INTEGER,
      disabled_nodes_json TEXT
    );
    CREATE TABLE workflow_node_attempts (
      id TEXT PRIMARY KEY, submission_id TEXT NOT NULL, node_id TEXT NOT NULL,
      attempt INTEGER NOT NULL, state TEXT NOT NULL, persona_snapshot_json TEXT,
      session_action_snapshot_json TEXT, runner_id TEXT, model_id TEXT, verdict_json TEXT,
      output_json TEXT, retry_at INTEGER, input_fingerprint TEXT NOT NULL, error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER,
      finished_at INTEGER
    );
    CREATE UNIQUE INDEX idx_workflow_node_attempts_identity
      ON workflow_node_attempts(submission_id, node_id, attempt);
    CREATE INDEX idx_workflow_node_attempts_state
      ON workflow_node_attempts(state, retry_at);
    CREATE TABLE workflow_evidence_staging (
      id TEXT PRIMARY KEY, note_key TEXT NOT NULL, client_item_id TEXT NOT NULL,
      source_kind TEXT NOT NULL, source_root TEXT NOT NULL, source_locator TEXT NOT NULL,
      display_name TEXT NOT NULL, caption TEXT NOT NULL, repository_scope TEXT NOT NULL,
      mime_type TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
      generation INTEGER NOT NULL, state TEXT NOT NULL, reserved_group_key TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(note_key, client_item_id)
    );
    INSERT INTO workflow_evidence_staging (
      id, note_key, client_item_id, source_kind, source_root, source_locator,
      display_name, caption, repository_scope, mime_type, bytes, sha256,
      generation, state, reserved_group_key, created_at, updated_at
    ) VALUES (
      'old-image', 'old-note', 'old-client', 'agent', '/repo', 'evidence/old.png',
      'old.png', 'Historical image', 'repo-01', 'image/png', 10,
      '${"a".repeat(64)}', 1, 'staged', NULL, 1, 1
    );
    INSERT INTO workflow_runs (
      id, binding_id, workflow_version_id, status, current_phase, max_repair_rounds,
      trigger_source, trigger_key, started_at, updated_at
    ) VALUES ('run', 'binding', 'version', 'running', 'persona_review', 5,
      'manual', 'run-trigger', 1, 2);
  `);
  raw.close();
}

test("an upgraded run persists feedback and snapshots each later Persona attempt", async () => {
  seedPreFeatureDb();
  const { openDb } = await import("../src/server/db.ts");
  const db = openDb();
  const { WorkflowStore } = await import("../src/server/workflows/store.ts");
  const store = new WorkflowStore(db);

  const runColumns = new Set(
    (db.prepare("PRAGMA table_info(workflow_runs)").all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  const attemptColumns = new Set(
    (db.prepare("PRAGMA table_info(workflow_node_attempts)").all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  assert.ok(runColumns.has("persona_directives_json"));
  assert.ok(attemptColumns.has("operator_directive_json"));
  assert.ok(attemptColumns.has("check_evidence_json"));
  assert.deepEqual(store.getRun("run")?.personaDirectives, []);
  const stagingColumns = new Set(
    (db.prepare("PRAGMA table_info(workflow_evidence_staging)").all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  assert.ok(stagingColumns.has("evidence_kind"));
  assert.ok(stagingColumns.has("inline_content"));
  assert.equal(store.listWorkflowEvidence("old-note").images[0]?.id, "old-image");
  assert.deepEqual(store.listWorkflowEvidence("old-note").artifacts, []);

  db.prepare(`
    INSERT INTO workflow_submissions (
      id, run_id, round, segment, mode, trigger_source, trigger_key, evidence_fingerprint,
      context_json, evidence_json, status, created_at, updated_at
    ) VALUES (?, 'run', ?, 0, 'full_workflow', 'manual', ?, 'fp', '{}', '{}',
      'running', ?, ?)
  `).run("submission-1", 1, "submission-1-trigger", 3, 3);

  const first = store.setRunPersonaDirective(
    "run",
    "judge",
    "Honor the approved exception",
    { kind: "persona_directive_set", payload: { nodeId: "judge", requestId: "set-1" } },
    4,
  );
  assert.ok(first);
  assert.equal(first.directive.revision, 1);

  store.insertAttempt({
    id: "attempt-1",
    submissionId: "submission-1",
    nodeId: "judge",
    attempt: 1,
    state: "queued",
    persona: JSON.parse(persona),
    inputFingerprint: "attempt-1-fp",
    now: 5,
  });
  const claimedFirst = store.claimAttempt("attempt-1", "claude", "fake-model", 6);
  assert.equal(claimedFirst?.operatorDirective?.feedback, "Honor the approved exception");
  assert.equal(claimedFirst?.operatorDirective?.revision, 1);

  const second = store.setRunPersonaDirective(
    "run",
    "judge",
    "Honor the exception and cite the human decision",
    { kind: "persona_directive_set", payload: { nodeId: "judge", requestId: "set-2" } },
    7,
  );
  assert.equal(second?.directive.revision, 2);
  assert.equal(store.getAttempt("attempt-1")?.operatorDirective?.revision, 1);

  db.prepare(`
    INSERT INTO workflow_submissions (
      id, run_id, round, segment, mode, trigger_source, trigger_key, evidence_fingerprint,
      context_json, evidence_json, status, created_at, updated_at
    ) VALUES (?, 'run', ?, 0, 'full_workflow', 'manual', ?, 'fp-2', '{}', '{}',
      'running', ?, ?)
  `).run("submission-2", 2, "submission-2-trigger", 8, 8);
  store.insertAttempt({
    id: "attempt-2",
    submissionId: "submission-2",
    nodeId: "judge",
    attempt: 1,
    state: "queued",
    persona: JSON.parse(persona),
    inputFingerprint: "attempt-2-fp",
    now: 9,
  });
  const claimedSecond = store.claimAttempt("attempt-2", "claude", "fake-model", 10);
  assert.equal(claimedSecond?.operatorDirective?.feedback, "Honor the exception and cite the human decision");
  assert.equal(claimedSecond?.operatorDirective?.revision, 2);

  const removed = store.removeRunPersonaDirective(
    "run",
    "judge",
    { kind: "persona_directive_removed", payload: { nodeId: "judge", requestId: "remove-1" } },
    11,
  );
  assert.equal(removed?.removed, true);
  assert.deepEqual(removed?.run.personaDirectives, []);
  assert.equal(store.getAttempt("attempt-2")?.operatorDirective?.revision, 2);
});
