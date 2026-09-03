import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { TOUR_ENTRIES } from "../src/web/tour/entries.ts";
import { SETUP_TOUR, type SetupTourNavigation } from "../src/web/tour/tours/setup.ts";
import { TOUR_TARGET_NAMESPACES } from "../src/web/tour/target-registry.ts";

test("the Setup tour follows the panel and closes without an action", () => {
  assert.deepEqual(SETUP_TOUR.steps.map((step) => step.id), [
    "overview",
    "families",
    "statuses",
    "remedies",
    "recheck",
    "close",
  ]);
  const declared = Object.keys(TOUR_TARGET_NAMESPACES.setup).map((name) => `setup:${name}`);
  const used = new Set(SETUP_TOUR.steps.flatMap((step) => step.targets.map((beat) => beat.target)));
  assert.deepEqual([...used].sort(), declared.sort());
  assert.equal(SETUP_TOUR.steps.at(-1)?.centered, true);
  assert.equal(SETUP_TOUR.steps.at(-1)?.targets.length, 0);
});

test("every Setup spotlight is registered by the rendered panel owner", () => {
  const source = readFileSync(new URL("../src/web/components/SetupPanel.tsx", import.meta.url), "utf8");
  for (const name of Object.keys(TOUR_TARGET_NAMESPACES.setup)) {
    assert.ok(source.includes(`useTourTargetRef<`), "the panel owns no target refs");
    assert.ok(source.includes(`"setup:${name}"`), `setup:${name} has no rendered owner`);
  }
});

test("both discovery surfaces use the Setup entry and its route", () => {
  const entry = TOUR_ENTRIES.find((candidate) => candidate.id === "setup");
  assert.ok(entry);
  assert.deepEqual(entry.entryRoute, { page: "settings", category: "setup" });
  assert.equal(entry.settings.ariaLabel, "Start Set up this machine tour");
  assert.equal(entry.palette.title, "Start Set up this machine tour");
});

test("every targeted stop prepares the Setup route, and the row stops name their family", () => {
  let moves = 0;
  const families: string[] = [];
  const navigation: SetupTourNavigation = {
    showSetup: () => { moves += 1; return true; },
    showSetupFamily: (family) => { moves += 1; families.push(family); return true; },
  };
  for (const stop of SETUP_TOUR.steps.filter((candidate) => candidate.targets.length > 0)) {
    assert.equal(stop.prepare?.({
      runtime: null,
      navigation,
      registry: { get: () => null, register: () => () => {} },
      stop,
      beat: 0,
      element: null,
    }), true);
  }
  assert.equal(moves, 5, "every targeted stop puts the route on Setup");
  // The panel shows one family at a time, so the two stops whose copy is about statuses and
  // remedies have to select the family that has both. Leaving them on whatever the rail
  // opened on is how they end up spotlighting a family with nothing to point at.
  assert.deepEqual(families, ["github", "github"]);
  const paneStops = SETUP_TOUR.steps
    .filter((step) => step.targets.some((beat) => beat.target === "setup:pane"))
    .map((step) => step.id);
  assert.deepEqual(paneStops, ["statuses", "remedies"]);
});
