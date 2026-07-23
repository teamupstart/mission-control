import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-workflow-store-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { WorkflowStore, clearWorkflowTables } = await import("../src/server/workflows/store.ts");
const { normalizePersonaName, normalizeWorkflowName } = await import("../src/shared/workflow.ts");

const db = openDb();
const store = new WorkflowStore(db);
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearWorkflowTables(db));

const draft = {
  nodes: [
    { id: "session", kind: "session" as const, position: { x: 0, y: 0 } },
    { id: "judge", kind: "persona" as const, personaId: "p1", position: { x: 220, y: 0 } },
    { id: "end", kind: "end" as const, outcome: "Approved", position: { x: 440, y: 0 } },
  ],
  edges: [
    { id: "start", source: "session", sourcePort: "submitted" as const, target: "judge", targetPort: "activate" as const },
    { id: "pass", source: "judge", sourcePort: "pass" as const, target: "end", targetPort: "terminal" as const },
    { id: "fail", source: "judge", sourcePort: "fail" as const, target: "session", targetPort: "return_for_changes" as const },
  ],
};

function seed(guidance = "# Exact\r\n\r\nKeep this.  \r\n") {
  store.insertPersona({ id: "p1", name: "Judge", normalizedName: normalizePersonaName("Judge"), description: "Quality", guidanceMarkdown: guidance, runner: null, model: null, createdAt: 1, updatedAt: 1 });
  return store.insertWorkflow({ id: "w1", name: "Review", normalizedName: normalizeWorkflowName("Review"), description: "", draft, completionPolicy: { kind: "none" }, bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 }, createdAt: 2, updatedAt: 2 });
}

test("definitions use revision CAS, normalized-name uniqueness, summaries, and soft archive", () => {
  const created = seed();
  assert.equal(created.ok, true);
  assert.equal(store.insertWorkflow({ id: "w2", name: "ＲＥＶＩＥＷ", normalizedName: normalizeWorkflowName("ＲＥＶＩＥＷ"), description: "", draft, completionPolicy: { kind: "none" }, bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 }, createdAt: 2, updatedAt: 2 }).ok, false);
  const updated = store.updateWorkflowCas("w1", 1, { description: "Changed" }, 3);
  assert.equal(updated.ok, true);
  if (!updated.ok) return;
  assert.equal(updated.workflow.draftRevision, 2);
  const stale = store.updateWorkflowCas("w1", 1, { description: "Lost" }, 4);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.reason, "revision_conflict");
  const summary = store.summary(updated.workflow);
  assert.equal(summary.nodeCount, 3);
  assert.equal(summary.personaCount, 1);
  assert.equal(summary.errorCount, 0);
  assert.equal(store.archiveWorkflowCas("w1", 2, 5).ok, true);
  assert.deepEqual(store.listWorkflows(), []);
  assert.equal(store.listWorkflows(true)[0]?.archivedAt, 5);
});

test("Publish snapshots exact Persona bytes, is idempotent per draft, and never mutates old versions", () => {
  const exact = "# Exact\r\n\r\nKeep this.  \r\n";
  seed(exact);
  const first = store.publishWorkflow("w1", 1, "v1", 10);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.version.version, 1);
  const metadata = store.listWorkflowVersionMetadata("w1")[0]!;
  assert.equal(metadata.version, 1);
  assert.equal("graph" in metadata, false);
  const node = first.version.graph.nodes.find((candidate) => candidate.kind === "persona");
  assert.ok(node?.kind === "persona");
  if (node?.kind !== "persona") return;
  assert.equal(node.persona.guidanceMarkdown, exact);
  assert.equal(node.persona.sourceRevision, 1);
  const repeated = store.publishWorkflow("w1", 1, "ignored", 11);
  assert.equal(repeated.ok, true);
  if (!repeated.ok) return;
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.version.id, "v1");

  store.updatePersonaCas("p1", 1, { guidanceMarkdown: "# Changed" }, 20);
  store.updateWorkflowCas("w1", 1, { description: "new revision" }, 21);
  const second = store.publishWorkflow("w1", 2, "v2", 22);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.version.version, 2);
  const old = store.getWorkflowVersion("w1", 1)?.graph.nodes.find((candidate) => candidate.kind === "persona");
  const latest = store.getWorkflowVersion("w1", 2)?.graph.nodes.find((candidate) => candidate.kind === "persona");
  assert.ok(old?.kind === "persona" && latest?.kind === "persona");
  if (old?.kind === "persona" && latest?.kind === "persona") {
    assert.equal(old.persona.guidanceMarkdown, exact);
    assert.equal(latest.persona.guidanceMarkdown, "# Changed");
    assert.equal(latest.persona.sourceRevision, 2);
  }
});

test("Publish rejects missing or archived live Personas with structured diagnostics", () => {
  seed();
  store.archivePersonaCas("p1", 1, 3);
  const result = store.publishWorkflow("w1", 1, "v1", 4);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "validation");
  assert.ok(result.diagnostics?.some((item) => item.code === "archived_persona"));
});
