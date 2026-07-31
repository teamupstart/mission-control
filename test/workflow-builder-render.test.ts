import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WorkflowPage } from "../src/web/workflows/WorkflowPage.tsx";
import { WorkflowProperties } from "../src/web/workflows/WorkflowProperties.tsx";
import { WorkflowVersionDetail, WorkflowVersionHistory } from "../src/web/workflows/WorkflowVersionHistory.tsx";
import {
  nextWorkflowName,
  WORKFLOW_REMOVED_UNSAVED_ERROR,
  WorkflowLoadError,
  workflowLifecycleError,
  workflowSelectionAfterRemoval,
  workflowSelectionRestore,
} from "../src/web/workflows/WorkflowLibrary.tsx";
import { WorkflowApiError } from "../src/web/workflows/workflowApi.ts";
import {
  clearRequestedWorkflowVersion,
  readRequestedWorkflowVersion,
  requestWorkflowVersionOpen,
} from "../src/web/workflows/workflowSelection.ts";
import type { LlmState } from "../src/web/useLlm.ts";
import {
  WORKFLOW_LIMITS,
  type WorkflowDefinition,
  type WorkflowSummary,
  type WorkflowVersion,
} from "../src/shared/workflow.ts";

const llm: LlmState = { config: null, status: null, personaDefaults: null, error: null, update: async () => {} };
const workflow: WorkflowDefinition = {
  id: "w", name: "Release review", normalizedName: "release review", description: "",
  draft: { nodes: [{ id: "session", kind: "session", position: { x: 0, y: 0 } }, { id: "end", kind: "end", outcome: "Approved", position: { x: 300, y: 0 } }], edges: [] },
  completionPolicy: { kind: "inspector", onFindings: "restart_workflow", missingPrAction: "wait" },
  resumptionPolicy: "manual",
  bindingDefaults: { triggerMode: "foreman_complete", deliveryMode: "live", maxRepairRounds: 5 },
  draftRevision: 2, currentVersionId: null, archivedAt: null, createdAt: 1, updatedAt: 2,
  builtin: false,
};

test("empty workflow library is an active Phase 2 builder, not a future-feature shell", () => {
  const html = renderToStaticMarkup(createElement(WorkflowPage, {
    tab: "workflows", personas: [], workflowSummaries: [], llm,
    isOverlayOpen: () => false, onTab: () => {}, onDirtyChange: () => {},
  }));
  assert.match(html, /Build a review workflow/);
  assert.match(html, /New workflow/);
  assert.doesNotMatch(html, /arrives in Phase 2/);
});

test("policy controls and structured diagnostics render in the right pane", () => {
  const html = renderToStaticMarkup(createElement(WorkflowProperties, {
    workflow,
    personas: [],
    diagnostics: [{ code: "session_submitted_route", severity: "error", message: "Session needs one route", nodeId: "session" }],
    selection: null,
    readOnly: false,
    onUpdate: () => {},
    onConfirm: () => {},
  }));
  assert.match(html, /Default trigger/);
  assert.match(html, /Inspector approval/);
  assert.match(html, /Restart all Personas/);
  // Message first; the machine code survives as the detail affordance, not the headline.
  assert.match(html, /Session needs one route/);
  assert.match(html, /class="workflow-diagnostic-code"[^>]*>session_submitted_route/);
  assert.ok(
    html.indexOf("Session needs one route") < html.indexOf("session_submitted_route"),
    "the sentence has to come before the code, or the panel still reads like a compiler",
  );
  // Internal plan-phase labels were left on shipped options and read as warnings not to
  // pick a mode that has been live for four phases.
  assert.doesNotMatch(html, /Phase \d/);
});

test("version history names immutable source revisions and never offers update-version mutation", () => {
  const version: WorkflowVersion = {
    id: "v", workflowId: "w", version: 1, sourceDraftRevision: 2,
    graph: { nodes: [{ id: "session", kind: "session", position: { x: 0, y: 0 } }, { id: "end", kind: "end", outcome: "Approved", position: { x: 300, y: 0 } }], edges: [] },
    completionPolicy: { kind: "inspector", onFindings: "inspector_only", missingPrAction: "offer_prepare_pr" },
    resumptionPolicy: "manual",
    bindingDefaults: workflow.bindingDefaults,
    publishedAt: 3,
  };
  const { graph: _graph, ...metadata } = version;
  const html = renderToStaticMarkup(createElement(WorkflowVersionHistory, { versions: [metadata], personas: [] }));
  assert.match(html, /Version 1/);
  assert.match(html, /Draft r2/);
  assert.doesNotMatch(html, /Update version/);
  const detail = renderToStaticMarkup(createElement(WorkflowVersionDetail, { version, personas: [] }));
  assert.match(detail, /Maximum repair rounds/);
  assert.match(detail, />5</);
  assert.match(detail, /inspector_only/);
  assert.match(detail, /offer_prepare_pr/);
  assert.doesNotMatch(detail, /Bind this version/);
  const bindableDetail = renderToStaticMarkup(createElement(WorkflowVersionDetail, {
    version,
    personas: [],
    onBindVersion: () => {},
  }));
  assert.match(bindableDetail, /Bind this version/);
  const source = readFileSync(fileURLToPath(new URL("../src/web/workflows/WorkflowLibrary.tsx", import.meta.url)), "utf8");
  assert.match(source, /onBindVersion=\{workflow\.archivedAt === null \? onBindVersion : undefined\}/);
  // BOTH doors into the bind flow, not just the one. Version history was gated first and the
  // pipeline-mode button was left open, so an archived workflow still offered a bind whose
  // only ending is the server's 409. A gate on one of two entry points is not a gate.
  assert.match(source, /mode === "pipeline" && onBindWorkflow && workflow\.archivedAt === null &&/);
});

test("autosave conflict recovery offers reload and duplicate without overwriting", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/web/workflows/WorkflowLibrary.tsx", import.meta.url)), "utf8");
  assert.match(source, /Autosave is paused/);
  assert.match(source, /Reload latest/);
  assert.match(source, /Duplicate my draft/);
  assert.match(source, /if \(!\(await draft\.saveNow\(\)\)\) return;/);
  assert.match(source, /if \(!draft\.conflict && !\(await draft\.saveNow\(\)\)\) return;/);
});

/** The exact `<button …>` whose text is `label`, so an attribute assertion cannot drift onto a neighbour. */
function buttonFor(source: string, label: string): string {
  const end = source.indexOf(`>${label}</button>`);
  assert.notEqual(end, -1, `no ${label} button in WorkflowLibrary`);
  const start = source.lastIndexOf("<button", end);
  assert.notEqual(start, -1, `${label} button has no opening tag`);
  return source.slice(start, end);
}

test("workflow transitions lock every editor surface until the latest draft is durable", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/web/workflows/WorkflowLibrary.tsx", import.meta.url)), "utf8");
  assert.match(source, /transitionRef\.current = true/);
  assert.match(source, /await runTransition\(async \(\) => \{[\s\S]*await draft\.saveNow\(\)/);
  // One shared `readOnly`, reaching all four editing surfaces: the pipeline, the canvas and
  // both properties rails. Four hand-written copies is how one of them keeps accepting edits.
  assert.match(source, /const readOnly = !workflow \|\| workflow\.archivedAt !== null \|\| workflow\.builtin;/);
  assert.equal(source.match(/readOnly=\{transitioning \|\| readOnly\}/g)?.length, 4);
  // Every lifecycle control stands down mid-transition. Archived-ness is NOT among their
  // disabled conditions any more: since Restore arrived, an archived workflow swaps Archive
  // out for Restore instead of showing a dead Archive button, so that half of the old guard
  // lives in the render branch asserted below. Archive spells the same guard through
  // `workflowArchiveBlocked`, which is the one control that also has to refuse a built-in.
  for (const label of ["Delete", "Restore"]) {
    assert.match(buttonFor(source, label), /disabled=\{transitioning\}/, `${label} ignores transitioning`);
  }
  assert.match(
    buttonFor(source, "Archive"),
    /disabled=\{workflowArchiveBlocked\(\{ transitioning, archived: false, builtin: workflow\.builtin \}\)\}/,
  );
  assert.match(source, /workflow\.archivedAt === null \? \(/);
});

test("delete is offered only before the first publish, and restore only when archived", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/web/workflows/WorkflowLibrary.tsx", import.meta.url)), "utf8");
  // The browser mirrors the daemon's `published` refusal so the operator never reaches a 409
  // that only tells them what they cannot do.
  // BOTH halves, matching the store's own guard. `versions` is a second request that is `[]`
  // while in flight, so the list alone offered Delete on a published workflow until it landed.
  // `currentVersionId` arrives with the workflow detail, which is what makes this right on
  // first paint rather than one round trip later.
  assert.match(source, /workflow\?\.currentVersionId === null/);
  assert.match(source, /&& draft\.versions\.length === 0;/);
  assert.match(source, /\{neverPublished && \(/);
  // Delete is a POST to its own path: reusing `DELETE /api/workflows/:id` would make the
  // destructive path reachable by any client that still means "archive" by that verb.
  assert.match(source, /\/delete`, \{ method: "POST"/);
  assert.match(source, /\/unarchive`, \{ method: "POST"/);
  // Archive keeps its confirmation and so does Delete; Restore destroys nothing and has none.
  assert.match(source, /title: "Delete workflow"/);
  assert.match(source, /cannot be undone/);
  assert.doesNotMatch(buttonFor(source, "Restore"), /setConfirm/);
});

test("archive copy states the active-binding block, not just what survives", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/web/workflows/WorkflowLibrary.tsx", import.meta.url)), "utf8");
  // `archiveWorkflowCas` refuses with `active_binding`, so an archive is not something the
  // operator can always complete. All three archive strings are read independently - a
  // hovered tooltip, the dialog body, the confirm button's own tooltip - so each has to carry
  // the block as well as the reassurance. These said only "published versions stay readable",
  // which promised continuity for runs in a case the guard never permits.
  const archiveCopy = [
    /"Archive this workflow - blocked while a binding is active; published versions stay readable"/,
    /body: `Archive \$\{workflow\.name\}\? Archiving is blocked while any binding is still active\./,
    /confirmHint: "Archives the workflow unless a binding is still active - its published versions stay readable"/,
  ];
  for (const pattern of archiveCopy) assert.match(source, pattern);
  // The retired wording, which the daemon has never been able to honour.
  assert.doesNotMatch(source, /runs already bound to them keep working/);
});

test("generated create and duplicate names honor normalized durable uniqueness", () => {
  const summaries: WorkflowSummary[] = [
    { id: "1", name: "Ｕｎｔｉｔｌｅｄ   Workflow", description: "", draftRevision: 1, currentVersionId: null, publishedVersion: null, archivedAt: null, updatedAt: 1, errorCount: 0, warningCount: 0, nodeCount: 2, personaCount: 0, builtin: false },
    { id: "2", name: "Review COPY", description: "", draftRevision: 1, currentVersionId: null, publishedVersion: null, archivedAt: 2, updatedAt: 2, errorCount: 0, warningCount: 0, nodeCount: 2, personaCount: 0, builtin: false },
  ];
  assert.equal(nextWorkflowName("Untitled workflow", summaries), "Untitled workflow 2");
  assert.equal(nextWorkflowName("Review copy", summaries), "Review copy 2");

  const maximum = "x".repeat(WORKFLOW_LIMITS.workflowName);
  const firstCopy = nextWorkflowName(maximum, summaries, " copy");
  assert.equal(firstCopy.length, WORKFLOW_LIMITS.workflowName);
  assert.match(firstCopy, / copy$/);
  const copySummary: WorkflowSummary = { ...summaries[0]!, id: "3", name: firstCopy };
  const secondCopy = nextWorkflowName(maximum, [...summaries, copySummary], " copy");
  assert.equal(secondCopy.length, WORKFLOW_LIMITS.workflowName);
  assert.match(secondCopy, / copy 2$/);
});

test("top-bar workflow navigation opens the builder tab", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/web/App.tsx", import.meta.url)), "utf8");
  assert.match(source, /route\.page === "fleet"[\s\S]*\{ page: "workflows", tab: "workflows" \}/);
});

test("workflow detail load failures remain visible without a loaded workflow", () => {
  const html = renderToStaticMarkup(createElement(WorkflowLoadError, {
    error: "Could not load workflow",
    canRetry: true,
    onRetry: () => {},
  }));
  assert.match(html, /role="alert"/);
  assert.match(html, /Could not load workflow/);
  assert.match(html, /Retry/);
});

test("workflow removal reconciles only a previously observed selected summary", () => {
  const active = [{
    id: "workflow-1", name: "Review", description: "", draftRevision: 1,
    currentVersionId: null, publishedVersion: null, archivedAt: null, updatedAt: 1,
    errorCount: 0, warningCount: 0, nodeCount: 2, personaCount: 0, builtin: false,
  }];
  const archived = { ...active[0]!, id: "workflow-archived", archivedAt: 2 };
  const observed = new Set(["workflow-removed"]);

  assert.equal(
    workflowSelectionAfterRemoval(false, "workflow-removed", [], observed),
    undefined,
  );
  assert.equal(
    workflowSelectionAfterRemoval(true, "workflow-removed", [], new Set()),
    undefined,
  );
  assert.equal(
    workflowSelectionAfterRemoval(
      true,
      "workflow-archived",
      [...active, archived],
      new Set(["workflow-archived"]),
    ),
    undefined,
  );
  assert.equal(
    workflowSelectionAfterRemoval(true, "workflow-removed", active, observed),
    "workflow-1",
  );
  assert.equal(
    workflowSelectionAfterRemoval(true, "workflow-removed", active, observed, true),
    undefined,
  );
  assert.equal(
    workflowSelectionAfterRemoval(true, "workflow-removed", [], observed),
    null,
  );
});

test("leaving a tombstoned dirty draft takes an explicit discard", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/web/workflows/WorkflowLibrary.tsx", import.meta.url)), "utf8");
  // The banner tells the operator to copy what they need before selecting another workflow or
  // creating one. Both paths correctly skip the usual saveNow() guard, because the workflow is
  // gone and a save can only fail - and that is exactly why nothing else stood between a stray
  // click on the list and the draft being dropped. An instruction the UI does not enforce is
  // not a warning, it is a caption on data loss.
  assert.match(source, /Copy anything you need before selecting another workflow or creating a new one/);
  assert.match(source, /if \(!selectedWorkflowRemoved \|\| !draft\.dirty\) return false;/);
  // Both doors, not one. Each returns early when the confirmation takes over.
  assert.match(source, /if \(requireTombstoneDiscard\(\(\) => void selectNow\(id\)\)\) return;/);
  assert.match(source, /if \(requireTombstoneDiscard\(\(\) => void createNow\(\)\)\) return;/);
  // A confirmation, not a block: refusing to navigate would strand the operator on a
  // workflow that no longer exists.
  assert.match(source, /confirmLabel: "Discard and continue"/);
});

test("workflow lifecycle refusals use the existing load error surface", () => {
  const refusal = (code: string) => new WorkflowApiError("request refused", 409, { code });

  assert.match(workflowLifecycleError(refusal("workflow_published")), /already been published/);
  assert.match(workflowLifecycleError(refusal("workflow_not_archived")), /already restored/);
  assert.match(workflowLifecycleError(refusal("workflow_revision_conflict")), /changed in another tab/);
  assert.equal(workflowLifecycleError(new Error("network unavailable")), "network unavailable");
  assert.match(WORKFLOW_REMOVED_UNSAVED_ERROR, /deleted elsewhere/);
  assert.match(WORKFLOW_REMOVED_UNSAVED_ERROR, /unsaved changes cannot be saved/);
  assert.doesNotMatch(WORKFLOW_REMOVED_UNSAVED_ERROR, /retry|reload/i);

  const source = readFileSync(fileURLToPath(new URL("../src/web/workflows/WorkflowLibrary.tsx", import.meta.url)), "utf8");
  assert.match(source, /catch \(caught\) \{\s*draft\.showError\(workflowLifecycleError\(caught\)\)/);
  assert.match(source, /draft\.dirty \|\| draft\.saving/);
  assert.match(source, /draft\.showError\(workflowLifecycleError\(new Error\(WORKFLOW_REMOVED_UNSAVED_ERROR\)\)\)/);
});

test("last workflow restoration excludes archived history unless a version link requested it", () => {
  const active = [{
    id: "workflow-1", name: "Review", description: "", draftRevision: 1,
    currentVersionId: null, publishedVersion: null, archivedAt: null, updatedAt: 1,
    errorCount: 0, warningCount: 0, nodeCount: 2, personaCount: 0, builtin: false,
  }];
  const archived = { ...active[0]!, id: "workflow-archived", archivedAt: 2 };
  assert.equal(workflowSelectionRestore(false, null, active, "workflow-1"), "workflow-1");
  assert.equal(workflowSelectionRestore(true, null, active, "workflow-1"), undefined);
  assert.equal(
    workflowSelectionRestore(false, null, active, "workflow-archived", [...active, archived]),
    "workflow-1",
  );
  assert.equal(
    workflowSelectionRestore(
      false,
      null,
      active,
      "workflow-archived",
      [...active, archived],
      "workflow-archived",
    ),
    "workflow-archived",
  );
});

test("Open version carries one bounded request across the Runs-to-builder route", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const priorLocal = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const priorSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });
  try {
    requestWorkflowVersionOpen("workflow-1", 7);
    assert.equal(readRequestedWorkflowVersion("workflow-1"), 7);
    assert.equal(readRequestedWorkflowVersion("another-workflow"), null);
    clearRequestedWorkflowVersion();
    assert.equal(readRequestedWorkflowVersion("workflow-1"), null);
  } finally {
    if (priorLocal) Object.defineProperty(globalThis, "localStorage", priorLocal);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
    if (priorSession) Object.defineProperty(globalThis, "sessionStorage", priorSession);
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  }
});
