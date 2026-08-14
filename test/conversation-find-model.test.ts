import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectHits,
  hitsInScope,
  hitsInWindow,
  matchesIn,
  buildMatcher,
  splitForHighlight,
  stepIndex,
  toolLineText,
  toolSearchText,
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
  // `endTs` matches `ts` here: these fixtures are undated, and a folded run of one turn
  // ends where it starts. Nothing in the search model reads it - it exists for the
  // terminal rendering's span - but the row type is one shape for both.
  return { kind: "tools", id, ts: 0, endTs: 0, tools: list };
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

test("a match spanning a chip's name and detail marks both halves, not neither", () => {
  // A chip is collected as one string ("read registry.ts") and rendered as two spans,
  // so a query across the space between them belongs to both. Filtering each span by
  // containment drops it from both, and the rail could then navigate to a match with
  // nothing marked on screen - a counted hit that is not a visible one.
  const rows = [
    tools("t1", [{ name: "Read", input: JSON.stringify({ file_path: "/repo/registry.ts" }) }]),
  ];
  const searchText = toolSearchText(rows[0]!.kind === "tools" ? rows[0]!.tools[0]! : ({} as ToolCall));
  const name = "read";
  const detailOffset = searchText.length - "registry.ts".length;

  const hits = collectHits(rows, "read registry", { caseSensitive: false }, "claude");
  assert.equal(hits.length, 1, "the chip text is searched as one unit");

  const nameHits = hitsInWindow(hits, 0, name.length);
  const detailHits = hitsInWindow(hits, detailOffset, searchText.length);
  assert.equal(nameHits.length, 1, "the part inside the name survives, clipped");
  assert.equal(detailHits.length, 1, "so does the part inside the detail");
  assert.deepEqual({ start: nameHits[0]?.start, end: nameHits[0]?.end }, { start: 0, end: 4 });
  assert.deepEqual({ start: detailHits[0]?.start, end: detailHits[0]?.end }, { start: 0, end: 8 });
  // Both halves are the SAME match, so the ring still counts it once.
  assert.equal(nameHits[0]?.key, detailHits[0]?.key);
});

test("hitsInWindow drops what is wholly outside and keeps what straddles", () => {
  const base = { key: "k", rowId: "r", toolIndex: null, scope: "user", who: "you", pre: "", hit: "", post: "" } as const;
  const hits = [
    { ...base, key: "before", start: 0, end: 3 },
    { ...base, key: "straddle", start: 8, end: 14 },
    { ...base, key: "inside", start: 12, end: 15 },
    { ...base, key: "after", start: 30, end: 34 },
  ];
  const out = hitsInWindow(hits, 10, 20);
  assert.deepEqual(
    out.map((h) => [h.key, h.start, h.end]),
    [
      ["straddle", 0, 4],
      ["inside", 2, 5],
    ],
  );
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

test("the You scope means the human, not everything wearing the user role", () => {
  // The defect this pins: the scope was set from `role` alone on the line right after
  // `turnWho` had already read `origin` for the byline, so one hit could carry
  // who: "foreman" and scope: "user" at once. Filtering to "You" then returned rows
  // whose own byline said foreman - the pill claiming the human asked for work that
  // Foreman delivered.
  const rows = [
    turn("mine", { role: "user", text: "pane" }),
    turn("f", { role: "user", origin: "foreman", text: "pane" }),
    turn("h", { role: "user", origin: "harness", text: "pane" }),
  ];
  const hits = collectHits(rows, "pane", { caseSensitive: false }, "claude");

  const you = hitsInScope(hits, "user");
  assert.deepEqual(you.map((h) => h.rowId), ["mine"]);
  // The property that failed before, stated directly: no hit may say one thing on its
  // byline and another in its scope.
  for (const h of you) assert.equal(h.who, "you");

  // Nothing became unfindable - the machine-typed turns moved to their own scope and
  // are still reachable under `all`, which is the default.
  assert.deepEqual(hitsInScope(hits, "injected").map((h) => h.rowId), ["f", "h"]);
  assert.equal(hitsInScope(hits, "all").length, 3);
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

// ---- searching a tool call in each of the two renderings ----
//
// The chat log draws a tool call as a chip carrying the capped summary; the terminal
// rendering draws it as a line carrying the literal input. Different text on screen for
// the same call, so `collectHits` takes the projection to search with. What these pin is
// the module's founding rule under that split: what is COUNTED is what is SHOWN, in
// whichever rendering is up - never more (a hit nobody can see or jump to) and never less
// (text plainly on screen that find reports zero of).

const RUN: ToolCall = { name: "Bash", input: JSON.stringify({ command: "git status --short" }) };

test("a chat chip is searched over the summary it draws, and no further", () => {
  const rows = [tools("r", [RUN])];
  // `bash git` is what the chip shows, and both halves match.
  assert.equal(collectHits(rows, "bash", { caseSensitive: false }, "claude").length, 1);
  assert.equal(collectHits(rows, "git", { caseSensitive: false }, "claude").length, 1);
  // The rest of the command lives only in the chip's hover tooltip. Counting it would
  // promise a jump to a highlight that cannot exist on screen.
  assert.equal(collectHits(rows, "--short", { caseSensitive: false }, "claude").length, 0);
  assert.equal(collectHits(rows, "status", { caseSensitive: false }, "claude").length, 0);
});

test("a terminal line is searched over the whole command it draws", () => {
  const rows = [tools("r", [RUN])];
  const hits = collectHits(rows, "--short", { caseSensitive: false }, "claude", toolLineText);
  assert.equal(hits.length, 1, "text plainly on screen in an opened record was uncountable");
  // Addressed inside the rendered string, so the renderer's window arithmetic can place it.
  const text = toolLineText(RUN);
  assert.equal(text, "bash git status --short");
  assert.equal(text.slice(hits[0]!.start, hits[0]!.end), "--short");
  assert.equal(
    collectHits(rows, "status", { caseSensitive: false }, "claude", toolLineText).length,
    1,
  );
});

test("every hit in a line lands inside one of the two spans that draw it", () => {
  // The renderer splits the searched string into a name span and a target span, and
  // re-expresses each hit into those coordinates. A hit outside both windows would be
  // counted with nothing to mark, which is the failure this whole module is shaped to
  // make impossible.
  const text = toolLineText(RUN);
  const name = "bash";
  const target = text.slice(name.length + 1);
  for (const query of ["bash", "git", "status", "--short", "sh"]) {
    const hits = collectHits([tools("r", [RUN])], query, { caseSensitive: false }, "claude", toolLineText);
    for (const h of hits) {
      const inName = hitsInWindow([h], 0, name.length).length > 0;
      const inTarget = hitsInWindow([h], name.length + 1, text.length).length > 0;
      assert.ok(inName || inTarget, `"${query}" matched at ${h.start} with no span to mark it`);
    }
  }
  // And the two spans reassemble into exactly the string that was searched, so the line a
  // reader copies is the line find walked.
  assert.equal(`${name} ${target}`, text);
});

test("a call with no readable input is its bare name in both renderings", () => {
  const bare: ToolCall = { name: "Bash" };
  assert.equal(toolLineText(bare), "bash");
  assert.equal(toolSearchText(bare), "bash");
});
