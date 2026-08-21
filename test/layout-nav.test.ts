import { test } from "node:test";
import assert from "node:assert/strict";
import { moveSelection, type ArrowKey } from "../src/web/lib/layoutNav.ts";
import { parseLayoutMode, LAYOUTS } from "../src/web/lib/layout.ts";
import type { LayoutMode } from "../src/web/lib/layout.ts";

// Arrow-key navigation is the one thing that genuinely differs between the two
// layouts, and it's the kind of index arithmetic that reads as correct while being off
// by one at the edges. Kept pure precisely so it can be tested like this: no DOM, no
// dashboard, no flake - just "given this shape, where does the selection land".

const IDS = ["a", "b", "c", "d", "e"];

function move(mode: LayoutMode, key: ArrowKey, currentId: string | null, over: Partial<Parameters<typeof moveSelection>[0]> = {}) {
  return moveSelection({ mode, key, ids: IDS, currentId, columns: [], ...over });
}

test("nothing selected: the first arrow press takes the first session, in any layout", () => {
  for (const mode of LAYOUTS.map((l) => l.id)) {
    assert.equal(move(mode, "ArrowDown", null, { columns: [IDS] }), "a", mode);
    assert.equal(move(mode, "ArrowUp", null, { columns: [IDS] }), "a", mode);
  }
});

test("a selection that has since vanished is treated as no selection", () => {
  assert.equal(move("console", "ArrowDown", "gone"), "a");
});

test("console: up/down walk the single-column rail, horizontal arrows do nothing", () => {
  // The rail cursor's answer only. Scrolling the open detail is the detail focus zone's
  // job and is routed by App before this is reached (see console-zone-nav.test.ts), so
  // here the rail is just a flat vertical list.
  assert.equal(move("console", "ArrowDown", "a"), "b");
  assert.equal(move("console", "ArrowUp", "b"), "a");
  // Edges stay put rather than wrapping.
  assert.equal(move("console", "ArrowUp", "a"), null);
  assert.equal(move("console", "ArrowDown", "e"), null);
  // No spatial destination sideways in a one-column rail.
  assert.equal(move("console", "ArrowRight", "a"), null);
  assert.equal(move("console", "ArrowLeft", "a"), null);
});

test("board: up/down walk a column, left/right cross between them", () => {
  const columns = [["a", "b"], ["c"], ["d", "e"]];
  const on = (key: ArrowKey, currentId: string) =>
    moveSelection({ mode: "board", key, ids: IDS, currentId, columns });
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
    moveSelection({ mode: "board", key: "ArrowRight", ids: IDS, currentId: "b", columns }),
    "c",
  );
});

test("board: an empty column is stepped over, not fallen into", () => {
  // Exactly the shipped shape: five columns, most of them empty most of the time.
  const columns = [["a"], [], [], ["b"], []];
  const on = (key: ArrowKey, currentId: string) =>
    moveSelection({ mode: "board", key, ids: ["a", "b"], currentId, columns });
  assert.equal(on("ArrowRight", "a"), "b");
  assert.equal(on("ArrowLeft", "b"), "a");
  // Nothing but empties to the right of "b" - stay put.
  assert.equal(on("ArrowRight", "b"), null);
});

test("no sessions: every arrow is a no-op", () => {
  for (const mode of LAYOUTS.map((layout) => layout.id)) {
    assert.equal(moveSelection({ mode, key: "ArrowDown", ids: [], currentId: null, columns: [] }), null);
  }
});

test("a stored layout is only trusted if we still ship it", () => {
  assert.equal(parseLayoutMode("console"), "console");
  assert.equal(parseLayoutMode("board"), "board");
  assert.equal(parseLayoutMode("grid"), "console");
  // The retired Cards value, junk, a mode from a future version, or a cleared key all
  // fall back to Console
  // rather than rendering an app with no layout at all.
  assert.equal(parseLayoutMode("triage"), "console");
  assert.equal(parseLayoutMode(""), "console");
  assert.equal(parseLayoutMode(null), "console");
  assert.equal(parseLayoutMode(undefined), "console");
});
