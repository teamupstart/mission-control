import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ACTIONS, isReservedChord } from "../src/web/lib/keybindings.ts";

/**
 * The board's arrow cursor is a selection layer that opens nothing, and everything that
 * used to be reachable through "selecting is opening" has to survive that.
 *
 * Three things are at stake, and none of them fails loudly:
 *
 *  - `Enter` now means "open the tile the cursor is on", so it can no longer be handed
 *    out as a binding: it would work in Cards and Console and silently not on the board.
 *  - Only the board's DRILL-IN draws an action bar, so a chord aimed at a tile the arrows
 *    merely landed on has nothing registered to run. It has to drill in first, or `s`,
 *    `f`, `q`, Shift+Tab and `k` are dead keys on one layout of three.
 *  - Arrow selection has to take DOM focus with it. Nothing else moves focus, so whatever
 *    was last clicked keeps it - and Enter, which this app deliberately leaves to a
 *    focused control, would fire that instead of opening the board.
 *
 * Driven as source + the pure binding module rather than a click: no jsdom here, and the
 * flow is a global keydown handler reaching a ref through two renders.
 */

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/web/${rel}`, import.meta.url)), "utf8");

const app = src("App.tsx");

test("Enter is reserved, because the board's Enter is structural navigation", () => {
  assert.equal(isReservedChord("Enter"), true);
  assert.equal(isReservedChord("shift+Enter"), true);
  for (const a of ACTIONS) {
    assert.notEqual(a.defaultBinding, "Enter", `${a.id} ships bound to a reserved key`);
  }
});

test("a modified Enter still reaches the chord matching it merely shares a key with", () => {
  // The switch keys off `e.key`, so cmd/alt/shift+Enter lands in the same arm. Claiming
  // it there returned before a single binding was compared, in every layout.
  const arm = app.slice(app.indexOf('case "Enter":'), app.indexOf("// Actions on the selected card."));
  assert.match(arm, /if \(chord !== "Enter"\) break;/, arm);
  // And the paths the board's Enter does not apply to fall through rather than return.
  assert.match(arm, /layout !== "board" \|\| !selectedId \|\| boardOpen\) break;/, arm);
});

test("every action-bar chord is one the board can defer, not just perform", () => {
  const table = app.slice(app.indexOf("const BAR_ACTIONS"), app.indexOf("export function App"));
  for (const [id, method] of [
    ["send", "startSend"],
    ["focus", "focusPane"],
    ["queue", "toggleQueue"],
    ["mode", "cycleMode"],
    ["kill", "requestKill"],
  ]) {
    assert.match(table, new RegExp(`\\["${id}", "${method}"\\]`), `${id} is not in BAR_ACTIONS`);
  }
  // The chain of `else if`s this replaced could only ever run against a bar that already
  // existed, which is exactly what the board's overview does not have.
  assert.doesNotMatch(app, /chord === bindings\.send/);
});

test("a selection chord on the board's overview drills in and then runs", () => {
  assert.match(app, /pendingBarAction\.current = \{ id: selectedId, run \};\s*\n\s*setBoardOpen\(true\);/, app.slice(app.indexOf("const bar = BAR_ACTIONS"), app.indexOf("window.addEventListener")));
  // Reconciled against what actually opened: a selection that moved in between must not
  // hand its neighbour a kill confirm.
  assert.match(app, /if \(!pending \|\| pending\.id !== boardOpenId\) return;/);
});

test("the board's drill-in is the selection, not a second id that can drift from it", () => {
  // A flag plus a derivation. Holding an id let another layout's arrows move the
  // selection out from under it, so returning to the board reopened the session you left.
  assert.match(app, /const \[boardOpen, setBoardOpen\] = useState\(false\)/);
  assert.match(app, /const boardOpenId = boardOpen \? selectedId : null;/);
  assert.doesNotMatch(app, /setBoardOpenId/);
});

test("the arrow cursor takes focus onto the tile's own open button", () => {
  assert.match(app, /pendingTileFocus\.current = nextId/);
  assert.match(app, /querySelector<HTMLElement>\("button\.tile-open"\)/);
  // That selector is the whole contract, and nothing compiles it. SessionTile draws the
  // stretched button precisely so the keyboard has something to land on.
  const tile = src("components/layouts/SessionTile.tsx");
  assert.match(tile, /<button[\s\S]*?className="tile-open"/, "the keyboard half of the tile is gone");
});
