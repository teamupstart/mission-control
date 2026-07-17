import { test } from "node:test";
import assert from "node:assert/strict";
import { moveSelection, type ArrowKey } from "../src/web/lib/layoutNav.ts";
import { parseLayoutMode, LAYOUTS } from "../src/web/lib/layout.ts";
import type { LayoutMode } from "../src/web/lib/layout.ts";

// Arrow-key navigation is the one thing that genuinely differs between the three
// layouts, and it's the kind of index arithmetic that reads as correct while being off
// by one at the edges. Kept pure precisely so it can be tested like this: no DOM, no
// dashboard, no flake - just "given this shape, where does the selection land".

const IDS = ["a", "b", "c", "d", "e"];

function move(mode: LayoutMode, key: ArrowKey, currentId: string | null, over: Partial<Parameters<typeof moveSelection>[0]> = {}) {
  return moveSelection({ mode, key, ids: IDS, currentId, cols: 2, columns: [], ...over });
}

test("nothing selected: the first arrow press takes the first session, in any layout", () => {
  for (const mode of LAYOUTS.map((l) => l.id)) {
    assert.equal(move(mode, "ArrowDown", null, { columns: [IDS] }), "a", mode);
    assert.equal(move(mode, "ArrowUp", null, { columns: [IDS] }), "a", mode);
  }
});

test("a selection that has since vanished is treated as no selection", () => {
  assert.equal(move("grid", "ArrowRight", "gone"), "a");
});

test("grid: left/right walk the list, up/down jump a row", () => {
  assert.equal(move("grid", "ArrowRight", "a"), "b");
  assert.equal(move("grid", "ArrowLeft", "b"), "a");
  assert.equal(move("grid", "ArrowDown", "a"), "c"); // 2 columns
  assert.equal(move("grid", "ArrowUp", "c"), "a");
});

test("grid: the edges stay put rather than wrapping", () => {
  assert.equal(move("grid", "ArrowLeft", "a"), null);
  assert.equal(move("grid", "ArrowRight", "e"), null);
  assert.equal(move("grid", "ArrowUp", "a"), null);
  assert.equal(move("grid", "ArrowDown", "e"), null); // e + 2 is past the end
});

test("console: a single list - up/down step, left/right do nothing", () => {
  assert.equal(move("console", "ArrowDown", "a"), "b");
  assert.equal(move("console", "ArrowUp", "b"), "a");
  assert.equal(move("console", "ArrowUp", "a"), null);
  assert.equal(move("console", "ArrowDown", "e"), null);
  // Not silently aliased to up/down: there is no sideways in a rail.
  assert.equal(move("console", "ArrowRight", "a"), null);
  assert.equal(move("console", "ArrowLeft", "a"), null);
});

test("board: up/down walk a column, left/right cross between them", () => {
  const columns = [["a", "b"], ["c"], ["d", "e"]];
  const on = (key: ArrowKey, currentId: string) =>
    moveSelection({ mode: "board", key, ids: IDS, currentId, cols: 1, columns });
  assert.equal(on("ArrowDown", "a"), "b");
  assert.equal(on("ArrowUp", "b"), "a");
  assert.equal(on("ArrowRight", "a"), "c");
  assert.equal(on("ArrowLeft", "c"), "a");
  assert.equal(on("ArrowUp", "a"), null);
  assert.equal(on("ArrowLeft", "a"), null);
  assert.equal(on("ArrowRight", "e"), null);
});

test("board: crossing into a shorter column clamps to its last row", () => {
  // "b" is row 1; the middle column only has a row 0 to land on.
  const columns = [["a", "b"], ["c"], ["d", "e"]];
  assert.equal(
    moveSelection({ mode: "board", key: "ArrowRight", ids: IDS, currentId: "b", cols: 1, columns }),
    "c",
  );
});

test("board: an empty column is stepped over, not fallen into", () => {
  // Exactly the shipped shape: five columns, most of them empty most of the time.
  const columns = [["a"], [], [], ["b"], []];
  const on = (key: ArrowKey, currentId: string) =>
    moveSelection({ mode: "board", key, ids: ["a", "b"], currentId, cols: 1, columns });
  assert.equal(on("ArrowRight", "a"), "b");
  assert.equal(on("ArrowLeft", "b"), "a");
  // Nothing but empties to the right of "b" - stay put.
  assert.equal(on("ArrowRight", "b"), null);
});

test("no sessions: every arrow is a no-op", () => {
  assert.equal(moveSelection({ mode: "grid", key: "ArrowDown", ids: [], currentId: null, cols: 3, columns: [] }), null);
});

test("a stored layout is only trusted if we still ship it", () => {
  assert.equal(parseLayoutMode("console"), "console");
  assert.equal(parseLayoutMode("board"), "board");
  assert.equal(parseLayoutMode("grid"), "grid");
  // Junk, a mode from a future version, or a cleared key all fall back to the grid
  // rather than rendering an app with no layout at all.
  assert.equal(parseLayoutMode("triage"), "grid");
  assert.equal(parseLayoutMode(""), "grid");
  assert.equal(parseLayoutMode(null), "grid");
  assert.equal(parseLayoutMode(undefined), "grid");
});
