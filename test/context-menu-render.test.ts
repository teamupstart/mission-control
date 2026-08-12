/**
 * What is at stake: what a row is CALLED to a screen reader, and to a locator.
 *
 * Every row carries a payload cue beside its label - "selection", "link text" - which is the
 * half of decision D4 that makes a dense row readable. Folded into the accessible name it
 * would turn `Copy` into "Copy selection", and a menu that legitimately offers `Copy` and
 * `Copy URL` at once would then have two names nobody can tell apart by their beginnings. So
 * the cue is `aria-hidden` and the tooltip carries the same information in full, which leaves
 * each row's accessible name exactly its label.
 *
 * That is a real accessibility claim and it is also the contract `e2e/specs/context-menu.spec.ts`
 * selects by, so it is worth a test that costs microseconds rather than a browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ContextMenuRows } from "../src/web/components/ContextMenu.tsx";
import type { ContextAction, ResolvedContextMenu } from "../src/web/lib/context-actions.ts";
import { tooltipLabels } from "./helpers/markup.ts";

function action(over: Partial<ContextAction> & Pick<ContextAction, "id" | "label">): ContextAction {
  return { description: `describe ${over.label}`, kind: "copy", payload: over.label, ...over };
}

function render(menu: ResolvedContextMenu): string {
  return renderToStaticMarkup(
    createElement(ContextMenuRows, { menu, onChoose: () => {} }),
  );
}

const LINK_MENU: ResolvedContextMenu = {
  item: [
    action({ id: "copy-link-text", label: "Copy", hint: "selection" }),
    action({ id: "copy-url", label: "Copy URL" }),
    action({ id: "open-link", label: "Open link", kind: "open" }),
  ],
  container: [],
};

test("rows are menuitems, and the payload cue is not part of the name", () => {
  const html = render(LINK_MENU);
  assert.equal([...html.matchAll(/role="menuitem"/g)].length, 3);
  // The cue is drawn and hidden from the accessibility tree in the same element, so `Copy` and
  // `Copy URL` stay two distinguishable names.
  assert.match(html, /<span class="ctx-hint" aria-hidden="true">selection<\/span>/);
  assert.match(html, /<span class="ctx-label">Copy<\/span>/);
});

test("every row describes itself, so no row is a guess", () => {
  // `test/tooltip-coverage.test.ts` requires the wrapper; this is the check that the label
  // inside it says something. A tooltip reading "Copy" beside a button reading "Copy" would
  // pass that scan and tell the reader nothing about what lands on the clipboard.
  assert.deepEqual(tooltipLabels(render(LINK_MENU)), [
    "describe Copy",
    "describe Copy URL",
    "describe Open link",
  ]);
});

test("the two tiers are separated only when both have rows", () => {
  const both = render({
    item: [action({ id: "copy-url", label: "Copy URL" })],
    container: [action({ id: "copy-message", label: "Copy message" })],
  });
  assert.equal([...both.matchAll(/class="ctx-sep"/g)].length, 1);
  assert.match(both, /role="separator"/);
  // A menu with one tier draws no line, or it reads as a group boundary that is not there -
  // which is the state phase 2 ships in, with tier 2 still empty.
  assert.doesNotMatch(render(LINK_MENU), /ctx-sep/);
  assert.doesNotMatch(
    render({ item: [], container: [action({ id: "copy-branch", label: "Copy branch" })] }),
    /ctx-sep/,
  );
});

test("tier 1 renders above tier 2, most specific first", () => {
  const html = render({
    item: [action({ id: "copy-url", label: "Copy URL" })],
    container: [action({ id: "copy-message", label: "Copy message" })],
  });
  assert.ok(html.indexOf("Copy URL") < html.indexOf("Copy message"));
});
