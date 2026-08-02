import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Palette } from "../src/web/components/Palette.tsx";
import type { PaletteStores } from "../src/web/lib/palette-index.ts";
import { withOverlayHost } from "./helpers/overlay-host.ts";

// The markup shape the browser spec cannot pin cheaply: the dialog's ARIA wiring, the group
// boxes, the kind chips, and the inline switch. `e2e/specs/palette.spec.ts` owns whether it
// WORKS; this owns what it is made of.
//
// Wrapped in a host because the palette is a screen-owning dialog and routes through
// <Overlay>, which refuses to render without one (see overlay-registry.test.ts). The host is
// inert - a static render runs no effects - so this is purely about what it draws.

function stores(over: Partial<PaletteStores> = {}): PaletteStores {
  return {
    workflows: [],
    runs: [],
    ensembles: [],
    personas: [],
    sessionActions: [],
    schedules: [],
    sessionNames: new Map(),
    settingsBindings: new Map(),
    ...over,
  };
}

function render(open: boolean, source: PaletteStores = stores()): string {
  return renderToStaticMarkup(
    withOverlayHost(
      createElement(Palette, {
        open,
        onClose: () => {},
        onActivate: () => {},
        stores: source,
      }),
    ),
  );
}

test("a closed palette renders nothing", () => {
  assert.equal(render(false), "");
});

test("an open palette is a dialog over a listbox, with the key hints under it", () => {
  const html = render(true);
  // The shared Overlay backdrop is the veil, and the panel is the dialog on top of it.
  assert.match(html, /class="modal-backdrop"/);
  assert.match(html, /class="pal"[^>]*role="dialog"/);
  assert.match(html, /aria-label="Search everything"/);
  assert.match(html, /role="combobox"/);
  assert.match(html, /role="listbox"/);
  assert.match(html, /class="pal-foot"/);
  // The tab filter is discoverable from the footer, or nobody finds it.
  assert.match(html, /filter by kind/);
});

test("the empty palette offers the verbs, each in a labelled group box", () => {
  const html = render(true);
  // A `role="group"` inside the listbox, labelled by the heading a sighted operator reads -
  // so "Do" is a structure a screen reader can announce, not just a styled div.
  assert.match(html, /role="group" aria-label="Do"/);
  assert.match(html, /Dispatch an agent…/);
  assert.match(html, /Launch a Best of N ensemble…/);
});

test("every row carries a kind chip, toned by kind", () => {
  const html = render(true);
  assert.match(html, /class="pal-kind pal-kind-command">command</);
  assert.match(html, /class="pal-kind pal-kind-strategy">strategy</);
});

test("nothing is on screen before you type but what needs you and what you can start", () => {
  // The negative a static render is uniquely good at: an unprompted palette must not dump
  // fifty settings rows at someone who has typed nothing. No switch, no setting chip.
  const html = render(
    true,
    stores({ settingsBindings: new Map([["format-messages", { get: () => true, set: () => {} }]]) }),
  );
  assert.doesNotMatch(html, /class="pal-switch"/);
  assert.doesNotMatch(html, /pal-kind-setting/);
  assert.doesNotMatch(html, /role="group" aria-label="Settings"/);
  // Typing is what reaches them, and the browser spec owns that half.
  assert.match(html, /role="group" aria-label="Do"/);
});

test("an amber row is marked in the markup, not only by colour", () => {
  const html = render(
    true,
    stores({
      schedules: [
        {
          id: "sch-1",
          name: "Dependency audit",
          enabled: true,
          archivedAt: null,
          expression: "0 8 * * 1",
          timezone: "UTC",
          overlapPolicy: null,
          missedPolicy: null,
          executionMode: null,
          runnerId: null,
          revision: 1,
          template: null,
          nextRunAt: null,
          lastOccurrence: null,
          unreadable: null,
          health: "attention",
          healthReasons: [],
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    }),
  );
  assert.match(html, /class="pal-row-desc is-attention"/);
  assert.match(html, /needs attention/);
});

test("an option row names its kind in the accessible name, so the chip is not visual-only", () => {
  const html = render(true);
  assert.match(html, /aria-label="Dispatch an agent…, command"/);
  assert.match(html, /role="option"/);
});
