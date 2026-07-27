import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  WorkflowDefinition,
  WorkflowDraftGraph,
  WorkflowVersion,
} from "../src/shared/workflow.ts";

// What is at stake: a built-in workflow is app data merged into reads, and the merge rules are
// what make that safe. There are two projections and they are NOT interchangeable - the
// display listing lets an operator's same-named workflow shadow a built-in, while the
// addressable catalog and every version resolver must keep finding it, because a binding an
// operator already holds pins its version id and would otherwise stop resolving the moment
// they named a workflow the same thing. Every refusal lives in the store rather than at a
// caller, so a second caller cannot forget it.
//
// The catalog here is FABRICATED on purpose. These are rules about merging, not about what
// the four shipped documents happen to say, and asserting them against the real No-Mistakes
// Review would make "a name an operator already took" mean whatever that graph is called.

const home = mkdtempSync(join(tmpdir(), "mission-builtin-workflows-store-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { WorkflowStore, clearWorkflowTables } = await import("../src/server/workflows/store.ts");
const { normalizePersonaName, normalizeWorkflowName } = await import("../src/shared/workflow.ts");
const { BUILTIN_PERSONAS } = await import("../src/server/workflows/builtin-personas.ts");
const { builtinWorkflowId, builtinWorkflowVersionId } =
  await import("../src/server/workflows/builtin-workflows.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearWorkflowTables(db));

const SHIPPED_ID = builtinWorkflowId("fixture-review");
const judge = BUILTIN_PERSONAS[0]!;

const shippedDraft: WorkflowDraftGraph = {
  nodes: [
    { id: "fx-session", kind: "session", position: { x: 0, y: 0 } },
    { id: "fx-judge", kind: "persona", personaId: judge.id, position: { x: 220, y: 0 } },
    { id: "fx-end", kind: "end", outcome: "Complete", position: { x: 440, y: 0 } },
  ],
  edges: [
    { id: "fx-a", source: "fx-session", sourcePort: "submitted", target: "fx-judge", targetPort: "activate" },
    { id: "fx-b", source: "fx-judge", sourcePort: "pass", target: "fx-end", targetPort: "terminal" },
    { id: "fx-c", source: "fx-judge", sourcePort: "fail", target: "fx-session", targetPort: "return_for_changes" },
  ],
};

const shippedVersion = (version: number): WorkflowVersion => ({
  id: builtinWorkflowVersionId("fixture-review", version),
  workflowId: SHIPPED_ID,
  version,
  sourceDraftRevision: 1,
  graph: {
    nodes: shippedDraft.nodes.map((node) => node.kind === "persona"
      ? {
          id: node.id,
          kind: "persona" as const,
          position: node.position,
          persona: {
            sourcePersonaId: judge.id,
            sourceRevision: judge.revision,
            name: judge.name,
            description: judge.description,
            guidanceMarkdown: judge.guidanceMarkdown,
            runner: null,
            model: null,
          },
        }
      : node),
    edges: [...shippedDraft.edges],
  },
  completionPolicy: { kind: "none" },
  bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 },
  publishedAt: 0,
});

const shippedDefinition: WorkflowDefinition = {
  id: SHIPPED_ID,
  name: "Fixture Review",
  normalizedName: normalizeWorkflowName("Fixture Review"),
  description: "",
  draft: shippedDraft,
  completionPolicy: { kind: "none" },
  bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 },
  draftRevision: 1,
  // Two versions, because the append-only version list is the whole reason the catalog holds
  // a list: a binding pinned to version 1 has to keep resolving after version 2 ships.
  currentVersionId: builtinWorkflowVersionId("fixture-review", 2),
  archivedAt: null,
  createdAt: 0,
  updatedAt: 0,
  builtin: true,
};

const catalog = [{
  definition: shippedDefinition,
  versions: [shippedVersion(1), shippedVersion(2)],
}];

function fixtureStore() {
  return new WorkflowStore(db, BUILTIN_PERSONAS, catalog);
}

function insert(store: ReturnType<typeof fixtureStore>, id: string, name: string) {
  return store.insertWorkflow({
    id,
    name,
    normalizedName: normalizeWorkflowName(name),
    description: "",
    draft: shippedDraft,
    completionPolicy: { kind: "none" },
    bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 },
    createdAt: 1,
    updatedAt: 1,
  });
}

test("a built-in is listed on an empty database, in both listings, with no seeding step", () => {
  const store = fixtureStore();
  assert.deepEqual(store.listWorkflows().map((workflow) => workflow.id), [SHIPPED_ID]);
  // Built-ins are never archived, so the archived listing - which is what the SSE snapshot is
  // built from - stays a superset of the active one.
  assert.deepEqual(store.listWorkflows(true).map((workflow) => workflow.id), [SHIPPED_ID]);
  assert.equal(store.getWorkflow(SHIPPED_ID)?.builtin, true);
  assert.equal(store.summary(store.getWorkflow(SHIPPED_ID)!).builtin, true);
  // The summary's published version comes from the catalog, not from a row lookup that would
  // report the shipped workflow as unpublished and therefore unbindable.
  assert.equal(store.summary(store.getWorkflow(SHIPPED_ID)!).publishedVersion, 2);
});

test("a live same-named row shadows the listing while the built-in stays addressable", () => {
  const store = fixtureStore();
  // Only history can produce this: an operator who authored the workflow under that name
  // before it shipped. `insertWorkflow` refuses the name now, so no NEW shadow can appear.
  db.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json, completion_policy_json,
       binding_defaults_json, draft_revision, current_version_id, archived_at,
       created_at, updated_at
     ) VALUES (?, ?, ?, '', ?, ?, ?, 1, NULL, NULL, 1, 1)`,
  ).run(
    "operator",
    "FIXTURE   REVIEW",
    normalizeWorkflowName("Fixture Review"),
    JSON.stringify(shippedDraft),
    JSON.stringify({ kind: "none" }),
    JSON.stringify({ triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 }),
  );

  assert.deepEqual(store.listWorkflows().map((workflow) => workflow.id), ["operator"]);
  // Shadowing is a DISPLAY rule. Everything a durable binding or run touches must still find
  // the built-in, or an operator naming a workflow "Fixture Review" would break every run
  // already pinned to the shipped version.
  assert.ok(store.workflowCatalog().some((workflow) => workflow.id === SHIPPED_ID));
  assert.equal(store.getWorkflow(SHIPPED_ID)?.id, SHIPPED_ID);
  assert.equal(
    store.getWorkflowVersionById(builtinWorkflowVersionId("fixture-review", 1))?.version,
    1,
  );
  assert.equal(store.getWorkflowVersion(SHIPPED_ID, 2)?.id, catalog[0]!.versions[1]!.id);
  assert.deepEqual(
    store.listWorkflowVersions(SHIPPED_ID).map((version) => version.version),
    [2, 1],
    "newest first, matching the row query, so a caller cannot tell a built-in from a row",
  );
  assert.deepEqual(
    store.listWorkflowVersionMetadata(SHIPPED_ID).map((version) => version.version),
    [2, 1],
  );
  assert.equal("graph" in store.listWorkflowVersionMetadata(SHIPPED_ID)[0]!, false);
});

test("an archived same-named row does NOT shadow", () => {
  const store = fixtureStore();
  assert.equal(insert(store, "operator", "Fixture Review 2").ok, true);
  store.updateWorkflowCas("operator", 1, { name: "Fixture Review", normalizedName: normalizeWorkflowName("Fixture Review") });
  // The rename above is refused - so archive the row under its own name and prove the rule
  // directly, the way `personasForDisplay` states it: a retired workflow must not keep a
  // shipped one out of the library.
  db.prepare(`UPDATE workflow_definitions SET normalized_name = ?, archived_at = 9 WHERE id = 'operator'`)
    .run(normalizeWorkflowName("Fixture Review"));
  assert.deepEqual(store.listWorkflows().map((workflow) => workflow.id), [SHIPPED_ID]);
  assert.deepEqual(
    store.listWorkflows(true).map((workflow) => workflow.id).sort(),
    [SHIPPED_ID, "operator"].sort(),
  );
});

test("every mutating path refuses a built-in in the store, not at a caller", () => {
  const store = fixtureStore();

  const byId = insert(store, SHIPPED_ID, "Something else");
  assert.equal(byId.ok, false);
  if (!byId.ok) {
    assert.equal(byId.reason, "builtin");
    assert.equal(byId.current?.id, SHIPPED_ID);
  }

  const byName = insert(store, "operator", "ＦＩＸＴＵＲＥ   Review");
  assert.equal(byName.ok, false, "the normalized name is reserved the way any duplicate is");
  if (!byName.ok) {
    assert.equal(byName.reason, "name_conflict");
    assert.equal(byName.current?.id, SHIPPED_ID);
  }

  const updated = store.updateWorkflowCas(SHIPPED_ID, 1, { description: "mine" });
  assert.equal(updated.ok, false);
  if (!updated.ok) assert.equal(updated.reason, "builtin");

  const archived = store.archiveWorkflowCas(SHIPPED_ID, 1);
  assert.equal(archived.ok, false);
  if (!archived.ok) assert.equal(archived.reason, "builtin");

  const published = store.publishWorkflow(SHIPPED_ID, 1, "would-be-version");
  assert.equal(published.ok, false, "a built-in arrives published; there is nothing to mint");
  if (!published.ok) assert.equal(published.reason, "builtin");

  // Both of these are refused BEFORE the guard that would otherwise answer first, so the
  // operator is told the real reason. `unarchive` would say `not_found` about a workflow they
  // are looking at, and `delete` would say `published` about one they never published.
  const restored = store.unarchiveWorkflowCas(SHIPPED_ID, 1);
  assert.equal(restored.ok, false);
  if (!restored.ok) {
    assert.equal(restored.reason, "builtin");
    assert.equal(restored.current?.id, SHIPPED_ID);
  }

  const removed = store.deleteWorkflowCas(SHIPPED_ID, 1);
  assert.equal(removed.ok, false);
  if (!removed.ok) {
    assert.equal(removed.reason, "builtin");
    assert.equal(removed.current?.id, SHIPPED_ID);
  }

  // Nothing above wrote a row, so the catalog is exactly what it was.
  assert.deepEqual(store.listWorkflows().map((workflow) => workflow.id), [SHIPPED_ID]);
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM workflow_versions`).get() as { n: number } | undefined
      ? Number((db.prepare(`SELECT COUNT(*) AS n FROM workflow_versions`).get() as { n: number }).n)
      : -1,
    0,
  );
});

test("renaming an operator workflow onto a built-in name is refused", () => {
  const store = fixtureStore();
  assert.equal(insert(store, "operator", "Mine").ok, true);
  const renamed = store.updateWorkflowCas("operator", 1, {
    name: "Fixture Review",
    normalizedName: normalizeWorkflowName("Fixture Review"),
  });
  assert.equal(renamed.ok, false);
  if (!renamed.ok) {
    assert.equal(renamed.reason, "name_conflict");
    assert.equal(renamed.current?.id, SHIPPED_ID);
  }
  // A rename that does not touch the name is still allowed.
  assert.equal(store.updateWorkflowCas("operator", 1, { description: "fine" }).ok, true);
});

test("a run bound to a built-in version resolves its workflow rather than reading as missing", () => {
  const store = fixtureStore();
  const versionId = builtinWorkflowVersionId("fixture-review", 1);
  store.insertPersona({
    id: "p1",
    name: "Judge",
    normalizedName: normalizePersonaName("Judge"),
    description: "",
    guidanceMarkdown: "# Judge",
    runner: null,
    model: null,
    createdAt: 1,
    updatedAt: 1,
  });
  const binding = store.insertBinding({
    id: "b1",
    workflowVersionId: versionId,
    noteKey: "note",
    sessionId: "s1",
    sessionAgent: "claude",
    sessionName: "session",
    sessionCwd: null,
    sessionRepoRoot: null,
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 5,
    now: 1,
  });
  store.createInitialSubmission(
    { id: "r1", binding, triggerSource: "manual", triggerKey: "k1", now: 2 },
    {
      id: "sub1",
      triggerSource: "manual",
      triggerKey: "k1",
      context: {},
      evidence: {},
      now: 2,
    },
  );

  // The run-summary query LEFT JOINs the version and definition rows, and a built-in owns
  // neither - so without the catalog fallback the shipped workflow's own runs would list
  // under "Missing workflow version".
  const summary = store.runSummary("r1");
  assert.equal(summary?.workflowId, SHIPPED_ID);
  assert.equal(summary?.workflowName, "Fixture Review");
  assert.equal(summary?.workflowVersion, 1);
  // And filtering run history by that workflow must find it, which the `d.id` join cannot.
  const page = store.listRunSummaryPage({ limit: 10, cursor: null, workflowId: SHIPPED_ID });
  assert.deepEqual(page.items.map((item) => item.id), ["r1"]);
});
