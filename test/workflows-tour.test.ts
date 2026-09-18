import assert from "node:assert/strict";
import test from "node:test";

import { flattenTour, type TourStepContext } from "../src/web/tour/contracts.ts";
import { tourEntry } from "../src/web/tour/entries.ts";
import { createTourTargetRegistry } from "../src/web/tour/target-registry.ts";
import {
  WORKFLOWS_TOUR,
  selectWorkflowsTourSession,
  type WorkflowsTourNavigation,
  type WorkflowsTourRuntime,
} from "../src/web/tour/tours/workflows.ts";

/**
 * Follow the review as DATA, checked without a browser.
 *
 * The stop table, the route each stop asks for, the run and session selection rules, and
 * every fallback clause are a definition rather than a component. The browser proof is
 * `e2e/specs/workflows-tour.spec.ts`.
 */

type Runtime = WorkflowsTourRuntime;

const READY_RUNTIME: Runtime = {
  run: { id: "run-1" },
  seedError: null,
  sessionId: "session-1",
  sessionLive: true,
  sessionError: null,
  dispatchOpen: false,
  bindingDialogOpen: false,
};

interface Move {
  kind: keyof WorkflowsTourNavigation;
  argument?: string;
}

/** A navigator that records where a stop asked to go, and accepts every move. */
function recorder(accept = true): { moves: Move[]; navigation: WorkflowsTourNavigation } {
  const moves: Move[] = [];
  const record = (kind: keyof WorkflowsTourNavigation, argument?: string): boolean => {
    moves.push(argument === undefined ? { kind } : { kind, argument });
    return accept;
  };
  return {
    moves,
    navigation: {
      showRuns: () => record("showRuns"),
      showDispatchModal: () => record("showDispatchModal"),
      closeDispatch: () => void record("closeDispatch"),
      showBindingChip: (sessionId) => record("showBindingChip", sessionId ?? "none"),
      openBindingDialog: (sessionId) => record("openBindingDialog", sessionId ?? "none"),
      closeBindingDialog: () => void record("closeBindingDialog"),
      showRun: (runId, pane) => record("showRun", `${runId}:${pane}`),
    },
  };
}

function contextFor(
  stopId: string,
  runtime: Runtime,
  navigation: WorkflowsTourNavigation,
  element: HTMLElement | null = {} as HTMLElement,
): TourStepContext<Runtime, WorkflowsTourNavigation> {
  const stop = WORKFLOWS_TOUR.steps.find((candidate) => candidate.id === stopId);
  assert.ok(stop, `no stop ${stopId}`);
  return {
    runtime,
    navigation,
    registry: createTourTargetRegistry(),
    stop,
    beat: 0,
    element,
  };
}

test("the tour is thirteen stops in lifecycle order, with one two-beat gate", () => {
  assert.equal(WORKFLOWS_TOUR.title, "Follow the review");
  assert.deepEqual(WORKFLOWS_TOUR.steps.map((stop) => stop.id), [
    "workflows",
    "after-work",
    "binding",
    "bind-dialog",
    "pipeline",
    "evidence",
    "readiness",
    "commands",
    "judges",
    "rounds",
    "pull-request",
    "inspector",
    "close",
  ]);

  const screens = flattenTour(WORKFLOWS_TOUR);
  // Thirteen stops; the Inspector stop spotlights the strip footer then the Completion
  // pane, and the opening card is the one deliberate centered stop.
  assert.equal(screens.length, 14);
  const centered = WORKFLOWS_TOUR.steps.filter((stop) => stop.targets.length === 0);
  assert.deepEqual(centered.map((stop) => stop.id), ["workflows"]);
  assert.equal(centered[0]?.centered, true);
  const inspector = WORKFLOWS_TOUR.steps.find((stop) => stop.id === "inspector");
  assert.equal(inspector?.targets.length, 2);
});

test("the entry opens on the Runs page and hands it over on exit", () => {
  const entry = tourEntry("workflows");
  assert.deepEqual(entry.entryRoute, { page: "runs" });
  assert.deepEqual(entry.exit, {
    route: { page: "runs" },
    focus: "workflows:run-filter-all",
  });
});

test("session selection prefers an armed session, then the first live one", () => {
  assert.equal(
    selectWorkflowsTourSession(["s1", "s2", "s3"], new Set(["s2"])),
    "s2",
  );
  assert.equal(selectWorkflowsTourSession(["s1", "s2"], new Set()), "s1");
  assert.equal(selectWorkflowsTourSession([], new Set(["gone"])), null);
});

test("each stop asks for the surface its copy describes", () => {
  const { moves, navigation } = recorder();
  for (const stop of WORKFLOWS_TOUR.steps) {
    stop.prepare?.(contextFor(stop.id, READY_RUNTIME, navigation));
  }
  assert.deepEqual(moves, [
    { kind: "showRuns" },
    { kind: "showDispatchModal" },
    { kind: "showBindingChip", argument: "session-1" },
    { kind: "openBindingDialog", argument: "session-1" },
    { kind: "showRun", argument: "run-1:worklist" },
    { kind: "showRun", argument: "run-1:evidence" },
    { kind: "showRun", argument: "run-1:evidence" },
    { kind: "showRun", argument: "run-1:worklist" },
    { kind: "showRun", argument: "run-1:worklist" },
    { kind: "showRun", argument: "run-1:worklist" },
    { kind: "showRun", argument: "run-1:worklist" },
    { kind: "showRun", argument: "run-1:completion" },
    // The close stop stays where the previous stop left the operator.
  ]);
});

test("with no run yet, every run stop says the demo record is seeding", () => {
  const runtime: Runtime = { ...READY_RUNTIME, run: null };
  const { moves, navigation } = recorder();
  const runStops = ["pipeline", "evidence", "readiness", "commands", "judges", "rounds", "pull-request", "inspector"];
  for (const stopId of runStops) {
    const context = contextFor(stopId, runtime, navigation, null);
    assert.equal(context.stop.prepare?.(context), true);
    assert.equal(context.stop.ready?.(context), false);
    assert.equal(context.stop.attainable?.(context), false, `${stopId} should skip the wait`);
    assert.match(context.stop.fallback?.(context) ?? "", /seeding a demonstration/i);
  }
  assert.ok(moves.every((move) => move.kind === "showRuns"));
});

test("a refused seed turns every run stop's fallback into the daemon's own reason", () => {
  const runtime: Runtime = { ...READY_RUNTIME, run: null, seedError: "the disk is full" };
  const { navigation } = recorder();
  for (const stopId of ["pipeline", "inspector", "close"]) {
    const context = contextFor(stopId, runtime, navigation, null);
    assert.match(
      context.stop.fallback?.(context) ?? "",
      /could not be seeded: the disk is full/,
    );
  }
});

test("while the temporary conversation launches, the binding stops say so and wait", () => {
  const runtime: Runtime = { ...READY_RUNTIME, sessionId: null, sessionLive: false };
  const { moves, navigation } = recorder();
  for (const stopId of ["binding", "bind-dialog"]) {
    const context = contextFor(stopId, runtime, navigation, null);
    assert.equal(context.stop.prepare?.(context), true);
    assert.equal(context.stop.ready?.(context), false);
    assert.equal(context.stop.attainable?.(context), false);
    assert.match(context.stop.fallback?.(context) ?? "", /temporary conversation/);
  }
  // The chip stop still walks to the fleet; the dialog opener refuses to open over nothing.
  assert.deepEqual(moves, [
    { kind: "showBindingChip", argument: "none" },
    { kind: "openBindingDialog", argument: "none" },
  ]);
});

test("a refused conversation launch turns the binding fallbacks into the daemon's reason", () => {
  const runtime: Runtime = {
    ...READY_RUNTIME,
    sessionId: null,
    sessionLive: false,
    sessionError: "no git repository",
  };
  const { navigation } = recorder();
  for (const stopId of ["binding", "bind-dialog"]) {
    const context = contextFor(stopId, runtime, navigation, null);
    assert.match(
      context.stop.fallback?.(context) ?? "",
      /could not start: no git repository/,
    );
  }
});

test("a session evicted mid-tour turns both binding stops into their fallback copy", () => {
  const runtime: Runtime = { ...READY_RUNTIME, sessionLive: false };
  const { navigation } = recorder();
  for (const stopId of ["binding", "bind-dialog"]) {
    const context = contextFor(stopId, runtime, navigation, null);
    assert.equal(context.stop.ready?.(context), false);
    assert.equal(context.stop.attainable?.(context), false);
  }
});

test("the modal stops reconcile to their opener when the operator closes the modal", () => {
  const { navigation } = recorder();
  const closedDispatch = contextFor("after-work", READY_RUNTIME, navigation);
  assert.deepEqual(closedDispatch.stop.reconcile?.(closedDispatch), {
    kind: "goto",
    stopId: "workflows",
    beat: 0,
  });
  const openDispatch = contextFor(
    "after-work",
    { ...READY_RUNTIME, dispatchOpen: true },
    navigation,
  );
  assert.deepEqual(openDispatch.stop.reconcile?.(openDispatch), { kind: "refresh" });

  const closedDialog = contextFor("bind-dialog", READY_RUNTIME, navigation);
  assert.deepEqual(closedDialog.stop.reconcile?.(closedDialog), {
    kind: "goto",
    stopId: "binding",
    beat: 0,
  });
});

test("leaving a modal stop backwards closes the modal it opened", () => {
  const dispatch = recorder();
  contextFor("after-work", READY_RUNTIME, dispatch.navigation).stop
    .onBack?.(contextFor("after-work", READY_RUNTIME, dispatch.navigation));
  assert.deepEqual(dispatch.moves, [{ kind: "closeDispatch" }]);

  const dialog = recorder();
  contextFor("bind-dialog", READY_RUNTIME, dialog.navigation).stop
    .onBack?.(contextFor("bind-dialog", READY_RUNTIME, dialog.navigation));
  assert.deepEqual(dialog.moves, [{ kind: "closeBindingDialog" }]);
});
