import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LibraryBackRow } from "../src/web/library/LibraryBackRow.tsx";
import {
  LIBRARY_EDITOR_SELECTOR,
  libraryEscapeStep,
} from "../src/web/library/useLibraryEscape.ts";

/**
 * What is at stake: opening a Persona, an Action or a Command was a dead end. Escape did
 * nothing, no screen drew a way back, and the only control that navigated to `#/library`
 * was the topbar chip already painted as the current page.
 *
 * Two properties carry the fix and neither is visible in a static render, so the decision
 * order is pinned as a pure function here and the browser behaviour is pinned in
 * `e2e/specs/library-exit.spec.ts` - which is the only layer that can prove Escape inside
 * CodeMirror leaves the editor rather than the page.
 *
 * The order is the whole contract. Four later phases inherit it, so a rung moved here is a
 * cross-phase break rather than a local tidy-up.
 */

const press = (over: Partial<Parameters<typeof libraryEscapeStep>[0]> = {}) =>
  libraryEscapeStep({
    key: "Escape",
    defaultPrevented: false,
    overlayOpen: false,
    focusInEditor: false,
    ...over,
  });

test("a press that is not an unanswered Escape is not ours", () => {
  assert.equal(press({ key: "Enter" }), "ignore");
  assert.equal(press({ key: "Escape" }), "leave-page");
  // The rung that keeps CodeMirror's own Escapes intact. `basicSetup` binds three commands
  // to it, and CodeMirror calls `preventDefault()` exactly when one of them takes the press
  // - a live selection collapsing, an open completion closing, the search panel shutting.
  // Every one of those is a layer the operator asked to peel, and none is a page exit.
  assert.equal(press({ defaultPrevented: true }), "ignore");
  // Also how the workflow builder's own nested Escapes keep working: the connect dialog and
  // the pipeline insert picker are React `onKeyDown` handlers that `preventDefault`, so
  // their press arrives at `window` already answered.
  assert.equal(press({ defaultPrevented: true, focusInEditor: true }), "ignore");
});

test("an overlay owns Escape, and the page underneath does not also answer it", () => {
  // The case that would lose work if it were wrong: the dirty gate's own dialog is raised
  // while the keyboard is still in the field that made the draft dirty. If the editor rung
  // came first, Escape would blur the field instead of cancelling the dialog - and if the
  // page rung came first, one press would both cancel the gate and re-ask it.
  assert.equal(press({ overlayOpen: true }), "stand-down");
  assert.equal(press({ overlayOpen: true, focusInEditor: true }), "stand-down");
  // Stand down means STAND DOWN, not "leave later": the overlay closes itself through its
  // own listener and the route is untouched.
  assert.notEqual(press({ overlayOpen: true }), "leave-page");
});

test("the editor is peeled before the page, so Escape is never a way to lose a draft", () => {
  assert.equal(press({ focusInEditor: true }), "leave-editor");
  assert.equal(press({ focusInEditor: false }), "leave-page");
});

test("the editor rung covers the pane that fills the screen, not just the fields around it", () => {
  // The trap this whole hook exists for. `SettingsPage`'s handler BAILS on
  // `input, textarea, select, [contenteditable='true']`, and CodeMirror's content host is
  // `contenteditable` - so copying it verbatim would have left Escape dead in the guidance
  // and prompt editors, which is exactly the region a lost operator is looking at.
  assert.match(LIBRARY_EDITOR_SELECTOR, /\.cm-editor/);
  // And the rest of Settings' list is carried rather than rewritten: this is the same rule
  // about the same elements, spending the press instead of dropping it.
  for (const editing of ["input", "textarea", "select", "[contenteditable='true']"]) {
    assert.ok(
      LIBRARY_EDITOR_SELECTOR.includes(editing),
      `${editing} must still take its own Escape first`,
    );
  }
});

test("the hook installs one listener, reads the FOCUS, and leaves through the caller", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "../src/web/library/useLibraryEscape.ts"),
    "utf8",
  );
  // One `window` listener for the whole ladder. A second one anywhere in these surfaces is
  // how "the topmost overlay closes exactly one layer" stops being true.
  assert.equal(source.match(/addEventListener\("keydown"/g)?.length, 1);
  assert.equal(source.match(/removeEventListener\("keydown"/g)?.length, 1);
  // The FOCUSED element, not `event.target`: CodeMirror's focus sits on `.cm-content` while
  // plenty of its presses report a target further in, and a target-based check would miss.
  assert.match(source, /document\.activeElement/);
  assert.doesNotMatch(source, /event\.target/);
  // No second way out. Leaving is the caller's `onLeave`, which App points at the router's
  // `navigate` - the one path that raises the leave-with-unsaved-changes dialog.
  assert.doesNotMatch(source, /window\.location/);
  assert.doesNotMatch(source, /history\./);
  // Bubble phase, like `SettingsPage` and `Overlay`. A capture listener here would outrun
  // the shortcut-recording panel's own capture handler and navigate away mid-record.
  assert.doesNotMatch(source, /addEventListener\("keydown", onKey, true\)/);
  // Installed once. Both callbacks live in refs precisely so a router that changes identity
  // whenever a draft's dirtiness does cannot resubscribe the listener under the operator.
  assert.match(source, /useEffect\([\s\S]*?\}, \[\]\);/);
});

test("the back row says where it goes and teaches the key, without owning either", () => {
  const html = renderToStaticMarkup(createElement(LibraryBackRow, { onLeave: () => {} }));
  // The accessible name is the cross-phase contract: the Playwright specs select by it, and
  // "← Library" alone announces as "Library", which names a destination without saying that
  // reaching it is what this control does.
  assert.match(html, /aria-label="Back to Library"/);
  assert.match(html, /Library/);
  // The glyph is decoration; the word is the label.
  assert.match(html, /<span aria-hidden="true">←<\/span>/);
  // `esc` on the face, through the shared `.kb-hint` vocabulary rather than a new one.
  assert.match(html, /<kbd class="kb-hint">esc<\/kbd>/);
  // It navigates through its caller and nowhere else, so the back row and Escape leave by
  // one path and a dirty draft raises one dialog.
  const source = readFileSync(
    resolve(import.meta.dirname, "../src/web/library/LibraryBackRow.tsx"),
    "utf8",
  );
  assert.doesNotMatch(source, /window\.location|history\.|navigate\(/);
});

test("all four authoring surfaces mount the ladder, and none invents a second way out", () => {
  // The row itself is asserted where it is DRAWN - each surface's own render test walks the
  // markup and checks it precedes the rail heading. What is left here is the half no render
  // can see: that the keystroke is mounted beside the row rather than only in three of four
  // places, and that neither exit reaches around the router.
  //
  // FILE-granular, like `overlay-registry.test.ts`'s source scans and stated as such: this
  // runner has no DOM, so a hook call is a string here. What it catches is the shape a later
  // phase would break - a rail restyled with the ladder dropped on the way.
  for (const component of [
    "PersonaLibrary",
    "SessionActionLibrary",
    "CommandLibrary",
    "WorkflowLibrary",
  ]) {
    const source = readFileSync(
      resolve(import.meta.dirname, `../src/web/workflows/${component}.tsx`),
      "utf8",
    );
    assert.match(
      source,
      /useLibraryEscape\(\{ isOverlayOpen, onLeave \}\)/,
      `${component} draws a way out but does not answer Escape`,
    );
    // Leaving is the caller's, so the dirty gate is unavoidable rather than remembered.
    assert.match(source, /onLeave: \(\) => void;/);
    assert.doesNotMatch(
      source,
      /onLeave=\{\(\) =>/,
      `${component} must pass App's leave callback through, not wrap a new one`,
    );
  }
});
