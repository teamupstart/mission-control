import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "../src/shared/types.ts";
import type { PersonaView, WorkflowSummary } from "../src/shared/workflow.ts";

// What is at stake: Personas are SSE state, not a second polling subsystem. A reconnect snapshot
// and the incremental upsert stream must converge on the same catalog, including a soft archive.

const home = mkdtempSync(join(tmpdir(), "mission-workflow-sse-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { PersonaManager } = await import("../src/server/workflows/personas.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { WorkflowStore, clearWorkflowTables } = await import("../src/server/workflows/store.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));

test("snapshot, upsert, archive, and reconnect produce one equivalent Persona catalog", () => {
  clearWorkflowTables(db);
  const registry = new Registry();
  const manager = new PersonaManager(registry, new WorkflowStore(db));
  assert.deepEqual(registry.snapshot().personas, []);
  const emptySnapshot = { type: "snapshot", ...registry.snapshot() } satisfies ServerEvent;
  assert.deepEqual(emptySnapshot.personas, []);

  const events: ServerEvent[] = [];
  const unsubscribe = registry.subscribe((event) => events.push(event));
  const created = manager.create({
    name: "Quality",
    description: "",
    guidanceMarkdown: "# Review",
    runner: null,
    model: null,
  }, 100);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const archived = manager.archive(created.persona.id, 1, 200);
  assert.equal(archived.ok, true);
  unsubscribe();

  assert.deepEqual(events.map((event) => event.type), ["persona_upsert", "persona_upsert"]);
  const reduced = new Map<string, PersonaView>();
  for (const event of events) {
    if (event.type === "persona_upsert") reduced.set(event.persona.id, event.persona);
    if (event.type === "persona_remove") reduced.delete(event.id);
  }
  assert.deepEqual([...reduced.values()], registry.snapshot().personas);
  assert.equal(registry.snapshot().personas[0]?.archivedAt, 200);
  const archivedSnapshot = { type: "snapshot", ...registry.snapshot() } satisfies ServerEvent;
  assert.deepEqual(archivedSnapshot.personas, registry.snapshot().personas);

  const reconnect = new Registry();
  new PersonaManager(reconnect, new WorkflowStore(db));
  assert.deepEqual(reconnect.snapshot().personas, registry.snapshot().personas);
});

test("workflow summary snapshot, upsert, archive, and reconnect converge without graph JSON", () => {
  clearWorkflowTables(db);
  const registry = new Registry();
  const store = new WorkflowStore(db);
  new PersonaManager(registry, store);
  const manager = new WorkflowManager(registry, store);
  assert.deepEqual(registry.snapshot().workflowSummaries, []);
  const events: ServerEvent[] = [];
  const unsubscribe = registry.subscribe((event) => events.push(event));
  const created = manager.create({
    name: "Review",
    description: "",
    draft: { nodes: [{ id: "session", kind: "session", position: { x: 0, y: 0 } }, { id: "end", kind: "end", outcome: "Complete", position: { x: 360, y: 0 } }], edges: [] },
    completionPolicy: { kind: "none" },
    bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 },
  }, 100);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  manager.archive(created.workflow.id, 1, 200);
  unsubscribe();
  assert.deepEqual(events.map((event) => event.type), ["workflow_upsert", "workflow_upsert"]);
  const reduced = new Map<string, WorkflowSummary>();
  for (const event of events) {
    if (event.type === "workflow_upsert") reduced.set(event.workflow.id, event.workflow);
    if (event.type === "workflow_remove") reduced.delete(event.id);
  }
  assert.deepEqual([...reduced.values()], registry.snapshot().workflowSummaries);
  assert.equal("draft" in registry.snapshot().workflowSummaries[0]!, false);
  const reconnect = new Registry();
  new PersonaManager(reconnect, store);
  new WorkflowManager(reconnect, store);
  assert.deepEqual(reconnect.snapshot().workflowSummaries, registry.snapshot().workflowSummaries);
});

test("compact workflow run summaries converge through snapshot, incremental SSE, and reconnect", () => {
  clearWorkflowTables(db);
  const graph = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 100, y: 0 } },
    ],
    edges: [],
  };
  const defaults = JSON.stringify({ triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 });
  db.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json, completion_policy_json,
       binding_defaults_json, draft_revision, current_version_id, archived_at, created_at, updated_at
     ) VALUES ('w', 'Review', 'review', '', ?, '{"kind":"none"}', ?, 1, 'v', NULL, 1, 1)`,
  ).run(JSON.stringify(graph), defaults);
  db.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, binding_defaults_json, published_at
     ) VALUES ('v', 'w', 1, 1, ?, '{"kind":"none"}', ?, 1)`,
  ).run(JSON.stringify(graph), defaults);
  const store = new WorkflowStore(db);
  const binding = store.insertBinding({
    id: "b",
    workflowVersionId: "v",
    noteKey: "note",
    sessionId: "session",
    sessionAgent: "claude",
    sessionName: "work",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 5,
    now: 1,
  });
  store.createInitialSubmission(
    { id: "run", binding, triggerSource: "manual", triggerKey: "manual:b:req", now: 2 },
    { id: "sub", triggerSource: "manual", triggerKey: "manual:b:req", context: {}, evidence: {}, now: 2 },
  );
  store.setRunState("run", "waiting_for_inspector", "inspector_review", {
    prKey: "owner/repo#88",
    prUrl: "https://github.com/owner/repo/pull/88",
    targetHeadSha: "abcdef1234567890",
    failedHeadSha: null,
    enteredAt: 2,
    lastObservedAt: 3,
    observedHeadSha: "abcdef1234567890",
    reviewPosture: "live",
    waitReason: "review_pending",
    findingFingerprints: [],
  }, 3);
  const registry = new Registry();
  new PersonaManager(registry, store);
  const manager = new WorkflowManager(registry, store);
  assert.equal(registry.snapshot().workflowRunSummaries.length, 1);
  assert.equal("version" in registry.snapshot().workflowRunSummaries[0]!, false);
  assert.equal("context" in registry.snapshot().workflowRunSummaries[0]!, false);
  assert.equal(registry.snapshot().workflowRunSummaries[0]?.gate, "waiting_inspector");
  assert.equal(registry.snapshot().workflowRunSummaries[0]?.gatePrNumber, 88);
  assert.equal(registry.snapshot().workflowRunSummaries[0]?.gateHeadShort, "abcdef12");
  assert.equal(registry.snapshot().workflowRunSummaries[0]?.reviewPosture, "live");
  const listRunSummaries = store.listRunSummaries;
  store.listRunSummaries = () => {
    throw new Error("incremental publication scanned workflow history");
  };
  assert.equal(store.runSummary("run")?.id, "run");
  const events: ServerEvent[] = [];
  const unsubscribe = registry.subscribe((event) => events.push(event));
  manager.cancel("run", "cancel-request", 3);
  unsubscribe();
  assert.equal(events.at(-1)?.type, "workflow_run_upsert");
  assert.equal(registry.snapshot().workflowRunSummaries[0]?.status, "cancelled");
  store.listRunSummaries = listRunSummaries;

  const reconnect = new Registry();
  new PersonaManager(reconnect, store);
  new WorkflowManager(reconnect, store);
  assert.deepEqual(
    reconnect.snapshot().workflowRunSummaries,
    registry.snapshot().workflowRunSummaries,
  );
});
