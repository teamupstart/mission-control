import assert from "node:assert/strict";
import test from "node:test";
import { INSPECTOR_REVIEW_EFFORT, inspectorEffortChoice, inspectorEffortShown } from "../src/shared/inspector.ts";
import { launchEffortLevels } from "../src/shared/harness-capabilities.ts";
import { LLM_RUNNER_IDS } from "../src/shared/llm.ts";
import { providerModelDefault } from "../src/shared/model.ts";

// A review is the one thorough read a pull request gets, so it asks for more than the
// provider's default effort unless the operator chose otherwise. The saved setting has three
// states, and "never chosen" must not be read as "provider default".

test("a review nobody configured asks for xhigh, and a reply keeps the provider default", () => {
  assert.equal(INSPECTOR_REVIEW_EFFORT, "xhigh");
  assert.equal(inspectorEffortChoice(undefined, "review"), "xhigh");
  assert.equal(inspectorEffortChoice(undefined, "reply"), null);
});

test("a chosen level applies to reviews and replies alike", () => {
  assert.equal(inspectorEffortChoice("medium", "review"), "medium");
  assert.equal(inspectorEffortChoice("medium", "reply"), "medium");
});

// The settings row shows what a review will run at. A default the model does not offer is
// never used, so it must not be shown as though it were.
test("the row shows the review default only where the model offers it", () => {
  for (const runner of LLM_RUNNER_IDS) {
    for (const model of [providerModelDefault(runner, "balanced"), "gpt-5.6-test", "no-such-model"]) {
      const offered = launchEffortLevels(runner, model).includes("xhigh");
      assert.equal(inspectorEffortShown(undefined, runner, model), offered ? "xhigh" : null, runner + " " + model);
      // A saved choice is shown as saved either way; the row marks an unsupported one.
      assert.equal(inspectorEffortShown("xhigh", runner, model), "xhigh");
      assert.equal(inspectorEffortShown(null, runner, model), null);
    }
  }
  assert.equal(inspectorEffortShown(undefined, undefined, undefined), null);
});

test("choosing the provider default turns the review default off", () => {
  assert.equal(inspectorEffortChoice(null, "review"), null);
  assert.equal(inspectorEffortChoice(null, "reply"), null);
});
