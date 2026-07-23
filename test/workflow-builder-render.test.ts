import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WorkflowPage } from "../src/web/workflows/WorkflowPage.tsx";
import { WorkflowProperties } from "../src/web/workflows/WorkflowProperties.tsx";
import { WorkflowVersionHistory } from "../src/web/workflows/WorkflowVersionHistory.tsx";
import type { LlmState } from "../src/web/useLlm.ts";
import type { WorkflowDefinition, WorkflowVersion } from "../src/shared/workflow.ts";

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
    completionPolicy: { kind: "none" },
    bindingDefaults: workflow.bindingDefaults,
    publishedAt: 3,
  };
  const html = renderToStaticMarkup(createElement(WorkflowVersionHistory, { versions: [version], personas: [] }));
  assert.match(html, /Version 1/);
  assert.match(html, /Draft r2/);
  assert.doesNotMatch(html, /Update version/);
});

test("autosave conflict recovery offers reload and duplicate without overwriting", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/web/workflows/WorkflowLibrary.tsx", import.meta.url)), "utf8");
  assert.match(source, /Autosave is paused/);
  assert.match(source, /Reload latest/);
  assert.match(source, /Duplicate my draft/);
});
