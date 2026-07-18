import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsModal, SETTINGS_CATEGORIES } from "../src/web/components/SettingsModal.tsx";
import type { SettingsCategoryId } from "../src/web/components/SettingsModal.tsx";
import { LAYOUTS } from "../src/web/lib/layout.ts";
import type { ForemanState } from "../src/web/useForeman.ts";

// Rendered rather than driven through a browser: the dashboard's SSE stream holds the
// connection open, which hangs headless automation (same reason as plan-decisions-render).
// Static markup is enough to prove the two-pane structure - the rail lists every category,
// and the active category selects which panel renders - since the only thing a click does
// is set `active`, which we exercise here through the initialCategory prop.

// Foreman config is owned by App and passed in; null config is the pre-poll state, which
// renders the panel's defaults. Static render never runs effects, so nothing fetches.
const FOREMAN: ForemanState = { config: null, status: null, update: async () => {}, error: null };

// The layout is owned by App too, for the same reason as Foreman: the dashboard behind the
// modal renders it, so the panel only edits what it's handed.
function render(initialCategory?: SettingsCategoryId): string {
  return renderToStaticMarkup(
    createElement(SettingsModal, {
      onClose: () => {},
      foreman: FOREMAN,
      layout: "grid",
      onLayoutChange: () => {},
      initialCategory,
    }),
  );
}

// Distinctive text that appears ONLY inside a given panel (not in the nav), so matching it
// proves that panel is the one rendered.
const KEYBOARD_ONLY = /Anywhere/; // a keyboard action group label
const SKILLS_ONLY = /Enable Mission Control skills/; // the skills master toggle
const LAYOUT_ONLY = /Dashboard layout/; // the picker's radiogroup label

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
  for (const id of ["keyboard", "skills", "foreman"] as const) {
    assert.doesNotMatch(render(id), LAYOUT_ONLY, `layout picker leaked into ${id}`);
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
