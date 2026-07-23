import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: Phase 1 is the only migration boundary for the complete workflow family.
// A missing table or nullable conflict key would not fail until a later phase tried to recover a
// real run, when adding the constraint safely would already require migrating user history.

const home = mkdtempSync(join(tmpdir(), "mission-workflow-db-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const {
  WORKFLOW_TABLES,
  WorkflowRowError,
  clearWorkflowTables,
  parsePersonaRow,
  parseWorkflowBindingRow,
  parseWorkflowDefinitionRow,
  parseWorkflowDeliveryRow,
  parseWorkflowEdgeReceiptRow,
  parseWorkflowEventRow,
  parseWorkflowLlmCallRow,
  parseWorkflowNodeAttemptRow,
  parseWorkflowRunRow,
  parseWorkflowSubmissionRow,
  parseWorkflowVersionRow,
} = await import("../src/server/workflows/store.ts");

const db = openDb();
const graph = JSON.stringify({
  nodes: [{ id: "s", kind: "session", position: { x: 0, y: 0 } }],
  edges: [],
});
const publishedGraph = graph;
const policy = JSON.stringify({ kind: "none" });
const defaults = JSON.stringify({ triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 });

after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearWorkflowTables(db));

test("the complete Phase 1 table family and required indexes exist", () => {
  const tables = new Set(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  for (const table of WORKFLOW_TABLES) assert.ok(tables.has(table), `missing ${table}`);

  const uniqueIndexes = (table: string): string[][] =>
    (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number }>)
      .filter((index) => index.unique === 1)
      .map((index) =>
        (db.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string }>).map((column) => column.name),
      );

  assert.ok(uniqueIndexes("personas").some((columns) => columns.join(",") === "normalized_name"));
  assert.ok(uniqueIndexes("workflow_versions").some((columns) => columns.join(",") === "workflow_id,version"));
  assert.ok(
    uniqueIndexes("workflow_versions").some(
      (columns) => columns.join(",") === "workflow_id,source_draft_revision",
    ),
  );
  assert.ok(uniqueIndexes("workflow_submissions").some((columns) => columns.join(",") === "trigger_key"));
  assert.ok(
    uniqueIndexes("workflow_deliveries").some(
      (columns) => columns.join(",") === "submission_id,kind,payload_sha256",
    ),
  );
});

test("one active binding owns a note key while archived history may coexist", () => {
  const insert = db.prepare(
    `INSERT INTO workflow_bindings (
       id, workflow_version_id, note_key, session_id, trigger_mode, delivery_mode,
       state, max_repair_rounds, created_at, updated_at
     ) VALUES (?, 'v1', 'note', 'session', 'manual', 'preview', ?, 5, 1, 1)`,
  );
  insert.run("b1", "active");
  assert.throws(() => insert.run("b2", "active"));
  insert.run("b3", "archived");
});

test("published version identities are idempotent at both version and source revision", () => {
  const insert = db.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, binding_defaults_json, published_at
     ) VALUES (?, 'w1', ?, ?, ?, ?, ?, 1)`,
  );
  insert.run("v1", 1, 7, publishedGraph, policy, defaults);
  assert.throws(() => insert.run("v2", 1, 8, publishedGraph, policy, defaults));
  assert.throws(() => insert.run("v3", 2, 7, publishedGraph, policy, defaults));
});

test("submission trigger keys and rounds cannot multiply on retry", () => {
  const insert = db.prepare(
    `INSERT INTO workflow_submissions (
       id, run_id, round, mode, trigger_source, trigger_key, evidence_fingerprint,
       context_json, evidence_json, status, created_at, updated_at
     ) VALUES (?, ?, ?, 'full_workflow', 'manual', ?, 'fp', '{}', '{}', 'capturing', 1, 1)`,
  );
  insert.run("s1", "r1", 1, "manual:b:req1");
  assert.throws(() => insert.run("s2", "r2", 1, "manual:b:req1"));
  assert.throws(() => insert.run("s3", "r1", 1, "manual:b:req2"));
});

test("delivery identity cannot duplicate an immutable packet", () => {
  const insert = db.prepare(
    `INSERT INTO workflow_deliveries (
       id, run_id, submission_id, kind, session_id, note_key, payload, payload_sha256,
       state, created_at, updated_at
     ) VALUES (?, 'r', 's', 'persona_feedback', 'session', 'note', 'payload', 'sha', 'prepared', 1, 1)`,
  );
  insert.run("d1");
  assert.throws(() => insert.run("d2"));
});

test("graph and policy JSON are validated on durable reads", () => {
  const row = {
    id: "w",
    name: "Workflow",
    normalized_name: "workflow",
    description: "",
    draft_graph_json: graph,
    completion_policy_json: policy,
    binding_defaults_json: defaults,
    draft_revision: 1,
    current_version_id: null,
    archived_at: null,
    created_at: 1,
    updated_at: 1,
  };
  assert.equal(parseWorkflowDefinitionRow(row).draft.nodes[0]?.kind, "session");
  assert.throws(
    () => parseWorkflowDefinitionRow({ ...row, draft_graph_json: JSON.stringify({ nodes: [{ kind: "inspector" }], edges: [] }) }),
    WorkflowRowError,
  );
  assert.throws(
    () => parseWorkflowDefinitionRow({ ...row, completion_policy_json: JSON.stringify({ kind: "maybe" }) }),
    WorkflowRowError,
  );
});

test("every workflow table has a validating typed row parser", () => {
  const exactMarkdown = "# Exact\r\n\r\nTrailing space  \r\n";
  assert.equal(parsePersonaRow({
    id: "p",
    name: "Persona",
    normalized_name: "persona",
    description: "",
    guidance_md: exactMarkdown,
    runner_id: null,
    model_id: null,
    revision: 1,
    archived_at: null,
    created_at: 1,
    updated_at: 1,
  }).guidanceMarkdown, exactMarkdown);

  assert.equal(parseWorkflowVersionRow({
    id: "v",
    workflow_id: "w",
    version: 1,
    source_draft_revision: 1,
    graph_json: publishedGraph,
    completion_policy_json: policy,
    binding_defaults_json: defaults,
    published_at: 1,
  }).graph.nodes[0]?.kind, "session");

  assert.equal(parseWorkflowBindingRow({
    id: "b",
    workflow_version_id: "v",
    note_key: "note",
    session_id: "session",
    trigger_mode: "manual",
    delivery_mode: "preview",
    state: "active",
    max_repair_rounds: 5,
    created_at: 1,
    updated_at: 1,
  }).state, "active");

  assert.equal(parseWorkflowEdgeReceiptRow({
    id: 1,
    submission_id: "s",
    edge_id: "edge",
    source_attempt_id: "a",
    payload_json: "{}",
    created_at: 1,
  }).edgeId, "edge");

  assert.equal(parseWorkflowEventRow({
    id: 1,
    run_id: "r",
    ts: 1,
    event_kind: "run_started",
    payload_json: "{}",
  }).kind, "run_started");
});

test("every later-phase state parser rejects unknown durable enum values", () => {
  const run = {
    id: "r",
    binding_id: "b",
    workflow_version_id: "v",
    status: "running",
    current_phase: "persona",
    max_repair_rounds: 5,
    trigger_source: "manual",
    trigger_key: "t",
    inspector_pr_key: null,
    inspector_head_sha: null,
    gate_state_json: null,
    started_at: 1,
    updated_at: 1,
    completed_at: null,
  };
  assert.equal(parseWorkflowRunRow(run).status, "running");
  assert.throws(() => parseWorkflowRunRow({ ...run, status: "mystery" }), WorkflowRowError);

  const submission = {
    id: "s",
    run_id: "r",
    round: 1,
    mode: "full_workflow",
    trigger_source: "manual",
    trigger_key: "t",
    evidence_fingerprint: "fp",
    context_json: "{}",
    evidence_json: "{}",
    pr_head_sha: null,
    status: "capturing",
    created_at: 1,
    updated_at: 1,
    completed_at: null,
  };
  assert.equal(parseWorkflowSubmissionRow(submission).status, "capturing");
  assert.throws(() => parseWorkflowSubmissionRow({ ...submission, mode: "partial" }), WorkflowRowError);

  const attempt = {
    id: "a",
    submission_id: "s",
    node_id: "p",
    attempt: 1,
    state: "queued",
    persona_snapshot_json: null,
    verdict_json: null,
    output_json: null,
    retry_at: null,
    input_fingerprint: "fp",
    error: null,
    created_at: 1,
    updated_at: 1,
    started_at: null,
    finished_at: null,
  };
  assert.equal(parseWorkflowNodeAttemptRow(attempt).state, "queued");
  assert.throws(() => parseWorkflowNodeAttemptRow({ ...attempt, state: "passed" }), WorkflowRowError);

  const delivery = {
    id: "d",
    run_id: "r",
    submission_id: "s",
    kind: "persona_feedback",
    session_id: "session",
    note_key: "note",
    payload: "x",
    payload_sha256: "sha",
    state: "prepared",
    error: null,
    created_at: 1,
    updated_at: 1,
    delivered_at: null,
  };
  assert.equal(parseWorkflowDeliveryRow(delivery).state, "prepared");
  assert.throws(() => parseWorkflowDeliveryRow({ ...delivery, state: "maybe_sent" }), WorkflowRowError);

  const call = {
    id: "c",
    run_id: "r",
    submission_id: "s",
    node_attempt_id: null,
    purpose: "context_compaction",
    runner_id: "claude",
    model_id: "claude-haiku-4-5",
    attempt: 1,
    state: "running",
    started_at: 1,
    finished_at: null,
    duration_ms: null,
    input_bytes: 1,
    output_bytes: 0,
    cost_usd: null,
    error_code: null,
  };
  assert.equal(parseWorkflowLlmCallRow(call).purpose, "context_compaction");
  assert.throws(() => parseWorkflowLlmCallRow({ ...call, purpose: "unknown" }), WorkflowRowError);
  assert.throws(() => parseWorkflowLlmCallRow({ ...call, error_code: "x".repeat(201) }), WorkflowRowError);
});
