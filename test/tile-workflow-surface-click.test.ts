import { test } from "node:test";
import assert from "node:assert/strict";

import { isDragSelection, isSurfaceClick } from "../src/web/lib/pointer.ts";

/**
 * The rule that lets a Board tile's expanded workflow panel mean something when you click it.
 *
 * The panel stops every click from reaching the tile - it is most of a tall tile, so letting a
 * miss bubble would open the console on every mis-aim - and that stop is why clicking an
 * expanded ladder used to do nothing whatsoever, not even move the board's cursor onto the tile
 * you were reading. It now acts on its own background: select first, follow the run second.
 *
 * The half worth pinning without a browser is which clicks count as "background". Every control
 * inside that panel already answers its own click - the disclosure toggle, "Open run", the peek
 * link, each rung's actions - and the panel must not fire a second, different action underneath
 * them. That is asked of the click target rather than listed here, so a control added to the
 * ladder later is covered the day it lands; these cases are the contract that makes that safe.
 *
 * The behaviour itself - one click selects, the next opens the run - is a browser question and
 * lives in `e2e/specs/board-tile-workflow-click.spec.ts`.
 */

/** The one method `isSurfaceClick` uses, over a fixture that says what an ancestor search finds. */
function target(match: string | null): { closest(selector: string): unknown } {
  return { closest: () => match };
}

test("a click on the panel's own background is the panel's to act on", () => {
  assert.equal(isSurfaceClick(target(null)), true);
});

test("a click on a control inside the panel belongs to that control alone", () => {
  // What `closest` returns is the ancestor it found; any non-null match means the click was
  // already answered - by the disclosure button, "Open run", a rung action, or the peek link.
  assert.equal(isSurfaceClick(target("<button>")), false);
});

test("a click with no target at all is nobody's", () => {
  assert.equal(isSurfaceClick(null), false);
});

test("the interactive selector names the controls this panel actually draws", () => {
  // A guard on the selector itself, read off the one question it asks. The ladder draws
  // buttons, the collapsed peek is an anchor with an href, and ARIA-labelled controls appear
  // as `role="button"` - dropping any of them would make the panel fire a second action
  // underneath something that had already answered the click.
  let asked = "";
  isSurfaceClick({
    closest: (selector: string): unknown => {
      asked = selector;
      return null;
    },
  });
  for (const control of ["a[href]", "button", "input", "textarea", '[role="button"]']) {
    assert.ok(asked.includes(control), `${control} is an owner of its own clicks`);
  }
});

test("a drag that ends inside the panel is not a click on it", () => {
  // Shared with the tile root's own guard: copying a reviewer's sentence out of an expanded
  // ladder is a fair thing to want, and the mouseup that ends that drag must not navigate.
  assert.equal(isDragSelection({ isCollapsed: false }), true);
  assert.equal(isDragSelection({ isCollapsed: true }), false);
  assert.equal(isDragSelection(null), false);
});
