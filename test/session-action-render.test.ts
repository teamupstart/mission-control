import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PipelineEditor } from "../src/web/workflows/PipelineEditor.tsx";
import { WorkflowProperties } from "../src/web/workflows/WorkflowProperties.tsx";
import { WorkflowVersionDetail } from "../src/web/workflows/WorkflowVersionHistory.tsx";
import { compileStages } from "../src/shared/workflow-stages.ts";
import { validateWorkflowGraph } from "../src/shared/workflow-graph.ts";
import type { StagePipeline } from "../src/shared/workflow-stages.ts";
import type {
  PublishedWorkflowNode,
  SessionAction,
  WorkflowDefinition,
  WorkflowDraftGraph,
  WorkflowVersion,
} from "../src/shared/workflow.ts";

/**
 * What is at stake: this phase deliberately ships NO way to author a session action, because
 * nothing can execute one yet. A graph that already contains one - it can only have arrived
 * through the raw draft API - still has to render, name itself, and say plainly why it cannot
 * be published. The load-bearing assertions are the negative ones: no remove control, no drag
 * handle, and no id in the markup.
 *
 * `renderToStaticMarkup`, no jsdom (house rule), so this covers render only.
 */

const action: SessionAction = {
  id: "bbbbbbbb-0000-4000-8000-000000000001",
  name: "Pull Request",
  normalizedName: "pull request",
  description: "Prepare the reviewed work",
  promptMarkdown: "# Pull Request\n\nOpen it.\n",
  requiredSkillId: "pull-request",
  completion: { kind: "pull_request" },
  revision: 2,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  builtin: false,
};

const SESSION_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const END_ID = "aaaaaaaa-0000-4000-8000-000000000002";
const ACTION_NODE_ID = "cccccccc-0000-4000-8000-000000000003";

const EMPTY: WorkflowDraftGraph = {
  nodes: [
    { id: SESSION_ID, kind: "session", position: { x: 0, y: 0 } },
    { id: END_ID, kind: "end", outcome: "Complete", position: { x: 300, y: 0 } },
  ],
  edges: [],
};

const PIPELINE: StagePipeline = {
  sessionId: SESSION_ID,
  endId: END_ID,
  endOutcome: "Complete",
  stages: [{
    kind: "session_action",
    member: { nodeId: ACTION_NODE_ID, kind: "session_action", sessionActionId: action.id },
  }],
};

const graph = compileStages(PIPELINE, EMPTY);

const workflow: WorkflowDefinition = {
  id: "dddddddd-0000-4000-8000-000000000004",
  name: "Ship it",
  normalizedName: "ship it",
  description: "",
  draft: graph,
  completionPolicy: { kind: "none" },
  resumptionPolicy: "auto",
  bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 },
  draftRevision: 1,
  currentVersionId: null,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  builtin: false,
};

const pipelineMarkup = (sessionActions: SessionAction[]): string =>
  renderToStaticMarkup(createElement(PipelineEditor, {
    graph,
    personas: [],
    sessionActions,
    onChange: () => {},
    onConfirm: () => {},
    onAnnounce: () => {},
  }));

test("an action stage names itself, says what it needs, and says what proves it done", () => {
  const html = pipelineMarkup([action]);
  assert.match(html, /Pull Request/);
  assert.match(html, /Session action/, "the badge says what this row is, beside reviewers");
  assert.match(html, /Skill · pull-request/);
  assert.match(html, /Completes when a pull request is opened and verified/);
  // The one thing an operator most needs to know about the stage below it.
  assert.match(html, /later stages review new evidence/);
  // Its seam says `complete`, not `pass`: everything after it reads new evidence.
  assert.match(html, /complete/);

  // The negative that motivated the whole surface: no id may reach the markup.
  for (const id of [action.id, ACTION_NODE_ID, SESSION_ID, END_ID]) {
    assert.doesNotMatch(html, new RegExp(id), `${id} reached the markup`);
  }
});

test("an action stage offers no authoring control this build cannot honour", () => {
  const html = pipelineMarkup([action]);
  // No Remove button and no drag handle. The model refuses these edits too
  // (`editableStage`), but an affordance that reported an error would be worse than none.
  assert.doesNotMatch(html, /aria-label="Remove Stage 1"/);
  assert.doesNotMatch(html, /draggable="true"/);
  // And no member-level focus stop, because there is no key it could answer.
  assert.doesNotMatch(html, /data-focus-key="member:0:0"/);
  assert.match(html, /data-focus-key="stage:0"/, "the card itself is still reachable");
  // No "Add reviewer or check" picker either. An action runs ALONE, so the control would
  // list four reviewers and refuse every one of them - which reads as a bug, not a rule.
  // Found by driving the real builder; the browser showed it before this pinned it.
  assert.doesNotMatch(html, /Add a reviewer or check to Stage 1/);
});

test("Duplicate is gated on what can actually be copied, not on any selection", () => {
  // The Graph toolbar's Duplicate lit up for a selected action and then did nothing,
  // because duplicating one is an add control by another name and `duplicateNodes` refuses
  // it. Pinned at the source, since a React Flow canvas cannot be rendered to markup here.
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "src", "web", "workflows", "WorkflowLibrary.tsx"),
    "utf8",
  );
  assert.match(source, /const duplicableIds = selectedIds\.filter/);
  assert.match(source, /kind !== "session" && kind !== "session_action"/);
  assert.match(source, /disabled=\{duplicableIds\.length === 0\}/);
  // And the palette still offers no way to create one in the first place.
  assert.doesNotMatch(source, /kind: "session_action" \}/);
});

test("a missing source is said plainly rather than shown as an id", () => {
  const html = pipelineMarkup([]);
  assert.match(html, /Missing session action/);
  assert.match(html, /This session action no longer exists/);
  assert.doesNotMatch(html, new RegExp(action.id));
});

test("the Graph rail describes a selected action read-only, with no picker", () => {
  const html = renderToStaticMarkup(createElement(WorkflowProperties, {
    workflow,
    personas: [],
    sessionActions: [action],
    diagnostics: validateWorkflowGraph({
      graph,
      sessionActions: [action],
      completionPolicy: workflow.completionPolicy,
    }).diagnostics,
    selection: { kind: "node", id: ACTION_NODE_ID },
    readOnly: false,
    onUpdate: () => {},
    onConfirm: () => {},
  }));
  assert.match(html, /Pull Request/);
  assert.match(html, /Requires the pull-request skill/);
  assert.match(html, /Completes only once a matching pull request is open and verified/);
  assert.match(html, /Every stage after it reviews evidence captured once it has/);
  // No select element for the action: choosing one is not offered in this build.
  assert.doesNotMatch(html, /<select[^>]*>[\s\S]*Pull Request[\s\S]*<\/select>/);
  // The refusal is stated in the same panel that would otherwise offer Publish.
  assert.match(html, /cannot be published/);
});

test("a published version shows the exact instruction it froze", () => {
  const version: WorkflowVersion = {
    id: "eeeeeeee-0000-4000-8000-000000000005",
    workflowId: workflow.id,
    version: 1,
    sourceDraftRevision: 1,
    graph: {
      nodes: graph.nodes.map((node): PublishedWorkflowNode => node.kind === "session_action"
        ? {
            id: node.id,
            kind: "session_action" as const,
            position: node.position,
            action: {
              sourceSessionActionId: action.id,
              sourceRevision: 1,
              name: action.name,
              description: action.description,
              promptMarkdown: "# Pull Request\n\nThe frozen wording.\n",
              requiredSkillId: action.requiredSkillId,
              completion: action.completion,
            },
          }
        // This fixture graph holds no Persona node, so every other arm carries through.
        : node as PublishedWorkflowNode),
      edges: graph.edges,
    },
    completionPolicy: { kind: "none" },
    resumptionPolicy: "auto",
    bindingDefaults: workflow.bindingDefaults,
    publishedAt: 1,
  };
  const html = renderToStaticMarkup(createElement(WorkflowVersionDetail, {
    version,
    personas: [],
    sessionActions: [action],
  }));
  // A version that typed an instruction into somebody's session has to be able to show WHICH
  // instruction, or its audit trail stops at "an action ran".
  assert.match(html, /The frozen wording\./);
  assert.match(html, /revision 1/);
  // The live source has moved on, and history says so rather than hiding it.
  assert.match(html, /outdated/);
  assert.match(html, /Requires the pull-request skill/);
});
