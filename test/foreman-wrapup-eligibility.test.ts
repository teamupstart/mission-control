import assert from "node:assert/strict";
import test from "node:test";

import { automaticWrapupBlock } from "../src/server/foreman/wrapup-eligibility.ts";

function block(over: Partial<Parameters<typeof automaticWrapupBlock>[0]> = {}) {
  return automaticWrapupBlock({
    taskKind: "ship",
    objective: "Implement retry handling in the uploader.",
    changedPaths: null,
    ...over,
  });
}

test("scout is an absolute automatic-wrap-up block", () => {
  const result = block({
    taskKind: "scout",
    objective: "Implement a production-ready change and open a pull request.",
    changedPaths: ["src/uploader.ts", "test/uploader.test.ts"],
  });

  assert.equal(result?.kind, "scout");
});

test("an explicit mockup output is a non-shipping review artifact", () => {
  for (const objective of [
    "Explore the session layout.\n\nOutput: mockups",
    "Required deliverable: three wireframes and a recommendation",
    "Expected artifacts: an interactive prototype",
    "Output: design explorations",
    "Output: a plan for code changes",
    "Output: a report on code changes",
    "Output: an implementation plan",
    "Output: a report on implementation details",
  ]) {
    assert.equal(block({ objective })?.kind, "review_artifact", objective);
  }
});

test("a natural-language review-artifact request is blocked without an Output field", () => {
  for (const objective of [
    "Present at least three HTML mockups for the new session viewer.",
    "Present HTML mockups that reflect the existing source code.",
    "Write a report comparing the available approaches.",
    "Write a report on code changes.",
    "Prepare a migration plan for operator review.",
    "Prepare a plan to implement the feature.",
  ]) {
    assert.equal(block({ objective })?.kind, "review_artifact", objective);
  }
});

test("mockup context does not block a task that also asks for implementation", () => {
  for (const objective of [
    "Use the approved mockup to implement the production-ready session viewer.",
    "Output: a working feature, code changes, and updated mockups",
    "Create mockups, then deliver the implementation.",
    "Create the mockups and implement them.",
    "Output: mockups\nOutput: source code",
    "Output: mockups and source code",
    "Create a mockup viewer component.",
  ]) {
    assert.equal(block({ objective }), null, objective);
  }
});

test("an artifact-only diff is blocked, while a mixed implementation stays eligible", () => {
  assert.equal(
    block({ changedPaths: ["docs/mockups/session/a.html", "docs/mockups/session/b.html"] })?.kind,
    "review_artifact",
  );
  assert.equal(
    block({ changedPaths: ["docs/plans/session/plan.md", "docs/mockups/session/a.html"] })?.kind,
    "review_artifact",
  );
  assert.equal(
    block({ changedPaths: ["docs/mockups/session/a.html", "src/web/Session.tsx"] }),
    null,
  );
});

test("ordinary ship work remains eligible", () => {
  assert.equal(block(), null);
  assert.equal(block({ changedPaths: [] }), null);
  assert.equal(block({ taskKind: null, objective: null, changedPaths: null }), null);
});
