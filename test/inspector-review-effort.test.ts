import assert from "node:assert/strict";
import test from "node:test";
import { INSPECTOR_REVIEW_EFFORT, inspectorReviewEffort } from "../src/shared/inspector.ts";
import { launchEffortLevels } from "../src/shared/harness-capabilities.ts";
import { LLM_RUNNER_IDS } from "../src/shared/llm.ts";
import { providerModelDefault } from "../src/shared/model.ts";

// A review is the one thorough read a pull request gets, so it asks for more than the
// provider's default effort. A runner forwards the level unchecked, so the level must be
// one the provider offers for the model, or nothing at all.

test("a review asks for xhigh effort", () => {
  assert.equal(INSPECTOR_REVIEW_EFFORT, "xhigh");
});

test("every provider's default review model is offered the review effort", () => {
  for (const runner of LLM_RUNNER_IDS) {
    const model = providerModelDefault(runner, "balanced");
    assert.equal(inspectorReviewEffort(runner, model), INSPECTOR_REVIEW_EFFORT, runner);
  }
});

test("the review effort is passed only where the provider offers it", () => {
  for (const runner of LLM_RUNNER_IDS) {
    for (const model of [null, providerModelDefault(runner, "cheap"), providerModelDefault(runner, "deep")]) {
      const offered = launchEffortLevels(runner, model).includes(INSPECTOR_REVIEW_EFFORT);
      assert.equal(inspectorReviewEffort(runner, model), offered ? INSPECTOR_REVIEW_EFFORT : undefined);
    }
  }
});
