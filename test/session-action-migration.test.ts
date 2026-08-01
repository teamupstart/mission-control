/**
 * What is at stake: the continuation migration is the only one in this phase that touches
 * tables an operator's machine is already USING, and one of its steps is destructive.
 *
 * `workflow_submissions` carried a UNIQUE index on `(run_id, round)`. That index is precisely
 * what makes a second evidence snapshot inside a repair round impossible, so it has to be
 * dropped - and dropping the wrong index, or failing to drop this one, are both silent. A
 * migration that only added the column would leave every existing machine unable to run an
 * action at all, while the fresh schema passed its own test.
 *
 * So this file upgrades a database that looks like a machine mid-flight: published versions,
 * an active binding, a run, submissions in two rounds, attempts, receipts and a delivered
 * packet. Every one of those rows must still parse, keep its id, and read as segment zero.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const home = mkdtempSync(join(tmpdir(), "mission-session-action-migration-"));
process.env.MISSION_HOME = home;

const LEGACY_IDS = {
  run: "legacy-run",
  roundOne: "legacy-submission-1",
  roundTwo: "legacy-submission-2",
  attempt: "legacy-attempt",
  delivery: "legacy-delivery",
};

/**
 * A pre-continuation database with a real, active workflow family in it.
 *
 * The schema below is the merged Phase 1 shape verbatim, including the two-column unique
 * index this migration has to replace. Writing it out rather than importing it is the point:
 * an upgrade test that builds its fixture with the CURRENT schema proves nothing.
 */
function seedPreContinuationDb(): void {
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec(`
    CREATE TABLE IF NOT EXISTS workflow_definitions (
      id                     TEXT PRIMARY KEY,
      name                   TEXT NOT NULL,
      normalized_name        TEXT NOT NULL,
      description            TEXT NOT NULL DEFAULT '',
      draft_graph_json       TEXT NOT NULL,
      completion_policy_json TEXT NOT NULL,
      resumption_policy      TEXT,
      binding_defaults_json  TEXT NOT NULL,
      draft_revision         INTEGER NOT NULL DEFAULT 1,
      current_version_id     TEXT,
      archived_at            INTEGER,
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_versions (
      id                     TEXT PRIMARY KEY,
      workflow_id            TEXT NOT NULL,
      version                INTEGER NOT NULL,
      source_draft_revision  INTEGER NOT NULL,
      graph_json             TEXT NOT NULL,
      completion_policy_json TEXT NOT NULL,
      resumption_policy      TEXT,
      binding_defaults_json  TEXT NOT NULL,
      published_at           INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_bindings (
      id                  TEXT PRIMARY KEY,
      workflow_version_id TEXT NOT NULL,
      note_key            TEXT NOT NULL,
      session_id          TEXT,
      session_agent       TEXT NOT NULL DEFAULT '',
      session_name        TEXT NOT NULL DEFAULT '',
      session_cwd         TEXT,
      session_repo_root   TEXT,
      trigger_mode        TEXT NOT NULL,
      delivery_mode       TEXT NOT NULL,
      state               TEXT NOT NULL,
      max_repair_rounds   INTEGER NOT NULL,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id                    TEXT PRIMARY KEY,
      binding_id            TEXT NOT NULL,
      workflow_version_id   TEXT NOT NULL,
      status                TEXT NOT NULL,
      current_phase         TEXT NOT NULL,
      max_repair_rounds     INTEGER NOT NULL,
      trigger_source        TEXT NOT NULL,
      trigger_key           TEXT NOT NULL,
      inspector_pr_key      TEXT,
      inspector_head_sha    TEXT,
      gate_state_json       TEXT,
      started_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      completed_at          INTEGER
    );
    CREATE TABLE IF NOT EXISTS workflow_submissions (
      id                   TEXT PRIMARY KEY,
      run_id               TEXT NOT NULL,
      round                INTEGER NOT NULL,
      mode                 TEXT NOT NULL,
      trigger_source       TEXT NOT NULL,
      trigger_key          TEXT NOT NULL,
      evidence_fingerprint TEXT NOT NULL,
      context_json         TEXT NOT NULL,
      evidence_json        TEXT NOT NULL,
      pr_head_sha          TEXT,
      status               TEXT NOT NULL,
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL,
      completed_at         INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_submissions_round
      ON workflow_submissions(run_id, round);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_submissions_trigger
      ON workflow_submissions(trigger_key);
    CREATE TABLE IF NOT EXISTS workflow_node_attempts (
      id                    TEXT PRIMARY KEY,
      submission_id         TEXT NOT NULL,
      node_id               TEXT NOT NULL,
      attempt               INTEGER NOT NULL,
      state                 TEXT NOT NULL,
      persona_snapshot_json TEXT,
      verdict_json          TEXT,
      output_json           TEXT,
      retry_at              INTEGER,
      input_fingerprint     TEXT NOT NULL,
      error                 TEXT,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      started_at            INTEGER,
      finished_at           INTEGER
    );
    CREATE TABLE IF NOT EXISTS workflow_edge_receipts (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id     TEXT NOT NULL,
      edge_id            TEXT NOT NULL,
      source_attempt_id  TEXT NOT NULL,
      payload_json       TEXT NOT NULL,
      created_at         INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_deliveries (
      id             TEXT PRIMARY KEY,
      run_id         TEXT NOT NULL,
      submission_id  TEXT NOT NULL,
      kind           TEXT NOT NULL,
      session_id     TEXT NOT NULL,
      note_key       TEXT NOT NULL,
      payload        TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      state          TEXT NOT NULL,
      error          TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      delivered_at   INTEGER
    );
  `);

  const graph = JSON.stringify({
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      {
        id: "judge",
        kind: "persona",
        persona: {
          sourcePersonaId: "p1",
          sourceRevision: 1,
          name: "Judge",
          description: "",
          guidanceMarkdown: "# Judge",
          runner: null,
          model: null,
        },
        position: { x: 200, y: 0 },
      },
      { id: "end", kind: "end", outcome: "Approved", position: { x: 400, y: 0 } },
    ],
    edges: [
      { id: "e1", source: "session", sourcePort: "submitted", target: "judge", targetPort: "activate" },
      { id: "e2", source: "judge", sourcePort: "pass", target: "end", targetPort: "terminal" },
      { id: "e3", source: "judge", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
    ],
  });
  const defaults = JSON.stringify({
    triggerMode: "manual",
    deliveryMode: "live",
    maxRepairRounds: 5,
  });
  raw.prepare(
    `INSERT INTO workflow_definitions (id, name, normalized_name, description, draft_graph_json,
       completion_policy_json, resumption_policy, binding_defaults_json, draft_revision,
       current_version_id, archived_at, created_at, updated_at)
     VALUES ('legacy-workflow', 'Legacy', 'legacy', '', ?, ?, 'manual', ?, 1, 'legacy-version',
             NULL, 1, 1)`,
  ).run(JSON.stringify({ nodes: [], edges: [] }), JSON.stringify({ kind: "none" }), defaults);
  raw.prepare(
    `INSERT INTO workflow_versions (id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, resumption_policy, binding_defaults_json, published_at)
     VALUES ('legacy-version', 'legacy-workflow', 1, 1, ?, ?, 'manual', ?, 5)`,
  ).run(graph, JSON.stringify({ kind: "none" }), defaults);
  raw.prepare(
    `INSERT INTO workflow_bindings (id, workflow_version_id, note_key, session_id, session_agent,
       session_name, session_cwd, session_repo_root, trigger_mode, delivery_mode, state,
       max_repair_rounds, created_at, updated_at)
     VALUES ('legacy-binding', 'legacy-version', 'agent-legacy', 'legacy-session', 'claude',
             'legacy', '/repo', '/repo', 'manual', 'live', 'active', 5, 6, 6)`,
  ).run();
  raw.prepare(
    `INSERT INTO workflow_runs (id, binding_id, workflow_version_id, status, current_phase,
       max_repair_rounds, trigger_source, trigger_key, inspector_pr_key, inspector_head_sha,
       gate_state_json, started_at, updated_at, completed_at)
     VALUES (?, 'legacy-binding', 'legacy-version', 'waiting_for_session', 'persona_feedback',
             5, 'manual', 'manual:legacy', NULL, NULL, NULL, 7, 9, NULL)`,
  ).run(LEGACY_IDS.run);

  const context = JSON.stringify({
    primaryGoal: { rawPrompt: "Ship it", refined: null, sourceNoteKey: "agent-legacy" },
    humanDecisions: [],
    constraints: [],
    acceptanceCriteria: [],
    priorPersonaFeedback: [],
    session: { agent: "claude", name: "legacy", cwd: "/repo", branch: "feature" },
    evidence: {
      headSha: "abc",
      diffFingerprint: "d1",
      diff: "patch",
      diffTruncated: false,
      workingTreeDirty: false,
      workingTreeStatus: [],
      workingTreeStatusTruncated: false,
      transcript: [],
      transcriptAnchor: null,
      transcriptTruncated: false,
      standards: [],
      standardsTruncated: false,
    },
    compaction: { status: "fallback", runner: null, model: null, error: null },
  });
  const insertSubmission = raw.prepare(
    `INSERT INTO workflow_submissions (id, run_id, round, mode, trigger_source, trigger_key,
       evidence_fingerprint, context_json, evidence_json, pr_head_sha, status, created_at,
       updated_at, completed_at)
     VALUES (?, ?, ?, 'full_workflow', 'manual', ?, ?, ?, '{}', NULL, ?, ?, ?, NULL)`,
  );
  insertSubmission.run(LEGACY_IDS.roundOne, LEGACY_IDS.run, 1, "manual:legacy:1", "f1", context, "completed", 7, 7);
  insertSubmission.run(LEGACY_IDS.roundTwo, LEGACY_IDS.run, 2, "manual:legacy:2", "f2", context, "running", 8, 8);
  raw.prepare(
    `INSERT INTO workflow_node_attempts (id, submission_id, node_id, attempt, state,
       persona_snapshot_json, verdict_json, output_json, retry_at, input_fingerprint, error,
       created_at, updated_at, started_at, finished_at)
     VALUES (?, ?, 'judge', 1, 'completed', ?, NULL, NULL, NULL, 'f2:judge', NULL, 8, 8, 8, 8)`,
  ).run(
    LEGACY_IDS.attempt,
    LEGACY_IDS.roundTwo,
    JSON.stringify({
      sourcePersonaId: "p1",
      sourceRevision: 1,
      name: "Judge",
      description: "",
      guidanceMarkdown: "# Judge",
      runner: null,
      model: null,
    }),
  );
  raw.prepare(
    `INSERT INTO workflow_edge_receipts (submission_id, edge_id, source_attempt_id, payload_json,
       created_at)
     VALUES (?, 'e2', ?, ?, 8)`,
  ).run(LEGACY_IDS.roundTwo, LEGACY_IDS.attempt, JSON.stringify({ outcome: "pass" }));
  raw.prepare(
    `INSERT INTO workflow_deliveries (id, run_id, submission_id, kind, session_id, note_key,
       payload, payload_sha256, state, error, created_at, updated_at, delivered_at)
     VALUES (?, ?, ?, 'pr_handoff', 'legacy-session', 'agent-legacy', 'packet', 'sha', 'delivered',
             NULL, 8, 8, 8)`,
  ).run(LEGACY_IDS.delivery, LEGACY_IDS.run, LEGACY_IDS.roundTwo);
  raw.close();
}

seedPreContinuationDb();

const { openDb } = await import("../src/server/db.ts");
const { WorkflowStore } = await import("../src/server/workflows/store.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const db = openDb();
const store = new WorkflowStore(db);

function indexColumns(table: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const index of db.prepare(`PRAGMA index_list(${table})`).all() as unknown as Array<{
    name: string;
    unique: number;
  }>) {
    out.set(index.name, (db.prepare(`PRAGMA index_info(${index.name})`).all() as unknown as Array<{
      name: string;
    }>).map((column) => column.name));
  }
  return out;
}

test("the one-submission-per-round index is dropped by name and replaced by (run, round, segment)", () => {
  const indexes = indexColumns("workflow_submissions");
  assert.equal(
    indexes.has("idx_workflow_submissions_round"),
    false,
    "the two-column unique index survived, so no machine could ever capture a second segment",
  );
  assert.deepEqual(
    indexes.get("idx_workflow_submissions_segment"),
    ["run_id", "round", "segment"],
  );
  // The trigger-key index is untouched: submission idempotency is not what changed.
  assert.deepEqual(indexes.get("idx_workflow_submissions_trigger"), ["trigger_key"]);
});

test("every existing submission keeps its id and reads as segment zero", () => {
  const submissions = store.listSubmissions(LEGACY_IDS.run);
  assert.deepEqual(submissions.map((item) => item.id), [LEGACY_IDS.roundOne, LEGACY_IDS.roundTwo]);
  for (const submission of submissions) {
    assert.equal(submission.segment, 0, "a pre-feature round WAS its round's only evidence");
    assert.equal(submission.parentSubmissionId, null);
    assert.equal(submission.continuationNodeId, null);
    assert.equal(submission.continuationNodeAttemptId, null);
  }
  // Ordering is by (round, segment) and still resolves the same latest row.
  assert.equal(store.latestSubmissionForRun(LEGACY_IDS.run)?.id, LEGACY_IDS.roundTwo);
  assert.equal(store.submissionForRepairRound(LEGACY_IDS.run, 1)?.id, LEGACY_IDS.roundOne);
  assert.equal(store.submissionForSegment(LEGACY_IDS.run, 2, 0)?.id, LEGACY_IDS.roundTwo);
  assert.equal(store.submissionForSegment(LEGACY_IDS.run, 2, 1), null);
});

test("a second segment is now insertable where the old index forbade it", () => {
  // The proof that the drop actually took effect, rather than that the new index exists
  // beside a surviving old one.
  db.prepare(
    `INSERT INTO workflow_submissions (id, run_id, round, segment, parent_submission_id,
       continuation_node_id, continuation_node_attempt_id, mode, trigger_source, trigger_key,
       evidence_fingerprint, context_json, evidence_json, pr_head_sha, status, created_at,
       updated_at, completed_at)
     VALUES ('legacy-segment-1', ?, 2, 1, ?, 'judge', ?, 'full_workflow', 'manual',
             'manual:legacy:2:1', 'f3', '{}', '{}', NULL, 'running', 9, 9, NULL)`,
  ).run(LEGACY_IDS.run, LEGACY_IDS.roundTwo, LEGACY_IDS.attempt);
  const child = store.getSubmission("legacy-segment-1");
  assert.equal(child?.segment, 1);
  assert.equal(child?.round, 2);
  assert.equal(child?.parentSubmissionId, LEGACY_IDS.roundTwo);
  // And `(run, round, segment)` is still UNIQUE.
  assert.throws(() => db.prepare(
    `INSERT INTO workflow_submissions (id, run_id, round, segment, parent_submission_id,
       continuation_node_id, continuation_node_attempt_id, mode, trigger_source, trigger_key,
       evidence_fingerprint, context_json, evidence_json, pr_head_sha, status, created_at,
       updated_at, completed_at)
     VALUES ('legacy-segment-dup', ?, 2, 1, ?, 'judge', ?, 'full_workflow', 'manual',
             'manual:legacy:2:1:dup', 'f4', '{}', '{}', NULL, 'running', 9, 9, NULL)`,
  ).run(LEGACY_IDS.run, LEGACY_IDS.roundTwo, LEGACY_IDS.attempt));
  db.prepare(`DELETE FROM workflow_submissions WHERE id = 'legacy-segment-1'`).run();
});

test("existing attempts, receipts and pr_handoff deliveries stay readable and unchanged", () => {
  const attempt = store.getAttempt(LEGACY_IDS.attempt);
  assert.equal(attempt?.persona?.name, "Judge");
  // The new column is nullable, and a Persona attempt genuinely carries no action.
  assert.equal(attempt?.sessionAction, null);
  assert.deepEqual(
    store.listReceipts(LEGACY_IDS.roundTwo).map((receipt) => receipt.edgeId),
    ["e2"],
  );
  const delivery = store.getDelivery(LEGACY_IDS.delivery);
  assert.equal(delivery?.kind, "pr_handoff");
  assert.equal(delivery?.state, "delivered");
  // A historical packet names no attempt, and the row boundary requires exactly that of it.
  assert.equal(delivery?.nodeAttemptId, null);
});

test("the delivery-to-attempt link and its live-uniqueness index arrive on an upgraded database", () => {
  const indexes = indexColumns("workflow_deliveries");
  assert.deepEqual(indexes.get("idx_workflow_deliveries_attempt"), ["node_attempt_id", "state"]);
  assert.ok(indexes.has("idx_workflow_deliveries_action_live"));
  // The original packet identity is untouched: legacy dedupe behaviour is unchanged.
  assert.deepEqual(
    indexes.get("idx_workflow_deliveries_identity"),
    ["submission_id", "kind", "payload_sha256"],
  );
});

test("the run, binding and published version behave exactly as they did", () => {
  assert.equal(store.getRun(LEGACY_IDS.run)?.status, "waiting_for_session");
  assert.equal(store.getBinding("legacy-binding")?.state, "active");
  const version = store.getWorkflowVersionById("legacy-version");
  assert.equal(version?.version, 1);
  assert.deepEqual(version?.graph.nodes.map((node) => node.id), ["session", "judge", "end"]);
  // The repair budget still counts ROUNDS, which is the number the run was published with.
  assert.equal(store.runSummary(LEGACY_IDS.run)?.round, 2);
  assert.equal(store.runSummary(LEGACY_IDS.run)?.segment, 0);
});

test("opening twice is idempotent, as every start of the daemon is", () => {
  const again = openDb();
  const indexes = (again.prepare(`PRAGMA index_list(workflow_submissions)`).all() as unknown as Array<{
    name: string;
  }>).map((index) => index.name);
  assert.equal(indexes.includes("idx_workflow_submissions_round"), false);
  assert.equal(indexes.includes("idx_workflow_submissions_segment"), true);
});
