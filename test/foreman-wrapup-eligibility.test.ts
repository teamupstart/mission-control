import assert from "node:assert/strict";
import test from "node:test";

import { automaticWrapupBlock } from "../src/server/foreman/wrapup-eligibility.ts";

function block(over: Partial<Parameters<typeof automaticWrapupBlock>[0]> = {}) {
  return automaticWrapupBlock({
    taskKind: "ship",
    workflowId: null,
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

test("chat stays human-ended unless an explicit Workflow is selected", () => {
  assert.equal(block({ taskKind: "chat", workflowId: null })?.kind, "chat");
  assert.equal(
    block({ taskKind: "chat", workflowId: "workflow-review" }),
    null,
    "an explicitly selected Workflow follows ordinary completion policy",
  );
  assert.equal(
    block({
      taskKind: "chat",
      workflowId: "workflow-review",
      objective: "Output: mockups",
    })?.kind,
    "review_artifact",
    "the Workflow opt-in still passes through the ordinary artifact safeguard",
  );
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
      changedPaths: ["docs/archive/mockups/uploader.html"],
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
    "Investigate the login failure, then implement a fix.",
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
    block({ changedPaths: ["docs/archive/mockups/session/a.html", "docs/archive/mockups/session/b.html"] })?.kind,
    "review_artifact",
  );
  assert.equal(
    block({ changedPaths: ["docs/plans/session/plan.md", "docs/archive/mockups/session/a.html"] })?.kind,
    "review_artifact",
  );
  assert.equal(
    block({ changedPaths: ["docs/archive/mockups/session/a.html", "src/web/Session.tsx"] }),
    null,
  );
});

test("ordinary ship work remains eligible", () => {
  assert.equal(block(), null);
  assert.equal(block({ changedPaths: [] }), null);
  assert.equal(block({ taskKind: null, objective: null, changedPaths: null }), null);
});

/**
 * The plan kind's exemption, which is a requirement rather than a consequence.
 *
 * A plan task matches the review-artifact classifier TWICE over - "write a plan" is the
 * vocabulary its objective half matches, and a `docs/plans/**`-only diff is every path its
 * diff half matches - so the approved "offer ordinary wrap-up" decision is only delivered if
 * both halves are exempted. The reason a plan is not a review artifact in the sense this
 * setting means: a mockup is produced FOR a review and discarded, while a plan's landing on
 * the default branch is what releases the phase tasks that depend on its paths.
 */
test("a plan task is offered ordinary wrap-up, through both halves of the classifier", () => {
  // The objective half, which is the one that matters at the two call sites supplying no diff.
  assert.equal(block({ taskKind: "plan", objective: "Write a plan for the archives reading UI." }), null);
  assert.equal(block({ taskKind: "plan", objective: "Output: a plan" }), null);
  assert.equal(block({ taskKind: "plan", objective: "Prepare a migration plan for operator review." }), null);

  // The diff half, on the shape every plan task actually produces.
  assert.equal(
    block({
      taskKind: "plan",
      objective: "Plan the archives reading UI.",
      changedPaths: ["docs/plans/archives-ui/plan.md", "docs/plans/archives-ui/plan.html"],
    }),
    null,
  );
});

test("the exemption is keyed on the kind and did not weaken the classifier", () => {
  // THE negative case. Same objective, same diff, `ship` instead of `plan`: still blocked. A
  // classifier loosened rather than exempted would go green on the case above and quietly stop
  // retiring every mockup-only ship task in the fleet.
  const shipLikeAPlan = {
    objective: "Write a plan for the archives reading UI.",
    changedPaths: ["docs/plans/archives-ui/plan.md", "docs/plans/archives-ui/plan.html"],
  };
  assert.equal(block({ ...shipLikeAPlan, taskKind: "ship" })?.kind, "review_artifact");
  assert.equal(block({ ...shipLikeAPlan, taskKind: null })?.kind, "review_artifact");
  // And a scout still takes it too, on both halves - its own branch is separately switchable,
  // and an operator who turned that one off did not ask for this one to stop applying.
  assert.equal(
    block({ ...shipLikeAPlan, taskKind: "scout", skipScoutWrapup: false })?.kind,
    "review_artifact",
  );
});

test("the plan exemption does not reach past the review-artifact classifier", () => {
  // It exempts a plan from being retired as an ARTIFACT. It is not a blanket "never block a
  // plan", and the distinction is what keeps this a change to one classifier rather than to
  // the wrap-up boundary itself.
  assert.equal(
    block({ taskKind: "plan", objective: "Plan it.", skipReviewArtifactWrapup: false }),
    null,
    "with the safeguard off there was nothing to exempt from in the first place",
  );
});
