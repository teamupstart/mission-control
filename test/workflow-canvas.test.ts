import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyNodeChanges, type NodeChange } from "@xyflow/react";
import { reconcileCanvasNodes } from "../src/web/workflows/WorkflowCanvas.tsx";
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
