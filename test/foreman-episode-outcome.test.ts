import { test } from "node:test";
import assert from "node:assert/strict";
import { EPISODE_OUTCOMES, episodeOutcome, readSkipReason } from "../src/shared/foreman.ts";
import type { EpisodeOutcome } from "../src/shared/foreman.ts";

// What is at stake: `skipped` was one word standing in for three unrelated events, and on
// a real 833-episode ledger the two it did NOT describe were the majority of the pile.
//
//   235 of 318 skips were the reviewer being beaten by the clock - it reached a verdict and
//   the session moved on before it could be delivered. In the newest hundred rows, 8 of the
//   12 skips were escalations the OPERATOR had closed unanswered. Both rendered under a
//   tile captioned "the asks Foreman could not read, and left alone", which is a fair
//   description of neither, and beside a "decided by" cell reading `you · cheap` - as if
//   the human had reached for the cheap tier themselves.
//
// This is the derivation that separates them. It is pure, it is the only place the split
// is decided, and both the ledger cell and its hover read it - so a row cannot come to
// disagree with its own tooltip about what happened.

/** An episode's three deciding fields, defaulted to the commonest shape. */
function ep(over: Partial<Parameters<typeof episodeOutcome>[0]> = {}) {
  return { disposition: "answered" as const, resolvedBy: null, skipReason: null, ...over };
}

test("the dispositions that were never ambiguous map straight through", () => {
  assert.equal(episodeOutcome(ep({ disposition: "answered" })), "answered");
  assert.equal(episodeOutcome(ep({ disposition: "pending" })), "drafted");
  assert.equal(episodeOutcome(ep({ disposition: "escalated" })), "escalated");
});

// An answer is an answer whoever typed it. Who did stays in the "decided by" cell, which is
// the column that has always carried it correctly - `resolvedBy`, never `sentBy`.
test("an approval you confirmed is still an answer, not a fourth outcome", () => {
  assert.equal(episodeOutcome(ep({ disposition: "answered", resolvedBy: "you" })), "answered");
  assert.equal(episodeOutcome(ep({ disposition: "answered", resolvedBy: "foreman" })), "answered");
});

test("a skip Foreman chose is a decline", () => {
  assert.equal(
    episodeOutcome(ep({ disposition: "skipped", resolvedBy: "foreman", skipReason: null })),
    "declined",
  );
});

// The race. Foreman HAD a verdict - the recommendation is preserved on this very row - and
// the session moved on before it could be delivered. Nothing was sent and nothing was
// judged, which is why calling it a skip made the ledger's largest pile its least honest.
test("a verdict discarded because the session moved on is stale, not a skip", () => {
  assert.equal(
    episodeOutcome(ep({ disposition: "skipped", resolvedBy: "foreman", skipReason: "stale" })),
    "stale",
  );
});

// The human's own call, which the record already knew and nothing read: `resolveEpisode`
// stamps `resolvedBy: "you"` on a dismissal precisely so it stays legible apart from a
// decline. Reading it as "Foreman skipped this" credits Foreman with the operator's
// decision, which is the same class of error `episodeLabel` exists to prevent on the card.
test("an escalation you closed unanswered is a dismissal, not a decline", () => {
  assert.equal(
    episodeOutcome(ep({ disposition: "skipped", resolvedBy: "you", skipReason: null })),
    "dismissed",
  );
});

// Order of the two skip tests above, pinned. They cannot both be true of one episode - a
// stale row was never escalated, so no human ever saw it to dismiss - but the write path
// stamps `resolvedBy: "foreman"` on any self-resolved skip, so only the explicit ordering
// keeps a future `resolvedBy` change from silently re-labelling every stale row.
test("the stale mark outranks the author, so a stale row can never read as dismissed", () => {
  assert.equal(
    episodeOutcome(ep({ disposition: "skipped", resolvedBy: "you", skipReason: "stale" })),
    "stale",
  );
});

// Every historical row - all 833 of them at the time this shipped - has a null skip reason,
// because the column did not exist. They must read as the panel has always described them
// rather than as the new outcome, so the split adds a distinction going forward and does
// not retroactively re-characterise history it has no evidence about.
test("a row written before the column reads as the panel always described it", () => {
  assert.equal(
    episodeOutcome(ep({ disposition: "skipped", resolvedBy: "foreman", skipReason: null })),
    "declined",
  );
});

// An unknown skip reason from a newer build must not become a nearest match. Same rule the
// shadow columns state: a value this build cannot read is not evidence for a reading it can.
test("a skip reason a newer build minted reads as absent, not as stale", () => {
  assert.equal(readSkipReason("abandoned"), null);
  assert.equal(readSkipReason(null), null);
  assert.equal(readSkipReason("stale"), "stale");
});

// The vocabulary and the derivation have to stay one thing: an outcome the derivation can
// return that the vocabulary does not list has no label, no colour, and no hover.
test("every outcome the derivation can produce is in the declared vocabulary", () => {
  const produced = new Set<EpisodeOutcome>([
    episodeOutcome(ep({ disposition: "answered" })),
    episodeOutcome(ep({ disposition: "pending" })),
    episodeOutcome(ep({ disposition: "escalated" })),
    episodeOutcome(ep({ disposition: "skipped", resolvedBy: "foreman" })),
    episodeOutcome(ep({ disposition: "skipped", resolvedBy: "foreman", skipReason: "stale" })),
    episodeOutcome(ep({ disposition: "skipped", resolvedBy: "you" })),
  ]);
  for (const o of produced) assert.ok(EPISODE_OUTCOMES.includes(o), `${o} is not declared`);
  // And the other way: a declared outcome nothing can produce is a dead label.
  assert.equal(produced.size, EPISODE_OUTCOMES.length);
});
