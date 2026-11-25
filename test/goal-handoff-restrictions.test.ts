import assert from "node:assert/strict";
import test from "node:test";
import { GOAL_OPERATOR_HANDOFF_ONLY, hasOperatorHandoffHold } from "../src/shared/goal.ts";
import {
  contextualHandoffRestriction, explicitHandoffRestriction, withoutHandoffRestrictions,
} from "../src/server/goal/handoff-restrictions.ts";

test("buttons named stop and fenced examples do not reserve automatic handoff", () => {
  const objective = "Add start, stop, and restart buttons.";
  const sample = ["```text", GOAL_OPERATOR_HANDOFF_ONLY, "Do not open a PR.", "```"].join("\n");
  const withExample = objective + "\n" + sample;
  assert.equal(explicitHandoffRestriction(withExample), undefined);
  assert.equal(hasOperatorHandoffHold(withExample), false);
  assert.equal(withoutHandoffRestrictions(withExample + "\nNo PR."), withExample);
});

test("a bound workflow can own the PR while the operator reserves other actions", () => {
  const delegation = "Don’t open a PR, let the bound Workflow open it.";
  assert.equal(explicitHandoffRestriction(delegation), undefined);
  assert.equal(explicitHandoffRestriction("Stop here. " + delegation), "Stop here");
  assert.equal(explicitHandoffRestriction("Do not open a PR, but let the bound workflow publish the preview."), "Do not open a PR");
});

test("delegation cannot remove a prior approval condition", () => {
  for (const restriction of [
    "Do not open a PR until I approve",
    "Do not open a pull request before I approve",
    "Do not submit this for review without my approval",
  ]) {
    const objective = `${restriction}, then let the bound workflow open it.`;
    assert.equal(explicitHandoffRestriction(objective), restriction);
  }
});

test("release removes recognized and annotated restrictions and preserves the deliverable", () => {
  const work = "Add start, stop, and restart buttons.";
  for (const restriction of [
    "Do not open a pull request before I approve.",
    "Leave opening the PR to me.",
    contextualHandoffRestriction("Keep this local until I review it."),
  ]) {
    const objective = [work, restriction, GOAL_OPERATOR_HANDOFF_ONLY].join("\n");
    assert.ok(explicitHandoffRestriction(objective));
    assert.equal(withoutHandoffRestrictions(objective), work);
  }
});
