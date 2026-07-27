import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkflowPage } from "../src/web/workflows/WorkflowPage.tsx";
import { WorkflowProperties } from "../src/web/workflows/WorkflowProperties.tsx";
import { WorkflowVersionDetail, WorkflowVersionHistory } from "../src/web/workflows/WorkflowVersionHistory.tsx";
import {
  nextWorkflowName,
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

const require = createRequire(import.meta.url);

/**
 * Backstop for a hung browser, NOT an assertion about how fast one starts.
 *
 * These two cases launch a real Electron GUI, which is the only way to measure laid-out
 * geometry. That launch is cheap on Linux CI and expensive on a developer's Mac, where the
 * runner also keeps a second test file in flight: measured here, ~10s idle and past 40s under
 * that contention, against a former 20s deadline. The deadline firing produced a bare
 * ETIMEDOUT, which reads as the layout defect this test exists to catch rather than as a busy
 * machine. Keep it far above the honest cost - a real hang still fails, just later.
 */
const ELECTRON_TIMEOUT_MS = 120_000;

/** Run one Electron fixture in a throwaway profile and return its stdout. */
function runElectronFixture(args: string[]): string {
  const electron = require("electron") as string;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const userData = mkdtempSync(join(tmpdir(), "mission-workflow-browser-"));
  try {
    return execFileSync(electron, [
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      `--user-data-dir=${userData}`,
      ...args,
    ], { encoding: "utf8", env, timeout: ELECTRON_TIMEOUT_MS });
  } finally {
    rmSync(userData, { force: true, recursive: true });
  }
}

const llm: LlmState = { config: null, status: null, personaDefaults: null, error: null, update: async () => {} };
const workflow: WorkflowDefinition = {
  id: "w", name: "Release review", normalizedName: "release review", description: "",
  draft: { nodes: [{ id: "session", kind: "session", position: { x: 0, y: 0 } }, { id: "end", kind: "end", outcome: "Approved", position: { x: 300, y: 0 } }], edges: [] },
  completionPolicy: { kind: "inspector", onFindings: "restart_workflow", missingPrAction: "wait" },
  bindingDefaults: { triggerMode: "foreman_complete", deliveryMode: "live", maxRepairRounds: 5 },
  draftRevision: 2, currentVersionId: null, archivedAt: null, createdAt: 1, updatedAt: 2,
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
});

test("published workflow nodes stay within the visible React Flow graph", () => {
  const output = runElectronFixture([
    fileURLToPath(new URL("fixtures/workflow-graph-browser.cjs", import.meta.url)),
    fileURLToPath(new URL("../src/web/styles.css", import.meta.url)),
    require.resolve("@xyflow/react/dist/style.css"),
  ]);
  const { graph, root, nodes } = JSON.parse(output.trim()) as {
    graph: DOMRect;
    root: DOMRect;
    nodes: DOMRect[];
  };

  assert.ok(root.height > 0, "React Flow root must have a visible height");
  assert.ok(nodes.length > 0, "published graph must render nodes");
  for (const node of nodes) {
    assert.ok(node.top >= graph.top && node.bottom <= graph.bottom, "published node must remain inside the visible graph");
    assert.ok(node.top >= root.top && node.bottom <= root.bottom, "published node must remain inside the React Flow root");
  }
});

test("editable workflow canvas remains mounted with default node statuses", () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "mission-workflow-canvas-"));
  const bundlePath = join(fixtureDir, "canvas.js");
  const htmlPath = join(fixtureDir, "index.html");
  let output: string;
  try {
    execFileSync(require.resolve("esbuild/bin/esbuild"), [
      fileURLToPath(new URL("fixtures/workflow-canvas-mount.tsx", import.meta.url)),
      "--bundle",
      "--platform=browser",
      "--format=iife",
      `--outfile=${bundlePath}`,
    ], { encoding: "utf8" });
    writeFileSync(htmlPath, '<!doctype html><div id="root" style="width:800px;height:600px"></div><script src="./canvas.js"></script>');
    output = runElectronFixture([
      fileURLToPath(new URL("fixtures/workflow-canvas-mount-browser.cjs", import.meta.url)),
      htmlPath,
    ]);
  } finally {
    rmSync(fixtureDir, { force: true, recursive: true });
  }

  const result = JSON.parse(output.trim()) as {
    mounted: boolean;
    errors: string[];
    controls: string[];
    nativeTitles: number;
    attribution: boolean;
    maxZoomDisabled: boolean;
    maxZoomDescription: string;
    minZoomDisabled: boolean;
    minZoomDescription: string;
  };
  assert.deepEqual(result.errors, []);
  assert.equal(result.mounted, true);
  assert.deepEqual(result.controls, [
    "Zoom in",
    "Zoom out",
    "Fit the graph to view",
    "Reset canvas zoom",
  ]);
  assert.equal(result.nativeTitles, 0);
  assert.equal(result.attribution, true);
  assert.equal(result.maxZoomDisabled, true);
  assert.equal(result.maxZoomDescription, "Already at maximum zoom");
  assert.equal(result.minZoomDisabled, true);
  assert.equal(result.minZoomDescription, "Already at minimum zoom");
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
  assert.match(source, /readOnly=\{transitioning \|\| workflow\.archivedAt !== null\}/);
  // Every lifecycle control stands down mid-transition. Archived-ness is NOT among their
  // disabled conditions any more: since Restore arrived, an archived workflow swaps Archive
  // out for Restore instead of showing a dead Archive button, so that half of the old guard
  // lives in the render branch asserted below.
  for (const label of ["Delete", "Archive", "Restore"]) {
    assert.match(buttonFor(source, label), /disabled=\{transitioning\}/, `${label} ignores transitioning`);
  }
  assert.match(source, /workflow\.archivedAt === null \? \(/);
});

test("delete is offered only before the first publish, and restore only when archived", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/web/workflows/WorkflowLibrary.tsx", import.meta.url)), "utf8");
  // The browser mirrors the daemon's `published` refusal so the operator never reaches a 409
  // that only tells them what they cannot do.
  assert.match(source, /const neverPublished = Boolean\(workflow\) && draft\.versions\.length === 0;/);
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
    /label="Archive this workflow - blocked while a binding is active; published versions stay readable"/,
    /body: `Archive \$\{workflow\.name\}\? Archiving is blocked while any binding is still active\./,
    /confirmHint: "Archives the workflow unless a binding is still active - its published versions stay readable"/,
  ];
  for (const pattern of archiveCopy) assert.match(source, pattern);
  // The retired wording, which the daemon has never been able to honour.
  assert.doesNotMatch(source, /runs already bound to them keep working/);
});

test("generated create and duplicate names honor normalized durable uniqueness", () => {
  const summaries: WorkflowSummary[] = [
    { id: "1", name: "Ｕｎｔｉｔｌｅｄ   Workflow", description: "", draftRevision: 1, currentVersionId: null, publishedVersion: null, archivedAt: null, updatedAt: 1, errorCount: 0, warningCount: 0, nodeCount: 2, personaCount: 0 },
    { id: "2", name: "Review COPY", description: "", draftRevision: 1, currentVersionId: null, publishedVersion: null, archivedAt: 2, updatedAt: 2, errorCount: 0, warningCount: 0, nodeCount: 2, personaCount: 0 },
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
    errorCount: 0, warningCount: 0, nodeCount: 2, personaCount: 0,
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
    workflowSelectionAfterRemoval(true, "workflow-removed", [], observed),
    null,
  );
});

test("workflow lifecycle refusals use the existing load error surface", () => {
  const refusal = (code: string) => new WorkflowApiError("request refused", 409, { code });

  assert.match(workflowLifecycleError(refusal("workflow_published")), /already been published/);
  assert.match(workflowLifecycleError(refusal("workflow_not_archived")), /already restored/);
  assert.match(workflowLifecycleError(refusal("workflow_revision_conflict")), /changed in another tab/);
  assert.equal(workflowLifecycleError(new Error("network unavailable")), "network unavailable");

  const source = readFileSync(fileURLToPath(new URL("../src/web/workflows/WorkflowLibrary.tsx", import.meta.url)), "utf8");
  assert.match(source, /catch \(caught\) \{\s*draft\.showError\(workflowLifecycleError\(caught\)\)/);
});

test("last workflow restoration excludes archived history unless a version link requested it", () => {
  const active = [{
    id: "workflow-1", name: "Review", description: "", draftRevision: 1,
    currentVersionId: null, publishedVersion: null, archivedAt: null, updatedAt: 1,
    errorCount: 0, warningCount: 0, nodeCount: 2, personaCount: 0,
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
