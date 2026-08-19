import assert from "node:assert/strict";
import test from "node:test";

import {
  moveWorkflowRunSelection,
  moveWorkflowStageSelection,
} from "../src/web/workflows/run-navigation.ts";

test("workflow run arrows follow visible history without wrapping", () => {
  const ids = ["newest", "middle", "oldest"];

  assert.equal(moveWorkflowRunSelection(ids, null, "ArrowDown"), "newest");
  assert.equal(moveWorkflowRunSelection(ids, "missing", "ArrowUp"), "newest");
  assert.equal(moveWorkflowRunSelection(ids, "newest", "ArrowDown"), "middle");
  assert.equal(moveWorkflowRunSelection(ids, "middle", "ArrowDown"), "oldest");
  assert.equal(moveWorkflowRunSelection(ids, "middle", "ArrowUp"), "newest");
  assert.equal(moveWorkflowRunSelection(ids, "newest", "ArrowUp"), null);
  assert.equal(moveWorkflowRunSelection(ids, "oldest", "ArrowDown"), null);
  assert.equal(moveWorkflowRunSelection([], null, "ArrowDown"), null);
});

test("workflow stage arrows and tabs move one stage without wrapping", () => {
  assert.equal(moveWorkflowStageSelection(3, 0, "ArrowRight"), 1);
  assert.equal(moveWorkflowStageSelection(3, 1, "ArrowDown"), 2);
  assert.equal(moveWorkflowStageSelection(3, 2, "ArrowLeft"), 1);
  assert.equal(moveWorkflowStageSelection(3, 1, "ArrowUp"), 0);
  assert.equal(moveWorkflowStageSelection(3, 0, "Tab"), 1);
  assert.equal(moveWorkflowStageSelection(3, 1, "Tab", true), 0);
  assert.equal(moveWorkflowStageSelection(3, 0, "ArrowLeft"), null);
  assert.equal(moveWorkflowStageSelection(3, 2, "ArrowRight"), null);
  assert.equal(moveWorkflowStageSelection(0, 0, "Tab"), null);
});
