import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectHits,
  hitsInScope,
  matchesIn,
  buildMatcher,
  splitForHighlight,
  stepIndex,
  turnWho,
} from "../src/web/lib/find.ts";
import type { ConversationRow } from "../src/web/lib/episodes.ts";
import type { TranscriptMessage, ToolCall } from "../src/shared/types.ts";

/**
 * Find-in-conversation's match model.
 *
 * What is at stake is the COUNT. This feature's whole promise is "there are N of
 * these and here is each one", so a count that does not equal the number of
 * highlightable spans is the defect that matters - it is also invisible, because a
 * wrong number looks exactly like a right one. Every test here exists to pin the
 * count and the spans to the same source of truth.
 *
 * Kept pure and DOM-free on purpose: the design exploration behind this feature
 * highlighted by mutating the DOM, which cannot be tested without a browser and is
 * wrong in a React tree anyway (a streamed turn re-renders the turn and destroys
 * injected marks). Returning ranges instead is what makes this file possible.
 */

function msg(over: Partial<TranscriptMessage> = {}): TranscriptMessage {
  return { id: "m1", role: "user", text: "", tools: [], ts: 0, ...over };
}

function turn(id: string, m: Partial<TranscriptMessage>): ConversationRow {
  return { kind: "turn", id, ts: 0, message: msg({ id, ...m }) };
}

function tools(id: string, list: ToolCall[]): ConversationRow {
  return { kind: "tools", id, ts: 0, tools: list };
}

test("counts every occurrence, including several in one turn", () => {
  const rows = [turn("a", { text: "pane and pane and pane" })];
  const hits = collectHits(rows, "pane", { caseSensitive: false }, "claude");
  assert.equal(hits.length, 3);
  assert.deepEqual(
    hits.map((h) => h.start),
    [0, 9, 18],
  );
});

test("every counted hit yields exactly one highlightable span", () => {
  // The invariant the whole feature rests on. splitForHighlight is what the renderer
  // walks, so if these two ever disagree the count is lying about what is on screen.
  const text = "the registry names the registry that the registry holds";
  const rows = [turn("a", { text })];
  const hits = collectHits(rows, "registry", { caseSensitive: false }, "claude");
  const segments = splitForHighlight(
    text,
    hits.map((h) => ({ start: h.start, end: h.end })),
  );
  assert.equal(segments.filter((s) => s.isMatch).length, hits.length);
  // And the spans reassemble into the original text, so nothing is dropped or doubled.
  assert.equal(segments.map((s) => s.text).join(""), text);
});

test("a role byline is not searchable", () => {
  // Without the exclusion, "you" matches the label above every message the human ever
  // sent - useless, and the largest count in the log.
  const rows = [turn("a", { role: "user", text: "nothing here" })];
  assert.equal(collectHits(rows, "you", { caseSensitive: false }, "claude").length, 0);
  // The byline itself is still the string the rail shows.
  assert.equal(turnWho(msg({ role: "user" }), "claude"), "you");
  assert.equal(turnWho(msg({ role: "assistant" }), "claude"), "claude");
  assert.equal(turnWho(msg({ role: "user", origin: "foreman" }), "claude"), "foreman");
});

test("case sensitivity is honoured, and off by default finds both", () => {
  const rows = [turn("a", { text: "Ghostty and ghostty" })];
  assert.equal(collectHits(rows, "ghostty", { caseSensitive: false }, "claude").length, 2);
  assert.equal(collectHits(rows, "ghostty", { caseSensitive: true }, "claude").length, 1);
});

test("the query is literal, not a regular expression", () => {
  // Reached with the same chord as a browser's find, so `foo(bar)` means those seven
  // characters. A user typing a paren must not get a syntax error or a wildcard.
  const rows = [turn("a", { text: "call foo(bar) twice: foo(bar)" })];
  assert.equal(collectHits(rows, "foo(bar)", { caseSensitive: false }, "claude").length, 2);
  const dots = [turn("a", { text: "a.b and axb" })];
  assert.equal(collectHits(dots, "a.b", { caseSensitive: false }, "claude").length, 1);
});

test("an empty query matches nothing rather than everything", () => {
  const rows = [turn("a", { text: "anything" })];
  assert.equal(collectHits(rows, "", { caseSensitive: false }, "claude").length, 0);
  assert.equal(buildMatcher("", { caseSensitive: false }), null);
});

test("a zero-length match cannot hang the scan", () => {
  // matchesIn drives a /g regex by hand; a pattern that can match empty would never
  // advance lastIndex on its own.
  const re = /x*/g;
  const out = matchesIn("abc", re);
  assert.deepEqual(out, []);
});

test("tool chips are searchable, because that is where the paths are", () => {
  const rows = [
    tools("t1", [{ name: "Read", input: JSON.stringify({ file_path: "/repo/registry.ts" }) }]),
  ];
  const hits = collectHits(rows, "registry", { caseSensitive: false }, "claude");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.scope, "tool");
  assert.equal(hits[0]?.toolIndex, 0);
});

test("scope filters by who said it, and `all` is the identity", () => {
  const rows = [
    turn("a", { role: "user", text: "pane" }),
    turn("b", { role: "assistant", text: "pane" }),
    tools("t1", [{ name: "Read", input: JSON.stringify({ file_path: "/x/pane.ts" }) }]),
  ];
  const hits = collectHits(rows, "pane", { caseSensitive: false }, "claude");
  assert.equal(hitsInScope(hits, "all").length, hits.length);
  assert.equal(hitsInScope(hits, "user").length, 1);
  assert.equal(hitsInScope(hits, "assistant").length, 1);
  assert.equal(hitsInScope(hits, "tool").length, 1);
});

test("hits arrive in document order", () => {
  // The rail lists them and Enter walks them; both are only coherent if the order is
  // the order the reader would scroll past.
  const rows = [
    turn("a", { text: "pane one" }),
    turn("b", { text: "pane two" }),
    turn("c", { text: "pane three" }),
  ];
  const hits = collectHits(rows, "pane", { caseSensitive: false }, "claude");
  assert.deepEqual(
    hits.map((h) => h.rowId),
    ["a", "b", "c"],
  );
});

test("Foreman's episode cards are not part of the conversation being searched", () => {
  const rows: ConversationRow[] = [
    turn("a", { text: "pane" }),
    {
      kind: "episode",
      ts: 0,
      episode: { id: "e1", marker: "m", note: "pane pane pane" } as never,
    },
  ];
  assert.equal(collectHits(rows, "pane", { caseSensitive: false }, "claude").length, 1);
});

test("stepping wraps at both ends, the way a browser's find does", () => {
  assert.equal(stepIndex(3, 0, 1), 1);
  assert.equal(stepIndex(3, 2, 1), 0, "forward past the end wraps to the first");
  assert.equal(stepIndex(3, 0, -1), 2, "backward past the start wraps to the last");
  assert.equal(stepIndex(0, -1, 1), -1, "nothing to step through stays at -1");
});

test("hit keys are stable for the same query, so a streamed turn cannot move the ring", () => {
  const rows = [turn("a", { text: "pane and pane" })];
  const first = collectHits(rows, "pane", { caseSensitive: false }, "claude");
  const again = collectHits(
    [...rows, turn("b", { text: "later turn arrives" })],
    "pane",
    { caseSensitive: false },
    "claude",
  );
  assert.deepEqual(
    first.map((h) => h.key),
    again.slice(0, 2).map((h) => h.key),
  );
});

test("a rail snippet carries context either side and marks where it was cut", () => {
  const text = `${"x".repeat(80)}needle${"y".repeat(80)}`;
  const hits = collectHits([turn("a", { text })], "needle", { caseSensitive: false }, "claude");
  const h = hits[0]!;
  assert.equal(h.hit, "needle");
  assert.ok(h.pre.startsWith("…"), "a cut start is marked with an ellipsis");
  assert.ok(h.post.endsWith("…"), "a cut end is marked with an ellipsis");
  assert.ok(h.pre.length < text.length, "the snippet is bounded, not the whole turn");
});

test("text with no matches returns one unmatched segment, not an empty render", () => {
  assert.deepEqual(splitForHighlight("hello", []), [{ text: "hello", start: 0, isMatch: false }]);
  assert.deepEqual(splitForHighlight("", []), []);
});
