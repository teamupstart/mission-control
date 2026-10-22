/**
 * Which side of its input the repo picker's fixed dropdown opens on.
 *
 * Below, unless the room there cannot hold a full list and above has more. A unit test because
 * the rule is a pure function of two rectangles; `e2e/specs/trust-matrix-scroll.spec.ts` drives
 * the case that needed it, the Trust page's add row at the bottom of a long settings pane.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { placeList } from "../src/web/components/RepoCombobox.tsx";

const field = (top: number) => ({
  top,
  bottom: top + 32,
  left: 40,
  width: 600,
});

test("opens below with its full height when the viewport has room", () => {
  assert.deepEqual(placeList(field(100), 800), {
    top: 136,
    left: 40,
    width: 600,
    maxHeight: 220,
  });
});

test("stays below at exactly a full list's room, even with more room above", () => {
  // 764 - 532 - 4 - 8 = 220px below, 500 - 4 - 8 = 488px above.
  assert.deepEqual(placeList(field(500), 764), { top: 536, left: 40, width: 600, maxHeight: 220 });
});

test("flips above one pixel short of a full list's room when above has more", () => {
  // 219px below, 488px above.
  assert.deepEqual(placeList(field(500), 763), {
    bottom: 267,
    left: 40,
    width: 600,
    maxHeight: 220,
  });
});

test("opens above, anchored to the input, when the room below is a sliver", () => {
  // 760 - 732 - 4 - 8 = 16px below: the reported bug, a list too short to show a row.
  assert.deepEqual(placeList(field(700), 760), {
    bottom: 64,
    left: 40,
    width: 600,
    maxHeight: 220,
  });
});

test("caps an upward list to the room above it", () => {
  assert.deepEqual(placeList(field(150), 200), {
    bottom: 54,
    left: 40,
    width: 600,
    maxHeight: 138,
  });
});

test("stays below when neither side holds a full list and below has more room", () => {
  assert.deepEqual(placeList(field(60), 280), {
    top: 96,
    left: 40,
    width: 600,
    maxHeight: 176,
  });
  assert.deepEqual(placeList(field(100), 300), {
    top: 136,
    left: 40,
    width: 600,
    maxHeight: 156,
  });
});
