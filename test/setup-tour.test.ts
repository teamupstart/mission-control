import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { FIRST_RUN_TOUR, TOUR_ENTRIES } from "../src/web/tour/entries.ts";
import { SETUP_TOUR, type SetupTourNavigation } from "../src/web/tour/tours/setup.ts";
import { TOUR_TARGET_NAMESPACES } from "../src/web/tour/target-registry.ts";

/** The navigation the tour is driven through, recording the route moves it asks for. */
function recorder(): { navigation: SetupTourNavigation; moves: string[] } {
  const moves: string[] = [];
  return {
    moves,
    navigation: {
      showFleet: () => { moves.push("fleet"); return true; },
      showSettings: () => { moves.push("settings"); return true; },
      showSetup: () => { moves.push("setup"); return true; },
      showTrust: () => { moves.push("trust"); return true; },
    },
  };
}

type SetupStop = (typeof SETUP_TOUR.steps)[number];

function prepare(stop: SetupStop, navigation: SetupTourNavigation): boolean | undefined {
  return stop.prepare?.({
    runtime: null,
    navigation,
    registry: { get: () => null, register: () => () => {} },
    stop,
    beat: 0,
    element: null,
  });
}

test("the Setup tour is seven stops, from the gear to the Trust matrix", () => {
  assert.deepEqual(SETUP_TOUR.steps.map((step) => step.id), [
    "settings",
    "setup",
    "dependencies",
    "recheck",
    "trust",
    "grants",
    "trust-add",
  ]);
  // Every declared target is spotlighted, and every spotlight is declared: the namespace and
  // the tour cannot drift apart into a target nothing points at, or the reverse.
  const declared = Object.keys(TOUR_TARGET_NAMESPACES.setup).map((name) => `setup:${name}`);
  const used = SETUP_TOUR.steps.flatMap((step) => step.targets.map((beat) => beat.target));
  assert.deepEqual([...new Set(used)].sort(), declared.sort());
  // One spotlight per stop. This tour teaches a path, so a stop that looked at two things
  // would be a stop whose copy cannot say which one it means.
  assert.deepEqual(SETUP_TOUR.steps.map((step) => step.targets.length), [1, 1, 1, 1, 1, 1, 1]);
  // No centered close: the tour ends ON the panel it just opened rather than in front of it.
  assert.equal(SETUP_TOUR.steps.at(-1)?.centered, undefined);
  assert.deepEqual(
    SETUP_TOUR.steps.map((step) => step.targets[0]?.target),
    [
      "setup:settings-gear",
      "setup:settings-tab",
      "setup:dependencies",
      "setup:recheck",
      "setup:trust-tab",
      "setup:trust-matrix",
      "setup:trust-add",
    ],
  );
});

test("the tour grants nothing and installs nothing: every stop is a route move", () => {
  // The whole tour stays read-only now that it reaches Trust, which is where that matters
  // most: a stop that clicked a cell would hand out a live GitHub grant on behalf of an
  // operator who only pressed Next. `prepare` is the only callback any stop declares.
  for (const stop of SETUP_TOUR.steps) {
    assert.equal(stop.onNext, undefined, `${stop.id} takes Next over`);
    assert.equal(stop.onBack, undefined, `${stop.id} acts on Back`);
    assert.equal(stop.interactive, undefined, `${stop.id} opens the real surface`);
  }
});

test("the tour walks the fleet, Settings, Setup, then Trust, opening neither early", () => {
  const { navigation, moves } = recorder();
  for (const stop of SETUP_TOUR.steps) assert.equal(prepare(stop, navigation), true);
  // The gear reads "Settings" only from somewhere else, and each rail row the tour points at
  // has to be unselected for that stop to be about reaching its panel at all. The stop that
  // spotlights Trust in the rail is therefore still on Setup - the third "setup" move here.
  assert.deepEqual(moves, ["fleet", "settings", "setup", "setup", "setup", "trust", "trust"]);
});

test("each hand-over stop names its own label, and the tour finishes on the add row", () => {
  const { navigation } = recorder();
  const labels = SETUP_TOUR.steps.map((stop) => stop.nextLabel?.({
    runtime: null,
    navigation,
    registry: { get: () => null, register: () => () => {} },
    stop,
    beat: 0,
    element: null,
  }));
  assert.deepEqual(labels, [
    "Open Settings",
    "Open Setup",
    undefined,
    undefined,
    "Open Trust",
    undefined,
    "Finish tour",
  ]);
});

test("every Setup spotlight is registered by the surface that renders it", () => {
  // Three of the seven are outside both panels on purpose: the tour has to show an operator
  // who has never opened Setup or Trust where each one is, which is the top bar and the
  // Settings rail.
  const owners: Record<string, string> = {
    "settings-gear": "src/web/App.tsx",
    "settings-tab": "src/web/components/SettingsPage.tsx",
    "dependencies": "src/web/components/SetupPanel.tsx",
    "recheck": "src/web/components/SetupPanel.tsx",
    "trust-tab": "src/web/components/SettingsPage.tsx",
    "trust-matrix": "src/web/components/TrustPanel.tsx",
    "trust-add": "src/web/components/TrustPanel.tsx",
  };
  assert.deepEqual(Object.keys(owners).sort(), Object.keys(TOUR_TARGET_NAMESPACES.setup).sort());
  for (const [name, owner] of Object.entries(owners)) {
    const source = readFileSync(new URL(`../${owner}`, import.meta.url), "utf8");
    assert.ok(source.includes(`"setup:${name}"`), `setup:${name} has no rendered owner`);
  }
});

test("the Setup entry opens on the fleet and hands the operator Trust when it ends", () => {
  const entry = TOUR_ENTRIES.find((candidate) => candidate.id === "setup");
  assert.ok(entry);
  // The page the tour is ABOUT is its exit, not its entry: it starts where the gear it points
  // at still reads "Settings".
  assert.deepEqual(entry.entryRoute, { page: "fleet" });
  assert.deepEqual(entry.exit, {
    route: { page: "settings", category: "trust" },
    focus: "setup:trust-tab",
  });
  assert.equal(entry.settings.ariaLabel, "Start Set up this machine tour");
  assert.equal(entry.palette.title, "Start Set up this machine tour");
});

test("Setup is the tour a fresh profile receives automatically", () => {
  assert.equal(FIRST_RUN_TOUR, "setup");
  // The automatic tour is one of the registered ones rather than a fourth definition wired
  // straight into the effect that starts it.
  assert.ok(TOUR_ENTRIES.some((entry) => entry.id === FIRST_RUN_TOUR));
});

test("only a tour that hands a page over declares an exit route", () => {
  assert.deepEqual(
    TOUR_ENTRIES.filter((entry) => entry.exit).map((entry) => entry.id),
    ["setup"],
    "a demonstrating tour still owes back the page it borrowed",
  );
});
