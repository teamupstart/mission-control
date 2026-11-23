import { test } from "node:test";
import assert from "node:assert/strict";

// What is at stake: the Skin picker is rendered FROM the registry, so a skin that is
// registered but not offered - or offered without a name a screen reader can say - is a
// skin nobody can choose. And the tile that reads as chosen has to be the skin in force,
// which is the store's, not a default the panel assumed.
//
// The store seeds itself from the first-paint cache at module load, so the cache is stubbed
// with a non-default skin before anything imports it.

const store = new Map<string, string>([["mission-control.ui", JSON.stringify({ skin: "daylight" })]]);
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { AppearancePanel } = await import("../src/web/components/AppearancePanel.tsx");
const { SKINS } = await import("../src/shared/skins.ts");

const html = renderToStaticMarkup(createElement(AppearancePanel));

/** Every `<input ...>` in the markup, as its attribute string. */
const radios = [...html.matchAll(/<input([^>]*type="radio"[^>]*)>/g)].map((m) => m[1]!);

test("the Skin radiogroup offers one named radio per registered skin, in registry order", () => {
  assert.match(html, /role="radiogroup" aria-label="Skin" data-anchor="display\/skin"/);
  assert.equal(radios.length, SKINS.length, "a registered skin is missing from the picker");
  SKINS.forEach((skin, i) => {
    const radio = radios[i]!;
    assert.match(radio, new RegExp(`value="${skin.id}"`));
    assert.match(radio, new RegExp(`aria-label="${skin.label}"`), `${skin.id} has no accessible name`);
    assert.match(radio, /name="skin"/, "the radios do not share a group, so arrow keys cannot move between them");
    // Its one-line description is visible and tied to the radio.
    assert.match(html, new RegExp(`id="skin-desc-${skin.id}"[^>]*>${skin.description}<`));
  });
});

test("the checked tile is the skin the store holds", () => {
  const checked = radios.filter((r) => /checked=""/.test(r));
  assert.equal(checked.length, 1);
  assert.match(checked[0]!, /value="daylight"/);
  assert.match(html, /class="layout-option view-option is-on"><input[^>]*value="daylight"/);
});

test("each thumbnail is painted in its own skin's swatches, not the skin in force", () => {
  for (const skin of SKINS) {
    for (const colour of Object.values(skin.swatches)) {
      assert.ok(html.includes(`fill="${colour}"`), `${skin.id}'s ${colour} is not in its thumbnail`);
    }
  }
  assert.match(html, /Applies the moment you pick it - the dashboard behind this page repaints live\./);
  // Format messages is still there, below the picker.
  assert.ok(html.indexOf('data-anchor="display/skin"') < html.indexOf('data-anchor="display/format-messages"'));
});
