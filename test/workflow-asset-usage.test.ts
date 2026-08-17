import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  WorkflowDraftGraph,
  WorkflowSummary,
} from "../src/shared/workflow.ts";

/**
 * What is at stake: the browser must answer which workflows use one Library asset without
 * downloading every graph, while keeping draft, published and in-flight truth distinct.
 * These are the daemon's five required projection boundaries plus the exact live-id seam.
 */

const home = mkdtempSync(join(tmpdir(), "mission-workflow-asset-usage-"));
process.env.HARNESS_HOME = join(home, "state");

const { NO_MISTAKES_REVIEW_WORKFLOW_ID } = await import("../src/shared/builtin-workflow.ts");
const {
  normalizePersonaName,
  normalizeWorkflowName,
  personaSnapshotOf,
  sessionActionSnapshotOf,
  WORKFLOW_LIMITS,
} = await import("../src/shared/workflow.ts");
const { openDb } = await import("../src/server/db.ts");
const { WorkflowStore, clearWorkflowTables } =
  await import("../src/server/workflows/store.ts");

const db = openDb();
const store = new WorkflowStore(db);
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearWorkflowTables(db));

function seedAssets(): void {
  for (const id of ["persona-draft", "persona-published", "persona-both"]) {
    const created = store.insertPersona({
      id,
      name: id,
      normalizedName: normalizePersonaName(id),
      description: "",
      guidanceMarkdown: `# ${id}\n`,
      runner: null,
      model: null,
      createdAt: 1,
      updatedAt: 1,
    });
    assert.equal(created.ok, true);
  }
  for (const id of ["action-draft", "action-published", "action-both"]) {
    const created = store.insertSessionAction({
      id,
      name: id,
      normalizedName: id,
      description: "",
      promptMarkdown: `# ${id}\n`,
      requiredSkillId: null,
      completion: { kind: "session_turn" },
      createdAt: 1,
      updatedAt: 1,
    });
    assert.equal(created.ok, true);
  }
}

function graph(personaId: string, sessionActionId: string): WorkflowDraftGraph {
  return {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "persona", kind: "persona", personaId, position: { x: 200, y: 0 } },
      { id: "action", kind: "session_action", sessionActionId, position: { x: 400, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 600, y: 0 } },
    ],
    edges: [
      { id: "start", source: "session", sourcePort: "submitted", target: "persona", targetPort: "activate" },
      { id: "pass", source: "persona", sourcePort: "pass", target: "action", targetPort: "activate" },
      { id: "fail", source: "persona", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
      { id: "complete", source: "action", sourcePort: "complete", target: "end", targetPort: "terminal" },
    ],
  };
}

function insertWorkflow(
  id: string,
  personaId: string,
  sessionActionId: string,
): void {
  const created = store.insertWorkflow({
    id,
    name: id,
    normalizedName: normalizeWorkflowName(id),
    description: "",
    draft: graph(personaId, sessionActionId),
    completionPolicy: { kind: "none" },
    resumptionPolicy: "manual",
    bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 },
    createdAt: 1,
    updatedAt: 1,
  });
  assert.equal(created.ok, true);
}

function summary(id: string): WorkflowSummary {
  const workflow = store.getWorkflow(id);
  assert.ok(workflow);
  return store.summary(workflow);
}

test("a draft-only reference is projected separately from an absent published graph", () => {
  seedAssets();
  insertWorkflow("draft only", "persona-draft", "action-draft");
  assert.deepEqual(summary("draft only").assetReferences, {
    draft: { personaIds: ["persona-draft"], sessionActionIds: ["action-draft"] },
    published: null,
  });
});

test("a published-only reference stays projected after the draft moves to other assets", () => {
  seedAssets();
  insertWorkflow("published only", "persona-published", "action-published");
  assert.equal(store.publishWorkflow("published only", 1, "version-1", 2).ok, true);
  const updated = store.updateWorkflowCas(
    "published only",
    1,
    { draft: graph("persona-draft", "action-draft") },
    3,
  );
  assert.equal(updated.ok, true);
  assert.deepEqual(summary("published only").assetReferences, {
    draft: { personaIds: ["persona-draft"], sessionActionIds: ["action-draft"] },
    published: {
      personaIds: ["persona-published"],
      sessionActionIds: ["action-published"],
    },
  });
});

test("one asset referenced by both graphs is reported in both rather than merged", () => {
  seedAssets();
  insertWorkflow("both", "persona-both", "action-both");
  assert.equal(store.publishWorkflow("both", 1, "version-both", 2).ok, true);
  assert.deepEqual(summary("both").assetReferences, {
    draft: { personaIds: ["persona-both"], sessionActionIds: ["action-both"] },
    published: { personaIds: ["persona-both"], sessionActionIds: ["action-both"] },
  });
});

test("the built-in workflow projects ids from its catalog graphs", () => {
  const builtIn = summary(NO_MISTAKES_REVIEW_WORKFLOW_ID);
  assert.equal(builtIn.builtin, true);
  assert.ok(builtIn.assetReferences);
  assert.ok(builtIn.assetReferences.draft.personaIds.length > 0);
  assert.ok(builtIn.assetReferences.draft.sessionActionIds.length > 0);
  assert.deepEqual(builtIn.assetReferences.draft, builtIn.assetReferences.published);
});

test("an archived workflow retains its references in the SSE superset", () => {
  seedAssets();
  insertWorkflow("archived", "persona-both", "action-both");
  assert.equal(store.archiveWorkflowCas("archived", 1, 2).ok, true);
  const archived = store.listWorkflows(true).find((workflow) => workflow.id === "archived");
  assert.ok(archived);
  const projected = store.summary(archived);
  assert.equal(projected.archivedAt, 2);
  assert.deepEqual(projected.assetReferences?.draft, {
    personaIds: ["persona-both"],
    sessionActionIds: ["action-both"],
  });
});

test("a run summary carries exact active Persona and Action ids from immutable attempts", () => {
  seedAssets();
  insertWorkflow("live", "persona-both", "action-both");
  const published = store.publishWorkflow("live", 1, "version-live", 2);
  assert.equal(published.ok, true);
  if (!published.ok) return;
  const binding = store.insertBinding({
    id: "binding-live",
    workflowVersionId: published.version.id,
    noteKey: "note-live",
    sessionId: "session-live",
    sessionAgent: "claude",
    sessionName: "Live work",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 5,
    now: 3,
  });
  store.createInitialSubmission(
    { id: "run-live", binding, triggerSource: "manual", triggerKey: "manual:live", now: 4 },
    { id: "submission-live", triggerSource: "manual", triggerKey: "manual:live", context: {}, evidence: {}, now: 4 },
  );
  const persona = store.getPersona("persona-both");
  const action = store.getSessionAction("action-both");
  assert.ok(persona && action);
  store.insertAttempt({
    id: "attempt-persona",
    submissionId: "submission-live",
    nodeId: "persona",
    attempt: 1,
    state: "running",
    persona: personaSnapshotOf(persona),
    inputFingerprint: "persona-live",
    now: 5,
  });
  store.insertAttempt({
    id: "attempt-action",
    submissionId: "submission-live",
    nodeId: "action",
    attempt: 1,
    state: "waiting",
    persona: null,
    sessionAction: sessionActionSnapshotOf(action),
    sessionActionState: {
      wait: "working",
      deliveryId: null,
      anchor: null,
      pickedUpAt: null,
      settledAt: null,
      expectation: null,
      continuationSubmissionId: null,
      blocked: null,
    },
    inputFingerprint: "action-live",
    now: 5,
  });
  store.setRunState("run-live", "waiting_for_action", "session_action", null, 6);

  const run = store.runSummary("run-live");
  assert.deepEqual(run?.activePersonaIds, ["persona-both"]);
  assert.deepEqual(run?.activeSessionActionIds, ["action-both"]);
  assert.deepEqual(run?.activePersonaNames, ["persona-both"]);
  assert.equal(run?.actionWait, "working");
});

test("the summary projection stays bounded by two graph node ceilings", () => {
  const oldDaemonShape: WorkflowSummary = {
    id: "old",
    name: "Old",
    description: "",
    draftRevision: 1,
    currentVersionId: null,
    publishedVersion: null,
    archivedAt: null,
    updatedAt: 1,
    errorCount: 0,
    warningCount: 0,
    nodeCount: 0,
    personaCount: 0,
    builtin: false,
  };
  assert.equal(oldDaemonShape.assetReferences, undefined, "the new field remains optional");

  // One graph can contribute at most one projected id per node, and a summary carries two
  // graphs. This is the payload bound the type's comment promises, independent of workflow
  // count and without admitting graph JSON or asset content.
  const maxProjectedIds = WORKFLOW_LIMITS.graphNodes * 2;
  const references = summary(NO_MISTAKES_REVIEW_WORKFLOW_ID).assetReferences!;
  const projectedIds = references.draft.personaIds.length
    + references.draft.sessionActionIds.length
    + (references.published?.personaIds.length ?? 0)
    + (references.published?.sessionActionIds.length ?? 0);
  assert.ok(projectedIds <= maxProjectedIds);
});
