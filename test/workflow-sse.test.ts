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
