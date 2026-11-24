import assert from "node:assert/strict";
import test from "node:test";
import { INSPECTOR_REVIEW_EFFORT, inspectorEffortChoice } from "../src/shared/inspector.ts";

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

test("choosing the provider default turns the review default off", () => {
  assert.equal(inspectorEffortChoice(null, "review"), null);
  assert.equal(inspectorEffortChoice(null, "reply"), null);
});
