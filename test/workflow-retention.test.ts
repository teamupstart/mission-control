import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKFLOW_CONFIG } from "../src/shared/workflow.ts";
import { WorkflowConfigSchema } from "../src/shared/protocol.ts";

const home = mkdtempSync(join(tmpdir(), "mission-workflow-retention-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { openDb } = await import("../src/server/db.ts");
const {
  clearWorkflowTables,
  WorkflowStore,
  WORKFLOW_RETENTION_BATCH_SIZE,
} = await import("../src/server/workflows/store.ts");
const { Registry } = await import("../src/server/registry.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const db = openDb();
const store = new WorkflowStore(db);

beforeEach(() => clearWorkflowTables(db));

const context = {
  primaryGoal: { rawPrompt: "Keep this goal", refined: null, sourceNoteKey: "note" },
  humanDecisions: [],
  constraints: ["Keep this constraint"],
  acceptanceCriteria: [],
  priorPersonaFeedback: [],
  session: { agent: "codex", name: "worker", cwd: "/repo", branch: "feature" },
  evidence: {
    headSha: "a".repeat(40),
    diffFingerprint: "diff-fingerprint",
    diff: "secret diff body",
    diffTruncated: false,
    workingTreeDirty: true,
    workingTreeStatus: ["M secret.ts"],
    workingTreeStatusTruncated: false,
    transcript: [{ role: "user", content: "secret transcript" }],
    transcriptAnchor: 10,
    transcriptTruncated: false,
    standards: [{
      path: "AGENTS.md",
      text: "secret standards body",
      truncated: false,
      fingerprint: "standards-fingerprint",
    }],
    standardsTruncated: false,
    retention: { state: "full" },
  },
  compaction: { status: "fallback", runner: null, model: null, error: null },
};

function insertRun(
  id: string,
  status: "completed" | "cancelled" | "failed" | "blocked" | "running",
  completedAt: number | null,
): void {
  db.prepare(
    `INSERT INTO workflow_runs (
       id, binding_id, workflow_version_id, status, current_phase, max_repair_rounds,
       trigger_source, trigger_key, started_at, updated_at, completed_at
     ) VALUES (?, 'binding', 'version', ?, 'phase', 5, 'manual', ?, 1, ?, ?)`,
  ).run(id, status, `trigger:${id}`, completedAt ?? 1, completedAt);
}

function insertSubmission(id: string, runId: string): void {
  db.prepare(
    `INSERT INTO workflow_submissions (
       id, run_id, round, mode, trigger_source, trigger_key, evidence_fingerprint,
       context_json, evidence_json, status, created_at, updated_at, completed_at
     ) VALUES (?, ?, 1, 'full_workflow', 'manual', ?, 'fingerprint', ?, ?,
               'completed', 1, 1, 1)`,
  ).run(id, runId, `submission:${id}`, JSON.stringify(context), JSON.stringify(context.evidence));
}

function insertRawSubmission(
  id: string,
  runId: string,
  mode: "full_workflow" | "inspector_only",
  contextJson: string,
  status: "capturing" | "running" | "waiting_for_session" | "completed" | "cancelled" | "failed" = "completed",
): void {
  db.prepare(
    `INSERT INTO workflow_submissions (
       id, run_id, round, mode, trigger_source, trigger_key, evidence_fingerprint,
       context_json, evidence_json, status, created_at, updated_at, completed_at
     ) VALUES (?, ?, 1, ?, 'manual', ?, 'fingerprint', ?, '{}',
               ?, 1, 1, 1)`,
  ).run(id, runId, mode, `submission:${id}`, contextJson, status);
}

function seedReusableCatalog(): void {
  store.insertPersona({
    id: "persona",
    name: "Retained Persona",
    normalizedName: "retained persona",
    description: "",
    guidanceMarkdown: "Immutable guidance",
    runner: null,
    model: null,
    createdAt: 1,
    updatedAt: 1,
  });
  const graph = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      {
        id: "persona-node",
        kind: "persona",
        position: { x: 180, y: 0 },
        persona: {
          sourcePersonaId: "persona",
          sourceRevision: 1,
          name: "Retained Persona",
          description: "",
          guidanceMarkdown: "Immutable guidance",
          runner: null,
          model: null,
        },
      },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 360, y: 0 } },
    ],
    edges: [
      {
        id: "start",
        source: "session",
        sourcePort: "submitted",
        target: "persona-node",
        targetPort: "activate",
      },
      {
        id: "pass",
        source: "persona-node",
        sourcePort: "pass",
        target: "end",
        targetPort: "terminal",
      },
      {
        id: "fail",
        source: "persona-node",
        sourcePort: "fail",
        target: "session",
        targetPort: "return_for_changes",
      },
    ],
  };
  db.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json, completion_policy_json,
       binding_defaults_json, draft_revision, current_version_id, created_at, updated_at
     ) VALUES ('workflow', 'Retained workflow', 'retained workflow', '', ?,
               '{"kind":"none"}',
               '{"triggerMode":"manual","deliveryMode":"preview","maxRepairRounds":5}',
               1, 'version', 1, 1)`,
  ).run(JSON.stringify({ nodes: [], edges: [] }));
  db.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, binding_defaults_json, published_at
     ) VALUES ('version', 'workflow', 1, 1, ?, '{"kind":"none"}',
               '{"triggerMode":"manual","deliveryMode":"preview","maxRepairRounds":5}', 1)`,
  ).run(JSON.stringify(graph));
  db.prepare(
    `INSERT INTO workflow_bindings (
       id, workflow_version_id, note_key, session_id, session_agent, session_name,
       trigger_mode, delivery_mode, state, max_repair_rounds, created_at, updated_at
     ) VALUES ('binding', 'version', 'note', NULL, 'codex', 'Worker',
               'manual', 'preview', 'orphaned', 5, 1, 1)`,
  ).run();
}

test("retention config defaults old blobs and rejects unsafe ranges", () => {
  assert.deepEqual(WorkflowConfigSchema.parse({}), DEFAULT_WORKFLOW_CONFIG);
  assert.throws(() => WorkflowConfigSchema.parse({
    retention: { rawEvidenceDays: 0, completedRunDays: 29, maxCompletedRuns: 99 },
  }));
});

test("stage one prunes only eligible terminal evidence and records a sentinel first", () => {
  insertRun("compact", "completed", 1);
  insertSubmission("submission-compact", "compact");
  db.prepare(
    `INSERT INTO workflow_deliveries (
       id, run_id, submission_id, kind, session_id, note_key, payload, payload_sha256,
       state, error, created_at, updated_at, delivered_at
     ) VALUES ('delivery', 'compact', 'submission-compact', 'persona_feedback',
               'session', 'note', 'secret delivery packet', 'sha', 'delivered',
               'provider included a sensitive detail', 1, 1, 1)`,
  ).run();

  insertRun("uncertain", "completed", 1);
  insertSubmission("submission-uncertain", "uncertain");
  db.prepare(
    `INSERT INTO workflow_deliveries (
       id, run_id, submission_id, kind, session_id, note_key, payload, payload_sha256,
       state, created_at, updated_at
     ) VALUES ('uncertain-delivery', 'uncertain', 'submission-uncertain',
               'persona_feedback', 'session', 'note', 'must remain exact', 'sha-2',
               'uncertain', 1, 1)`,
  ).run();
  insertRun("failed", "failed", 1);
  insertRun("blocked", "blocked", null);
  insertRun("active", "running", null);

  const result = store.runRetention({
    rawEvidenceBefore: 10,
    completedRunsBefore: 0,
    maxCompletedRuns: 100,
    now: 20,
  });
  assert.deepEqual(result.compactedRunIds, ["compact"]);
  const submission = store.getSubmission("submission-compact")!;
  const compacted = submission.context as typeof context;
  assert.equal(compacted.evidence.retention.state, "pruned");
  assert.equal(compacted.evidence.diff, "");
  assert.deepEqual(compacted.evidence.workingTreeStatus, []);
  assert.deepEqual(compacted.evidence.transcript, []);
  assert.equal(compacted.evidence.standards[0]?.text, "");
  assert.equal(compacted.primaryGoal.rawPrompt, "Keep this goal");
  assert.equal(compacted.evidence.headSha, context.evidence.headSha);
  assert.equal(store.getDelivery("delivery")?.payload, "");
  assert.equal(store.getDelivery("delivery")?.payloadPrunedAt, 20);
  assert.equal(store.listEvents("compact").at(-1)?.kind, "evidence_pruned");
  assert.equal((store.getSubmission("submission-uncertain")!.context as typeof context).evidence.diff, "secret diff body");
  assert.equal(store.getDelivery("uncertain-delivery")?.payload, "must remain exact");
  assert.equal(store.getRun("failed")?.evidencePrunedAt ?? null, null);
  const repeated = store.runRetention({
    rawEvidenceBefore: 10,
    completedRunsBefore: 0,
    maxCompletedRuns: 100,
    now: 21,
  });
  assert.deepEqual(repeated, {
    compactedRunIds: [],
    deletedRunIds: [],
    failedRunCount: 0,
  });
  assert.equal(
    store.listEvents("compact").filter((event) => event.kind === "evidence_pruned").length,
    1,
  );
});

test("stage one skips non-evidence contexts and isolates malformed rows by run", () => {
  insertRun("a-inspector-only", "completed", 1);
  insertRawSubmission(
    "submission-inspector-only",
    "a-inspector-only",
    "inspector_only",
    JSON.stringify({ bypassReason: "Published policy", newHeadSha: "head" }),
  );
  insertRun("b-cancelled-before-capture", "cancelled", 1);
  insertRawSubmission(
    "submission-cancelled-before-capture",
    "b-cancelled-before-capture",
    "full_workflow",
    "{}",
    "cancelled",
  );
  insertRun("c-malformed", "completed", 1);
  insertRawSubmission(
    "submission-malformed",
    "c-malformed",
    "full_workflow",
    "{",
  );
  insertRun("d-valid", "completed", 1);
  insertSubmission("submission-valid", "d-valid");

  const result = store.runRetention({
    rawEvidenceBefore: 10,
    completedRunsBefore: 0,
    maxCompletedRuns: 100,
    now: 20,
  });

  assert.deepEqual(result.compactedRunIds, [
    "a-inspector-only",
    "b-cancelled-before-capture",
    "d-valid",
  ]);
  assert.equal(result.failedRunCount, 1);
  assert.deepEqual(
    store.getSubmission("submission-inspector-only")?.context,
    { bypassReason: "Published policy", newHeadSha: "head" },
  );
  assert.deepEqual(
    store.getSubmission("submission-cancelled-before-capture")?.context,
    {},
  );
  assert.equal(
    (store.getSubmission("submission-valid")?.context as typeof context)
      .evidence.retention.state,
    "pruned",
  );
  assert.equal(store.getRun("c-malformed")?.evidencePrunedAt, null);
});

test("stage two isolates a malformed run and deletes later eligible families", () => {
  insertRun("delete-corrupt", "completed", 1);
  insertRun("delete-next", "completed", 2);
  insertRun("delete-kept", "completed", 3);
  db.prepare(
    `UPDATE workflow_runs SET gate_state_json = '{' WHERE id = 'delete-corrupt'`,
  ).run();

  const result = store.runRetention({
    rawEvidenceBefore: 0,
    completedRunsBefore: 10,
    maxCompletedRuns: 1,
    now: 20,
  });

  assert.deepEqual(result.deletedRunIds, ["delete-next"]);
  assert.equal(result.failedRunCount, 1);
  assert.ok(
    db.prepare(`SELECT 1 FROM workflow_runs WHERE id = 'delete-corrupt'`).get(),
  );
  assert.equal(store.getRun("delete-next"), null);
  assert.ok(store.getRun("delete-kept"));
});

test("stage two keeps the newest cap and never deletes failed or uncertain families", () => {
  seedReusableCatalog();
  for (let index = 1; index <= 102; index += 1) {
    insertRun(`run-${String(index).padStart(3, "0")}`, "completed", index);
  }
  insertSubmission("submission-001", "run-001");
  db.prepare(
    `INSERT INTO workflow_node_attempts (
       id, submission_id, node_id, attempt, state, persona_snapshot_json,
       input_fingerprint, created_at, updated_at
     ) VALUES ('attempt-001', 'submission-001', 'persona-node', 1, 'completed',
               NULL, 'fingerprint', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_edge_receipts (
       submission_id, edge_id, source_attempt_id, payload_json, created_at
     ) VALUES ('submission-001', 'pass', 'attempt-001', '{}', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_deliveries (
       id, run_id, submission_id, kind, session_id, note_key, payload, payload_sha256,
       state, created_at, updated_at, delivered_at
     ) VALUES ('delivery-001', 'run-001', 'submission-001', 'persona_feedback',
               'session', 'note', 'packet', 'sha', 'delivered', 1, 1, 1)`,
  ).run();
  store.insertLlmCall({
    id: "call-001",
    runId: "run-001",
    submissionId: "submission-001",
    nodeAttemptId: "attempt-001",
    purpose: "persona_review",
    runner: "codex",
    model: "gpt-test",
    attempt: 1,
    state: "succeeded",
    startedAt: 1,
    finishedAt: 2,
    durationMs: 1,
    inputBytes: 10,
    outputBytes: 5,
    costUsd: null,
    errorCode: null,
  });
  store.appendEvent("run-001", "completed_audit", {}, 1);
  insertRun("failed-old", "failed", 1);
  insertRun("uncertain-old", "completed", 1);
  insertSubmission("submission-uncertain-old", "uncertain-old");
  db.prepare(
    `INSERT INTO workflow_deliveries (
       id, run_id, submission_id, kind, session_id, note_key, payload, payload_sha256,
       state, created_at, updated_at
     ) VALUES ('delivery-uncertain-old', 'uncertain-old', 'submission-uncertain-old',
               'persona_feedback', 'session', 'note', 'exact packet', 'sha-uncertain',
               'uncertain', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO inspector_prs (
       key, url, owner, repo, number, source, state, round, fail_count,
       adopted_at, updated_at
     ) VALUES ('owner/repo#1', 'https://github.com/owner/repo/pull/1',
               'owner', 'repo', 1, 'no-mistakes', 'open', 1, 0, 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO inspector_comments (
       id, pr_key, fingerprint, title, severity, round, status, created_at, updated_at
     ) VALUES ('comment', 'owner/repo#1', 'finding', 'Retained finding',
               'medium', 1, 'open', 1, 1)`,
  ).run();
  const result = store.runRetention({
    rawEvidenceBefore: 0,
    completedRunsBefore: 200,
    maxCompletedRuns: 100,
    now: 300,
  });
  assert.deepEqual(result.deletedRunIds, ["run-001", "run-002"]);
  assert.equal(store.getRun("run-001"), null);
  assert.ok(store.getRun("run-003"));
  assert.ok(store.getRun("failed-old"));
  assert.ok(store.getRun("uncertain-old"));
  for (const table of [
    "workflow_llm_calls",
    "workflow_deliveries",
    "workflow_edge_receipts",
    "workflow_node_attempts",
    "workflow_submissions",
    "workflow_events",
  ]) {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${
      table === "workflow_edge_receipts"
        || table === "workflow_node_attempts"
        ? "submission_id = 'submission-001'"
        : table === "workflow_submissions"
          ? "id = 'submission-001'"
          : "run_id = 'run-001'"
    }`).get() as { count: number };
    assert.equal(row.count, 0, `${table} child survived run-family deletion`);
  }
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS count FROM workflow_versions`).get() as { count: number }).count,
    1,
  );
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS count FROM personas`).get() as { count: number }).count,
    1,
  );
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS count FROM inspector_prs`).get() as { count: number }).count,
    1,
  );
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS count FROM inspector_comments`).get() as { count: number }).count,
    1,
  );
});

test("each retention stage processes a fixed-size batch", () => {
  for (let index = 1; index <= WORKFLOW_RETENTION_BATCH_SIZE + 1; index += 1) {
    insertRun(`compact-${String(index).padStart(3, "0")}`, "completed", index);
  }
  const originalInfo = console.info;
  console.info = () => {};
  const compacted = (() => {
    try {
      return store.runRetention({
        rawEvidenceBefore: WORKFLOW_RETENTION_BATCH_SIZE + 1,
        completedRunsBefore: 0,
        maxCompletedRuns: 100,
        now: 1_000,
      });
    } finally {
      console.info = originalInfo;
    }
  })();
  assert.equal(compacted.compactedRunIds.length, WORKFLOW_RETENTION_BATCH_SIZE);
  const uncompacted = db.prepare(
    `SELECT COUNT(*) AS count FROM workflow_runs WHERE evidence_pruned_at IS NULL`,
  ).get() as { count: number };
  assert.equal(uncompacted.count, 1);
  assert.equal(store.runRetention({
    rawEvidenceBefore: WORKFLOW_RETENTION_BATCH_SIZE + 1,
    completedRunsBefore: 0,
    maxCompletedRuns: 100,
    now: 1_001,
  }).compactedRunIds.length, 1);

  clearWorkflowTables(db);
  for (let index = 1; index <= WORKFLOW_RETENTION_BATCH_SIZE + 101; index += 1) {
    insertRun(`delete-${String(index).padStart(3, "0")}`, "completed", index);
  }
  const deleted = store.runRetention({
    rawEvidenceBefore: 0,
    completedRunsBefore: WORKFLOW_RETENTION_BATCH_SIZE + 101,
    maxCompletedRuns: 100,
    now: 1_000,
  });
  assert.equal(deleted.deletedRunIds.length, WORKFLOW_RETENTION_BATCH_SIZE);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS count FROM workflow_runs`).get() as { count: number }).count,
    101,
  );
});

test("manager publishes committed run removals and isolates retention sweep failure", async () => {
  seedReusableCatalog();
  for (let index = 1; index <= 1_002; index += 1) {
    insertRun(`sse-${String(index).padStart(3, "0")}`, "completed", index);
  }
  const registry = new Registry();
  registry.initializeWorkflowRuns(store.listRunSummaries());
  const manager = new WorkflowManager(registry, store, {
    retentionIntervalMs: 60 * 60 * 1_000,
  });
  registry.applyDiscovery([]);
  const removed: string[] = [];
  const unsubscribe = registry.subscribe((event) => {
    if (event.type === "workflow_run_remove") removed.push(event.id);
  });
  const originalInfo = console.info;
  console.info = () => {};
  try {
    manager.start();
    assert.deepEqual(removed, ["sse-001", "sse-002"]);
  } finally {
    console.info = originalInfo;
    unsubscribe();
    await manager.stop();
  }

  clearWorkflowTables(db);
  const isolatedRegistry = new Registry();
  const isolated = new WorkflowManager(isolatedRegistry, store, {
    retentionIntervalMs: 60 * 60 * 1_000,
    runRetention: () => {
      throw new Error("payload-shaped secret must not escape");
    },
  });
  isolatedRegistry.applyDiscovery([]);
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (value?: unknown) => { logs.push(String(value)); };
  try {
    isolated.start();
    assert.equal(isolated.status().lastRetentionError, "retention_failed");
    assert.ok(isolated.status().lastRecoveryAt);
    assert.doesNotMatch(logs.join("\n"), /payload-shaped secret/);
  } finally {
    console.error = originalError;
    await isolated.stop();
  }
});
