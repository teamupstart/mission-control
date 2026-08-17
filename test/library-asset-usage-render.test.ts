import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  WorkflowRunSummary,
  WorkflowSummary,
} from "../src/shared/workflow.ts";
import {
  LibraryAssetUsage,
  libraryAssetUsageView,
} from "../src/web/library/LibraryAssetUsage.tsx";

const workflow = (
  id: string,
  name: string,
  patch: Partial<WorkflowSummary> = {},
): WorkflowSummary => ({
  id,
  name,
  description: "",
  draftRevision: 2,
  currentVersionId: `${id}-v3`,
  publishedVersion: 3,
  archivedAt: null,
  updatedAt: 1,
  errorCount: 0,
  warningCount: 0,
  nodeCount: 4,
  personaCount: 1,
  builtin: false,
  assetReferences: {
    draft: { personaIds: [], sessionActionIds: [] },
    published: { personaIds: [], sessionActionIds: [] },
  },
  ...patch,
});

const run = (
  id: string,
  workflowId: string,
  patch: Partial<WorkflowRunSummary> = {},
): WorkflowRunSummary => ({
  id,
  bindingId: `${id}-binding`,
  workflowId,
  workflowName: `Run ${workflowId}`,
  workflowVersion: 1,
  sessionId: "session",
  noteKey: "note",
  status: "running",
  phase: "persona_review",
  round: 1,
  actionWait: null,
  maxRepairRounds: 5,
  activePersonaNames: [],
  activePersonaIds: [],
  activeSessionActionIds: [],
  failedPersonaCount: 0,
  bypassedPersonaReview: false,
  gate: "none",
  gatePrNumber: null,
  gateHeadShort: null,
  reviewPosture: null,
  updatedAt: 1,
  ...patch,
});

function render(
  workflows: WorkflowSummary[],
  runs: WorkflowRunSummary[] = [],
  asset: { kind: "persona" | "session_action"; id: string } = {
    kind: "persona",
    id: "persona-1",
  },
): string {
  return renderToStaticMarkup(createElement(LibraryAssetUsage, {
    asset,
    assetLabel: asset.kind === "persona" ? "Persona" : "Action",
    workflows,
    runs,
    hasSnapshot: true,
  }));
}

test("no references render the honest empty state", () => {
  const html = render([workflow("one", "One")]);
  assert.match(html, /<h3>Used by<\/h3>/);
  assert.match(html, /No workflows use this Persona/);
  assert.doesNotMatch(html, /gating now/);
});

test("several workflows are named, linked and labeled by draft and published truth", () => {
  const html = render([
    workflow("both", "Both graphs", {
      assetReferences: {
        draft: { personaIds: ["persona-1"], sessionActionIds: [] },
        published: { personaIds: ["persona-1"], sessionActionIds: [] },
      },
    }),
    workflow("draft", "Draft graph", {
      currentVersionId: null,
      publishedVersion: null,
      assetReferences: {
        draft: { personaIds: ["persona-1"], sessionActionIds: [] },
        published: null,
      },
    }),
    workflow("other", "Other asset"),
  ]);
  assert.match(html, /href="#\/library\/workflows\/both"[^>]*>Both graphs<\/a>/);
  assert.match(html, /Both graphs[\s\S]*>Draft<[\s\S]*>Published v3</);
  assert.match(html, /href="#\/library\/workflows\/draft"[^>]*>Draft graph<\/a>/);
  assert.doesNotMatch(html, /Other asset/);
});

test("an exact active id renders live gating and links to the live run", () => {
  const target = workflow("review", "Review", {
    assetReferences: {
      draft: { personaIds: ["persona-1"], sessionActionIds: [] },
      published: { personaIds: ["persona-1"], sessionActionIds: [] },
    },
  });
  const html = render([target], [run("run-1", "review", {
    activePersonaNames: ["Shadowed name"],
    activePersonaIds: ["persona-1"],
  })]);
  assert.match(html, /role="status"[^>]*>[\s\S]*1 run is gating now/);
  assert.match(html, /href="#\/runs\/run-1"[^>]*>1 run gating now<\/a>/);
});

test("an Action uses the same footer and only gates on its exact waiting attempt", () => {
  const target = workflow("ship", "Ship", {
    assetReferences: {
      draft: { personaIds: [], sessionActionIds: ["action-1"] },
      published: { personaIds: [], sessionActionIds: ["action-1"] },
    },
  });
  const waiting = run("run-action", "ship", {
    status: "waiting_for_action",
    phase: "session_action",
    actionWait: "working",
    activeSessionActionIds: ["action-1"],
  });
  assert.match(render(
    [target],
    [waiting],
    { kind: "session_action", id: "action-1" },
  ), /1 run is gating now/);
  assert.doesNotMatch(render(
    [target],
    [{ ...waiting, status: "running" }],
    { kind: "session_action", id: "action-1" },
  ), /gating now/);
});

test("an unresolvable live workflow is omitted with a count, never guessed from its name", () => {
  const missing = run("missing-run", "missing-workflow", {
    workflowName: "Do not guess this name",
    activePersonaIds: ["persona-1"],
  });
  const view = libraryAssetUsageView(
    { kind: "persona", id: "persona-1" },
    [workflow("known", "Known")],
    [missing],
  );
  assert.deepEqual(view.rows, []);
  assert.equal(view.unresolvedWorkflowCount, 1);
  const html = render([workflow("known", "Known")], [missing]);
  assert.match(html, /No resolved workflows can be shown for this Persona/);
  assert.match(html, /1 live workflow is unavailable in this catalog and is omitted/);
  assert.doesNotMatch(html, /Do not guess this name/);
});

test("an older daemon with no projection renders no footer instead of a false empty answer", () => {
  const old = workflow("old", "Old");
  delete old.assetReferences;
  assert.equal(render([old]), "");
});
