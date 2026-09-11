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
  return store.insertWorkflow({ id: "w1", name: "Review", normalizedName: normalizeWorkflowName("Review"), description: "", draft, completionPolicy: { kind: "none" }, resumptionPolicy: "manual", bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 }, createdAt: 2, updatedAt: 2 });
}

test("definitions use revision CAS, normalized-name uniqueness, summaries, and soft archive", () => {
  const created = seed();
  assert.equal(created.ok, true);
  assert.equal(store.insertWorkflow({ id: "w2", name: "ＲＥＶＩＥＷ", normalizedName: normalizeWorkflowName("ＲＥＶＩＥＷ"), description: "", draft, completionPolicy: { kind: "none" }, resumptionPolicy: "manual", bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 }, createdAt: 2, updatedAt: 2 }).ok, false);
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
  // By id, not by emptiness: the shipped built-in catalog is merged into both listings, so
  // "the archived row is gone from the active list" is the claim, not "nothing is listed".
  assert.equal(store.listWorkflows().some((workflow) => workflow.id === "w1"), false);
  assert.equal(store.listWorkflows(true).find((workflow) => workflow.id === "w1")?.archivedAt, 5);
});

test("readiness policy defaults off and enforcing drafts now publish immutably", () => {
  const created = seed();
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.workflow.evidenceReadinessPolicy, "off");
  const updated = store.updateWorkflowCas("w1", 1, {
    evidenceReadinessPolicy: "criterion_mapped_v1",
  }, 3);
  assert.equal(updated.ok, true);
  if (!updated.ok) return;
  const published = store.publishWorkflow("w1", 2, "v-readiness", 4);
  assert.equal(published.ok, true);
  if (!published.ok) return;
  assert.equal(published.version.evidenceReadinessPolicy, "criterion_mapped_v1");
  assert.equal(store.listWorkflowVersions("w1").length, 1);
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

// A node's own provider/model choice is frozen BESIDE the Persona snapshot, never inside it,
// and publication has to keep both facts separable forever: the snapshot says what the Persona
// recommended when the version was cut, and the override says what this workflow chose. What is
// at stake below is that a published pair cannot move afterwards - not when the Persona is
// edited, not when the draft is, and not when a newer version is published.
test("Publish freezes a node override beside the Persona snapshot, and later edits cannot move it", () => {
  seed();
  const routed = {
    ...draft,
    nodes: draft.nodes.map((node) => node.kind === "persona"
      ? { ...node, executionOverride: { runner: "codex" as const, model: "gpt-5.6-sol" } }
      : node),
  };
  const withOverride = store.updateWorkflowCas("w1", 1, { draft: routed }, 3);
  assert.equal(withOverride.ok, true);
  if (!withOverride.ok) return;
  // An override-only edit is an ordinary draft edit: it bumps the revision, which is what
  // Publish keys idempotency on. No second fingerprint is needed and none exists.
  assert.equal(withOverride.workflow.draftRevision, 2);

  const first = store.publishWorkflow("w1", 2, "v1", 4);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const node = first.version.graph.nodes.find((candidate) => candidate.kind === "persona");
  assert.ok(node?.kind === "persona");
  if (node?.kind !== "persona") return;
  assert.deepEqual(node.executionOverride, { runner: "codex", model: "gpt-5.6-sol" });
  // The snapshot still reports what the PERSONA recommends, which is nothing. Flattening the
  // override into it would destroy the only record of who decided.
  assert.equal(node.persona.runner, null);
  assert.equal(node.persona.model, null);

  // Republishing the same draft revision changes nothing.
  const repeated = store.publishWorkflow("w1", 2, "ignored", 5);
  assert.equal(repeated.ok, true);
  if (!repeated.ok) return;
  assert.equal(repeated.idempotent, true);
  assert.equal(store.listWorkflowVersions("w1").length, 1);

  // Change ONLY the override, and a distinct version is minted while version 1 stays put.
  store.updatePersonaCas("p1", 1, { runner: "claude", model: "claude-opus-4-8" }, 6);
  const rerouted = store.updateWorkflowCas("w1", 2, {
    draft: {
      ...draft,
      nodes: draft.nodes.map((candidate) => candidate.kind === "persona"
        ? { ...candidate, executionOverride: { runner: "claude" as const, model: "claude-opus-4-8" } }
        : candidate),
    },
  }, 7);
  assert.equal(rerouted.ok, true);
  const second = store.publishWorkflow("w1", 3, "v2", 8);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.version.version, 2);
  const before = store.getWorkflowVersion("w1", 1)?.graph.nodes.find((c) => c.kind === "persona");
  const after = store.getWorkflowVersion("w1", 2)?.graph.nodes.find((c) => c.kind === "persona");
  assert.ok(before?.kind === "persona" && after?.kind === "persona");
  if (before?.kind !== "persona" || after?.kind !== "persona") return;
  assert.deepEqual(before.executionOverride, { runner: "codex", model: "gpt-5.6-sol" });
  assert.deepEqual(after.executionOverride, { runner: "claude", model: "claude-opus-4-8" });
  // And the Persona edit that landed in between reached the new snapshot only.
  assert.equal(before.persona.runner, null);
  assert.equal(after.persona.runner, "claude");
});

test("Publish leaves an inheriting node with no override key at all", () => {
  seed();
  const published = store.publishWorkflow("w1", 1, "v1", 4);
  assert.equal(published.ok, true);
  if (!published.ok) return;
  const node = published.version.graph.nodes.find((candidate) => candidate.kind === "persona")!;
  // Not "undefined": the version's stored JSON must not gain a key, or every reader that
  // distinguishes inheritance from a choice would have to start distinguishing two spellings
  // of inheritance instead.
  assert.equal(Object.hasOwn(node, "executionOverride"), false);
  assert.equal(JSON.stringify(published.version.graph).includes("executionOverride"), false);
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
