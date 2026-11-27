import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGoalPrompt } from "../src/server/goal/prompt.ts";
import type { Session } from "../src/shared/types.ts";

// A pick between options the session itself offered is the commonest reply that a model
// misreads as an amendment: "B" names a deliverable, so it looks like a new requirement. The
// refiner no longer latches on that misreading, but the right answer is still steering, and
// the prompt is where the model is told so.

const session = { name: "advisor-settings", cwd: "/wt/advisor", gitBranch: "harness/advisor" } as Session;

test("the goal prompt distinguishes a choice within implementation from authorization to implement", () => {
  const prompt = buildGoalPrompt({
    session,
    currentObjective: "Show two mockups of the advisor settings page and implement the one I pick",
    initial: false,
    prompt: "B",
    window: null,
  });
  const rules = prompt.replace(/\s+/g, " ");
  assert.match(rules, /if the objective already says to implement the selected design, "B" selects the approach and leaves that objective intact/);
  assert.match(rules, /If exploration was the whole objective and the human now authorizes implementing a selected design in the product, use "replace"/);
  assert.match(rules, /Merely naming or favoring an option does not authorize implementation/);
  assert.match(rules, /When a selection is ambiguous about whether to implement it, use "unclear"/);
  assert.match(rules, /If the human explicitly stops further work or withholds automatic review, shipping or a pull request, include the exact standalone line "Automatic handoff: operator only"/);
  assert.match(rules, /Keep the hold until the human expressly lifts the restriction/);
});
