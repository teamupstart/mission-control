import assert from "node:assert/strict";
import test from "node:test";

import { automaticWrapupBlock } from "../src/server/foreman/wrapup-eligibility.ts";

function block(over: Partial<Parameters<typeof automaticWrapupBlock>[0]> = {}) {
  return automaticWrapupBlock({
    taskKind: "ship",
    objective: "Implement retry handling in the uploader.",
    changedPaths: null,
    skipScoutWrapup: true,
    skipReviewArtifactWrapup: true,
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

test("the scout and review-artifact safeguards can be disabled independently", () => {
  assert.equal(
    block({
      taskKind: "scout",
      objective: "Implement the production-ready uploader.",
      skipScoutWrapup: false,
    }),
    null,
  );
  assert.equal(
    block({
      objective: "Output: mockups",
      changedPaths: ["docs/mockups/uploader.html"],
      skipReviewArtifactWrapup: false,
    }),
    null,
  );

  assert.equal(
    block({
      taskKind: "scout",
      objective: "Output: mockups",
      skipScoutWrapup: false,
    })?.kind,
    "review_artifact",
    "the enabled artifact safeguard still applies to a scout",
  );
  assert.equal(
    block({
      taskKind: "scout",
      objective: "Output: mockups",
      skipReviewArtifactWrapup: false,
    })?.kind,
    "scout",
    "the enabled scout safeguard still applies to a review-artifact objective",
  );
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
    "Prepare a plan to implement the feature.\nOutput: mockups",
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
    "Research the current onboarding patterns.",
    "Analyze the competing session layouts.",
    "Audit the reset flow for gaps.",
    "Next, investigate why operators miss the queue.",
    "Compare the current onboarding patterns.",
    "Create mockups and deliver a recommendation.",
    "Write a report that explains how to implement the feature.",
    "Prepare an analysis describing how to update the dashboard.",
    "Write a report that explains how to submit a pull request.",
    "Review how the team currently opens pull requests.",
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
    "Output: wireframes and an updated React component",
    "Output: mockups plus unit tests",
    "Create a mockup viewer component.",
    "Implement the session viewer. Output: mockups",
    "Build an updated React component.\nDeliverables: wireframes",
    "Implement a research dashboard for onboarding patterns.",
    "Create mockups and update the dashboard UI.",
    "Research onboarding patterns, then refactor the dashboard.",
    "Write a report, then implement the feature.",
    "Review the code and submit a pull request.",
    "Audit the fix, then open a PR.",
    "Analyze the implementation; raise a pull request with any needed fixes.",
    "Review the finished work, then push the changes.",
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
