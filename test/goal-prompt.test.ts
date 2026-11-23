import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGoalPrompt } from "../src/server/goal/prompt.ts";
import type { Session } from "../src/shared/types.ts";

// A pick between options the session itself offered is the commonest reply that a model
// misreads as an amendment: "B" names a deliverable, so it looks like a new requirement. The
// refiner no longer latches on that misreading, but the right answer is still steering, and
// the prompt is where the model is told so.

const session = { name: "advisor-settings", cwd: "/wt/advisor", gitBranch: "harness/advisor" } as Session;

test("the goal prompt tells the model that picking an offered option is steering", () => {
  const prompt = buildGoalPrompt({
    session,
    currentObjective: "Show two mockups of the advisor settings page and implement the one I pick",
    initial: false,
    prompt: "B",
    window: null,
  });
  const steer = prompt.slice(prompt.indexOf('- "steer"'), prompt.indexOf('- "amend"'));
  assert.match(
    steer.replace(/\s+/g, " "),
    /When the objective or the conversation explicitly offers choices \(options, mockups, "A or B", "pick one"\), a reply that names one of them is steering, not an amendment\./,
  );
});
