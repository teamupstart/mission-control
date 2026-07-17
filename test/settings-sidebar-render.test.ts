import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsModal, SETTINGS_CATEGORIES } from "../src/web/components/SettingsModal.tsx";
import type { SettingsCategoryId } from "../src/web/components/SettingsModal.tsx";

// Rendered rather than driven through a browser: the dashboard's SSE stream holds the
// connection open, which hangs headless automation (same reason as plan-decisions-render).
// Static markup is enough to prove the two-pane structure - the rail lists every category,
// and the active category selects which panel renders - since the only thing a click does
// is set `active`, which we exercise here through the initialCategory prop.

function render(initialCategory?: SettingsCategoryId): string {
  return renderToStaticMarkup(
    createElement(SettingsModal, { onClose: () => {}, initialCategory }),
  );
}

// Distinctive text that appears ONLY inside a given panel (not in the nav), so matching it
// proves that panel is the one rendered.
const KEYBOARD_ONLY = /Anywhere/; // a keyboard action group label
const SKILLS_ONLY = /Enable Mission Control skills/; // the skills master toggle

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
