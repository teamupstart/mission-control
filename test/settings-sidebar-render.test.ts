import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsModal, SETTINGS_CATEGORIES } from "../src/web/components/SettingsModal.tsx";
import type { SettingsCategoryId } from "../src/web/components/SettingsModal.tsx";
import { LAYOUTS } from "../src/web/lib/layout.ts";
import type { ForemanState } from "../src/web/useForeman.ts";
import type { CostState } from "../src/web/useCost.ts";
import { withOverlayHost } from "./helpers/overlay-host.ts";

// Rendered rather than driven through a browser: the dashboard's SSE stream holds the
// connection open, which hangs headless automation (same reason as plan-decisions-render).
// Static markup is enough to prove the two-pane structure - the rail lists every category,
// and the active category selects which panel renders - since the only thing a click does
// is set `active`, which we exercise here through the initialCategory prop.

// Foreman config is owned by App and passed in; null config is the pre-poll state, which
// renders the panel's defaults. Static render never runs effects, so nothing fetches.
const FOREMAN: ForemanState = { config: null, status: null, backlogPlan: null, update: async () => {}, error: null };

// Cost is owned by App and passed in for the same reason as Foreman - the topbar strip
// reads the same view setting. A null status is the pre-poll state, which renders the
// panel's shipped defaults with its controls disabled.
const COST: CostState = { status: null, update: async () => {}, error: null };

// The layout is owned by App too, for the same reason as Foreman: the dashboard behind the
// modal renders it, so the panel only edits what it's handed.
function render(initialCategory?: SettingsCategoryId): string {
  // Wrapped in a host because the modal is an <Overlay>, and an overlay outside a host
  // refuses to render - being counted as open is not optional. See helpers/overlay-host.
  return renderToStaticMarkup(
    withOverlayHost(
      createElement(SettingsModal, {
        onClose: () => {},
        foreman: FOREMAN,
        cost: COST,
        layout: "grid",
        onLayoutChange: () => {},
        initialCategory,
      }),
    ),
  );
}

// Distinctive text that appears ONLY inside a given panel (not in the nav), so matching it
// proves that panel is the one rendered.
const KEYBOARD_ONLY = /Anywhere/; // a keyboard action group label
const SKILLS_ONLY = /Enable Mission Control skills/; // the skills master toggle
const LAYOUT_ONLY = /Dashboard layout/; // the picker's radiogroup label
const HARNESSES_ONLY = /Auto mode on dispatch/; // the harnesses toggle label
const APPEARANCE_ONLY = /Format messages/; // the rich-text toggle label
const COST_ONLY = /Track what the fleet costs/; // the telemetry master toggle label

test("the rail lists every category exactly once", () => {
  const html = render();
  const items = html.match(/class="settings-nav-item/g) ?? [];
  assert.equal(items.length, SETTINGS_CATEGORIES.length);
  for (const c of SETTINGS_CATEGORIES) assert.ok(html.includes(c.label), `nav missing ${c.label}`);
});

test("opens on Keyboard by default: keyboard panel shows, skills panel does not", () => {
  const html = render();
  assert.match(html, KEYBOARD_ONLY);
  assert.doesNotMatch(html, SKILLS_ONLY);
  // The active item is Keyboard, not Skills.
  assert.match(html, /settings-nav-item is-active"[^>]*><span[^>]*>⌨<\/span>Keyboard/);
});

test("Layout is a category of its own: its panel shows, the others don't", () => {
  const html = render("layout");
  assert.match(html, LAYOUT_ONLY);
  assert.doesNotMatch(html, KEYBOARD_ONLY);
  assert.doesNotMatch(html, SKILLS_ONLY);
  assert.match(html, /settings-nav-item is-active"[^>]*><span[^>]*>▦<\/span>Layout/);
});

test("the layout picker offers every layout, with the live one checked", () => {
  const html = render("layout");
  // Every shipped layout is on offer...
  for (const l of LAYOUTS) assert.ok(html.includes(l.label), `picker missing ${l.label}`);
  // ...and the one App handed us is the checked radio, not a local guess. Rendering the
  // panel against `layout: "grid"` must not leave a different mode selected - that is the
  // bug where the picker and the dashboard behind it disagree about what you're in.
  // (React emits `checked=""` BEFORE `value`, so the attributes are matched in that order.)
  const inputs = html.match(/<input[^>]*>/g) ?? [];
  const checked = inputs.filter((i) => i.includes("checked"));
  assert.equal(inputs.length, LAYOUTS.length, "one radio per layout");
  assert.equal(checked.length, 1, "exactly one layout is checked");
  assert.match(checked[0]!, /value="grid"/);
});

test("the layout panel is absent from every other category", () => {
  for (const id of ["keyboard", "skills", "harnesses", "foreman", "appearance", "cost"] as const) {
    assert.doesNotMatch(render(id), LAYOUT_ONLY, `layout picker leaked into ${id}`);
  }
});

test("Appearance is a category of its own: its panel shows, the others don't", () => {
  const html = render("appearance");
  assert.match(html, APPEARANCE_ONLY);
  assert.doesNotMatch(html, KEYBOARD_ONLY);
  assert.doesNotMatch(html, LAYOUT_ONLY);
  assert.match(html, /settings-nav-item is-active"[^>]*><span[^>]*>◐<\/span>Appearance/);
});

test("message formatting is on unless it has been turned off", () => {
  // `render` mounts the modal with no `RichTextProvider`, so `useRichText` returns its
  // out-of-provider fallback and `load` never runs. What this pins is that fallback: the
  // panel shows a checked box, not an unchecked one or no box at all. It says nothing
  // about what `load` reads from storage; that path is not covered here.
  const html = render("appearance");
  const toggle = (html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [])[0];
  assert.ok(toggle, "the appearance panel has a checkbox");
  assert.match(toggle, /checked/);
});

test("Harnesses is a category of its own: its panel shows, the others don't", () => {
  const html = render("harnesses");
  assert.match(html, HARNESSES_ONLY);
  assert.doesNotMatch(html, KEYBOARD_ONLY);
  assert.doesNotMatch(html, SKILLS_ONLY);
  assert.match(html, /settings-nav-item is-active"[^>]*><span[^>]*>⚙<\/span>Harnesses/);
});

test("Cost is a category of its own: its panel shows, the others don't", () => {
  const html = render("cost");
  assert.match(html, COST_ONLY);
  assert.doesNotMatch(html, KEYBOARD_ONLY);
  assert.doesNotMatch(html, HARNESSES_ONLY);
  assert.match(html, /settings-nav-item is-active"[^>]*><span[^>]*>\$<\/span>Cost/);
});

test("the cost panel says every number is an estimate", () => {
  // The one thing this panel must never stop saying. Anthropic's own docs are explicit
  // that the client-side figure can differ from billing, and on a subscription the
  // dollars are notional entirely - a panel that dropped the word would be presenting a
  // guess as a bill.
  assert.match(render("cost"), /estimate/i);
});

test("the cost panel's controls are disabled until the first read lands", () => {
  // `status` is null here (static render runs no effects), which is the pre-poll instant.
  // A live-looking toggle in that window would let a click race the fetch and write a
  // config built on defaults the daemon never sent.
  const html = render("cost");
  for (const control of html.match(/<(input|select)[^>]*>/g) ?? []) {
    assert.match(control, /disabled/, `cost control should be disabled pre-poll: ${control}`);
  }
});

test("initialCategory swaps the panel: skills shows, keyboard does not", () => {
  const html = render("skills");
  assert.match(html, SKILLS_ONLY);
  assert.doesNotMatch(html, KEYBOARD_ONLY);
  // The active item moved to Skills.
  assert.match(html, /settings-nav-item is-active"[^>]*><span[^>]*>✦<\/span>Skills/);
});

test("exactly one category is active at a time", () => {
  assert.equal((render().match(/settings-nav-item is-active/g) ?? []).length, 1);
  assert.equal((render("skills").match(/settings-nav-item is-active/g) ?? []).length, 1);
});

// The rail is a tab set, not navigation: buttons swap which panel renders beside them,
// so assistive tech should hear "tab 1 of 2, selected", not "current page".
test("the rail is a vertical tablist of tabs", () => {
  const html = render();
  assert.match(html, /role="tablist"[^>]*aria-orientation="vertical"/);
  assert.equal((html.match(/role="tab"/g) ?? []).length, SETTINGS_CATEGORIES.length);
  assert.doesNotMatch(html, /aria-current/);
});

test("aria-selected tracks the active category, and only it", () => {
  for (const active of SETTINGS_CATEGORIES) {
    const html = render(active.id);
    assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 1);
    assert.equal(
      (html.match(/aria-selected="false"/g) ?? []).length,
      SETTINGS_CATEGORIES.length - 1,
    );
    // The selected tab is the active one - same button that carries `is-active`.
    assert.match(
      html,
      new RegExp(`class="settings-nav-item is-active" role="tab" aria-selected="true"`),
    );
  }
});

// Roving tabindex: the rail is one Tab stop, and arrows (not Tab) move within it.
test("only the active tab is in the tab order", () => {
  for (const active of SETTINGS_CATEGORIES) {
    const html = render(active.id);
    assert.equal((html.match(/tabindex="0"/g) ?? []).length, 1);
    assert.equal((html.match(/tabindex="-1"/g) ?? []).length, SETTINGS_CATEGORIES.length - 1);
    assert.match(html, /class="settings-nav-item is-active"[^>]*tabindex="0"/);
  }
});

test("the pane is a tabpanel labelled by the active tab", () => {
  for (const active of SETTINGS_CATEGORIES) {
    const html = render(active.id);
    assert.match(
      html,
      new RegExp(`class="settings-pane" role="tabpanel" aria-labelledby="settings-tab-${active.id}"`),
    );
    // That label points at a tab that actually exists in the rail.
    assert.match(html, new RegExp(`id="settings-tab-${active.id}"`));
  }
});
