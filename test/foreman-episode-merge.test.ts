import { test } from "node:test";
import assert from "node:assert/strict";
import type { ForemanEpisode, TranscriptMessage } from "../src/shared/types.ts";
import { mergeEpisodes } from "../src/web/lib/episodes.ts";
import { transcriptRows } from "../src/web/lib/tools.ts";

// Where Foreman's decisions land in the conversation.
//
// The ordering is the whole feature: an episode placed wrong reads as Foreman
// answering a message that appears below its answer.

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

/** The merged order as a readable list: turn ids and episode markers. */
function order(rows: ReturnType<typeof mergeEpisodes>): string[] {
  return rows.map((r) => (r.kind === "episode" ? r.episode.marker : r.id));
}

test("no episodes leaves the transcript exactly as it was", () => {
  const rows = transcriptRows([msg("a", 100), msg("b", 200)]);
  assert.equal(mergeEpisodes(rows, []), rows, "the same array, not a copy");
});

test("an episode lands between the turns it happened between", () => {
  const rows = transcriptRows([msg("a", 100), msg("b", 300)]);
  const merged = mergeEpisodes(rows, [ep(1, 200)]);
  assert.deepEqual(order(merged), ["a", "await:1", "b"]);
});

test("episodes arrive newest-first and are still placed oldest-first", () => {
  // episodesFor() orders DESC for the drawer; the conversation needs ASC.
  const rows = transcriptRows([msg("a", 100), msg("b", 300), msg("c", 500)]);
  const merged = mergeEpisodes(rows, [ep(3, 400), ep(2, 200)]);
  assert.deepEqual(order(merged), ["a", "await:2", "b", "await:3", "c"]);
});

test("a tie keeps the transcript turn first", () => {
  // Foreman answers within seconds of the turn that provoked it, and second-
  // resolution timestamps collide. Placing the episode first would show it replying
  // to a message printed underneath its reply.
  const rows = transcriptRows([msg("a", 200)]);
  const merged = mergeEpisodes(rows, [ep(1, 200)]);
  assert.deepEqual(order(merged), ["a", "await:1"]);
});

test("an episode after every turn goes last", () => {
  const rows = transcriptRows([msg("a", 100), msg("b", 200)]);
  const merged = mergeEpisodes(rows, [ep(1, 900)]);
  assert.deepEqual(order(merged), ["a", "b", "await:1"]);
});

test("an episode before every turn goes first", () => {
  const rows = transcriptRows([msg("a", 500)]);
  const merged = mergeEpisodes(rows, [ep(1, 100)]);
  assert.deepEqual(order(merged), ["await:1", "a"]);
});

test("an undated episode sorts LAST, not first", () => {
  // createdAt 0 is what a missing time reads as. Sorting numerically would file the
  // episode we know least about above turns that definitely preceded it.
  const rows = transcriptRows([msg("a", 100), msg("b", 200)]);
  const merged = mergeEpisodes(rows, [ep(1, 0)]);
  assert.deepEqual(order(merged), ["a", "b", "await:1"]);
});

test("episodes render even when the transcript has no turns at all", () => {
  // The case that matters for an auto-discovered session whose JSONL can't be
  // resolved: Foreman's record is then the only thing there is to show.
  const merged = mergeEpisodes([], [ep(1, 100), ep(2, 200)]);
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
  const merged = mergeEpisodes(rows, [ep(1, 500)]);
  assert.deepEqual(order(merged), ["t1", "await:1"], "the episode follows the folded run");
});
