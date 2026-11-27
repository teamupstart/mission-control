import assert from "node:assert/strict";
import test from "node:test";

import type { WorkflowDraftGraph } from "../src/shared/workflow.ts";
import { workflowDraftValidation } from "../src/web/workflows/WorkflowLibrary.tsx";

const session = { id: "session", kind: "session", position: { x: 0, y: 0 } } as const;
const end = { id: "end", kind: "end", outcome: "Approved", position: { x: 220, y: 0 } } as const;
const complete = {
  nodes: [session, end],
  edges: [{ id: "done", source: "session", sourcePort: "submitted", target: "end", targetPort: "terminal" }],
} as unknown as WorkflowDraftGraph;
const noEnd = { nodes: [session], edges: [] } as unknown as WorkflowDraftGraph;

test("a graph with no completion policy is validated, not skipped", () => {
  // The builder's rail and Publish read this result; null would hide both for the workflow.
  const valid = workflowDraftValidation({ graph: complete, completionPolicy: undefined });
  assert.ok(valid, "a loaded graph without a policy still gets a validation result");
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.diagnostics, []);

  const broken = workflowDraftValidation({ graph: noEnd, completionPolicy: undefined });
  assert.ok(broken, "a broken graph without a policy is still checked");
  assert.equal(broken.valid, false);
  assert.ok(broken.diagnostics.some((item) => item.code === "missing_end"));
  assert.ok(!broken.diagnostics.some((item) => item.code === "invalid_completion_policy"),
    "an absent policy is read as none, not as an invalid one");
});

test("the result is the same with or without a none policy, and null only without a graph", () => {
  assert.deepEqual(
    workflowDraftValidation({ graph: noEnd, completionPolicy: undefined }),
    workflowDraftValidation({ graph: noEnd, completionPolicy: { kind: "none" } }),
  );
  // The other side of the boundary: no workflow loaded yet, nothing to validate.
  assert.equal(workflowDraftValidation({ graph: undefined, completionPolicy: undefined }), null);
  assert.equal(workflowDraftValidation({ graph: undefined, completionPolicy: { kind: "none" } }), null);
});
