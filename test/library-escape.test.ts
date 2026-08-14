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

/**
 * The file's CODE, with its prose blanked out.
 *
 * Borrowed from `tooltip-coverage.test.ts`, and this file learned why the hard way: the
 * scans below assert that certain shapes are ABSENT, and the comments explaining why they
 * are absent name them. A raw-text scan reads "never use `instanceof HTMLElement`" as an
 * `instanceof HTMLElement`. Same width, so a reported offset still points at the real line.
 */
function code(path: string): string {
  return readFileSync(resolve(import.meta.dirname, path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

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

test("the editor rung covers the panes that fill the screen, not just the fields around them", () => {
  // The trap this whole hook exists for. `SettingsPage`'s handler BAILS on
  // `input, textarea, select, [contenteditable='true']`, and CodeMirror's content host is
  // `contenteditable` - so copying it verbatim would have left Escape dead in the guidance
  // and prompt editors, which is exactly the region a lost operator is looking at.
  assert.match(LIBRARY_EDITOR_SELECTOR, /\.cm-editor/);
  // The workflow builder's canvas, and the reason it needs naming while the builder's other
  // nested Escapes do not: React Flow binds Escape to unselect and does NOT `preventDefault`
  // it, so it never reaches the `ignore` rung. Without this entry one press deselected the
  // node AND took the whole page - and `WorkflowCanvas` selects on focus, so tabbing into the
  // canvas was enough to get there. Matched on the container, so an edge, the pane and the
  // controls are covered without this file tracking React Flow's internals.
  assert.match(LIBRARY_EDITOR_SELECTOR, /\.react-flow(?![\w-])/);
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
  const source = code("../src/web/library/useLibraryEscape.ts");
  // One `window` listener for the whole ladder. A second one anywhere in these surfaces is
  // how "the topmost overlay closes exactly one layer" stops being true.
  assert.equal(source.match(/addEventListener\("keydown"/g)?.length, 1);
  assert.equal(source.match(/removeEventListener\("keydown"/g)?.length, 1);
  // BOTH the live focus and the event's target, because neither alone answers "where was the
  // keyboard" on every surface. React Flow's unselect replaces the focused edge, so by the
  // time this runs `document.activeElement` has fallen back to `<body>` while the target still
  // names the edge - reading focus alone left the whole page on one press. The reverse case is
  // CodeMirror, whose focus is the honest answer.
  assert.match(source, /document\.activeElement/);
  assert.match(source, /event\.target/);
  assert.match(source, /isInsideEditor\(focused\) \|\| isInsideEditor\(pressedOn\)/);
  // The blur is duck-typed, never `instanceof HTMLElement`: `blur` comes from the
  // `HTMLOrForeignElement` mixin, and a focusable graph edge is an `SVGElement`. Guarding on
  // HTML skipped the blur while `preventDefault` still fired - a press spent doing nothing,
  // which is the dead end this hook exists to remove.
  assert.doesNotMatch(source, /instanceof HTMLElement/);
  assert.match(source, /typeof focusable\?\.blur === "function"/);
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
  const source = code("../src/web/library/LibraryBackRow.tsx");
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
    const source = code(`../src/web/workflows/${component}.tsx`);
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
