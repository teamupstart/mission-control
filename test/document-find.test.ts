import assert from "node:assert/strict";
import test from "node:test";

import {
  documentHits,
  frameFindCount,
  frameFindIndex,
  hitLine,
  hitLinesByBlock,
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

test("hitLinesByBlock offers one ring entry per reachable location", () => {
  /*
   * The HTML preview can only be told a LINE, so two occurrences on one line are two things
   * nothing can tell apart: both resolve requests are byte-identical and both answers name the
   * same block. Offering them as two ring entries promised a step that could not happen, and
   * could reveal the block belonging to the other occurrence.
   */
  const source = [
    "<p>reconnect</p><p>reconnect again</p>",  // line 1: two blocks, two matches
    "<p>nothing here</p>",                     // line 2
    "<p>reconnect</p>",                        // line 3
  ].join("\n");
  const hits = documentHits(source, "reconnect", { caseSensitive: false }, "source");
  assert.equal(hits.length, 3, "three occurrences in the source");
  assert.deepEqual(hits.map((hit) => hit.line), [1, 1, 3]);
  // ...but only two places the reveal can distinguish.
  assert.deepEqual(hitLinesByBlock(hits), [1, 3]);
});

test("hitLinesByBlock keeps document order and revisits a line that recurs", () => {
  const of = (...lines: number[]) => lines.map((line, at) => ({
    key: `source:${at}`,
    start: at,
    end: at + 1,
    line,
  }));
  assert.deepEqual(hitLinesByBlock(of(4, 4, 4)), [4]);
  assert.deepEqual(hitLinesByBlock(of(1, 2, 3)), [1, 2, 3]);
  // Not a set: a line the walk returns to after leaving it is a second location to visit,
  // which cannot arise from `documentHits` but must not silently collapse if it ever does.
  assert.deepEqual(hitLinesByBlock(of(1, 2, 1)), [1, 2, 1]);
  assert.deepEqual(hitLinesByBlock([]), []);
});

// ---- which reveal the sandboxed HTML preview shows ----

test("htmlRevealChoice gives the comment jump precedence over a live find reveal", async () => {
  const { htmlRevealChoice } = await import("../src/web/components/FileWorkspace.tsx");
  const comment = { blockPath: [{ index: 1, tag: "section" }], nonce: 7 };
  const find = { blockPath: [{ index: 2, tag: "p" }], nonce: 3 };

  /*
   * The frame can show only ONE outline - `missionJump` removes the previous target as it sets
   * the next - and two sources can ask. They used to post independently from two effects, so
   * whichever fired last won and a find reveal could displace a comment jump the reader had
   * just performed. The comment jump wins because it is an explicit navigation; find's reveal
   * follows the ring and is re-sent by the next step anyway.
   */
  assert.equal(htmlRevealChoice(comment, find)?.source, "comment");
  assert.deepEqual(htmlRevealChoice(comment, find)?.target, comment);

  // Find owns the frame when nothing else is asking.
  assert.equal(htmlRevealChoice(null, find)?.source, "find");
  assert.deepEqual(htmlRevealChoice(null, find)?.target, find);

  // Nobody asking is its own answer, and NOT an instruction to reveal something.
  assert.equal(htmlRevealChoice(null, null), null);
});

test("a comment jump arriving over a find reveal takes the frame, and is re-posted", async () => {
  const { htmlRevealChoice } = await import("../src/web/components/FileWorkspace.tsx");
  const comment = { blockPath: [{ index: 1, tag: "section" }], nonce: 7 };
  const find = { blockPath: [{ index: 2, tag: "p" }], nonce: 3 };

  /*
   * The clobbering half of the report. Find owns the frame, then the reader opens a comment
   * thread: the answer flips to the comment's block AND its key changes, so the single posting
   * effect actually sends it. Under the two independent effects this depended on which one
   * happened to fire last, and a later find step could displace the comment jump silently.
   */
  const before = htmlRevealChoice(null, find);
  const after = htmlRevealChoice(comment, find);
  assert.equal(before?.source, "find");
  assert.equal(after?.source, "comment");
  assert.notEqual(after?.key, before?.key, "the key must change, or nothing would be posted");

  /*
   * And once a comment jump is live, find stepping its ring cannot take the frame back - which
   * is the precedence, not an accident of effect ordering.
   */
  const stepped = htmlRevealChoice(comment, { blockPath: [{ index: 5, tag: "p" }], nonce: 4 });
  assert.equal(stepped?.source, "comment");
  assert.equal(stepped?.key, after?.key, "a find step must not re-post over a comment jump");
});

test("no source asking is not an instruction to clear, which this phase cannot send", async () => {
  const { htmlRevealChoice } = await import("../src/web/components/FileWorkspace.tsx");
  /*
   * The other half of the report, recorded honestly rather than papered over. Closing find with
   * no comment jump live leaves nothing to reveal, and the answer is `null` - which the posting
   * effect treats as "send nothing", NOT as "clear the outline".
   *
   * It cannot mean clear: the frame's `missionJump` only removes the previous target as it sets
   * a new one, and a path that walks nowhere resolves to `document.body`, so posting "nothing"
   * would outline the whole page. A real clear needs a new hash-pinned script and a CSP change,
   * which is Phase 2's scoped edit. The last outline therefore stays until the frame reloads.
   */
  assert.equal(htmlRevealChoice(null, null), null);
});

test("htmlRevealChoice keys on the block AND the nonce, so a repeat jump is a new request", async () => {
  const { htmlRevealChoice } = await import("../src/web/components/FileWorkspace.tsx");
  const path = [{ index: 1, tag: "section" }, { index: 0, tag: "p" }];

  // Identical input is one request: re-posting would re-run the frame's smooth scroll under a
  // reader who had scrolled away from it.
  assert.equal(
    htmlRevealChoice(null, { blockPath: path, nonce: 4 })?.key,
    htmlRevealChoice(null, { blockPath: path, nonce: 4 })?.key,
  );
  // A new nonce on the SAME block is a fresh ask - find stepping back onto it, or a deep link
  // followed twice - and must not be swallowed as a no-op.
  assert.notEqual(
    htmlRevealChoice(null, { blockPath: path, nonce: 4 })?.key,
    htmlRevealChoice(null, { blockPath: path, nonce: 5 })?.key,
  );
  // A different block at the same nonce is a different answer.
  assert.notEqual(
    htmlRevealChoice(null, { blockPath: path, nonce: 4 })?.key,
    htmlRevealChoice(null, { blockPath: [{ index: 9, tag: "div" }], nonce: 4 })?.key,
  );
  // The two sources never collide on a key, even naming the same block at the same nonce.
  assert.notEqual(
    htmlRevealChoice({ blockPath: path, nonce: 4 }, null)?.key,
    htmlRevealChoice(null, { blockPath: path, nonce: 4 })?.key,
  );
});

/*
 * ---- the count a frame reports, and the window before it arrives ----
 *
 * A surface this origin cannot read reports its own count by message, so a round trip
 * separates the keystroke from the number. What may be shown in that window is not a
 * presentation detail: the HTML preview's whole reason for counting inside the frame is that
 * the count equals what is highlighted, and both of the obvious answers break it.
 */

const session = (query: string, caseSensitive = false, index = 0) => (
  { query, caseSensitive, index }
);
/** The previewed source a count was taken over. Two distinct documents, by content. */
const DOC = "<p>the budget is bounded</p>";
const EDITED = "<p>the budget is bounded</p><!-- edited -->";
const reply = (query: string, count: number, caseSensitive = false, document = DOC) => (
  { query, caseSensitive, count, document }
);

test("a frame's count for the query and document the bar is holding is the count", () => {
  assert.equal(frameFindCount(reply("budget", 3), session("budget"), DOC), 3);
  // Zero from the frame is a real answer about the document, not an absent one.
  assert.equal(frameFindCount(reply("nope", 0), session("nope"), DOC), 0);
});

test("a previous query's count is never displayed once the query moves on", () => {
  /*
   * The defect GitHub Inspector found on PR #827, round 1, pinned.
   *
   * The first implementation carried the last agreed count through the window, reasoning that
   * it beat flashing `No results` over a query that matches. It does not: the frame applies
   * the new query and repaints BEFORE its reply is delivered, so changing a three-hit query to
   * a no-hit one showed `1 / 3` over a document with nothing highlighted. Null is the answer,
   * and the bar renders it as no number rather than as `No results`.
   */
  const stale = reply("budget", 3);
  assert.equal(frameFindCount(stale, session("zzz"), DOC), null);
  // Every intermediate state of typing is the same window, not just the final one.
  for (const typed of ["b", "bu", "bud", "budge"]) {
    assert.equal(
      frameFindCount(stale, session(typed), DOC),
      null,
      `stale count shown for ${typed}`,
    );
  }
});

test("flipping the case flag re-opens the window, because it re-runs the search", () => {
  const found = reply("Budget", 3, false);
  assert.equal(frameFindCount(found, session("Budget", false), DOC), 3);
  // `Aa` changes the answer exactly as retyping does, so the old number is just as wrong.
  assert.equal(frameFindCount(found, session("Budget", true), DOC), null);
});

test("a count does not survive the srcDoc reload that destroys the highlights it counted", () => {
  /*
   * The defect GitHub Inspector found on PR #827, round 2, and the same mistake as round 1 in
   * a much larger window.
   *
   * The preview's `srcDoc` is rebuilt whenever the previewed source changes, which reloads the
   * document and destroys its `CSS.highlights`. The count was keyed to the query and the case
   * flag but not to the document, so across a reload the bar kept the old number - and kept
   * stepping enabled - over a frame with nothing highlighted at all. That window is a parse, a
   * style pass and four scripts, not a message round trip.
   *
   * The original justification for leaving it was that clearing bought nothing but a flicker.
   * The flicker was `No results`, which round 1's fix removed: with "not known" representable,
   * clearing is free.
   */
  const counted = reply("budget", 3, false, DOC);
  // Same query, same case flag, one edit later: the count describes a document that is gone.
  assert.equal(frameFindCount(counted, session("budget"), EDITED), null);
  // And it comes back by itself when the reloaded frame reports against the new source.
  assert.equal(
    frameFindCount(reply("budget", 3, false, EDITED), session("budget"), EDITED),
    3,
  );
});

test("an empty query is counted, not awaited, whatever the document is doing", () => {
  // Nothing was asked, so nothing is outstanding: zero rather than null, which keeps the bar
  // from sitting in a permanent "not known" state whenever find is open and empty.
  assert.equal(frameFindCount(null, session(""), DOC), 0);
  assert.equal(frameFindCount(reply("x", 2), session(""), DOC), 0);
  assert.equal(frameFindCount(reply("x", 2), session(""), EDITED), 0);
});

test("no reply yet, and no session at all, are both unknown rather than zero", () => {
  // Before the frame has answered once - find opened over a preview still loading.
  assert.equal(frameFindCount(null, session("budget"), DOC), null);
  // No find session: there is no query to have an answer about.
  assert.equal(frameFindCount(null, null, DOC), null);
});

test("the index handed to a frame does not move the reader while the count is unknown", () => {
  /*
   * A regression introduced by the fix for Inspector round 2, caught by re-reading it.
   *
   * Keying the count to the previewed source makes it null across a reload, which makes the
   * CLAMPED index -1 there - clamping against a ring of unknown size has no answer. The posted
   * index was `max(clamped, 0)`, so a reader sitting on the third match was moved back to the
   * first every time the document reloaded under them, silently.
   *
   * This case is NOT covered end to end, and the attempt is instructive: switching to the
   * Editor and back unmounts the preview, which clears the bridge and drops the workspace into
   * the source-derived fallback, so the browser test passed with and without the fix. The
   * reachable path is a change to the file on disk while Preview is on screen. The rule is
   * pinned here instead, where the mutation actually fails.
   */
  const on3rd = session("budget", false, 2);
  // Count known: the clamped index is what the reader is looking at.
  assert.equal(frameFindIndex(on3rd, 2, true), 2);
  // Count known and the ring shrank under them: still the clamped one, never past the end.
  assert.equal(frameFindIndex(on3rd, 1, true), 1);
  // Count UNKNOWN: the stored index, so the reload leaves the reader where they were.
  assert.equal(frameFindIndex(on3rd, -1, false), 2);
  // And never a negative, whichever branch produced it.
  assert.equal(frameFindIndex(session("budget", false, -5), -1, false), 0);
  assert.equal(frameFindIndex(null, -1, false), 0);
});
