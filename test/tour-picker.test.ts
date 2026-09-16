import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TourPicker } from "../src/web/components/TourPicker.tsx";
import { tourCatalog } from "../src/web/tour/catalog.ts";
import { TOUR_ENTRIES, RECOMMENDED_TOUR } from "../src/web/tour/entries.ts";
import { TOUR_DEFINITIONS } from "../src/web/tour/definitions.ts";
import { withOverlayHost } from "./helpers/overlay-host.ts";

test("catalog promotes the recommendation and counts authored stops without changing discovery", () => {
  const order = TOUR_ENTRIES.map((entry) => entry.id);
  const catalog = tourCatalog();
  assert.equal(catalog[0]?.id, RECOMMENDED_TOUR);
  assert.deepEqual(catalog.slice(1).map((entry) => entry.id), order.filter((id) => id !== RECOMMENDED_TOUR));
  assert.equal(new Set(catalog.map((entry) => entry.id)).size, TOUR_ENTRIES.length);
  for (const entry of catalog) {
    assert.equal(entry.stopCount, TOUR_DEFINITIONS[entry.id].steps.length);
    assert.equal(entry.preview.outcomes.length, 3);
  }
  assert.deepEqual(TOUR_ENTRIES.map((entry) => entry.id), order);
  const withoutRecommended = TOUR_ENTRIES.filter((entry) => entry.id !== RECOMMENDED_TOUR);
  assert.deepEqual(tourCatalog(withoutRecommended).map((entry) => entry.id), withoutRecommended.map((entry) => entry.id));
  assert.deepEqual(tourCatalog([]), []);
});

test("an empty catalog stays dismissible and cannot start a tour", () => {
  const html = renderToStaticMarkup(withOverlayHost(createElement(TourPicker, {
    entries: [], enabled: true, hydrated: false, saving: false, saveError: false,
    onSave() {}, onStart() {}, onClose() {},
  })));
  assert.match(html, /No tours are available/);
  assert.match(html, /Dismiss/);
  assert.match(html, /Loading your saved preference/);
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, /Start this tour/);
});
