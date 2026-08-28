import assert from "node:assert/strict";
import test from "node:test";

import { findDecorations, type FileEditorFind } from "../src/web/components/FileEditor.tsx";
import { documentHits } from "../src/web/lib/documentFind.ts";

/**
 * The Editor's find decorations: which ranges are painted, and which one reads as current.
 *
 * Derived from the model on every call and never mapped through a document change, which is
 * the rule the comment markers beside them already follow - three of `FileEditor`'s four
 * update paths destroy a mapped decoration outright.
 *
 * The class names are CodeMirror's own on purpose, so the theme rules the component already
 * carries keep applying to the panel's replacement.
 */

const SOURCE = [
  "export const reconnectBudgetMs = 30_000;",
  "",
  "// the reconnect budget is bounded",
  "export function reconnect(): void {}",
].join("\n");

/** Every painted range, in document order, with the class it carries. */
function painted(find: FileEditorFind | null, docLength: number) {
  const set = findDecorations(find, docLength);
  const out: { from: number; to: number; class: string | undefined }[] = [];
  const cursor = set.iter();
  while (cursor.value !== null) {
    out.push({
      from: cursor.from,
      to: cursor.to,
      class: (cursor.value.spec as { class?: string }).class,
    });
    cursor.next();
  }
  return out;
}

function model(query: string, currentIndex: number): FileEditorFind {
  return {
    hits: documentHits(SOURCE, query, { caseSensitive: false }, "source"),
    currentIndex,
    scrollNonce: 0,
    onChord: () => {},
  };
}

test("every source hit is painted, and exactly one reads as current", () => {
  const find = model("reconnect", 2);
  const ranges = painted(find, SOURCE.length);
  assert.equal(ranges.length, 3, "three occurrences in this document");
  assert.deepEqual(
    ranges.map((range) => SOURCE.slice(range.from, range.to).toLowerCase()),
    ["reconnect", "reconnect", "reconnect"],
  );
  assert.deepEqual(
    ranges.map((range) => range.class),
    [
      "cm-searchMatch",
      "cm-searchMatch",
      "cm-searchMatch cm-searchMatch-selected",
    ],
  );
});

test("the painted ranges are the core's hits, so the count and the highlights agree", () => {
  const find = model("budget", 0);
  assert.deepEqual(
    painted(find, SOURCE.length).map((range) => ({ from: range.from, to: range.to })),
    find.hits.map((hit) => ({ from: hit.start, to: hit.end })),
  );
});

test("a closed find, and a find with no hits, paint nothing", () => {
  assert.deepEqual(painted(null, SOURCE.length), []);
  assert.deepEqual(painted(model("", 0), SOURCE.length), []);
  assert.deepEqual(painted(model("nothing matches this", 0), SOURCE.length), []);
});

test("no hit reads as current when the index names none", () => {
  for (const index of [-1, 99]) {
    const classes = painted(model("reconnect", index), SOURCE.length)
      .map((range) => range.class);
    assert.ok(
      classes.every((value) => value === "cm-searchMatch"),
      `index ${index} selected a hit`,
    );
  }
});

test("a hit past the end of the document is dropped rather than throwing", () => {
  /*
   * The one-dispatch gap this guards. A document change and the model that follows it are two
   * dispatches, so between them the offsets describe text that has already moved - and a
   * CodeMirror range past the end of the document is an exception, not a stale highlight.
   */
  const find = model("reconnect", 0);
  const shortened = 20;
  const ranges = painted(find, shortened);
  assert.ok(ranges.length > 0, "the hits still inside the shortened document are painted");
  for (const range of ranges) {
    assert.ok(range.to <= shortened, `${range.to} is past the shortened document`);
    assert.ok(range.from < range.to, "an empty range is dropped rather than painted");
  }
});
