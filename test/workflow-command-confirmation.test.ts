import assert from "node:assert/strict";
import test from "node:test";
import {
  CONFIGURE_COMMAND_OPTION_ID,
  commandConfirmationCard,
  operatorConfirmation,
  type CommandConfirmationCard,
} from "../src/server/workflows/commands.ts";
import type { ReviewItem } from "../src/shared/types.ts";

const RUN_STARTED = 1_000;
const CHANGE = { runId: "run-1", slot: "test", repoRoot: "/repo", command: ["npm", "test"] };

/** The card as the dashboard stores it once the operator answered it. */
function answered(card: CommandConfirmationCard, over: Partial<ReviewItem> = {}, selected = CONFIGURE_COMMAND_OPTION_ID): ReviewItem {
  return {
    id: "card-1", sessionId: "s", kind: "input", title: card.title, body: card.question,
    status: "answered", response: "Answered", decisions: [card.decision],
    selections: [{ decisionId: card.decision.id, selected: [selected], other: null }],
    resolvedBy: "human", createdAt: RUN_STARTED, resolvedAt: RUN_STARTED + 5,
    ...over,
  };
}

test("the daemon-composed card names the run, slot, repository and the exact argv", () => {
  const card = commandConfirmationCard(CHANGE);
  assert.match(card.question, /Repository: \/repo/);
  assert.match(card.question, /Slot: test/);
  assert.match(card.question, /Workflow run: run-1/);
  assert.match(card.question, /Command \(exact argv, one JSON string per argument\): \["npm","test"\]/);
  assert.equal(card.decision.question, card.question);
  assert.deepEqual(card.decision.options.map((option) => option.id), [CONFIGURE_COMMAND_OPTION_ID, "decline"]);
  assert.equal(operatorConfirmation([answered(card)], card, RUN_STARTED)?.id, "card-1");
});

test("argv boundaries are part of what is confirmed", () => {
  // The same space-joined text, two different programs.
  const spaced = commandConfirmationCard({ ...CHANGE, command: ["./tools/run checks", "test"] });
  const split = commandConfirmationCard({ ...CHANGE, command: ["./tools/run", "checks test"] });
  assert.notEqual(spaced.decision.id, split.decision.id);
  assert.notEqual(spaced.question, split.question);
  assert.ok(operatorConfirmation([answered(spaced)], spaced, RUN_STARTED));
  assert.equal(operatorConfirmation([answered(spaced)], split, RUN_STARTED), null);
});

test("an answer authorizes only the change its card names", () => {
  const card = commandConfirmationCard(CHANGE);
  for (const [why, other] of [
    ["another run", { ...CHANGE, runId: "run-2" }],
    ["another slot", { ...CHANGE, slot: "lint" }],
    ["another repository", { ...CHANGE, repoRoot: "/elsewhere" }],
    ["another argv", { ...CHANGE, command: ["npm", "run", "test"] }],
  ] as const) {
    assert.equal(operatorConfirmation([answered(commandConfirmationCard(other))], card, RUN_STARTED), null, why);
  }
});

test("nothing short of the human choosing Configure on that exact card authorizes it", () => {
  const card = commandConfirmationCard(CHANGE);
  const refused: Array<[string, ReviewItem]> = [
    ["the operator declined", answered(card, {}, "decline")],
    ["the card is still pending", answered(card, { status: "pending", resolvedAt: null, selections: null })],
    ["the card was dismissed", answered(card, { status: "dismissed", selections: null })],
    ["Foreman answered it", answered(card, { resolvedBy: "foreman" })],
    ["a standing approval answered it", answered(card, { resolvedBy: "standing-approval" })],
    ["a controlling session answered it", answered(card, { resolvedBy: "session:sdk:other" })],
    ["it was answered before this run started", answered(card, { resolvedAt: RUN_STARTED - 1 })],
    ["it is not a request_input card", answered(card, { kind: "plan-decisions" })],
    // A session-phrased card reusing the decision id but saying something else.
    ["the question was rewritten", answered(card, { decisions: [{ ...card.decision, question: "Run the tests?" }] })],
    ["an option was relabeled", answered(card, { decisions: [{ ...card.decision,
      options: card.decision.options.map((option) => ({ ...option, label: "Yes" })) }] })],
    // An unrelated card the human happened to answer with the argv's text.
    ["an unrelated card", answered(card, { decisions: [{ id: "q", question: "Which command?",
      options: [{ id: "o0", label: "npm test" }] }], selections: [{ decisionId: "q", selected: ["o0"], other: null }] })],
  ];
  for (const [why, review] of refused) {
    assert.equal(operatorConfirmation([review], card, RUN_STARTED), null, why);
  }
});
