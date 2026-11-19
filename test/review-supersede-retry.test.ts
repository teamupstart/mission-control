import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: one decision, two cards, answered twice (issue #1527).
//
// `request_input` blocks until a person answers. Codex's MCP client gives up on the call after
// five minutes, sends no cancellation, and hands the model "timed out awaiting tool call". The
// model then reissues the decision in NEW words - "The previous prompt timed out. May I
// proceed..." - so the byte-identical re-attach in `ReviewManager.create` never matches, and
// the abandoned card stayed in the queue beside its retry. Both pairs the live database
// recorded in thirty days look exactly like that.
//
// So a new `request_input` ask that announces itself as a retry AND shares the older ask's
// wording withdraws that older card. Anything else - in particular a different later question -
// leaves every older card exactly where it is.

const home = mkdtempSync(join(tmpdir(), "mission-review-supersede-"));
process.env.HARNESS_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { openDb, loadPendingReviews } = await import("../src/server/db.ts");
import type { ReviewItem } from "../src/shared/types.ts";
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager, PARALLEL_ASK_WINDOW_MS } = await import("../src/server/reviews.ts");
const { ANNOUNCED_RETRY_MIN_OVERLAP, REWORDED_MIN_OVERLAP, SWAP_CONTEXT_WORDS, MAX_SWAP_WORDS } =
  await import("../src/server/review-retry.ts");
const { reviewToolResult, isConversationResolvedReview } = await import("../src/shared/review-item.ts");

type PlanDecision = import("../src/shared/types.ts").PlanDecision;
type ServerEvent = import("../src/shared/types.ts").ServerEvent;

openDb();

// Paraphrased from the real pair the live database recorded.
const FIRST =
  "Approve this rollout and release authority before I create the four drafted tasks? Phase 1 " +
  "migrates workspace access, phases 2 and 3 run in parallel, and I merge each PR after checks pass.";
const RETRY =
  "The previous prompt timed out. May I proceed with the four drafted tasks and merge each PR " +
  "after checks pass? Phase 1 migrates workspace access, then phases 2 and 3 run in parallel.";
const FIRST_OPTIONS = ["Approve parallel rollout and merges", "Schedule only; hold merges"];
// A retry collapses only when it offers the same choices; only its question may be reworded.
const RETRY_OPTIONS = FIRST_OPTIONS;
const decisions = (question: string, labels: string[]): PlanDecision[] => [
  { id: "q", question, options: labels.map((label, i) => ({ id: `o${i}`, label })) },
];
const T0 = 1_800_000_000_000;
const AFTER_TIMEOUT = T0 + 5 * 60_000 + 15_000;

let n = 0;
function fixture() {
  const session = `sdk:supersede-${++n}`;
  const registry = new Registry();
  const reviews = new ReviewManager(registry);
  const events: ServerEvent[] = [];
  registry.subscribe((e) => events.push(e));
  const ask = (question: string, labels: string[], now: number, snoozable = true) =>
    reviews.create(session, "input", question, question, decisions(question, labels), { snoozable, now });
  return { session, registry, reviews, events, ask };
}

/** Like `fixture`, but asks the way request_input does when the agent passes `context`. */
function fixtureWithContext() {
  const base = fixture();
  const ask = (question: string, context: string, labels: string[], now: number) => {
    const body = context ? `${question}\n\n${context}` : question;
    return base.reviews.create(base.session, "input", question, body, decisions(question, labels), { snoozable: true, now });
  };
  return { ...base, ask };
}

test("a reworded retry after a client timeout withdraws the earlier card", () => {
  const { session, registry, events, ask } = fixture();
  const first = ask(FIRST, FIRST_OPTIONS, T0);
  const retry = ask(RETRY, RETRY_OPTIONS, AFTER_TIMEOUT);

  assert.notEqual(retry.id, first.id);
  assert.deepEqual(
    registry.pendingReviews(session).map((r) => r.id),
    [retry.id],
    "the operator still sees both cards for one decision",
  );
  assert.equal(registry.getReview(first.id)?.status, "superseded");
  assert.deepEqual(
    loadPendingReviews().filter((r) => r.sessionId === session).map((r) => r.id),
    [retry.id],
    "the withdrawal was not persisted, so a restart would bring the old card back",
  );
  const published = events.flatMap((e) => (e.type === "review_upsert" && e.review.id === first.id ? [e.review] : []));
  assert.equal(published.at(-1)?.status, "superseded", "the dashboard was never told the old card left");
});

test("a withdrawn card is nobody's answer and the agent's old call is told why", async () => {
  const { registry, reviews, ask } = fixture();
  const first = ask(FIRST, FIRST_OPTIONS, T0);
  // A client that never cancelled leaves its MCP child long-polling the old card.
  const stale = reviews.wait(first.id, 5_000);
  ask(RETRY, RETRY_OPTIONS, AFTER_TIMEOUT);

  const released = await stale;
  assert.equal(released?.status, "superseded");
  assert.equal(released?.resolvedBy, null);
  assert.equal(isConversationResolvedReview(registry.getReview(first.id)!), false,
    "a withdrawal would be drawn in the conversation as the operator's answer");
  const result = reviewToolResult(released!);
  assert.equal(result.isError, true);
  assert.match(result.text, /newer request_input question/);
});

test("a withdrawn card sends nothing to an agent whose wait had detached", () => {
  const { session, reviews, ask } = fixture();
  const delivered: string[] = [];
  reviews.startContinuationRecovery((review) => (delivered.push(review.id), true));
  const first = ask(FIRST, FIRST_OPTIONS, T0);
  reviews.detachWait(first.id, session);
  ask(RETRY, RETRY_OPTIONS, AFTER_TIMEOUT);
  assert.deepEqual(delivered, [], "the agent was messaged about a question it already re-asked");
});

test("parallel asks in one batch are all still waited on, so none is withdrawn", () => {
  const { session, registry, ask } = fixture();
  // Even worded as a retry: nothing in one batch can be retrying another call in that batch.
  ask(FIRST, FIRST_OPTIONS, T0);
  ask(RETRY, RETRY_OPTIONS, T0 + PARALLEL_ASK_WINDOW_MS - 1);
  assert.equal(registry.pendingReviews(session).length, 2);
});

test("an answered question is history, not something a later ask withdraws", () => {
  const { registry, reviews, ask } = fixture();
  const first = ask(FIRST, FIRST_OPTIONS, T0);
  reviews.resolve(first.id, "answer", "Approve", "human");
  ask(RETRY, RETRY_OPTIONS, AFTER_TIMEOUT);
  assert.equal(registry.getReview(first.id)?.status, "answered");
});

test("a question the operator snoozed stays, even after it comes back", () => {
  const { session, registry, reviews, ask } = fixture();
  const parked = ask(FIRST, FIRST_OPTIONS, T0);
  reviews.snooze(parked.id, 60_000, { mode: "judgment" }, T0 + 1_000);
  ask(RETRY, RETRY_OPTIONS, AFTER_TIMEOUT);
  assert.equal(registry.getReview(parked.id)?.status, "snoozed");

  reviews.wake(parked.id, AFTER_TIMEOUT + 60_000);
  ask(`${RETRY} (asked again)`, RETRY_OPTIONS, AFTER_TIMEOUT + 120_000);
  assert.equal(registry.getReview(parked.id)?.status, "pending",
    "a question the operator deliberately parked was withdrawn");
  assert.ok(registry.pendingReviews(session).some((r) => r.id === parked.id));
});

test("only request_input's own asks withdraw or are withdrawn", () => {
  const { session, registry, reviews, ask } = fixture();
  // Worded so the retry check alone WOULD match them; only the kind and flag keep them.
  const plan = reviews.create(session, "plan-decisions", FIRST, FIRST, decisions(FIRST, FIRST_OPTIONS), { now: T0 });
  const confirmation = ask(`${FIRST} Confirm.`, FIRST_OPTIONS, T0, false);
  const retry = ask(RETRY, RETRY_OPTIONS, AFTER_TIMEOUT);
  assert.equal(registry.getReview(plan.id)?.status, "pending");
  assert.equal(registry.getReview(confirmation.id)?.status, "pending");

  // ...and a confirmation raised later does not withdraw the request_input card either.
  ask(`${RETRY} Confirm.`, RETRY_OPTIONS, AFTER_TIMEOUT + 10 * 60_000, false);
  assert.equal(registry.getReview(retry.id)?.status, "pending");
});

test("another session's newer ask leaves yours alone", () => {
  const { session, registry, reviews, ask } = fixture();
  const mine = ask(FIRST, FIRST_OPTIONS, T0);
  reviews.create("sdk:someone-else", "input", RETRY, RETRY, decisions(RETRY, RETRY_OPTIONS), {
    snoozable: true,
    now: AFTER_TIMEOUT,
  });
  assert.equal(registry.getReview(mine.id)?.status, "pending");
  assert.equal(registry.pendingReviews(session).length, 1);
});

test("a byte-identical retry still re-attaches to the one open card", () => {
  const { session, registry, ask } = fixture();
  const first = ask(FIRST, FIRST_OPTIONS, T0);
  const retry = ask(FIRST, FIRST_OPTIONS, AFTER_TIMEOUT);
  assert.equal(retry.id, first.id);
  assert.equal(registry.getReview(first.id)?.status, "pending");
  assert.equal(registry.pendingReviews(session).length, 1);
});

test("a different later question never withdraws one the operator still has to answer", () => {
  const { session, registry, ask } = fixture();
  const first = ask(FIRST, FIRST_OPTIONS, T0);
  ask("Which linter should this repository use?", ["biome", "eslint"], AFTER_TIMEOUT);
  assert.equal(registry.getReview(first.id)?.status, "pending");
  assert.equal(registry.pendingReviews(session).length, 2);
});

const ANNOUNCE = "The previous prompt timed out. ";

/** Ask `older`, then after a client timeout `newer` in both forms; return the older card's status each time. */
function pairOutcomes(older: string, newer: string, labels: string[]): Array<[string, string | undefined]> {
  return ["", ANNOUNCE].map((lead) => {
    const { registry, ask } = fixture();
    const first = ask(older, labels, T0);
    ask(`${lead}${newer}`, labels, AFTER_TIMEOUT);
    return [`${lead}${newer}`, registry.getReview(first.id)?.status];
  });
}

test("asks that differ only in a phase number are different decisions, announced or not", () => {
  // From the live database: "Please review Phase 1 PR" then "Phase 2 PR", sharing 95% of their
  // words. A single digit is invisible to word overlap.
  const phase = (n: number) =>
    `Please approve Phase ${n} of the rollout: it migrates workspace access and runs the full suite before merge.`;
  for (const [newer, status] of pairOutcomes(phase(1), phase(2), ["Approve", "Request changes"])) {
    assert.equal(status, "pending", `withdrawn by: ${newer}`);
  }
});

test("asks that differ only in a PR number are different decisions, announced or not", () => {
  const byHash = (n: number) => `Please approve PR #${n}: it migrates workspace access and runs the full suite before merge.`;
  for (const [newer, status] of pairOutcomes(byHash(101), byHash(102), ["Approve", "Request changes"])) {
    assert.equal(status, "pending", `withdrawn by: ${newer}`);
  }
  const bare = (n: number) => `Please approve the migration (#${n}): it moves workspace access and runs the full suite before merge.`;
  for (const [newer, status] of pairOutcomes(bare(101), bare(102), ["Approve", "Request changes"])) {
    assert.equal(status, "pending", `withdrawn by: ${newer}`);
  }
  const byLink = (n: number) =>
    `Please approve https://github.com/acme/app/pull/${n}: it migrates workspace access and runs the full suite before merge.`;
  for (const [newer, status] of pairOutcomes(byLink(101), byLink(102), ["Approve", "Request changes"])) {
    assert.equal(status, "pending", `withdrawn by: ${newer}`);
  }
});

test("asks that differ only in who or what they name are different decisions, announced or not", () => {
  const grant = (who: string) => `Should I grant ${who} access to the production repository for the release?`;
  for (const [newer, status] of pairOutcomes(grant("Alice"), grant("Bob"), ["Approve", "Deny"])) {
    assert.equal(status, "pending", `withdrawn by: ${newer}`);
  }
});

test("a lower-case subject swapped inside the same wording is a different decision, announced or not", () => {
  const grant = (who: string) => `Should I grant ${who} access to the production repository for the release?`;
  for (const [newer, status] of pairOutcomes(grant("alice"), grant("bob"), ["Approve", "Deny"])) {
    assert.equal(status, "pending", `withdrawn by: ${newer}`);
  }
});

test("a subject replaced together with a qualifier is a different decision, announced or not", () => {
  const older = "Should I grant alice access to the production repository for the release?";
  const newer = "Should I grant bob temporary access to the production repository for the release?";
  for (const [asked, status] of pairOutcomes(older, newer, ["Approve", "Deny"])) {
    assert.equal(status, "pending", `withdrawn by: ${asked}`);
  }
  for (const [asked, status] of pairOutcomes(newer, older, ["Approve", "Deny"])) {
    assert.equal(status, "pending", `withdrawn by: ${asked}`);
  }
});

test("a swap counts up to three words for one, and no further", () => {
  assert.equal(MAX_SWAP_WORDS, 3);
  // Twenty words, one replaced by a run: only the swap check can keep the older card.
  const replaceWith = (run: string[]) => {
    const { registry, ask } = fixture();
    const first = ask(OLDER_WORDS.join(" "), [], T0);
    const newer = [...OLDER_WORDS.slice(0, 8), ...run, ...OLDER_WORDS.slice(9)];
    ask(`${ANNOUNCED} ${newer.join(" ")}`, [], AFTER_TIMEOUT);
    return registry.getReview(first.id)?.status;
  };
  assert.equal(replaceWith(["zqzw", "zqzx", "zqzy"]), "pending", "one word replaced by three was not a new subject");
  assert.equal(replaceWith(["zqzv", "zqzw", "zqzx", "zqzy"]), "superseded", "one word replaced by four was a new subject");
});

test("a retry that rewords two words for two is still the same decision", () => {
  // From the live database: "remove the old link" became "remove an existing link" in a real
  // announced retry. Flagging two-for-two swaps blocked it.
  const { registry, ask } = fixture();
  const first = ask(
    "Existing-link replacement needs a contract choice. If you refuse replacement, an operator must remove the old link before setup can continue.",
    ["Preserve entries with recovery", "Refuse existing-link replacement"],
    T0,
  );
  ask(
    "The restart interrupted the pending contract choice. If you refuse replacement, an operator must remove an existing link before setup can continue.",
    ["Preserve entries with recovery", "Refuse existing-link replacement"],
    AFTER_TIMEOUT,
  );
  assert.equal(registry.getReview(first.id)?.status, "superseded");
});

test("changed choices are a different decision, announced or not", () => {
  const question =
    "Should I roll the database migration out to production tonight, given that the staging copy finished cleanly and the on-call rotation changes at six?";
  const outcome = (newerQuestion: string, newerOptions: string[]) => {
    const { registry, ask } = fixture();
    const first = ask(question, ["Approve", "Deny"], T0);
    ask(newerQuestion, newerOptions, AFTER_TIMEOUT);
    return registry.getReview(first.id)?.status;
  };
  assert.equal(outcome(question, ["Approve", "Defer"]), "pending", '"Deny" to "Defer" withdrew the older card');
  assert.equal(outcome(`${ANNOUNCE}${question}`, ["Approve", "Defer"]), "pending", 'announced "Deny" to "Defer" withdrew it');
  assert.equal(outcome(`${ANNOUNCE}${question}`, ["Approve", "Deny", "Defer"]), "pending", "an added option withdrew it");
  // Unannounced, any reworded label is a changed choice, not only a one-word swap.
  assert.equal(outcome(question, ["Approve", "Hold it until Monday"]), "pending", "an unannounced reworded label withdrew it");
  assert.equal(outcome(`${ANNOUNCE}${question}`, ["Approve", "Deny"]), "superseded",
    "a retry with unchanged choices was not matched");
});

test("an announced retry that replaces a choice outright is a different decision", () => {
  // The reviewer's case: one option becomes a different action, the other stays.
  const question =
    "Should I ship the database migration tonight, given that the staging copy finished cleanly and the on-call rotation changes at six?";
  const { registry, ask } = fixture();
  const first = ask(question, ["approve for staging", "hold until Monday"], T0);
  ask(`${ANNOUNCE}${question}`, ["deploy to production", "hold until Monday"], AFTER_TIMEOUT);
  assert.equal(registry.getReview(first.id)?.status, "pending");
});

test("the issue's Codex retry, which replaced most of its choices, keeps both cards", () => {
  // From the live database. The retry kept the decision's topic but offered different choices
  // (0.08 and 0.10 of two options' wording survived), so it is not a duplicate to collapse.
  const { session, registry, ask } = fixture();
  const first = ask(FIRST, ["Approve parallel rollout and autonomous release", "Approve serial rollout and autonomous release", "Schedule only; hold merges for me"], T0);
  ask(RETRY, ["Proceed and merge after checks pass", "Schedule tasks, but hold merges", "Revise the scope first"], AFTER_TIMEOUT);
  assert.equal(registry.getReview(first.id)?.status, "pending");
  assert.equal(registry.pendingReviews(session).length, 2);
});

test("an announced retry that rewords any option keeps both cards", () => {
  // The operator's rule: identical choices, or two cards. A rewording that keeps every word of
  // meaning is still a different card, because no wording rule told it apart from a changed one.
  const question =
    "Should I ship the database migration tonight, given that the staging copy finished cleanly and the on-call rotation changes at six?";
  const { registry, reviews, session } = fixture();
  const ask = (q: string, detail: string, now: number) =>
    reviews.create(session, "input", q, q, [{ id: "q", question: q, options: [
      { id: "o0", label: "Hold", detail: "wait for the on-call change" },
      { id: "o1", label: "Ship", detail },
    ] }], { snoozable: true, now });
  const first = ask(question, "deploy the migration to staging first", T0);
  ask(`${ANNOUNCE}${question}`, "first deploy the migration to staging", AFTER_TIMEOUT);
  assert.equal(registry.getReview(first.id)?.status, "pending");
});

test("a choice whose detail changes its subject is a different decision, even under the same label", () => {
  // The reviewer's case: the labels stay, the last option's detail names another target.
  const question =
    "Should I ship the database migration tonight, given that the staging copy finished cleanly and the on-call rotation changes at six?";
  const outcome = (newerQuestion: string, detail: string) => {
    const { registry, reviews, session } = fixture();
    const ask = (q: string, last: string, now: number) =>
      reviews.create(session, "input", q, q, [{ id: "q", question: q, options: [
        { id: "o0", label: "Hold", detail: "wait for the on-call change" },
        { id: "o1", label: "Ship", detail: last },
      ] }], { snoozable: true, now });
    const first = ask(question, "deploy to staging", T0);
    ask(newerQuestion, detail, AFTER_TIMEOUT);
    return registry.getReview(first.id)?.status;
  };
  assert.equal(outcome(question.replace("Should I", "So, should I"), "deploy to production"), "pending",
    "an unannounced staging-to-production detail withdrew the older card");
  assert.equal(outcome(`${ANNOUNCE}${question}`, "deploy to production"), "pending",
    "an announced staging-to-production detail withdrew the older card");
  assert.equal(outcome(`${ANNOUNCE}${question}`, "deploy to the production cluster"), "pending",
    "one word replaced by three in the detail withdrew the older card");
  assert.equal(outcome(`${ANNOUNCE}${question}`, "deploy to staging"), "superseded",
    "an unchanged detail was treated as a different choice");
  assert.equal(outcome(`${ANNOUNCE}${question}`, "roll out to production"), "pending",
    "a detail rewritten to a different action withdrew the older card");
  assert.equal(outcome(`${ANNOUNCE}${question}`, "Deploy to staging."), "superseded",
    "a detail differing only in case and punctuation was treated as a different choice");
});

test("a label with one subject replaced by several words is a different choice", () => {
  const question =
    "Should I ship the database migration tonight, given that the staging copy finished cleanly and the on-call rotation changes at six?";
  const { registry, ask } = fixture();
  // Last, so no wording follows it for the word-swap check to anchor on: only the choice check sees it.
  const first = ask(question, ["hold until Monday", "approve for staging"], T0);
  ask(`${ANNOUNCE}${question}`, ["hold until Monday", "approve for the production cluster"], AFTER_TIMEOUT);
  assert.equal(registry.getReview(first.id)?.status, "pending");
});

test("a retry that rewrites a detail under the same label keeps both cards", () => {
  // From the live database: a real announced retry rewrote this detail, keeping its meaning.
  // Under the identical-choices rule it is a different card; this pins the stated cost.
  const question =
    "Existing-link replacement needs a contract choice. Which behavior should Setup use when another link already occupies the path?";
  const { registry, reviews, session } = fixture();
  const ask = (q: string, detail: string, now: number) =>
    reviews.create(session, "input", q, q, [{ id: "q", question: q, options: [
      { id: "o0", label: "Preserve entries with recovery", detail: "Keep automatic Setup repair." },
      { id: "o1", label: "Refuse existing-link replacement", detail },
    ] }], { snoozable: true, now });
  const first = ask(question,
    "Guarantee foreign paths are never moved by refusing automatic replacement; an operator must remove the old link before Setup can install.", T0);
  ask(`The restart interrupted the pending contract choice. ${question}`,
    "Keep foreign paths entirely untouched by refusing automatic replacement. The operator must remove an existing link before Setup can install.",
    AFTER_TIMEOUT);
  assert.equal(registry.getReview(first.id)?.status, "pending");
});

test("dropping the Recommended marker is not a changed choice", () => {
  const { registry, ask } = fixture();
  const question = "Which button location should I implement for Publish as Claude artifact, the toolbar or the row?";
  const first = ask(question, ["Files toolbar button (Recommended)", "Row in Open in"], T0);
  ask(`${ANNOUNCE}${question}`, ["Files toolbar button", "Row in Open in"], AFTER_TIMEOUT);
  assert.equal(registry.getReview(first.id)?.status, "superseded");
});

test("a question that gains or loses a negation is a different decision, announced or not", () => {
  // The reviewer's case: one inserted "not" reverses what Approve means, and overlap ignores it.
  const grant = "Should I grant alice access to production for this release?";
  const negated = "Should I not grant alice access to production for this release?";
  for (const [asked, status] of pairOutcomes(grant, negated, ["Approve", "Deny"])) {
    assert.equal(status, "pending", `withdrawn by: ${asked}`);
  }
  for (const [asked, status] of pairOutcomes(negated, grant, ["Approve", "Deny"])) {
    assert.equal(status, "pending", `withdrawn by: ${asked}`);
  }
  for (const contraction of ["Shouldn't I grant", "Shouldn\u2019t I grant", "Shouldnt I grant"]) {
    for (const [asked, status] of pairOutcomes(grant, grant.replace("Should I grant", contraction), ["Approve", "Deny"])) {
      assert.equal(status, "pending", `withdrawn by: ${asked}`);
    }
  }
});

test("a free-text ask is judged by its question paragraph, not its context", () => {
  // No options, so the question is the body's leading paragraph (`inputReviewBody`).
  const outcome = (newerQuestion: string, newerContext: string) => {
    const { session, registry, reviews } = fixture();
    const question = "Should I grant alice access to the production repository for this release?";
    const body = (q: string, ctx: string) => `${q}\n\n${ctx}`;
    const first = reviews.create(session, "input", question,
      body(question, "Neither the audit nor the change log flags her account."), null, { snoozable: true, now: T0 });
    reviews.create(session, "input", newerQuestion, body(newerQuestion, newerContext), null, { snoozable: true, now: AFTER_TIMEOUT });
    return registry.getReview(first.id)?.status;
  };
  assert.equal(
    outcome(`${ANNOUNCE}Should I grant alice access to the production repository for this release?`,
      "Her account came back clean from both sources we checked, the audit and the change log."),
    "superseded", "a negation that changed only in the context withdrew nothing");
  assert.equal(
    outcome(`${ANNOUNCE}Should I not grant alice access to the production repository for this release?`,
      "Neither the audit nor the change log flags her account."),
    "pending", "a negation added to the question withdrew the older card");
});

test("a negation inside the retry announcement does not count against the decision", () => {
  // The reviewer's case: "not" belongs to the sentence about the last call, not to the question.
  const { registry, ask } = fixture();
  const first = ask("Should I ship the migration tonight?", ["Approve", "Deny"], T0);
  ask("The previous prompt was not answered. Should I ship the migration tonight?", ["Approve", "Deny"], AFTER_TIMEOUT);
  assert.equal(registry.getReview(first.id)?.status, "superseded");
});

test("a question that adds or drops an action is a different decision, announced or not", () => {
  // The reviewer's case: approving the newer question authorizes more than the older one did.
  const narrow = "Should I deploy to production?";
  const broad = "Should I deploy to production and delete the database?";
  for (const [asked, status] of pairOutcomes(narrow, broad, ["Approve", "Deny"])) {
    assert.equal(status, "pending", `withdrawn by: ${asked}`);
  }
  for (const [asked, status] of pairOutcomes(broad, narrow, ["Approve", "Deny"])) {
    assert.equal(status, "pending", `withdrawn by: ${asked}`);
  }
  // Adding only a stopword changes nothing being decided.
  const { registry, ask } = fixture();
  const first = ask("Should I deploy to production?", ["Approve", "Deny"], T0);
  ask(`${ANNOUNCE}Should I deploy this to production?`, ["Approve", "Deny"], AFTER_TIMEOUT);
  assert.equal(registry.getReview(first.id)?.status, "superseded");
});

test("a context that changes the target is a different decision, announced or not", () => {
  // The reviewer's case: same question, same choices, and a short context naming another target.
  const outcome = (newerQuestion: string, olderContext: string, newerContext: string) => {
    const { registry, ask } = fixtureWithContext();
    const first = ask("Should I ship?", olderContext, ["Approve", "Hold"], T0);
    ask(newerQuestion, newerContext, ["Approve", "Hold"], AFTER_TIMEOUT);
    return registry.getReview(first.id)?.status;
  };
  for (const question of ["Should I ship?", `${ANNOUNCE}Should I ship?`]) {
    assert.equal(outcome(question, "Deploy to staging.", "Deploy to production."), "pending", `staging to production: ${question}`);
    assert.equal(outcome(question, "Deploy to staging.", "Deploy to staging and production."), "pending", `added target: ${question}`);
  }
  assert.equal(outcome(`${ANNOUNCE}Should I ship?`, "Deploy to staging.", "Deploy to staging."), "superseded",
    "an unchanged context was treated as a different target");
});

test("a negation that moves to another action is a different decision, announced or not", () => {
  // The reviewer's case: the same words and one "not", now reversing the other action.
  const older = "Should I not deploy to staging and deploy to production?";
  const newer = "Should I deploy to staging and not deploy to production?";
  for (const [asked, status] of pairOutcomes(older, newer, ["Approve", "Deny"])) {
    assert.equal(status, "pending", `withdrawn by: ${asked}`);
  }
  for (const [asked, status] of pairOutcomes(newer, older, ["Approve", "Deny"])) {
    assert.equal(status, "pending", `withdrawn by: ${asked}`);
  }
});

test("a question reworded around a kept negation is still the same decision", () => {
  // From the live database: a real retry rewrote the sentence holding its "cannot".
  const { registry, ask } = fixture();
  const first = ask(
    "The restart interrupted the pending contract choice. macOS and Linux cannot atomically replace a path only if its inode still matches. Which behavior should existing-link repair use when another process writes concurrently?",
    ["Preserve entries with recovery", "Refuse existing-link replacement"], T0);
  ask(
    // Reworded so the "cannot" also stands at a different position: only a question with the same
    // words around a moved negation is a reversal.
    "The restart interrupted this unanswered choice. Existing-link repair on macOS and Linux cannot atomically compare an inode and replace its path. Which behavior should existing-link repair use when another process writes concurrently?",
    ["Preserve entries with recovery", "Refuse existing-link replacement"], AFTER_TIMEOUT);
  assert.equal(registry.getReview(first.id)?.status, "superseded");
});

test("with to without reverses the decision, announced or not", () => {
  // GitHub Inspector on PR #1538: "with" is a stopword, so only reading "without" as a negation
  // keeps the edit from passing as rephrasing.
  for (const [asked, status] of pairOutcomes("Should I deploy with backups?", "Should I deploy without backups?", ["Approve", "Deny"])) {
    assert.equal(status, "pending", `withdrawn by: ${asked}`);
  }
  // An announcement that says the last call ended without an answer is not part of the decision.
  const { registry, ask } = fixture();
  const first = ask("Should I deploy with backups?", ["Approve", "Deny"], T0);
  ask("The earlier request timed out without an answer. Should I deploy with backups?", ["Approve", "Deny"], AFTER_TIMEOUT);
  assert.equal(registry.getReview(first.id)?.status, "superseded");
});

test("a retry that keeps its negation is still the same decision", () => {
  const { registry, ask } = fixture();
  const question = "Should I not grant alice access to the production repository for this release?";
  const first = ask(question, ["Approve", "Deny"], T0);
  ask(`${ANNOUNCE}${question}`, ["Approve", "Deny"], AFTER_TIMEOUT);
  assert.equal(registry.getReview(first.id)?.status, "superseded");
});

test("a short question about a different person never withdraws another's card", () => {
  // Foreman's short-subject-swap gap: too few words around the name for the word-swap check, and
  // with the same Approve/Deny options the overlap clears every threshold.
  const cases: Array<[string, string]> = [
    ["Grant alice access?", "Grant bob access?"],
    ["Should alice get production access?", "Should bob get production access?"],
    ["Grant alice access?", "Grant bob and carol access?"],
  ];
  for (const [older, newer] of cases) {
    for (const [asked, status] of pairOutcomes(older, newer, ["Approve", "Deny"])) {
      assert.equal(status, "pending", `withdrawn by: ${asked}`);
    }
  }
});

test("a question with several targets swapped is a different decision, announced or not", () => {
  // GitHub Inspector's case on PR #1538: two swaps, neither with three matching words on both sides,
  // and two edits rather than one.
  const older = "Should I deploy to staging and notify alice?";
  const newer = "Should I deploy to production and notify bob?";
  for (const [asked, status] of pairOutcomes(older, newer, ["Approve", "Deny"])) {
    assert.equal(status, "pending", `withdrawn by: ${asked}`);
  }
});

test("targets swapped in several places in the context are a different decision", () => {
  const { registry, ask } = fixtureWithContext();
  const first = ask("Should I ship?", "Deploy to staging and notify alice.", ["Approve", "Hold"], T0);
  ask(`${ANNOUNCE}Should I ship?`, "Deploy to production and notify bob.", ["Approve", "Hold"], AFTER_TIMEOUT);
  assert.equal(registry.getReview(first.id)?.status, "pending");
});

test("a short question repeated under a retry announcement is still the same decision", () => {
  const { registry, ask } = fixture();
  const first = ask("Grant alice access?", ["Approve", "Deny"], T0);
  ask("The capability decision is still unresolved; the earlier request timed out. Grant alice access?", ["Approve", "Deny"], AFTER_TIMEOUT);
  assert.equal(registry.getReview(first.id)?.status, "superseded");
  // Swapping only a stopword in a short question is phrasing, not a different subject.
  const again = fixture();
  const older = again.ask("Should I grant alice the access?", ["Approve", "Deny"], T0);
  again.ask("The earlier request timed out. Should I grant alice this access?", ["Approve", "Deny"], AFTER_TIMEOUT);
  assert.equal(again.registry.getReview(older.id)?.status, "superseded");
});

test("swapping only a stopword is rephrasing, not a different subject", () => {
  const { registry, ask } = fixture();
  const first = ask("Should I grant alice access to the production repository for this release?", ["Approve", "Deny"], T0);
  ask("Should I grant alice access to the production repository for the release?", ["Approve", "Deny"], AFTER_TIMEOUT);
  assert.equal(registry.getReview(first.id)?.status, "superseded");
});

test("a paraphrase sharing too little of the question keeps both cards, announced or not", () => {
  // The deliberate boundary: wording alone cannot tell this paraphrase from a different question.
  // Its identical options do not count as shared wording, so even announced it shares nothing.
  for (const [asked, status] of pairOutcomes(
    "Which linter should this repository use?",
    "Choose a linting tool for this project.",
    ["biome", "eslint"],
  )) {
    assert.equal(status, "pending", `withdrawn by: ${asked}`);
  }
  // An announced restatement that keeps the question's words is matched.
  const { registry, ask } = fixture();
  const first = ask("Which linter should this repository use?", ["biome", "eslint"], T0);
  ask(`${ANNOUNCE}Which linter should the repository use going forward?`, ["biome", "eslint"], AFTER_TIMEOUT);
  assert.equal(registry.getReview(first.id)?.status, "superseded");
});

test("a retry that drops a number the older ask named is still the same decision", () => {
  // Retries shorten. Losing "Codex 0.160.0" is not the same as naming a different revision.
  const { registry, ask } = fixture();
  const first = ask(
    "Phase 4 probes found Claude 2.1.310 and Codex 0.160.0 both admit project skills. Revision 16 needs a decision. How should Phase 4 proceed?",
    ["Ship catalog only", "Investigate wider isolation"],
    T0,
  );
  ask(
    "The earlier request timed out. Phase 4 probes found both harnesses admit project skills. Revision 16 needs a decision. How should Phase 4 proceed?",
    ["Ship catalog only", "Investigate wider isolation"],
    AFTER_TIMEOUT,
  );
  assert.equal(registry.getReview(first.id)?.status, "superseded");
});

test("a near-restatement with no retry announcement still replaces the earlier card", () => {
  // From the live database: re-asked after a delay without saying why.
  const { session, registry, ask } = fixture();
  const first = ask(
    "Which button location should I implement for Publish as Claude artifact? Option A puts it in the file header, option B in the overflow menu.",
    ["File header", "Overflow menu"],
    T0,
  );
  const again = ask(
    "Please confirm which button location I should implement for Publish as Claude artifact: option A in the file header, or option B in the overflow menu?",
    ["File header", "Overflow menu"],
    AFTER_TIMEOUT,
  );
  assert.equal(registry.getReview(first.id)?.status, "superseded");
  assert.deepEqual(registry.pendingReviews(session).map((r) => r.id), [again.id]);
});

// ---- the boundaries, each pinned on both sides ----
//
// Content words from a pool that cannot collide with a stopword, the retry announcement, or a
// labelled number, so each ask's overlap is exactly `shared / 20`.
const POOL = Array.from({ length: 80 }, (_, i) => `zq${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`);
const OLDER_WORDS = POOL.slice(0, 20);
/**
 * Twenty content words, `shared` of them from the older ask and the rest fresh. The shared words
 * come reversed, so the overlap is exactly `shared / 20` while no run of the older ask survives
 * in order: what is measured is the overlap threshold, not an edit to the same sentence.
 */
const newerWords = (shared: number) => [...POOL.slice(40, 40 + 20 - shared), ...OLDER_WORDS.slice(0, shared).reverse()];
/** "previous", "prompt" and "timed" add three content words, so the smaller side stays the older 20. */
const ANNOUNCED = "The previous prompt timed out.";

function overlapCase(newer: string, at = AFTER_TIMEOUT) {
  const { registry, ask } = fixture();
  const first = ask(OLDER_WORDS.join(" "), [], T0);
  ask(newer, [], at);
  return registry.getReview(first.id)?.status;
}

test("an announced retry needs exactly 35% shared wording", () => {
  assert.equal(ANNOUNCED_RETRY_MIN_OVERLAP, 0.35);
  assert.equal(overlapCase(`${ANNOUNCED} ${newerWords(6).join(" ")}`), "pending", "6/20 = 0.30 withdrew the older card");
  assert.equal(overlapCase(`${ANNOUNCED} ${newerWords(7).join(" ")}`), "superseded", "7/20 = 0.35 kept the older card");
  assert.equal(overlapCase(`${ANNOUNCED} ${newerWords(8).join(" ")}`), "superseded", "8/20 = 0.40 kept the older card");
});

test("an unannounced rewording needs exactly 80% shared wording", () => {
  assert.equal(REWORDED_MIN_OVERLAP, 0.8);
  assert.equal(overlapCase(newerWords(15).join(" ")), "pending", "15/20 = 0.75 withdrew the older card");
  assert.equal(overlapCase(newerWords(16).join(" ")), "superseded", "16/20 = 0.80 kept the older card");
  assert.equal(overlapCase(newerWords(17).join(" ")), "superseded", "17/20 = 0.85 kept the older card");
});

test("a swapped word needs exactly three matching words on each side to mark a new subject", () => {
  assert.equal(SWAP_CONTEXT_WORDS, 3);
  // The swap sits in the CONTEXT, so the question is unchanged and only the word-swap check can
  // keep the older card. Four inserted words at the front stop the matching run on the left, which
  // would otherwise reach back into the question, and are too long a run for the small-edits
  // check; the context's end stops the run on the right.
  const question = "Which option should the release take?";
  const swapAt = (index: number) => {
    const { registry, ask } = fixtureWithContext();
    const first = ask(question, OLDER_WORDS.join(" "), [], T0);
    const newer = [...OLDER_WORDS];
    newer[index] = "zqzz";
    ask(question, ["zqia", "zqib", "zqic", "zqid", ...newer].join(" "), [], AFTER_TIMEOUT);
    return registry.getReview(first.id)?.status;
  };
  assert.equal(swapAt(2), "superseded", "two words before the swap marked a new subject");
  assert.equal(swapAt(3), "pending", "three words before the swap did not mark a new subject");
  assert.equal(swapAt(16), "pending", "three words after the swap did not mark a new subject");
  assert.equal(swapAt(17), "superseded", "two words after the swap marked a new subject");
});

test("the parallel window ends at exactly 30 seconds", () => {
  assert.equal(PARALLEL_ASK_WINDOW_MS, 30_000);
  const retry = `${ANNOUNCED} ${newerWords(20).join(" ")}`;
  assert.equal(overlapCase(retry, T0 + PARALLEL_ASK_WINDOW_MS - 1), "pending", "a parallel call 1 ms inside the window was withdrawn");
  assert.equal(overlapCase(retry, T0 + PARALLEL_ASK_WINDOW_MS), "superseded", "a retry exactly 30 s later was kept");
  assert.equal(overlapCase(retry, T0 + PARALLEL_ASK_WINDOW_MS + 1), "superseded", "a retry 1 ms past the window was kept");
});

test("an ask that mentions a timeout but asks about something else leaves the older card", () => {
  const { registry, ask } = fixture();
  const first = ask(FIRST, FIRST_OPTIONS, T0);
  ask(
    "The earlier request timed out, so separately: which linter should this repository use?",
    ["biome", "eslint"],
    AFTER_TIMEOUT,
  );
  assert.equal(registry.getReview(first.id)?.status, "pending");
});

test("only the question the retry repeats is withdrawn, never its unrelated neighbours", () => {
  const { session, registry, ask } = fixture();
  const linter = ask("Which linter should this repository use?", ["biome", "eslint"], T0);
  const first = ask(FIRST, FIRST_OPTIONS, T0 + PARALLEL_ASK_WINDOW_MS + 1);
  const retry = ask(RETRY, RETRY_OPTIONS, AFTER_TIMEOUT + PARALLEL_ASK_WINDOW_MS);
  assert.equal(registry.getReview(first.id)?.status, "superseded");
  assert.equal(registry.getReview(linter.id)?.status, "pending");
  assert.deepEqual(registry.pendingReviews(session).map((r) => r.id).sort(), [linter.id, retry.id].sort());
});

test("the shapes real agents retry in are recognised", () => {
  // Paraphrases of the other retries the live database recorded, as request_input builds them:
  // the question, then its context after a blank line (`inputReviewBody`).
  const pairs: Array<[[string, string], [string, string]]> = [
    [
      ["How should this phase proceed?",
        "Phase 4 probes found that neither Claude nor Codex enforces the approved frozen skill set with the proposed overlay."],
      ["The capability decision is still unresolved; the earlier request timed out. How should this phase proceed?",
        "Probes show the Claude overlay and Codex overlay both admit project skills, so the frozen skill set is not enforced."],
    ],
    [
      ["How broadly should we address sessions getting stuck before workflow handoff?", ""],
      ["The previous scope question was interrupted by the restart. How broadly should we address sessions getting stuck before workflow handoff?", ""],
    ],
  ];
  for (const [[olderQ, olderCtx], [newerQ, newerCtx]] of pairs) {
    const { registry, ask } = fixtureWithContext();
    const first = ask(olderQ, olderCtx, ["Narrow fix", "Broad fix"], T0);
    ask(newerQ, newerCtx, ["Narrow fix", "Broad fix"], AFTER_TIMEOUT);
    assert.equal(registry.getReview(first.id)?.status, "superseded", newerQ);
  }
});

test("a negation that changes only in the context is restating, not a different decision", () => {
  // "neither ... nor" in one context, "not" twice in the other: the question is unchanged.
  const { registry, ask } = fixtureWithContext();
  const question = "Should I keep skill selection unavailable for this phase of the catalog work?";
  const first = ask(question, "Probes found that neither Claude nor Codex enforces the frozen skill set.", ["Keep it", "Investigate"], T0);
  ask(`${ANNOUNCE}${question}`, "Probes show Claude does not enforce the frozen skill set, and Codex does not either.",
    ["Keep it", "Investigate"], AFTER_TIMEOUT);
  assert.equal(registry.getReview(first.id)?.status, "superseded");
});

// ---- PR #1538 review findings ----

test("a retry reference in the context is not a retry announcement", () => {
  // CodeRabbit: "See previous request." in the context must not earn the 35% threshold. The
  // questions share 67% of their wording, enough for an announced retry and not for a plain one.
  const outcome = (newerQuestion: string, newerContext: string) => {
    const { registry, ask } = fixtureWithContext();
    const first = ask("Should the nightly job compact the event log before the backup window opens?",
      "Storage is nearly full.", ["Approve", "Hold"], T0);
    ask(newerQuestion, newerContext, ["Approve", "Hold"], AFTER_TIMEOUT);
    return registry.getReview(first.id)?.status;
  };
  const reordered = "Before the backup window opens, should the event log be compacted by the nightly job?";
  assert.equal(outcome(reordered, "See previous request."), "pending", "a context reference earned the lower threshold");
  assert.equal(outcome(`The previous prompt timed out. ${reordered}`, "Storage is nearly full."), "superseded",
    "an announcement in the question did not earn the lower threshold");
});

test("identical options are a gate, not wording the questions share", () => {
  // CodeRabbit: two different questions offering the same long options reached 80% on the options.
  const options = ["Approve and proceed as proposed", "Hold pending further operator review"];
  const { registry, ask } = fixture();
  const first = ask("Enable caching?", options, T0);
  ask("Rotate the stale database credentials now?", options, AFTER_TIMEOUT);
  assert.equal(registry.getReview(first.id)?.status, "pending");
});

test("pull request numbers are compared across reference formats", () => {
  // CodeRabbit: "PR #101" and ".../pull/102" were filed under different labels and never compared.
  const { registry, ask } = fixture();
  const first = ask("Please review the migration in PR #101 before the release.", ["Approve", "Request changes"], T0);
  ask("The previous prompt timed out. Please review the migration in https://github.com/acme/app/pull/102 before the release.",
    ["Approve", "Request changes"], AFTER_TIMEOUT);
  assert.equal(registry.getReview(first.id)?.status, "pending");
});

test("a number's sign in an option is part of the choice", () => {
  // CodeRabbit: "+5" and "-5" normalized to the same words.
  const question = "Which clock offset should the scheduler apply for the nightly window?";
  const outcome = (newerDetail: string) => {
    const { registry, reviews, session } = fixture();
    const ask = (q: string, detail: string, now: number) =>
      reviews.create(session, "input", q, q, [{ id: "q", question: q, options: [
        { id: "o0", label: "Apply", detail }, { id: "o1", label: "Leave it" },
      ] }], { snoozable: true, now });
    const first = ask(question, "Set offset to +5", T0);
    ask(`${ANNOUNCE}${question}`, newerDetail, AFTER_TIMEOUT);
    return registry.getReview(first.id)?.status;
  };
  assert.equal(outcome("Set offset to -5"), "pending", "a flipped sign withdrew the older card");
  assert.equal(outcome("Set offset to +5."), "superseded", "a trailing period was treated as a changed choice");
});

test("a decision that mentions a previous request is still compared", () => {
  // CodeRabbit: the whole question matched the announcement phrase and was stripped from both sides.
  for (const [asked, status] of pairOutcomes("Should I approve the previous request?", "Should I not approve the previous request?", ["Approve", "Deny"])) {
    assert.equal(status, "pending", `withdrawn by: ${asked}`);
  }
});

test("a failed withdrawal leaves neither the new card nor the withdrawal", () => {
  // CodeRabbit: the insert and the withdrawal commit together, or not at all.
  const { session, registry, ask } = fixture();
  const first = ask(FIRST, FIRST_OPTIONS, T0);
  openDb().exec(`CREATE TRIGGER fail_supersede BEFORE UPDATE OF status ON reviews
    WHEN NEW.status = 'superseded' BEGIN SELECT RAISE(ABORT, 'withdrawal failed'); END`);
  try {
    assert.throws(() => ask(RETRY, RETRY_OPTIONS, AFTER_TIMEOUT), /withdrawal failed/);
  } finally {
    openDb().exec("DROP TRIGGER fail_supersede");
  }
  const persisted: ReviewItem[] = loadPendingReviews().filter((r) => r.sessionId === session);
  assert.deepEqual(persisted.map((r) => r.id), [first.id], "the new card was written without its withdrawal");
  assert.deepEqual(registry.pendingReviews(session).map((r) => r.id), [first.id], "the new card was published");

  const retry = ask(RETRY, RETRY_OPTIONS, AFTER_TIMEOUT + 1);
  assert.equal(registry.getReview(first.id)?.status, "superseded");
  assert.deepEqual(loadPendingReviews().filter((r) => r.sessionId === session).map((r) => r.id), [retry.id]);
});
