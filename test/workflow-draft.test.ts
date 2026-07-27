import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { WorkflowDefinition } from "../src/shared/workflow.ts";
import {
  editableFingerprint,
  restoreWorkflowEditableSnapshot,
  reconcileWorkflowSave,
  workflowEditableSnapshot,
  workflowDraftLoading,
  workflowPublishMetadataChanged,
  workflowPublishBlocked,
  workflowSavePreflight,
  workflowSummaryAction,
} from "../src/web/workflows/useWorkflowDraft.ts";
import type { WorkflowSummary } from "../src/shared/workflow.ts";

const workflow = (description: string, revision = 1): WorkflowDefinition => ({
  id: "w", name: "Review", normalizedName: "review", description,
  draft: { nodes: [{ id: "session", kind: "session", position: { x: 0, y: 0 } }, { id: "end", kind: "end", outcome: "Complete", position: { x: 300, y: 0 } }], edges: [] },
  completionPolicy: { kind: "none" },
  bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 },
  draftRevision: revision, currentVersionId: null, archivedAt: null, createdAt: 1, updatedAt: revision, builtin: false,
});

test("save reconciliation preserves edits made while the request is in flight", () => {
  const submitted = workflow("first");
  const concurrentlyEdited = workflow("typed while saving");
  const stored = { ...workflow("first", 2), currentVersionId: "v1" };
  const reconciled = reconcileWorkflowSave(concurrentlyEdited, editableFingerprint(submitted), stored);
  assert.equal(reconciled.description, "typed while saving");
  assert.equal(reconciled.draftRevision, 2);
  assert.equal(reconciled.currentVersionId, "v1");
  assert.equal(workflowPublishMetadataChanged(submitted, stored), true);
  assert.equal(
    workflowSavePreflight(reconciled, null, editableFingerprint(submitted)),
    "save",
    "the flush must persist an edit that arrived during the first PATCH",
  );
});

test("undo snapshots preserve the newest server CAS metadata after autosave", () => {
  const original = workflow("before", 1);
  const snapshot = workflowEditableSnapshot(original);
  const stored = { ...workflow("after", 2), currentVersionId: "v1", updatedAt: 20 };
  const restored = restoreWorkflowEditableSnapshot(stored, snapshot);
  assert.equal(restored.description, "before");
  assert.equal(restored.draftRevision, 2);
  assert.equal(restored.currentVersionId, "v1");
  assert.equal(restored.updatedAt, 20);
});

test("Publish guards cover dirty, saving, conflict, invalid, duplicate-revision, archive, and built-in states", () => {
  // The loop below folds over every key, so a guard added to the input is covered by adding
  // it here and nowhere else - which is what stops a new refusal from shipping untested.
  const ready = { dirty: false, saving: false, conflicted: false, valid: true, alreadyPublished: false, archived: false, builtin: false };
  assert.equal(workflowPublishBlocked(ready), false);
  for (const field of Object.keys(ready) as Array<keyof typeof ready>) {
    if (field === "valid") assert.equal(workflowPublishBlocked({ ...ready, valid: false }), true);
    else assert.equal(workflowPublishBlocked({ ...ready, [field]: true }), true);
  }
});

test("autosave is debounced and one in-flight Promise owns concurrent callers", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/web/workflows/useWorkflowDraft.ts", import.meta.url)), "utf8");
  assert.match(source, /window\.setTimeout\(\(\) => void saveNow\(\), 500\)/);
  assert.match(source, /if \(inFlight\.current\) return inFlight\.current/);
  assert.match(source, /while \(true\)[\s\S]*workflowSavePreflight/);
  assert.match(source, /loadGeneration\.current !== generation/);
  assert.match(source, /workflow\?\.id === workflowId/);
  assert.match(source, /\/api\/workflows\/\$\{requestedId\}\/versions/);
});

test("a completed failed detail load is retryable instead of permanently loading", () => {
  const input = { workflowId: "w", workflow: null, error: null, loading: false };
  assert.equal(workflowDraftLoading(input), true);
  assert.equal(workflowDraftLoading({ ...input, error: "Could not load workflow" }), false);
  assert.equal(workflowDraftLoading({ ...input, error: "Could not load workflow", loading: true }), true);
  assert.equal(workflowDraftLoading({ ...input, workflowId: null }), false);
});

const summary = (revision: number, currentVersionId: string | null = null): WorkflowSummary => ({
  id: "w", name: "Review", description: "", draftRevision: revision,
  currentVersionId, publishedVersion: currentVersionId ? 1 : null, archivedAt: null,
  updatedAt: revision, errorCount: 0, warningCount: 0, nodeCount: 2, personaCount: 0, builtin: false,
});

test("a conflict blocks every save-backed workflow transition", () => {
  assert.equal(workflowSavePreflight(workflow("local"), summary(2), editableFingerprint(workflow("saved"))), "blocked");
});

test("stream reconciliation ignores an owned in-flight save and conflicts only after a newer revision wins", () => {
  assert.equal(workflowSummaryAction({ local: workflow("local"), summary: summary(2), dirty: true, saving: true }), "ignore");
  assert.equal(workflowSummaryAction({ local: workflow("local"), summary: summary(2), dirty: true, saving: false }), "conflict");
  assert.equal(workflowSummaryAction({ local: workflow("saved", 2), summary: summary(2), dirty: false, saving: false }), "ignore");
});

test("same-revision publish metadata reloads a clean editor", () => {
  const local = workflow("saved", 2);
  assert.equal(workflowSummaryAction({ local, summary: { ...summary(2, "v1"), updatedAt: 3 }, dirty: false, saving: false }), "reload");
  assert.equal(workflowSummaryAction({ local, summary: { ...summary(2, "v1"), updatedAt: 3 }, dirty: true, saving: false }), "ignore");
});
