import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  WorkflowStore,
  WORKFLOW_TABLES,
  WorkflowRowError,
  clearWorkflowTables,
  parsePersonaRow,
  parseWorkflowBindingClaimRow,
  parseWorkflowBindingRow,
  parseWorkflowDefinitionRow,
  parseWorkflowEvidenceStagingRow,
  parseWorkflowDeliveryRow,
  parseWorkflowEdgeReceiptRow,
  parseWorkflowEventRow,
  parseWorkflowLlmCallRow,
  parseWorkflowNodeAttemptRow,
  parseWorkflowRunRow,
  parseWorkflowSubmissionRow,
  parseWorkflowSubmissionImageRow,
  parseWorkflowSubmissionTextArtifactRow,
  parseWorkflowVersionRow,
} = await import("../src/server/workflows/store.ts");
const {
  WORKFLOW_EVIDENCE_COVERAGE_LIMITS,
  evaluateWorkflowEvidenceReadiness,
} = await import("../src/shared/workflow.ts");

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

  const indexes = (table: string): string[][] =>
    (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>)
      .map((index) =>
        (db.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string }>)
          .map((column) => column.name));

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
  assert.ok(indexes("workflow_runs").some((columns) => columns.join(",") === "updated_at,id"));
  assert.ok(
    indexes("workflow_evidence_staging").some(
      (columns) => columns.join(",") === "note_key,state,generation,created_at,id",
    ),
  );
  assert.ok(
    indexes("workflow_submission_images").some(
      (columns) => columns.join(",") === "submission_id,ordinal",
    ),
  );
  assert.ok(
    indexes("workflow_submission_text_artifacts").some(
      (columns) => columns.join(",") === "submission_id,ordinal",
    ),
  );
  assert.ok(
    indexes("workflow_runs").some((columns) => columns.join(",") === "status,updated_at,id"),
  );
  assert.ok(
    indexes("workflow_runs").some(
      (columns) => columns.join(",") === "workflow_version_id,updated_at,id",
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

test("submission capture round-trips readiness above the coverage authoring bound", () => {
  db.prepare(
    `INSERT INTO workflow_submissions (
       id, run_id, round, mode, trigger_source, trigger_key, evidence_fingerprint,
       context_json, evidence_json, status, created_at, updated_at
     ) VALUES ('s1', 'r1', 1, 'full_workflow', 'manual', 'manual:b:req1', 'fp',
               '{}', '{}', 'capturing', 1, 1)`,
  ).run();
  const readiness = evaluateWorkflowEvidenceReadiness({
    canonicalCriteria: Array.from(
      { length: WORKFLOW_EVIDENCE_COVERAGE_LIMITS.maxClaims },
      (_, index) => ({
        id: `canonical-${index}`,
        text: "x".repeat(WORKFLOW_EVIDENCE_COVERAGE_LIMITS.criterionBytes),
        material: true,
        suggestedProofClass: null,
        matchedClientCriterionIds: [],
      }),
    ),
    coverage: [],
    evidence: [],
  });
  assert.ok(
    Buffer.byteLength(JSON.stringify(readiness), "utf8")
      > WORKFLOW_EVIDENCE_COVERAGE_LIMITS.aggregateJsonBytes,
    "the fixture must exercise the readiness-only storage allowance",
  );

  const store = new WorkflowStore(db);
  const updated = store.updateSubmissionCapture("s1", {
    context: {},
    evidence: {},
    readiness,
  }, 2);
  assert.deepEqual(updated.readiness, readiness);
  assert.deepEqual(store.getSubmission("s1")?.readiness, readiness);
});

test("an external claim is unique by source key and owns at most one binding", () => {
  const insert = db.prepare(
    `INSERT INTO workflow_binding_claims (source_key, source_kind, source_id, binding_id, created_at)
     VALUES (?, 'ensemble', ?, ?, 1)`,
  );
  insert.run("ensemble:e1:result:m1:workflow:v1", "e1", "b1");
  // The same external result retried, after a lost response or a restart, must collide
  // rather than start a second review of the same artifact.
  assert.throws(() => insert.run("ensemble:e1:result:m1:workflow:v1", "e1", "b2"));
  // And two different results must not both believe they own one binding.
  assert.throws(() => insert.run("ensemble:e1:result:m2:workflow:v1", "e1", "b1"));
  insert.run("ensemble:e1:result:m2:workflow:v1", "e1", "b2");

  const columns = (db.prepare(`PRAGMA table_info(workflow_binding_claims)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>);
  // Every column is NOT NULL: SQLite treats NULLs as distinct inside a unique index, so a
  // nullable half would make the retry insert instead of collide. The primary key is asserted
  // the same way as the rest and NOT excused by `pk`, because on a non-STRICT rowid table
  // SQLite does not imply NOT NULL from PRIMARY KEY.
  for (const column of columns) {
    assert.equal(column.notnull, 1, `${column.name} is nullable`);
  }
  assert.equal(columns.find((column) => column.name === "source_key")?.pk, 1);
  // The quirk itself, exercised: without the explicit NOT NULL these would both insert, and
  // several claims with no key would each be a distinct identity nothing could resolve.
  assert.throws(() => insert.run(null, "e1", "b3"));
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

  const claim = {
    source_key: "ensemble:e1:result:m1:workflow:v1",
    source_kind: "ensemble",
    source_id: "e1",
    binding_id: "b1",
    created_at: 1,
  };
  assert.equal(parseWorkflowBindingClaimRow(claim).sourceId, "e1");
  assert.throws(() => parseWorkflowBindingClaimRow({ ...claim, source_kind: "swarm" }), WorkflowRowError);
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
  assert.equal(parseWorkflowNodeAttemptRow(attempt).checkEvidence, undefined);
  assert.throws(
    () => parseWorkflowNodeAttemptRow({ ...attempt, check_evidence_json: "[]" }),
    WorkflowRowError,
  );
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

test("workflow evidence rows preserve old image defaults and validate text artifacts", () => {
  const staged = {
    id: "stage",
    note_key: "note",
    client_item_id: "client",
    source_kind: "agent",
    source_root: "/repo",
    source_locator: "evidence/screen.png",
    display_name: "screen.png",
    caption: "Visible result",
    repository_scope: "repo-01",
    mime_type: "image/png",
    bytes: 10,
    sha256: "a".repeat(64),
    generation: 1,
    state: "staged",
    reserved_group_key: null,
    created_at: 1,
    updated_at: 1,
  };
  assert.equal(parseWorkflowEvidenceStagingRow(staged).state, "staged");
  assert.equal(parseWorkflowEvidenceStagingRow(staged).evidence_kind, "image");
  assert.throws(
    () => parseWorkflowEvidenceStagingRow({ ...staged, state: "attached" }),
    WorkflowRowError,
  );
  assert.throws(
    () => parseWorkflowEvidenceStagingRow({ ...staged, repository_scope: "repo-primary" }),
    WorkflowRowError,
  );
  assert.throws(
    () => parseWorkflowEvidenceStagingRow({
      ...staged,
      state: "reserved",
      reserved_group_key: null,
    }),
    WorkflowRowError,
  );
  const image = {
    id: "image",
    submission_id: "submission",
    staging_id: "stage",
    ordinal: 0,
    display_name: "screen.png",
    caption: "Visible result",
    repository_scope: "repo-01",
    mime_type: "image/png",
    bytes: 10,
    sha256: "a".repeat(64),
    storage_relative_path: "retained/submission/image.png",
    availability: "retained",
    pruned_at: null,
    created_at: 1,
  };
  assert.equal(parseWorkflowSubmissionImageRow(image).availability, "retained");
  assert.throws(
    () => parseWorkflowSubmissionImageRow({ ...image, sha256: "not-a-digest" }),
    WorkflowRowError,
  );
  assert.throws(
    () => parseWorkflowSubmissionImageRow({ ...image, availability: "pruned", pruned_at: null }),
    WorkflowRowError,
  );

  const artifact = {
    id: "artifact",
    submission_id: "submission",
    staging_id: "stage-text",
    ordinal: 0,
    display_name: "focused.tap",
    caption: "Focused test output",
    repository_scope: "repo-01",
    mime_type: "text/plain",
    bytes: Buffer.byteLength("ok 13\n"),
    sha256: "b".repeat(64),
    content: "ok 13\n",
    availability: "retained",
    pruned_at: null,
    created_at: 1,
  };
  assert.equal(parseWorkflowSubmissionTextArtifactRow(artifact).content, "ok 13\n");
  assert.throws(
    () => parseWorkflowSubmissionTextArtifactRow({ ...artifact, mime_type: "application/json" }),
    WorkflowRowError,
  );
  assert.throws(
    () => parseWorkflowEvidenceStagingRow({
      ...staged,
      evidence_kind: "text",
      mime_type: "text/plain",
      source_kind: "upload",
    }),
    WorkflowRowError,
  );
  const commandContent = "Command: npm test\nExit code: 0\nOutput:\nok 1\n";
  const command = {
    ...staged,
    client_item_id: "command-client",
    source_kind: "command",
    evidence_kind: "text",
    source_locator: "command:command-client",
    inline_content: commandContent,
    command_exit_code: 0,
    display_name: "command-output.txt",
    mime_type: "text/plain",
    bytes: Buffer.byteLength(commandContent),
    sha256: createHash("sha256").update(commandContent).digest("hex"),
  };
  assert.equal(parseWorkflowEvidenceStagingRow(command).source_kind, "command");
  assert.equal(parseWorkflowEvidenceStagingRow(command).command_exit_code, 0);
  assert.equal(
    parseWorkflowEvidenceStagingRow({ ...command, command_exit_code: -9 }).command_exit_code,
    -9,
  );
  assert.throws(
    () => parseWorkflowEvidenceStagingRow({ ...command, sha256: "c".repeat(64) }),
    WorkflowRowError,
  );
  assert.throws(
    () => parseWorkflowEvidenceStagingRow({ ...command, inline_content: null }),
    WorkflowRowError,
  );
  assert.throws(
    () => parseWorkflowEvidenceStagingRow({ ...command, command_exit_code: null }),
    WorkflowRowError,
  );
  assert.throws(
    () => parseWorkflowEvidenceStagingRow({ ...staged, inline_content: commandContent }),
    WorkflowRowError,
  );
});
