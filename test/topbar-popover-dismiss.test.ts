/**
 * What is at stake: the Foreman and Alerts popovers are lightweight topbar dropdowns with
 * their own `open` state - NOT entries in the overlay registry, so App's global Escape does
 * not know they exist and cannot close them. Each has to dismiss itself. A click outside
 * already does; Escape has to as well, or the keyboard has no way to back out of a menu the
 * mouse opened.
 *
 * And it has to STOP there: App's Escape (on `window`) collapses the expanded card and drops
 * the fleet selection. A popover Escape that bubbled on would close the menu AND undo the
 * selection behind it in one press. So each handler calls `stopPropagation`, and this file
 * pins both halves - close on Escape, and don't let it through - for both popovers.
 *
 * Driven from source, not a click: these popovers sit behind an SSE stream that hangs
 * headless automation, and there is no jsdom here to dispatch a real keydown into. This is
 * the same way `board-keyboard-open.test.ts` pins App's own keydown handler.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/web/components/${rel}`, import.meta.url)), "utf8");

/** The body of the `onKey` handler registered for keydown - where the Escape rule lives. */
function escapeHandler(source: string): string {
  const start = source.indexOf("function onKey");
  assert.notEqual(start, -1, "no keydown handler is registered, so Escape does nothing");
  // Balanced enough for these small handlers: from the signature to the first `\n  }` that
  // closes it at the useEffect's indentation.
  const end = source.indexOf("\n    }", start);
  assert.notEqual(end, -1);
  return source.slice(start, end);
}

for (const file of ["ForemanBar.tsx", "AlertBar.tsx"]) {
  test(`${file}: the popover closes on Escape and keeps it from App's global Escape`, () => {
    const source = src(file);

    // The listener is actually wired up, and torn down with its mousedown twin.
    assert.match(source, /addEventListener\("keydown", onKey\)/, "keydown listener is not registered");
    assert.match(source, /removeEventListener\("keydown", onKey\)/, "keydown listener is never removed");

    const handler = escapeHandler(source);
    assert.match(handler, /e\.key === "Escape"/, "the handler does not act on Escape");
    assert.match(handler, /setOpen\(false\)/, "Escape does not close the popover");
    // Without this, the same Escape reaches App and also collapses/deselects behind the menu.
    assert.match(handler, /e\.stopPropagation\(\)/, "Escape is allowed to bubble to App's global handler");
    // Only fire while the menu is open, so Escape is free for everything else otherwise.
    assert.match(handler, /open && e\.key === "Escape"/, "the handler acts even while the popover is closed");
  });
}
