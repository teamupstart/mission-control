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
  workflowSelectionRestore,
} from "../src/web/workflows/WorkflowLibrary.tsx";
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
  }));
  assert.match(html, /Default trigger/);
  assert.match(html, /Inspector approval \(Phase 5\)/);
  assert.match(html, /Restart all Personas/);
  assert.match(html, /session_submitted_route/);
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
  const require = createRequire(import.meta.url);
  const electron = require("electron") as string;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const userData = mkdtempSync(join(tmpdir(), "mission-workflow-browser-"));
  let output: string;
  try {
    output = execFileSync(electron, [
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      `--user-data-dir=${userData}`,
      fileURLToPath(new URL("fixtures/workflow-graph-browser.cjs", import.meta.url)),
      fileURLToPath(new URL("../src/web/styles.css", import.meta.url)),
      require.resolve("@xyflow/react/dist/style.css"),
    ], { encoding: "utf8", env, timeout: 20_000 });
  } finally {
    rmSync(userData, { force: true, recursive: true });
  }
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
  const require = createRequire(import.meta.url);
  const electron = require("electron") as string;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const fixtureDir = mkdtempSync(join(tmpdir(), "mission-workflow-canvas-"));
  const userData = mkdtempSync(join(tmpdir(), "mission-workflow-browser-"));
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
    output = execFileSync(electron, [
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      `--user-data-dir=${userData}`,
      fileURLToPath(new URL("fixtures/workflow-canvas-mount-browser.cjs", import.meta.url)),
      htmlPath,
    ], { encoding: "utf8", env, timeout: 20_000 });
  } finally {
    rmSync(fixtureDir, { force: true, recursive: true });
    rmSync(userData, { force: true, recursive: true });
  }

  const result = JSON.parse(output.trim()) as { mounted: boolean; errors: string[] };
  assert.deepEqual(result.errors, []);
  assert.equal(result.mounted, true);
});

test("autosave conflict recovery offers reload and duplicate without overwriting", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/web/workflows/WorkflowLibrary.tsx", import.meta.url)), "utf8");
  assert.match(source, /Autosave is paused/);
  assert.match(source, /Reload latest/);
  assert.match(source, /Duplicate my draft/);
  assert.match(source, /if \(!\(await draft\.saveNow\(\)\)\) return;/);
  assert.match(source, /if \(!draft\.conflict && !\(await draft\.saveNow\(\)\)\) return;/);
});

test("workflow transitions lock every editor surface until the latest draft is durable", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/web/workflows/WorkflowLibrary.tsx", import.meta.url)), "utf8");
  assert.match(source, /transitionRef\.current = true/);
  assert.match(source, /await runTransition\(async \(\) => \{[\s\S]*await draft\.saveNow\(\)/);
  assert.match(source, /readOnly=\{transitioning \|\| workflow\.archivedAt !== null\}/);
  assert.match(source, /disabled=\{transitioning \|\| workflow\.archivedAt !== null\}/);
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

test("last workflow restoration runs once and cannot reopen an archived selection", () => {
  const active = [{
    id: "workflow-1", name: "Review", description: "", draftRevision: 1,
    currentVersionId: null, publishedVersion: null, archivedAt: null, updatedAt: 1,
    errorCount: 0, warningCount: 0, nodeCount: 2, personaCount: 0,
  }];
  assert.equal(workflowSelectionRestore(false, null, active, "workflow-1"), "workflow-1");
  assert.equal(workflowSelectionRestore(true, null, active, "workflow-1"), undefined);
});
