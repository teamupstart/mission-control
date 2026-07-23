import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readLastWorkflowId, rememberWorkflowId } from "../src/web/workflows/workflowSelection.ts";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  },
});

beforeEach(() => values.clear());

test("the workflow library remembers and clears its last selected definition", () => {
  assert.equal(readLastWorkflowId(), null);
  rememberWorkflowId("workflow-2");
  assert.equal(readLastWorkflowId(), "workflow-2");
  rememberWorkflowId(null);
  assert.equal(readLastWorkflowId(), null);
});
