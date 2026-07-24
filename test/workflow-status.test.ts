import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-workflow-status-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { clearWorkflowTables, WorkflowStore } = await import("../src/server/workflows/store.ts");
const db = openDb();

test("workflow status is on-demand, structured, bounded, and payload-free", () => {
  db.prepare(
    `INSERT INTO workflow_runs (
       id, binding_id, workflow_version_id, status, current_phase, max_repair_rounds,
       trigger_source, trigger_key, gate_state_json, started_at, updated_at
     ) VALUES ('run', 'binding', 'version', 'running', 'persona_review', 5,
               'manual', 'trigger', NULL, 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_submissions (
       id, run_id, round, mode, trigger_source, trigger_key, evidence_fingerprint,
       context_json, evidence_json, status, created_at, updated_at
     ) VALUES ('submission', 'run', 1, 'full_workflow', 'manual', 'submission-trigger',
               'fingerprint', '{}', '{}', 'running', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_node_attempts (
       id, submission_id, node_id, attempt, state, persona_snapshot_json,
       input_fingerprint, created_at, updated_at
     ) VALUES ('attempt', 'submission', 'persona', 1, 'queued',
               '{"sourcePersonaId":"p","sourceRevision":1,"name":"P","description":"","guidanceMarkdown":"secret guidance","runner":"codex","model":"gpt"}',
               'fingerprint', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_deliveries (
       id, run_id, submission_id, kind, session_id, note_key, payload, payload_sha256,
       state, created_at, updated_at
     ) VALUES ('delivery', 'run', 'submission', 'persona_feedback', 'session', 'note',
               'secret delivery payload', 'sha', 'uncertain', 1, 1)`,
  ).run();
  const store = new WorkflowStore(db);
  store.insertLlmCall({
    id: "call",
    runId: "run",
    submissionId: "submission",
    nodeAttemptId: "attempt",
    purpose: "persona_review",
    runner: "codex",
    model: "gpt",
    attempt: 1,
    state: "running",
    startedAt: 1,
    finishedAt: null,
    durationMs: null,
    inputBytes: 1_000,
    outputBytes: 0,
    costUsd: null,
    errorCode: null,
  });
  store.insertLlmCall({
    id: "compaction-call",
    runId: "run",
    submissionId: "submission",
    nodeAttemptId: null,
    purpose: "context_compaction",
    runner: "codex",
    model: "gpt",
    attempt: 1,
    state: "running",
    startedAt: 1,
    finishedAt: null,
    durationMs: null,
    inputBytes: 1_000,
    outputBytes: 0,
    costUsd: null,
    errorCode: null,
  });
  const manager = new WorkflowManager(new Registry(), store);
  const status = manager.status();
  assert.deepEqual(status, {
    activeRuns: 1,
    queuedPersonaCalls: 1,
    runningPersonaCalls: 1,
    waitingDeliveries: 0,
    uncertainDeliveries: 1,
    inspectorGates: 0,
    lastRecoveryAt: null,
    lastRetentionAt: null,
    lastRetentionError: null,
    retainedRunCount: 1,
    lastRetentionCompacted: 0,
    lastRetentionDeleted: 0,
  });
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, /secret|guidance|payload|prompt|diff|transcript/i);
});

test("status exposes recovery and retention timing with a bounded failure class", async () => {
  clearWorkflowTables(db);
  const registry = new Registry();
  const manager = new WorkflowManager(registry, new WorkflowStore(db), {
    runRetention: () => {
      throw new Error("raw prompt and delivery payload must stay private");
    },
  });
  registry.applyDiscovery([]);
  const originalError = console.error;
  const originalInfo = console.info;
  console.error = () => {};
  console.info = () => {};
  try {
    manager.start();
    const status = manager.status();
    assert.ok(status.lastRecoveryAt);
    assert.ok(status.lastRetentionAt);
    assert.equal(status.lastRetentionError, "retention_failed");
    assert.doesNotMatch(JSON.stringify(status), /raw prompt|delivery payload/);
  } finally {
    console.error = originalError;
    console.info = originalInfo;
    await manager.stop();
  }
});

test("status reports partial retention failures without hiding committed work", async () => {
  clearWorkflowTables(db);
  const registry = new Registry();
  const manager = new WorkflowManager(registry, new WorkflowStore(db), {
    runRetention: () => ({
      compactedRunIds: ["compacted"],
      deletedRunIds: ["deleted"],
      failedRunCount: 1,
    }),
  });
  registry.applyDiscovery([]);
  const originalError = console.error;
  console.error = () => {};
  try {
    manager.start();
    const status = manager.status();
    assert.equal(status.lastRetentionError, "retention_partial_failure");
    assert.equal(status.lastRetentionCompacted, 1);
    assert.equal(status.lastRetentionDeleted, 1);
  } finally {
    console.error = originalError;
    await manager.stop();
  }
});
