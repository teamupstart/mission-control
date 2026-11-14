import assert from "node:assert/strict";
import test from "node:test";

import { flattenTour, type TourStepContext } from "../src/web/tour/contracts.ts";
import { TOUR_ENTRIES, tourEntry } from "../src/web/tour/entries.ts";
import {
  createTourTargetRegistry,
  TOUR_TARGET_NAMESPACES,
  type TourTargetRegistry,
} from "../src/web/tour/target-registry.ts";
import {
  AGENT_SHEPHERD_PROFILE_ID,
  RESIDENTS_TOUR,
  selectResidentsTourProfile,
  type ResidentsTourNavigation,
  type ResidentsTourRuntime,
} from "../src/web/tour/tours/residents.ts";

/**
 * Meet your residents as DATA, checked without a browser: the stop table, the moves each stop
 * asks for, the built-in it reads, and what each stop says while its surface is missing. The
 * browser proof is `e2e/specs/residents-tour.spec.ts`.
 */

type Runtime = ResidentsTourRuntime;
type Navigation = ResidentsTourNavigation;

const READY: Runtime = { profileId: AGENT_SHEPHERD_PROFILE_ID, drawerShown: false };

function recorder(): { moves: string[]; navigation: Navigation } {
  const moves: string[] = [];
  return {
    moves,
    navigation: {
      showProfile: (profileId) => { moves.push(`profile:${profileId ?? "none"}`); return true; },
      showFleet: () => { moves.push("fleet"); return true; },
      showDrawer: () => { moves.push("drawer"); return true; },
      hideDrawer: () => { moves.push("hide-drawer"); },
      reachedEnd: () => { moves.push("reached-end"); },
    },
  };
}

function contextFor(
  stopId: string,
  runtime: Runtime,
  navigation: Navigation,
  options: { element?: HTMLElement | null; registry?: TourTargetRegistry } = {},
): TourStepContext<Runtime, Navigation> {
  const stop = RESIDENTS_TOUR.steps.find((candidate) => candidate.id === stopId);
  assert.ok(stop, `no stop ${stopId}`);
  return {
    runtime,
    navigation,
    registry: options.registry ?? createTourTargetRegistry(),
    stop,
    beat: 0,
    element: options.element === undefined ? ({} as HTMLElement) : options.element,
  };
}

test("the tour is ten stops: the built-in, its profile, then the drawer and its pin", () => {
  assert.equal(RESIDENTS_TOUR.title, "Meet your residents");
  assert.deepEqual(RESIDENTS_TOUR.steps.map((stop) => stop.id), [
    "residents",
    "agent-shepherd",
    "profile",
    "duplicate",
    "new",
    "loop",
    "launch",
    "open-sidebar",
    "sidebar",
    "pin",
  ]);
  // One spotlight per stop, after the one deliberate centered opening.
  assert.equal(flattenTour(RESIDENTS_TOUR).length, 10);
  const centered = RESIDENTS_TOUR.steps.filter((stop) => stop.targets.length === 0);
  assert.deepEqual(centered.map((stop) => stop.id), ["residents"]);
  assert.equal(centered[0]?.centered, true);
  // Every declared target is spotlighted, and every spotlight is declared.
  const declared = Object.keys(TOUR_TARGET_NAMESPACES.residents).map((name) => `residents:${name}`);
  const used = RESIDENTS_TOUR.steps.flatMap((stop) => stop.targets.map((beat) => beat.target));
  assert.deepEqual([...new Set(used)].sort(), declared.sort());
});

test("the tour saves, duplicates, launches and pins nothing: every stop is a move", () => {
  for (const stop of RESIDENTS_TOUR.steps) {
    assert.equal(stop.onNext, undefined, `${stop.id} takes Next over`);
    assert.equal(stop.interactive, undefined, `${stop.id} opens the real surface`);
    assert.equal(stop.gateNext, undefined, `${stop.id} holds Next`);
  }
  assert.deepEqual(RESIDENTS_TOUR.documentFlags, []);
});

test("it reads the built-in on the Residents page, then walks to the drawer", () => {
  const { navigation, moves } = recorder();
  for (const stop of RESIDENTS_TOUR.steps) {
    assert.equal(stop.prepare?.(contextFor(stop.id, READY, navigation)), true, stop.id);
  }
  // Only the last stop says the tour was seen through: leaving before it is dismissing it
  // midway, which App answers by announcing the tour again in the next window's picker.
  assert.deepEqual(moves, [
    ...Array(7).fill(`profile:${AGENT_SHEPHERD_PROFILE_ID}`),
    "fleet",
    "drawer",
    "reached-end",
    "drawer",
  ]);
  // Back out of the drawer puts away a drawer the tour opened; nothing else acts on Back.
  const back = recorder();
  for (const stop of RESIDENTS_TOUR.steps) stop.onBack?.(contextFor(stop.id, READY, back.navigation));
  assert.deepEqual(back.moves, ["hide-drawer"]);
});

test("hand-over stops name what Next does, and the last one finishes", () => {
  const { navigation } = recorder();
  const labels = RESIDENTS_TOUR.steps.map((stop) => stop.nextLabel?.(contextFor(stop.id, READY, navigation)));
  assert.deepEqual(labels, [
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "Open the sidebar",
    undefined,
    "Finish tour",
  ]);
});

test("the tour reads Agent Shepherd only, and waits rather than presenting another profile", () => {
  const shepherd = { id: AGENT_SHEPHERD_PROFILE_ID, builtin: true };
  const other = { id: "builtin:other", builtin: true };
  const mine = { id: "profile-1", builtin: false };
  assert.equal(AGENT_SHEPHERD_PROFILE_ID, "builtin:agent-shepherd");
  assert.equal(selectResidentsTourProfile([mine, other, shepherd]), AGENT_SHEPHERD_PROFILE_ID);
  // Without Agent Shepherd there is nothing to advertise: neither another built-in nor a
  // profile of the operator's is presented as it, and the stops show their loading copy.
  assert.equal(selectResidentsTourProfile([mine, other]), null);
  assert.equal(selectResidentsTourProfile([mine]), null);
  assert.equal(selectResidentsTourProfile([]), null);
});

test("until the profiles arrive, the page stops say so and wait on the rail", () => {
  const { navigation, moves } = recorder();
  const loading: Runtime = { profileId: null, drawerShown: false };
  for (const id of ["agent-shepherd", "profile", "duplicate", "loop", "launch"]) {
    const context = contextFor(id, loading, navigation);
    assert.equal(context.stop.ready?.(context), false, id);
    assert.equal(context.stop.attainable?.(context), false, id);
    assert.match(context.stop.fallback?.(context) ?? "", /still arriving/, id);
    // With no profile to name, the target resolves to nothing rather than to the wrong row.
    assert.equal(context.stop.targets[0]?.resolve?.(context) ?? null, null, id);
    assert.equal(context.stop.reconcile?.(context).kind, "restage", id);
  }
  // New stands on the rail, which is on the page whether or not a built-in has arrived.
  const fresh = contextFor("new", loading, navigation);
  assert.equal(fresh.stop.ready?.(fresh), true);
  contextFor("residents", loading, navigation).stop.prepare?.(contextFor("residents", loading, navigation));
  assert.deepEqual(moves, ["profile:none"]);
});

test("the drawer stops wait for the drawer, and a hidden top-bar button names the other ways in", () => {
  const { navigation } = recorder();
  const closed = contextFor("sidebar", READY, navigation);
  assert.equal(closed.stop.ready?.(closed), false);
  assert.equal(closed.stop.reconcile?.(closed).kind, "restage");
  const open = contextFor("pin", { ...READY, drawerShown: true }, navigation);
  assert.equal(open.stop.ready?.(open), true);
  assert.equal(open.stop.reconcile?.(open).kind, "refresh");
  const hidden = contextFor("open-sidebar", READY, navigation, { element: null });
  assert.equal(hidden.stop.ready?.(hidden), false);
  assert.match(hidden.stop.fallback?.(hidden) ?? "", /Shift\+H/);
});

test("the entry opens on the Residents page and hands the fleet over on exit", () => {
  const entry = tourEntry("residents");
  assert.deepEqual(entry.entryRoute, { page: "residents" });
  assert.deepEqual(entry.exit, { route: { page: "fleet" }, focus: "residents:topbar-button" });
  assert.equal(entry.settings.ariaLabel, "Start Meet your residents tour");
  assert.equal(entry.palette.title, "Start Meet your residents tour");
  assert.equal(entry.preview.illustration, "residents");
  assert.ok(entry.palette.keywords.includes("agent shepherd"));
  assert.equal(TOUR_ENTRIES.at(-1)?.id, "residents");
});
