import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: one question asked, two identical cards in "to review".
//
// `request_input` (and `request_plan_decisions`, and `request_review`) BLOCK on a human,
// for as long as the human takes. Claude Code's MCP client does not wait that long: it
// abandons a tool call after its own timeout and hands the model an error, and the model's
// natural recovery is to ask the identical question again. Nothing downstream could tell
// the retry from a fresh ask - `create` minted a new UUID per POST and the reviews table
// carries no dedup key - so the abandoned row stayed pending beside its own retry and the
// operator was shown the same prompt twice, with only one of the two attached to an agent
// that is still listening.
//
// The live database says this is exactly what happened: of the duplicate pairs recorded
// there, the largest cluster lands 293-325 seconds apart with a BYTE-IDENTICAL body - the
// client's five-minute tool timeout, not a human-meaningful interval, and not two questions
// that merely resemble each other.
//
// So `create` is now idempotent over the pending window: an identical ask from the same
// session, while the first is still unanswered, re-attaches to the row that already exists.
// The retry then long-polls the ORIGINAL review, so answering the one card the operator
// sees unblocks whichever call is still listening.

const home = mkdtempSync(join(tmpdir(), "mission-review-duplicate-"));
process.env.HARNESS_HOME = home;
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { openDb, loadPendingReviews } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");

type PlanDecision = import("../src/shared/types.ts").PlanDecision;
type ServerEvent = import("../src/shared/types.ts").ServerEvent;

openDb();

const QUESTION = "Which linter should this repository standardise on?";
const DECISIONS: PlanDecision[] = [
  {
    id: "q",
    question: QUESTION,
    options: [
      { id: "o0", label: "biome" },
      { id: "o1", label: "eslint" },
    ],
  },
];

// Every case gets its own session id. A `Registry` reloads every pending row in the
// database at construction (`loadPendingReviews`), so cases sharing one would count each
// other's questions.
let n = 0;
function harness() {
  const SESSION = `sdk:duplicate-ask-${++n}`;
  const registry = new Registry();
  const reviews = new ReviewManager(registry);
  const events: ServerEvent[] = [];
  registry.subscribe((e) => events.push(e));
  const ask = (decisions: PlanDecision[] | null = DECISIONS) =>
    reviews.create(SESSION, "input", QUESTION, QUESTION, decisions);
  return { SESSION, registry, reviews, events, ask };
}

test("a retried identical ask re-attaches instead of queueing a second card", () => {
  const { SESSION, registry, events, ask } = harness();

  const first = ask();
  const retry = ask();

  assert.equal(retry.id, first.id, "the retry got its own review row");
  assert.equal(
    registry.pendingReviews(SESSION).length,
    1,
    "the operator is shown the same prompt twice",
  );
  assert.equal(
    events.filter((e) => e.type === "review_upsert").length,
    1,
    "a re-attach re-published the row it did not change",
  );
});

test("the retry is not written to the database either", () => {
  const { SESSION, ask } = harness();
  const first = ask();
  ask();
  const rows = loadPendingReviews().filter((r) => r.sessionId === SESSION);
  assert.deepEqual(rows.map((r) => r.id), [first.id]);
});

test("answering the one card unblocks the call that retried onto it", async () => {
  const { reviews, ask } = harness();
  const first = ask();
  const retry = ask();

  // Both calls long-poll; the second is the one the model is actually still holding.
  const firstWait = reviews.wait(first.id, 5_000);
  const retryWait = reviews.wait(retry.id, 5_000);
  reviews.resolve(first.id, "answer", "biome", "human");

  assert.equal((await firstWait)?.response, "biome");
  assert.equal((await retryWait)?.response, "biome", "the retry never heard the answer");
});

test("a genuinely different ask still gets its own card", () => {
  const { SESSION, registry, reviews } = harness();
  reviews.create(SESSION, "input", QUESTION, QUESTION, DECISIONS);
  reviews.create(SESSION, "input", "Ship it?", "Ship it?", DECISIONS);
  assert.equal(registry.pendingReviews(SESSION).length, 2);
});

test("the same question with different options is a different ask", () => {
  const { SESSION, registry, reviews } = harness();
  reviews.create(SESSION, "input", QUESTION, QUESTION, DECISIONS);
  reviews.create(SESSION, "input", QUESTION, QUESTION, [
    { ...DECISIONS[0]!, options: [{ id: "o0", label: "oxlint" }] },
  ]);
  assert.equal(registry.pendingReviews(SESSION).length, 2, "the option set was not compared");
});

test("re-asking after the human answered opens a fresh card", () => {
  const { SESSION, registry, reviews, ask } = harness();
  const first = ask();
  reviews.resolve(first.id, "answer", "biome", "human");

  const again = ask();
  assert.notEqual(again.id, first.id, "a settled row was reused as a live question");
  assert.equal(registry.pendingReviews(SESSION).length, 1);
});

test("another session asking the same thing is not collapsed into yours", () => {
  const { SESSION, registry, reviews, ask } = harness();
  ask();
  reviews.create("sdk:someone-else", "input", QUESTION, QUESTION, DECISIONS);
  assert.equal(registry.pendingReviews(SESSION).length, 1);
  assert.equal(registry.pendingReviews("sdk:someone-else").length, 1);
});

test("dedup spans kinds, because plan-decisions duplicates the same way", () => {
  const { SESSION, registry, reviews } = harness();
  const a = reviews.create(SESSION, "plan-decisions", "Keep Awake mode", "body", DECISIONS);
  const b = reviews.create(SESSION, "plan-decisions", "Keep Awake mode", "body", DECISIONS);
  assert.equal(b.id, a.id);
  assert.equal(registry.pendingReviews(SESSION).length, 1);
  // ...but a different kind carrying the same text is a different ask.
  reviews.create(SESSION, "input", "Keep Awake mode", "body", DECISIONS);
  assert.equal(registry.pendingReviews(SESSION).length, 2);
});
