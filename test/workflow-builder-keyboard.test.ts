import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  autoLayoutWorkflow,
  nextRovingNodeId,
} from "../src/web/workflows/WorkflowCanvas.tsx";
import type { WorkflowDraftGraph } from "../src/shared/workflow.ts";
import {
  WORKFLOW_NODE_SOURCE_PORTS,
  WORKFLOW_NODE_TARGET_PORTS,
} from "../src/shared/workflow-graph.ts";

const canvasSource = readFileSync(
  new URL("../src/web/workflows/WorkflowCanvas.tsx", import.meta.url),
  "utf8",
);
const librarySource = readFileSync(
  new URL("../src/web/workflows/WorkflowLibrary.tsx", import.meta.url),
  "utf8",
);
const draftSource = readFileSync(
  new URL("../src/web/workflows/useWorkflowDraft.ts", import.meta.url),
  "utf8",
);

const graph: WorkflowDraftGraph = {
  nodes: [
    { id: "session", kind: "session", position: { x: 500, y: 500 } },
    { id: "persona", kind: "persona", personaId: "p", position: { x: -50, y: 700 } },
    { id: "end", kind: "end", outcome: "Complete", position: { x: 10, y: 10 } },
  ],
  edges: [
    { id: "start", source: "session", sourcePort: "submitted", target: "persona", targetPort: "activate" },
    { id: "pass", source: "persona", sourcePort: "pass", target: "end", targetPort: "terminal" },
  ],
};

test("auto-layout changes positions only and keeps the single Session semantic identity", () => {
  const laidOut = autoLayoutWorkflow(graph);
  assert.deepEqual(laidOut.edges, graph.edges);
  assert.deepEqual(laidOut.nodes.map(({ position: _position, ...node }) => node), graph.nodes.map(({
    position: _position,
    ...node
  }) => node));
  assert.equal(laidOut.nodes.filter((node) => node.kind === "session").length, 1);
  assert.ok(laidOut.nodes.every((node) =>
    Number.isFinite(node.position.x) && Number.isFinite(node.position.y)));
});

test("keyboard editing covers move, connect, confirmed delete, undo, redo, and duplicate", () => {
  assert.match(librarySource, /onClick=\{\(\) => addNode\(\{ kind: "persona", personaId: palettePersona \}\)\}/);
  assert.match(canvasSource, /focusable: node\.id === focusNodeId/);
  assert.match(canvasSource, /onFocusCapture/);
  assert.match(canvasSource, /event\.key === "Tab"/);
  assert.match(canvasSource, /window\.requestAnimationFrame\(focusNext\)/);
  assert.match(canvasSource, /ArrowLeft/);
  assert.match(canvasSource, /const gridUnits = event\.shiftKey \? 10 : 1/);
  assert.match(canvasSource, /GRID_SIZE \* gridUnits/);
  assert.match(canvasSource, /onKeyboardConnect/);
  assert.match(canvasSource, /deleteKeyCode=\{null\}/);
  assert.match(
    librarySource,
    /connectionAllowed\(source, connectSourcePort, target, connectTargetPort\)/,
  );
  for (const id of [
    "workflow-connect-source",
    "workflow-connect-target",
  ]) {
    assert.match(librarySource, new RegExp(id));
  }
  assert.match(librarySource, /value=\{connectSourcePort\}/);
  assert.match(canvasSource, /setFocusNodeId\(selection\.id\)/);
  assert.match(librarySource, /value=\{connectTargetPort\}/);
  assert.deepEqual(WORKFLOW_NODE_SOURCE_PORTS.check, ["pass", "fail"]);
  assert.deepEqual(WORKFLOW_NODE_TARGET_PORTS.check, ["activate"]);
  assert.match(librarySource, /WORKFLOW_NODE_SOURCE_PORTS\[sourceNode\.kind\]/);
  assert.match(librarySource, /WORKFLOW_NODE_TARGET_PORTS\[targetNode\.kind\]/);
  // Delete on the canvas still confirms - through the registered overlay now, so the
  // fleet's key handler stands down while the question is on screen.
  assert.match(librarySource, /setConfirm\(\{/);
  assert.match(librarySource, /confirmLabel: "Remove"/);
  assert.doesNotMatch(librarySource, /window\.confirm/);
  assert.match(librarySource, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(librarySource, /if \(event\.shiftKey\) draft\.redo\(\)/);
  // The rule lives in `duplicableIds`, which is also what GATES the control, so the button
  // can no longer light up for a selection it would then refuse. Two exclusions, for two
  // reasons. Session, because a graph has exactly one. And a session
  // action this daemon cannot offer: duplicating a node is an ADD control by another name -
  // the third way to put one in a graph - so it answers the same `addableActions` question the
  // palette and the drop handler do. Without that clause a draft already naming an archived or
  // unavailable action was a way to mint a SECOND unpublishable stage from inside a builder
  // whose every other add control refuses it.
  assert.match(librarySource, /const duplicableIds = selectedIds\.filter/);
  assert.match(librarySource, /if \(!node \|\| node\.kind === "session"\) return false;/);
  assert.match(
    librarySource,
    /return addableActions\.some\(\(action\) => action\.id === node\.sessionActionId\);/,
  );
  assert.match(draftSource, /slice\(-49\)/);
  assert.match(canvasSource, /workflow-alignment-guide is-vertical/);
  assert.match(canvasSource, /workflow-alignment-guide is-horizontal/);
});

test("roving node focus advances in graph order and exits at either boundary", () => {
  const ids = ["session", "persona", "end"];
  assert.equal(nextRovingNodeId(ids, "session", false), "persona");
  assert.equal(nextRovingNodeId(ids, "persona", false), "end");
  assert.equal(nextRovingNodeId(ids, "end", false), null);
  assert.equal(nextRovingNodeId(ids, "end", true), "persona");
  assert.equal(nextRovingNodeId(ids, "session", true), null);
  assert.equal(nextRovingNodeId(ids, "missing", false), null);
});
