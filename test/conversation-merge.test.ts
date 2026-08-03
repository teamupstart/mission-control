import { test } from "node:test";
import assert from "node:assert/strict";
import type { ForemanEpisode, ReviewItem, TranscriptMessage } from "../src/shared/types.ts";
import { mergeConversation, type ConversationRow } from "../src/web/lib/episodes.ts";
import { transcriptRows } from "../src/web/lib/tools.ts";

// Where the out-of-band entries land in the conversation: Foreman's decisions, and the
// human's answers to reviews.
//
// The ordering is the whole feature: an entry placed wrong reads as a reply to a message
// that appears below it.

function msg(id: string, ts: number, over: Partial<TranscriptMessage> = {}): TranscriptMessage {
  return { id, role: "assistant", text: `turn ${id}`, tools: [], ts, ...over };
}

function ep(id: number, createdAt: number): ForemanEpisode {
  return {
    id,
    noteKey: "k",
    sessionId: "s",
    marker: `await:${id}`,
    situation: "terminal-pane",
    surface: "terminal",
    question: "q",
    pane: null,
    menu: null,
    reviewId: null,
    purpose: null,
    brief: null,
    recommendation: null,
    classification: null,
    confidence: null,
    tier: null,
    cheapAction: null,
    divergence: null,
    triageReason: null,
    skipReason: null,
    disposition: "escalated",
    lastAction: null,
    sentText: null,
    sentOption: null,
    sentBy: null,
    createdAt,
    resolvedAt: null,
    resolvedBy: null,
  };
}

function review(id: string, resolvedAt: number | null, over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id,
    sessionId: "s",
    kind: "input",
    title: "pick one",
    body: "pick one",
    status: "answered",
    response: "Answered:\n\n• pick one\n  → A",
    decisions: null,
    selections: null,
    resolvedBy: "human",
    createdAt: 1,
    resolvedAt,
    ...over,
  };
}

/** The merged order as a readable list: turn ids, episode markers, and review ids. */
function order(rows: ConversationRow[]): string[] {
  if (rows.some((r) => r.kind === "review" && r.review.id.startsWith("await:"))) {
    throw new Error("review ids must not collide with episode markers in this fixture");
  }
  return rows.map((r) =>
    r.kind === "episode" ? r.episode.marker : r.kind === "review" ? r.review.id : r.id,
  );
}

test("nothing to interleave leaves the transcript exactly as it was", () => {
  const rows = transcriptRows([msg("a", 100), msg("b", 200)]);
  assert.equal(mergeConversation(rows, []), rows, "the same array, not a copy");
  assert.equal(mergeConversation(rows, [], []), rows, "still the same array with reviews");
});

test("an episode lands between the turns it happened between", () => {
  const rows = transcriptRows([msg("a", 100), msg("b", 300)]);
  const merged = mergeConversation(rows, [ep(1, 200)]);
  assert.deepEqual(order(merged), ["a", "await:1", "b"]);
});

test("episodes arrive newest-first and are still placed oldest-first", () => {
  // episodesFor() orders DESC for the drawer; the conversation needs ASC.
  const rows = transcriptRows([msg("a", 100), msg("b", 300), msg("c", 500)]);
  const merged = mergeConversation(rows, [ep(3, 400), ep(2, 200)]);
  assert.deepEqual(order(merged), ["a", "await:2", "b", "await:3", "c"]);
});

test("a tie keeps the transcript turn first", () => {
  // Foreman answers within seconds of the turn that provoked it, and second-
  // resolution timestamps collide. Placing the episode first would show it replying
  // to a message printed underneath its reply.
  const rows = transcriptRows([msg("a", 200)]);
  const merged = mergeConversation(rows, [ep(1, 200)]);
  assert.deepEqual(order(merged), ["a", "await:1"]);
});

test("an episode after every turn goes last", () => {
  const rows = transcriptRows([msg("a", 100), msg("b", 200)]);
  const merged = mergeConversation(rows, [ep(1, 900)]);
  assert.deepEqual(order(merged), ["a", "b", "await:1"]);
});

test("an episode before every turn goes first", () => {
  const rows = transcriptRows([msg("a", 500)]);
  const merged = mergeConversation(rows, [ep(1, 100)]);
  assert.deepEqual(order(merged), ["await:1", "a"]);
});

test("an undated episode sorts LAST, not first", () => {
  // createdAt 0 is what a missing time reads as. Sorting numerically would file the
  // episode we know least about above turns that definitely preceded it.
  const rows = transcriptRows([msg("a", 100), msg("b", 200)]);
  const merged = mergeConversation(rows, [ep(1, 0)]);
  assert.deepEqual(order(merged), ["a", "b", "await:1"]);
});

test("episodes render even when the transcript has no turns at all", () => {
  // The case that matters for an auto-discovered session whose JSONL can't be
  // resolved: Foreman's record is then the only thing there is to show.
  const merged = mergeConversation([], [ep(1, 100), ep(2, 200)]);
  assert.equal(merged.length, 2);
});

test("a folded tool run carries the FIRST turn's timestamp", () => {
  // A run that keeps absorbing turns would otherwise walk forward in time while the
  // reader looks at it, and an episode interleaved against it would jump position.
  const rows = transcriptRows([
    msg("t1", 100, { text: "", tools: [{ name: "Bash", input: "ls" } as never] }),
    msg("t2", 900, { text: "", tools: [{ name: "Bash", input: "pwd" } as never] }),
  ]);
  assert.equal(rows.length, 1, "the two tool turns fold into one row");
  assert.equal(rows[0]!.ts, 100);
  const merged = mergeConversation(rows, [ep(1, 500)]);
  assert.deepEqual(order(merged), ["t1", "await:1"], "the episode follows the folded run");
});

// ---- the human's review answers ----

test("a review lands where it was ANSWERED, not where it was asked", () => {
  // The distinction that matters: an agent can block on a question across a long stretch
  // of work. Placing the entry at `createdAt` would file your reply above everything the
  // agent did while waiting for it.
  const rows = transcriptRows([msg("a", 100), msg("b", 200), msg("c", 300)]);
  const merged = mergeConversation(rows, [], [review("r1", 250, { createdAt: 110 })]);
  assert.deepEqual(order(merged), ["a", "b", "r1", "c"]);
});

test("reviews and episodes interleave with each other, not just with the turns", () => {
  const rows = transcriptRows([msg("a", 100), msg("b", 500)]);
  const merged = mergeConversation(rows, [ep(1, 300)], [review("r1", 200), review("r2", 400)]);
  assert.deepEqual(order(merged), ["a", "r1", "await:1", "r2", "b"]);
});

test("a review sharing a turn's timestamp follows it", () => {
  // Same rule as an episode's tie: an answer printed above the turn that prompted it
  // reads as a reply to nothing.
  const rows = transcriptRows([msg("a", 200)]);
  const merged = mergeConversation(rows, [], [review("r1", 200)]);
  assert.deepEqual(order(merged), ["a", "r1"]);
});

test("a born-settled review sharing its released reply's timestamp precedes it", () => {
  // Driver-question answers are recorded only after delivery succeeds, with a timestamp
  // captured immediately before delivery. The agent can write its reply in that same
  // millisecond, but the answer still belongs above the turn it released.
  const rows = transcriptRows([msg("ask", 100), msg("reply", 200)]);
  const merged = mergeConversation(rows, [], [
    review("r1", 200, { createdAt: 200, resolvedAt: 200 }),
  ]);
  assert.deepEqual(order(merged), ["ask", "r1", "reply"]);
});

test("a review with no resolution stamp sorts LAST, not first", () => {
  const rows = transcriptRows([msg("a", 100), msg("b", 200)]);
  const merged = mergeConversation(rows, [], [review("r1", null)]);
  assert.deepEqual(order(merged), ["a", "b", "r1"]);
});

test("a born-settled review with only the missing-time sentinel still sorts last", () => {
  const rows = transcriptRows([msg("a", 0), msg("b", 200)]);
  const merged = mergeConversation(rows, [], [review("r1", 0, { createdAt: 0 })]);
  assert.deepEqual(order(merged), ["a", "b", "r1"]);
});

test("reviews render even when the transcript has no turns at all", () => {
  // The auto-discovered session whose JSONL cannot be resolved: what you decided is then
  // the only account of the session there is.
  const merged = mergeConversation([], [], [review("r1", 100), review("r2", 200)]);
  assert.deepEqual(order(merged), ["r1", "r2"]);
});

test("reviews arriving out of order are still placed oldest-first", () => {
  const rows = transcriptRows([msg("a", 100), msg("b", 300), msg("c", 500)]);
  const merged = mergeConversation(rows, [], [review("r2", 400), review("r1", 200)]);
  assert.deepEqual(order(merged), ["a", "r1", "b", "r2", "c"]);
});
