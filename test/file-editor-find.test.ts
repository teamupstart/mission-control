import assert from "node:assert/strict";
import test from "node:test";

import {
  editorFindChord,
  findDecorations,
  type FileEditorFind,
} from "../src/web/components/FileEditor.tsx";
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

// ---- which chords the find owner claims ----

/** The fields `editorFindChord` reads, so a case here is a keystroke and nothing more. */
function press(
  key: string,
  mods: { mod?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {},
): KeyboardEvent {
  return {
    key,
    // "mod" stands for whichever this platform uses; both spellings are exercised below.
    metaKey: mods.meta ?? mods.mod ?? false,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
  } as KeyboardEvent;
}

test("find-previous is the SHIFTED chord on both platforms, for a letter as well as F3", () => {
  /*
   * The regression this pins, caught by a Linux CI shard and invisible to a macOS run.
   *
   * A CodeMirror binding's `shift` property resolves differently for a letter than for a
   * named key: under Shift the `g` key reports `event.key` as "G", a character that already
   * carries its shift, so the lookup and the `shift` fallback stop agreeing. Shift+Cmd+G
   * stepped backwards on macOS while Shift+Ctrl+G stepped FORWARDS on Linux. The decision is
   * now taken from `shiftKey` directly, so both platforms and both key kinds agree.
   */
  for (const [name, mods] of [["meta", { meta: true }], ["ctrl", { ctrl: true }]] as const) {
    assert.equal(editorFindChord(press("g", mods)), "next", `${name}+g`);
    assert.equal(
      editorFindChord(press("G", { ...mods, shift: true })),
      "previous",
      `shift+${name}+G - the key reports uppercase under shift`,
    );
    // Belt and braces: a browser that reported the lowercase base under shift must agree.
    assert.equal(editorFindChord(press("g", { ...mods, shift: true })), "previous", `shift+${name}+g`);
  }
  assert.equal(editorFindChord(press("F3")), "next");
  assert.equal(editorFindChord(press("F3", { shift: true })), "previous");
});

test("the open chord is the bare modifier pair, on either platform", () => {
  assert.equal(editorFindChord(press("f", { meta: true })), "open");
  assert.equal(editorFindChord(press("f", { ctrl: true })), "open");
  // Alt+Mod+F is somebody else's chord, so it is left alone rather than swallowed.
  assert.equal(editorFindChord(press("f", { meta: true, alt: true })), null);
});

test("go-to-line is claimed and inert, so its panel cannot open by the back door", () => {
  assert.equal(editorFindChord(press("g", { meta: true, alt: true })), "inert");
  assert.equal(editorFindChord(press("g", { ctrl: true, alt: true })), "inert");
});

test("everything else is not ours, and the editor keeps it", () => {
  for (const event of [
    press("f"),
    press("g"),
    press("a", { meta: true }),
    press("d", { meta: true }),
    press("l", { meta: true, shift: true }),
    press("Enter"),
    press("Escape"),
    press("F4"),
  ]) {
    assert.equal(editorFindChord(event), null, `claimed ${event.key} it should not have`);
  }
});
