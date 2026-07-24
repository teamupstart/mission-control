import { test } from "node:test";
import assert from "node:assert/strict";
import { missionRouteHash, parseMissionRoute } from "../src/web/workflows/useWorkflowRoute.ts";
import {
  DEFAULT_SETTINGS_CATEGORY,
  SETTINGS_CATEGORIES,
} from "../src/web/lib/settings-registry.ts";

// What is at stake: Settings is a page reached by hash now, so `#/settings/shipping` is a
// link people keep - in a bookmark, in a README, in a message to somebody else. Two things
// have to hold for that to be safe. It has to round-trip, or back/forward walks somewhere
// other than where the rail is. And an id this build does not have - a stale link, a typo,
// a category a future build added - has to fall back to the DEFAULT panel rather than
// rendering a blank pane or, worse, landing on whatever category happens to sort first;
// the default is the browser-scoped one, so a bad link cannot open a panel that acts on
// GitHub.

test("settings hashes parse and serialize without drifting", () => {
  assert.deepEqual(parseMissionRoute("#/settings"), {
    page: "settings",
    category: DEFAULT_SETTINGS_CATEGORY,
  });
  assert.deepEqual(parseMissionRoute("#/settings/shipping"), {
    page: "settings",
    category: "shipping",
  });
  // A trailing slash is the same link - it is what a copied URL often carries.
  assert.deepEqual(parseMissionRoute("#/settings/"), {
    page: "settings",
    category: DEFAULT_SETTINGS_CATEGORY,
  });
  assert.equal(missionRouteHash({ page: "settings", category: "shipping" }), "#/settings/shipping");
  // The category is always spelled out, so every settings link is a deep link.
  assert.equal(
    missionRouteHash({ page: "settings", category: DEFAULT_SETTINGS_CATEGORY }),
    `#/settings/${DEFAULT_SETTINGS_CATEGORY}`,
  );
});

test("every category round-trips through its own hash", () => {
  for (const c of SETTINGS_CATEGORIES) {
    const hash = missionRouteHash({ page: "settings", category: c.id });
    assert.equal(hash, `#/settings/${c.id}`);
    assert.deepEqual(parseMissionRoute(hash), { page: "settings", category: c.id });
  }
});

test("an unknown category falls back to the default panel, not to a blank one", () => {
  for (const bad of ["#/settings/trust", "#/settings/nonsense", "#/settings/%20"]) {
    assert.deepEqual(
      parseMissionRoute(bad),
      { page: "settings", category: DEFAULT_SETTINGS_CATEGORY },
      `${bad} should fall back`,
    );
  }
  // Deeper than the grammar goes is not a settings route at all.
  assert.deepEqual(parseMissionRoute("#/settings/shipping/extra"), { page: "fleet" });
});

test("the fleet and workflows routes are untouched by the new page", () => {
  assert.deepEqual(parseMissionRoute("#/fleet"), { page: "fleet" });
  assert.deepEqual(parseMissionRoute("#/workflows"), { page: "workflows", tab: "workflows" });
  assert.deepEqual(parseMissionRoute("#/workflows/personas"), { page: "workflows", tab: "personas" });
  assert.deepEqual(parseMissionRoute("#/workflows/runs/r1"), {
    page: "workflows",
    tab: "runs",
    runId: "r1",
  });
  assert.deepEqual(parseMissionRoute("#/unknown"), { page: "fleet" });
  assert.equal(missionRouteHash({ page: "fleet" }), "#/fleet");
  assert.equal(missionRouteHash({ page: "workflows", tab: "personas" }), "#/workflows/personas");
});

// The default is a real category, not a string somebody typed twice.
test("the default category is one of the registered ones", () => {
  assert.ok(SETTINGS_CATEGORIES.some((c) => c.id === DEFAULT_SETTINGS_CATEGORY));
});
