import assert from "node:assert/strict";
import test from "node:test";

import {
  documentHits,
  hitLine,
  hitsInWindow,
  stepIndex,
} from "../src/web/lib/documentFind.ts";

/**
 * The document find core: counts, the ring, and the line every jump is built on.
 *
 * The rule under test is the one the whole feature rests on - a counted match is a match
 * some surface can show and step to - so these cases are about the count being exactly the
 * occurrences in the string it was given, and about the line being right in every newline
 * convention this app can open a file in.
 */

const SOURCE = [
  "# Reconnect notes",
  "",
  "The reconnect budget is bounded.",
  "See [the audit](docs/reconnect-audit.md) for the reconnect trace.",
  "",
].join("\n");

test("documentHits counts every occurrence in the string it is given", () => {
  const hits = documentHits(SOURCE, "reconnect", { caseSensitive: false }, "source");
  // The heading, the prose, and - on line 4 - once inside the link DESTINATION and once in
  // the prose after it. The destination is the occurrence Markdown preview cannot show,
  // which is why each surface counts the string it renders rather than sharing this list.
  assert.deepEqual(
    hits.map((hit) => hit.line),
    [1, 3, 4, 4],
  );
  for (const hit of hits) {
    assert.equal(SOURCE.slice(hit.start, hit.end).toLowerCase(), "reconnect");
  }
});

test("documentHits keys are stable for a query and namespaced by surface", () => {
  const source = documentHits(SOURCE, "budget", { caseSensitive: false }, "source");
  const again = documentHits(SOURCE, "budget", { caseSensitive: false }, "source");
  const rendered = documentHits(SOURCE, "budget", { caseSensitive: false }, "rendered");
  assert.deepEqual(source.map((hit) => hit.key), again.map((hit) => hit.key));
  assert.deepEqual(source.map((hit) => hit.key), ["source:33"]);
  assert.deepEqual(rendered.map((hit) => hit.key), ["rendered:33"]);
  // A rendered key and a source key at the same offset must never be interchangeable.
  assert.notDeepEqual(source.map((hit) => hit.key), rendered.map((hit) => hit.key));
});

test("documentHits honours the case flag", () => {
  assert.equal(documentHits(SOURCE, "Reconnect", { caseSensitive: true }, "source").length, 1);
  assert.equal(documentHits(SOURCE, "Reconnect", { caseSensitive: false }, "source").length, 4);
});

test("documentHits answers an empty query with nothing rather than everything", () => {
  assert.deepEqual(documentHits(SOURCE, "", { caseSensitive: false }, "source"), []);
  // The zero-length guard: a matcher that could match "" would never advance and never
  // terminate. The empty query is refused before that can happen.
  assert.deepEqual(documentHits("", "reconnect", { caseSensitive: false }, "source"), []);
});

test("documentHits treats the query literally, not as a pattern", () => {
  const text = "call foo(bar) and then fooXbar";
  const hits = documentHits(text, "foo(bar)", { caseSensitive: false }, "source");
  assert.deepEqual(hits.map((hit) => hit.start), [5]);
});

test("hitLine counts CRLF as one break, at the file's start and end", () => {
  const crlf = "first\r\nsecond\r\nthird";
  assert.equal(hitLine(crlf, 0), 1);
  assert.equal(hitLine(crlf, 5), 1);
  // Between the CR and the LF, the break has not been passed: still line 1.
  assert.equal(hitLine(crlf, 6), 1);
  assert.equal(hitLine(crlf, 7), 2);
  assert.equal(hitLine(crlf, crlf.length), 3);
  // Past the end and before the start both clamp rather than inventing a line.
  assert.equal(hitLine(crlf, crlf.length + 40), 3);
  assert.equal(hitLine(crlf, -3), 1);
  // A lone CR is a break too, because the editor preserves whichever the file used.
  assert.equal(hitLine("first\rsecond", 6), 2);
  assert.equal(hitLine("", 0), 1);
});

test("documentHits reports the same lines hitLine does, in every convention", () => {
  for (const eol of ["\n", "\r\n", "\r"]) {
    const text = ["alpha", "beta match", "gamma", "match again"].join(eol);
    const hits = documentHits(text, "match", { caseSensitive: false }, "source");
    assert.deepEqual(
      hits.map((hit) => hit.line),
      hits.map((hit) => hitLine(text, hit.start)),
      `lines disagree for ${JSON.stringify(eol)}`,
    );
    assert.deepEqual(hits.map((hit) => hit.line), [2, 4]);
  }
});

test("stepIndex wraps in both directions and refuses an empty ring", () => {
  assert.equal(stepIndex(3, 0, 1), 1);
  assert.equal(stepIndex(3, 2, 1), 0);
  assert.equal(stepIndex(3, 0, -1), 2);
  assert.equal(stepIndex(1, 0, 1), 0);
  assert.equal(stepIndex(0, -1, 1), -1);
  assert.equal(stepIndex(0, 4, -1), -1);
});

test("hitsInWindow clips a straddling hit into both halves under one key", () => {
  const hits = documentHits("read prompt.ts", "read prompt", { caseSensitive: false }, "source");
  assert.equal(hits.length, 1);
  const key = hits[0]!.key;
  const left = hitsInWindow(hits, 0, 4);
  const right = hitsInWindow(hits, 5, 14);
  assert.deepEqual(left, [{ key, start: 0, end: 4, line: 1 }]);
  assert.deepEqual(right, [{ key, start: 0, end: 6, line: 1 }]);
  // A hit wholly on the far side is dropped, not clipped to nothing.
  assert.deepEqual(hitsInWindow(hits, 12, 14), []);
});
