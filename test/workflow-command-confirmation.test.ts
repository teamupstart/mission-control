import assert from "node:assert/strict";
import test from "node:test";
import { commandText, operatorConfirmation } from "../src/server/workflows/commands.ts";
import type { ReviewItem } from "../src/shared/types.ts";

const RUN_STARTED = 1_000;

function card(over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "card-1", sessionId: "s", kind: "input", title: "Confirm", body: "Use `npm test`?",
    status: "answered", response: "Answered:\n\n• Use `npm test`?\n  → npm test",
    decisions: [{ id: "q", question: "Use `npm test`?", options: [
      { id: "o0", label: "npm test" }, { id: "o1", label: "Use a different command" },
    ], allowOther: true }],
    selections: [{ decisionId: "q", selected: ["o0"], other: null }],
    resolvedBy: "human", createdAt: RUN_STARTED, resolvedAt: RUN_STARTED + 5,
    ...over,
  };
}

test("the operator picking exactly the argv on this run's card confirms it", () => {
  assert.equal(commandText(["npm", "run", "test:unit"]), "npm run test:unit");
  assert.equal(operatorConfirmation([card()], ["npm", "test"], RUN_STARTED)?.id, "card-1");
  // The "Other" text and a free-text answer count when they are exactly the argv.
  assert.ok(operatorConfirmation([card({ selections: [{ decisionId: "q", selected: [], other: " pytest  -q " }] })],
    ["pytest", "-q"], RUN_STARTED));
  assert.ok(operatorConfirmation([card({ decisions: null, selections: null, response: "`cargo test`" })],
    ["cargo", "test"], RUN_STARTED));
});

test("nothing short of the human choosing that argv after the run started confirms it", () => {
  const refused: Array<[string, ReviewItem]> = [
    ["a different option was picked", card({ selections: [{ decisionId: "q", selected: ["o1"], other: null }] })],
    ["the card is still pending", card({ status: "pending", resolvedAt: null, selections: null })],
    ["the card was dismissed", card({ status: "dismissed", selections: null })],
    ["Foreman answered it", card({ resolvedBy: "foreman" })],
    ["a standing approval answered it", card({ resolvedBy: "standing-approval" })],
    ["a controlling session answered it", card({ resolvedBy: "session:sdk:other" })],
    ["it was answered before this run started", card({ resolvedAt: RUN_STARTED - 1 })],
    ["it is not a request_input card", card({ kind: "plan-decisions" })],
    ["a free-text answer only mentions the argv", card({ decisions: null, selections: null, response: "yes, use npm test" })],
  ];
  for (const [why, review] of refused) {
    assert.equal(operatorConfirmation([review], ["npm", "test"], RUN_STARTED), null, why);
  }
  // Confirming one argv does not confirm another.
  assert.equal(operatorConfirmation([card()], ["npm", "run", "test"], RUN_STARTED), null);
});
