import assert from "node:assert/strict";
import test from "node:test";
import { GOAL_OPERATOR_HANDOFF_ONLY, hasOperatorHandoffHold } from "../src/shared/goal.ts";
import {
  contextualHandoffRestriction, explicitHandoffRestriction, withoutHandoffRestrictions,
} from "../src/server/goal/handoff-restrictions.ts";

test("buttons named stop and fenced examples do not reserve automatic handoff", () => {
  const objective = "Add controls for the following actions:\n- Start\n- Stop\n- Restart";
  const sample = ["```text", GOAL_OPERATOR_HANDOFF_ONLY, "- Do not open a PR.", "Do not ship this yet.", "```"].join("\n");
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
  assert.equal(explicitHandoffRestriction("- " + delegation), undefined);
  assert.equal(explicitHandoffRestriction("Do not ship this yet, but let the bound workflow open the PR."), "Do not ship this yet");
});

test("negated workflow delegation keeps the explicit no-PR restriction", () => {
  const objective = "Do not open a PR, and do not let the bound workflow open it.";
  assert.equal(explicitHandoffRestriction(objective), "Do not open a PR");
});

test("an adjacent affirmative PR assignment is delegation and keeps approval limits", () => {
  const delegated = "Don’t open a PR. Let the bound Workflow open it.";
  assert.equal(explicitHandoffRestriction(delegated), undefined);
  assert.equal(withoutHandoffRestrictions(delegated), delegated);
  assert.equal(explicitHandoffRestriction("Do not open a PR until I approve. Let the bound Workflow open it."), "Do not open a PR until I approve");
  assert.equal(explicitHandoffRestriction("Do not open a PR. Do not let the bound Workflow open it."), "Do not open a PR");
  assert.equal(explicitHandoffRestriction("Do not open a PR. Let the bound Workflow open it after I approve."), "Do not open a PR");
  assert.equal(explicitHandoffRestriction("Do not submit this for review. Let the bound Workflow open the PR."), "Do not submit this for review");
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
    "- Do not open a PR.",
    "1. Do not open a PR.",
    "Do not ship this yet.",
    "Keep this local until I review it.",
    "Leave opening the PR to me.",
    contextualHandoffRestriction("Keep this local until I review it."),
  ]) {
    const objective = [work, restriction, GOAL_OPERATOR_HANDOFF_ONLY].join("\n");
    assert.ok(explicitHandoffRestriction(objective));
    assert.equal(withoutHandoffRestrictions(objective), work);
  }
  assert.equal(withoutHandoffRestrictions("- No PR, but implement heading counts."), "- implement heading counts.");
});
