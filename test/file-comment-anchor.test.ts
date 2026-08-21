import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  FILE_COMMENT_QUOTE_MAX,
  boundQuote,
  fileCommentQuoteHash,
  normalizeQuote,
  reanchor,
  sha256Hex,
  sliceLines,
  type FileCommentAnchor,
} from "../src/shared/file-comment-anchor.ts";

// What is at stake: this module decides whether a queued comment is still ABOUT the text it
// was written about. Get it wrong in one direction and the walkthrough sends a comment
// quoting a paragraph the agent deleted three edits ago; get it wrong in the other and every
// comment is held as outdated the moment the file is touched at all.
//
// It is pure, so it is the cheapest part of the feature to test exhaustively and the part
// most worth testing that way.

const FILE = ["alpha", "bravo", "charlie", "delta", "echo"].join("\n");

function anchor(over: Partial<FileCommentAnchor> = {}): FileCommentAnchor {
  const path = over.path ?? "docs/plan.md";
  const quote = over.quote ?? "charlie";
  return {
    path,
    startLine: 3,
    endLine: 3,
    quote,
    quoteHash: fileCommentQuoteHash(path, quote),
    revision: "r1",
    surface: "editor",
    ...over,
  };
}

test("a matching revision short-circuits without searching the file at all", () => {
  // Rule 1, and the reason the revision is an ARGUMENT rather than something the caller
  // resolves afterwards: without it this rule cannot be evaluated and every send rescans
  // the whole file. The proof is that the reported lines are the anchor's own even though
  // the text handed in does not contain the quote anywhere.
  const out = reanchor(anchor(), "nothing here resembles the quote", "r1");
  assert.deepEqual(out, { kind: "unchanged", startLine: 3, endLine: 3, revision: "r1" });
});

test("a null revision on either side is unknown, never the same, so it searches", () => {
  // The cost of a rescan is far below the cost of sending a comment about text that has
  // since been deleted, so "unknown" falls through rather than short-circuiting.
  assert.equal(reanchor(anchor({ revision: null }), "gone", null).kind, "outdated");
  assert.equal(reanchor(anchor({ revision: null }), "gone", "r1").kind, "outdated");
  assert.equal(reanchor(anchor(), "gone", null).kind, "outdated");
});

test("a quote found exactly where it was is unchanged, and carries the new revision out", () => {
  const out = reanchor(anchor(), FILE, "r2");
  assert.deepEqual(out, { kind: "unchanged", startLine: 3, endLine: 3, revision: "r2" });
});

test("a quote found once somewhere else moves, silently, with the new range", () => {
  const moved = ["one", "two", "three", "four", "charlie", "six"].join("\n");
  assert.deepEqual(reanchor(anchor(), moved, "r2"), {
    kind: "moved",
    startLine: 5,
    endLine: 5,
    revision: "r2",
  });
});

test("a multi-line quote reports the whole range it now occupies", () => {
  const a = anchor({ quote: "bravo\ncharlie", startLine: 2, endLine: 3 });
  const shifted = ["x", "y", "z", "bravo", "charlie"].join("\n");
  assert.deepEqual(reanchor(a, shifted, "r2"), {
    kind: "moved",
    startLine: 4,
    endLine: 5,
    revision: "r2",
  });
});

test("a duplicated quote takes the occurrence NEAREST the previous line", () => {
  // A repeated sentence is ordinary in a document. "Nearest" is the only answer that does
  // not move a comment across a file because a later section repeats a line.
  const repeated = ["charlie", "b", "c", "charlie", "e", "f", "charlie"].join("\n");
  assert.deepEqual(reanchor(anchor({ startLine: 3, endLine: 3 }), repeated, "r2"), {
    kind: "moved",
    startLine: 4,
    endLine: 4,
    revision: "r2",
  });
  // The same file, a thread that was anchored near the end, and the answer moves with it.
  assert.deepEqual(reanchor(anchor({ startLine: 7, endLine: 7 }), repeated, "r2"), {
    kind: "unchanged",
    startLine: 7,
    endLine: 7,
    revision: "r2",
  });
});

test("a quote the agent has deleted goes outdated and advances NO revision", () => {
  // The column records the revision the anchor was last VALID against, and an outdated
  // anchor was not valid against this one. An outcome carrying a revision here would let a
  // later pass short-circuit on rule 1 and conclude the anchor is fine.
  const out = reanchor(anchor(), ["alpha", "bravo", "delta"].join("\n"), "r2");
  assert.deepEqual(out, { kind: "outdated" });
  assert.equal("revision" in out, false);
});

test("outdated is reversible: the quote coming back re-anchors and clears", () => {
  // This is why `outdated` is a column beside the status rather than a status value.
  const a = anchor();
  assert.equal(reanchor(a, ["alpha", "bravo"].join("\n"), "r2").kind, "outdated");
  assert.deepEqual(reanchor(a, FILE, "r3"), {
    kind: "unchanged",
    startLine: 3,
    endLine: 3,
    revision: "r3",
  });
});

test("an empty quote can never be confirmed present, so it is outdated rather than line 1", () => {
  assert.deepEqual(reanchor(anchor({ quote: "   \n\n  " }), FILE, "r2"), { kind: "outdated" });
});

test("normalization absorbs what an editor changes and nothing a person wrote", () => {
  // CRLF, a stripped trailing space, and a selection that swept up the blank line after the
  // paragraph are all noise nobody typed.
  assert.equal(normalizeQuote("\r\n  charlie  \t\r\n\n"), "  charlie");
  // Indentation, case and punctuation are CONTENT in source and are preserved - unlike
  // `fingerprint()`'s title normalization, which is absorbing model rewordings instead.
  assert.equal(normalizeQuote("  If (X) { Return; }"), "  If (X) { Return; }");
});

test("a CRLF checkout re-anchors against an LF quote and vice versa", () => {
  const crlf = ["alpha", "bravo", "charlie", "delta"].join("\r\n");
  assert.deepEqual(reanchor(anchor(), crlf, "r2"), {
    kind: "unchanged",
    startLine: 3,
    endLine: 3,
    revision: "r2",
  });
  assert.equal(reanchor(anchor({ quote: "charlie\r\n" }), FILE, "r2").kind, "unchanged");
});

test("the hash excludes the line number and includes the path", () => {
  // The Inspector's rule: a push that shifts code down must not re-identify everything.
  const moved = { ...anchor(), startLine: 99, endLine: 99 };
  assert.equal(fileCommentQuoteHash(moved.path, moved.quote), anchor().quoteHash);
  // The same paragraph in two files is two different comments.
  assert.notEqual(fileCommentQuoteHash("a.md", "same"), fileCommentQuoteHash("b.md", "same"));
});

test("the browser-safe digest agrees with node:crypto, byte for byte", () => {
  // The daemon and the browser must not end up with two hash algorithms for one column, and
  // `node:crypto` is forbidden in `src/shared/`. This is the only thing that proves the
  // hand-rolled implementation is the same function.
  for (const input of [
    "",
    "a",
    "abc",
    "docs/plans/x/plan.md\nthe paragraph as it currently reads",
    "x".repeat(55),
    "x".repeat(56),
    "x".repeat(64),
    "x".repeat(1000),
    "unicode: éü中文🚀",
  ]) {
    assert.equal(sha256Hex(input), createHash("sha256").update(input).digest("hex"), input.slice(0, 20));
  }
});

test("a quote longer than the wire budget is clamped, never refused", () => {
  // Refusing to save a comment someone just wrote is worse than anchoring it to its first
  // 4,000 characters.
  const long = "y".repeat(FILE_COMMENT_QUOTE_MAX + 500);
  assert.equal(boundQuote(long).length, FILE_COMMENT_QUOTE_MAX);
  assert.equal(boundQuote("short"), "short");
});

test("sliceLines clamps an overhanging range rather than refusing it", () => {
  // `snapToLine`'s rule: a made-up number is worse than none, and a stale render that
  // half-overhangs the end of a file still has real text to anchor to.
  assert.equal(sliceLines(FILE, 2, 3), "bravo\ncharlie");
  assert.equal(sliceLines(FILE, 4, 99), "delta\necho");
  assert.equal(sliceLines(FILE, 0, 1), "alpha");
  assert.equal(sliceLines("", 1, 5), "");
});
