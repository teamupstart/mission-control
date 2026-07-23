import { test } from "node:test";
import assert from "node:assert/strict";
import { applyNodeChanges, type NodeChange } from "@xyflow/react";
import { reconcileCanvasNodes } from "../src/web/workflows/WorkflowCanvas.tsx";
import type { WorkflowCanvasNode } from "../src/web/workflows/WorkflowNode.tsx";

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
