import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-workflow-pagination-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { openDb } = await import("../src/server/db.ts");
const {
  clearWorkflowTables,
  decodeWorkflowRunCursor,
  WorkflowStore,
} = await import("../src/server/workflows/store.ts");
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
