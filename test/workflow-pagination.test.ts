import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

const home = mkdtempSync(join(tmpdir(), "mission-workflow-pagination-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { openDb } = await import("../src/server/db.ts");
const {
  clearWorkflowTables,
  decodeWorkflowRunCursor,
  WorkflowStore,
} = await import("../src/server/workflows/store.ts");
const { fallbackWorkflowContext } = await import("../src/server/workflows/context.ts");
const db = openDb();
const store = new WorkflowStore(db);
beforeEach(() => clearWorkflowTables(db));

function seedCatalog(): void {
  db.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json, completion_policy_json,
       binding_defaults_json, draft_revision, current_version_id, created_at, updated_at
     ) VALUES ('workflow', 'Review', 'review', '', '{"nodes":[],"edges":[]}',
               '{"kind":"none"}',
               '{"triggerMode":"manual","deliveryMode":"preview","maxRepairRounds":5}',
               1, 'version', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, binding_defaults_json, published_at
     ) VALUES ('version', 'workflow', 1, 1, '{"nodes":[],"edges":[]}',
               '{"kind":"none"}',
               '{"triggerMode":"manual","deliveryMode":"preview","maxRepairRounds":5}', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_bindings (
       id, workflow_version_id, note_key, session_id, session_agent, session_name,
       trigger_mode, delivery_mode, state, max_repair_rounds, created_at, updated_at
     ) VALUES ('binding', 'version', 'note-key', 'session-1', 'codex', 'Worker',
               'manual', 'preview', 'active', 5, 1, 1)`,
  ).run();
}

function seedRun(id: string, updatedAt: number, status = "completed"): void {
  db.prepare(
    `INSERT INTO workflow_runs (
       id, binding_id, workflow_version_id, status, current_phase, max_repair_rounds,
       trigger_source, trigger_key, started_at, updated_at, completed_at
     ) VALUES (?, 'binding', 'version', ?, 'complete', 5, 'manual', ?, 1, ?, ?)`,
  ).run(id, status, `trigger:${id}`, updatedAt, status === "completed" ? updatedAt : null);
}

function instrumentedStore(): { store: InstanceType<typeof WorkflowStore>; statements: { count: number } } {
  const statements = { count: 0 };
  const countedDb = new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          statements.count += 1;
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DatabaseSync;
  return { store: new WorkflowStore(countedDb), statements };
}

function insertSubmission(input: {
  id: string;
  runId: string;
  round: number;
  contextJson: string;
  evidenceJson: string;
}): void {
  db.prepare(
    `INSERT INTO workflow_submissions (
       id, run_id, round, segment, mode, trigger_source, trigger_key,
       evidence_fingerprint, context_json, evidence_json, status,
       created_at, updated_at, completed_at
     ) VALUES (?, ?, ?, 0, 'full_workflow', 'manual', ?, ?, ?, ?,
               'completed', ?, ?, ?)`,
  ).run(
    input.id,
    input.runId,
    input.round,
    `submission:${input.id}`,
    `fingerprint:${input.id}`,
    input.contextJson,
    input.evidenceJson,
    input.round,
    input.round,
    input.round,
  );
  db.prepare(
     `INSERT INTO workflow_node_attempts (
       id, submission_id, node_id, attempt, state, input_fingerprint, created_at, updated_at
     ) VALUES (?, ?, 'node', 1, 'completed', ?, ?, ?)`,
  ).run(`attempt:${input.id}`, input.id, `attempt-fingerprint:${input.id}`, input.round, input.round);
}

test("run pages use a stable opaque updated-at/id cursor and exact filters", () => {
  seedCatalog();
  seedRun("a", 10);
  seedRun("b", 10);
  seedRun("c", 9, "running");
  const first = store.listRunSummaryPage({ limit: 1, cursor: null });
  assert.deepEqual(first.items.map((item) => item.id), ["b"]);
  assert.ok(first.nextCursor);
  const decoded = decodeWorkflowRunCursor(first.nextCursor!);
  assert.deepEqual(decoded, { updatedAt: 10, id: "b" });
  const second = store.listRunSummaryPage({ limit: 2, cursor: decoded });
  assert.deepEqual(second.items.map((item) => item.id), ["a", "c"]);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(
    store.listRunSummaryPage({ limit: 10, cursor: null, status: "running" }).items.map((item) => item.id),
    ["c"],
  );
  assert.equal(
    store.listRunSummaryPage({
      limit: 10,
      cursor: null,
      workflowId: "workflow",
      session: "session-1",
    }).items.length,
    3,
  );
  assert.equal(decodeWorkflowRunCursor("not-a-cursor"), null);
});

test("event and model-call pages are hard capped and advance by durable ids", () => {
  seedCatalog();
  seedRun("run", 10);
  const insert = db.prepare(
    `INSERT INTO workflow_events (run_id, ts, event_kind, payload_json)
     VALUES ('run', ?, 'event', '{}')`,
  );
  for (let index = 1; index <= 450; index += 1) insert.run(index);
  const first = store.listEventPage("run", 0, 200);
  assert.equal(first.items.length, 200);
  assert.equal(first.nextAfter, first.items.at(-1)?.id);
  const second = store.listEventPage("run", first.nextAfter!, 200);
  const third = store.listEventPage("run", second.nextAfter!, 200);
  assert.equal(second.items.length, 200);
  assert.equal(third.items.length, 50);
  assert.equal(third.nextAfter, null);
  assert.ok(second.items[0]!.id > first.items.at(-1)!.id);
});

test("keyset paging remains stable when a row is concurrently deleted", () => {
  seedCatalog();
  for (let index = 1; index <= 6; index += 1) {
    seedRun(`run-${index}`, index);
  }
  const first = store.listRunSummaryPage({ limit: 2, cursor: null });
  assert.deepEqual(first.items.map((item) => item.id), ["run-6", "run-5"]);
  const cursor = decodeWorkflowRunCursor(first.nextCursor!);
  assert.ok(cursor);
  db.prepare(`DELETE FROM workflow_runs WHERE id = 'run-5'`).run();
  const second = store.listRunSummaryPage({ limit: 2, cursor });
  assert.deepEqual(second.items.map((item) => item.id), ["run-4", "run-3"]);
  assert.equal(
    new Set([...first.items, ...second.items].map((item) => item.id)).size,
    4,
  );
});

test("one malformed durable row cannot pin the cursor or hide later history", () => {
  seedCatalog();
  seedRun("newest", 3);
  seedRun("malformed", 2, "newer_unknown_state");
  seedRun("oldest", 1);
  const originalError = console.error;
  console.error = () => {};
  try {
    const first = store.listRunSummaryPage({ limit: 2, cursor: null });
    assert.deepEqual(first.items.map((item) => item.id), ["newest"]);
    assert.ok(first.nextCursor);
    const second = store.listRunSummaryPage({
      limit: 2,
      cursor: decodeWorkflowRunCursor(first.nextCursor!),
    });
    assert.deepEqual(second.items.map((item) => item.id), ["oldest"]);
  } finally {
    console.error = originalError;
  }
});

test("a 1000-run installation still reads one bounded page", () => {
  seedCatalog();
  const insert = db.prepare(
    `INSERT INTO workflow_runs (
       id, binding_id, workflow_version_id, status, current_phase, max_repair_rounds,
       trigger_source, trigger_key, started_at, updated_at, completed_at
     ) VALUES (?, 'binding', 'version', 'completed', 'complete', 5,
               'manual', ?, 1, ?, ?)`,
  );
  for (let index = 1; index <= 1_000; index += 1) {
    insert.run(`scale-${String(index).padStart(4, "0")}`, `scale:${index}`, index, index);
  }
  const page = store.listRunSummaryPage({ limit: 50, cursor: null });
  assert.equal(page.items.length, 50);
  assert.equal(page.items[0]?.id, "scale-1000");
  assert.equal(page.items.at(-1)?.id, "scale-0951");
  assert.ok(page.nextCursor);
});

test("a 50-run summary page uses two statements and never reads context blobs", () => {
  seedCatalog();
  for (let index = 1; index <= 50; index += 1) {
    const runId = `bounded-${String(index).padStart(2, "0")}`;
    seedRun(runId, index);
    // Deliberately malformed and far larger than summary data. A summary has no reason to
    // parse or transfer either field, and the old per-run latestSubmission path did both.
    insertSubmission({
      id: `submission:${runId}`,
      runId,
      round: 1,
      contextJson: `{not-json:${"x".repeat(8_000)}`,
      evidenceJson: `{not-json:${"y".repeat(8_000)}`,
    });
  }
  const measured = instrumentedStore();
  const page = measured.store.listRunSummaryPage({ limit: 50, cursor: null });
  assert.equal(page.items.length, 50);
  assert.equal(measured.statements.count, 2);
  assert.equal(page.items[0]?.round, 1);
  assert.equal(page.items[0]?.segment, 0);
});

test("run detail statement count is constant as submission history grows", () => {
  seedCatalog();
  const raw = {
    primaryGoal: { rawPrompt: "Review this", refined: null, sourceNoteKey: "note-key" },
    humanDecisions: [],
    priorPersonaFeedback: [],
    session: { agent: "codex", name: "Worker", cwd: "/repo", branch: "feature" },
    evidence: {
      headSha: "abc",
      diffFingerprint: "diff",
      diff: "patch",
      diffTruncated: false,
      workingTreeDirty: false,
      workingTreeStatus: [],
      workingTreeStatusTruncated: false,
      transcript: [],
      transcriptAnchor: 1,
      transcriptTruncated: false,
      standards: [],
      standardsTruncated: false,
    },
  };
  const context = fallbackWorkflowContext(raw, "test fallback");
  const contextJson = JSON.stringify(context);
  const evidenceJson = JSON.stringify(context.evidence);
  seedRun("detail-one", 100);
  insertSubmission({
    id: "submission:detail-one:1",
    runId: "detail-one",
    round: 1,
    contextJson,
    evidenceJson,
  });
  seedRun("detail-many", 101);
  for (let round = 1; round <= 20; round += 1) {
    const submissionId = `submission:detail-many:${round}`;
    insertSubmission({
      id: submissionId,
      runId: "detail-many",
      round,
      contextJson,
      evidenceJson,
    });
    db.prepare(
      `INSERT INTO workflow_edge_receipts (
         submission_id, edge_id, source_attempt_id, payload_json, created_at
       ) VALUES (?, ?, ?, '{}', ?)`,
    ).run(submissionId, `edge:${round}`, `attempt:${submissionId}`, round);
  }

  const one = instrumentedStore();
  assert.ok(one.store.runDetail("detail-one"));
  const many = instrumentedStore();
  const detail = many.store.runDetail("detail-many");
  assert.equal(detail?.submissions.length, 20);
  assert.equal(detail?.attempts.length, 20);
  assert.equal(detail?.receipts.length, 20);
  assert.equal(many.statements.count, one.statements.count);
  // Readiness overrides and the refused-completion claim are each a separate append-only
  // ledger read behind one bounded query. Keep the important contract here: detail cost stays
  // constant as immutable submission history grows, which the equality above is what proves.
  assert.ok(many.statements.count <= 18, `detail used ${many.statements.count} statements`);
});
