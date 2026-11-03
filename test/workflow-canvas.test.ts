import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyNodeChanges, type NodeChange } from "@xyflow/react";
import { canvasNodes, minimapNodeClassName, reconcileCanvasNodes } from "../src/web/workflows/WorkflowCanvas.tsx";
import type { WorkflowCanvasNode } from "../src/web/workflows/WorkflowNode.tsx";

const canvasSource = readFileSync(
  new URL("../src/web/workflows/WorkflowCanvas.tsx", import.meta.url),
  "utf8",
);

const node = (label: string): WorkflowCanvasNode => ({
  id: "session",
  type: "session",
  position: { x: 0, y: 0 },
  data: { kind: "session", label, subtitle: "Submission and repair boundary", readOnly: false },
});

test("canvas projections retain React Flow measurements", () => {
  const changes: NodeChange<WorkflowCanvasNode>[] = [{
    id: "session",
    type: "dimensions",
    dimensions: { width: 180, height: 64 },
  }];
  const measured = applyNodeChanges(changes, [node("Session")]);
  const refreshed = reconcileCanvasNodes(measured, [node("Updated session")]);

  assert.deepEqual(refreshed[0]?.measured, { width: 180, height: 64 });
  assert.equal(refreshed[0]?.data.label, "Updated session");
});

test("React Flow array props keep module-level identities", () => {
  const componentStart = canvasSource.indexOf("export const WorkflowCanvas");
  assert.notEqual(componentStart, -1);
  const moduleSource = canvasSource.slice(0, componentStart);
  const flowStart = canvasSource.indexOf("\n      <ReactFlow\n", componentStart);
  assert.notEqual(flowStart, -1);
  const flowSource = canvasSource.slice(
    flowStart,
    canvasSource.indexOf("</ReactFlow>", componentStart),
  );

  const props = [
    ["snapGrid", "SNAP_GRID"],
    ["nodeExtent", "NODE_EXTENT"],
    ["multiSelectionKeyCode", "MULTI_SELECTION_KEYS"],
  ] as const;
  for (const [prop, constant] of props) {
    assert.match(moduleSource, new RegExp(`const ${constant}\\b`));
    assert.match(flowSource, new RegExp(`${prop}=\\{${constant}\\}`));
    assert.doesNotMatch(flowSource, new RegExp(`${prop}=\\{\\s*\\[`));
  }
});

test("React Flow mutation handlers keep stable callback identities through one latest ref", () => {
  const componentStart = canvasSource.indexOf("export const WorkflowCanvas");
  const flowStart = canvasSource.indexOf("\n      <ReactFlow\n", componentStart);
  assert.notEqual(componentStart, -1);
  assert.notEqual(flowStart, -1);
  const definitions = canvasSource.slice(componentStart, flowStart);
  const flowSource = canvasSource.slice(flowStart, canvasSource.indexOf("</ReactFlow>", flowStart));

  assert.match(
    definitions,
    /const handlersRef = useRef\(\{ changeNodes, changeEdges, connect, nodeDrag, nodeDragStop \}\)/,
  );
  const handlers = [
    ["onNodesChange", "changeNodes"],
    ["onEdgesChange", "changeEdges"],
    ["onConnect", "connect"],
    ["onNodeDrag", "nodeDrag"],
    ["onNodeDragStop", "nodeDragStop"],
  ] as const;
  for (const [prop, target] of handlers) {
    assert.match(
      definitions,
      new RegExp(
        `const ${prop} = useCallback\\([\\s\\S]{0,220}?handlersRef\\.current\\.${target}\\([\\s\\S]{0,120}?\\), \\[\\]\\);`,
      ),
    );
    assert.match(flowSource, new RegExp(`${prop}=\\{${prop}\\}`));
    assert.doesNotMatch(
      flowSource,
      new RegExp(`${prop}=\\{\\s*(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>`),
    );
  }
});

test("the minimap colours its nodes by class, so a skin repaints them through tokens", () => {
  // A `nodeColor` result lands as an inline `fill` that no stylesheet can override, so a
  // mounted minimap would keep the previous skin's colours. The class rule reads tokens.
  assert.doesNotMatch(canvasSource, /nodeColor=/);
  assert.doesNotMatch(canvasSource, /#[0-9a-fA-F]{3,8}\b/, "the canvas hard-codes a colour");
  assert.match(canvasSource, /nodeClassName=\{minimapNodeClassName\}/);
  assert.equal(minimapNodeClassName({ className: "workflow-runtime-failed" }), "workflow-minimap-node is-fail");
  assert.equal(minimapNodeClassName({ className: "workflow-runtime-passed" }), "workflow-minimap-node");
  assert.equal(minimapNodeClassName({}), "workflow-minimap-node");

  const css = readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.react-flow__minimap-node\.workflow-minimap-node \{ fill: var\(--canvas-minimap-node\); \}/);
  assert.match(css, /\.react-flow__minimap-node\.workflow-minimap-node\.is-fail \{ fill: var\(--canvas-minimap-fail\); \}/);
});

test("a run's failed node reaches the minimap as is-fail, through the canvas projection", () => {
  // A run hands the canvas node statuses as either a verdict ("fail") or an attempt state
  // ("failed"); the canvas turns each into a `workflow-runtime-*` class and the minimap reads
  // that class. Drive the whole path rather than the helper alone.
  const graph = {
    nodes: [
      { id: "session", kind: "session" as const, position: { x: 0, y: 0 } },
      { id: "judge", kind: "persona" as const, personaId: "missing", position: { x: 220, y: 0 } },
      { id: "check", kind: "persona" as const, personaId: "missing", position: { x: 220, y: 120 } },
      { id: "end", kind: "end" as const, outcome: "Approved", position: { x: 440, y: 0 } },
    ],
    edges: [],
  };
  const statuses = { judge: "fail", check: "failed", end: "completed" };
  const nodes = canvasNodes(graph, [], [], true, statuses, null, null);
  const minimap = Object.fromEntries(nodes.map((n) => [n.id, minimapNodeClassName(n)]));
  assert.deepEqual(minimap, {
    session: "workflow-minimap-node",
    judge: "workflow-minimap-node is-fail",
    check: "workflow-minimap-node is-fail",
    end: "workflow-minimap-node",
  });
});
