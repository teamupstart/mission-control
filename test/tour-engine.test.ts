import assert from "node:assert/strict";
import test from "node:test";

import {
  assertTourDefinition,
  cursorAt,
  flattenTour,
  goTo,
  hold,
  refresh,
  screenIndexOf,
  TourDefinitionError,
  type TourDefinition,
  type TourStep,
} from "../src/web/tour/contracts.ts";
import { TOUR_DEFINITIONS } from "../src/web/tour/definitions.ts";
import { TOUR_ENTRIES, tourEntry } from "../src/web/tour/entries.ts";
import { SEE_WORK_TOUR } from "../src/web/tour/tours/see-work.ts";
import { createTourTargetRegistry } from "../src/web/tour/target-registry.ts";

type Step = TourStep<null, null>;

function definition(steps: readonly Step[]): TourDefinition<null, null> {
  return {
    id: "see-work",
    title: "Test tour",
    steps,
    documentFlags: [],
    stopping: { title: "Stopping", description: "Stopping" },
    runtimeKey: () => "",
  };
}

const beat = (name: string): Step["targets"][number] =>
  ({ target: `see-work:${name}` } as Step["targets"][number]);

test("a definition with no stops is refused", () => {
  assert.throws(() => assertTourDefinition(definition([])), TourDefinitionError);
});

test("a repeated stop id is refused, because the cursor addresses stops by id", () => {
  assert.throws(
    () => assertTourDefinition(definition([
      { id: "one", title: "One", description: "", targets: [beat("line")] },
      { id: "one", title: "Two", description: "", targets: [beat("board")] },
    ])),
    /repeats stop id one/,
  );
});

test("a third beat is refused", () => {
  assert.throws(
    () => assertTourDefinition(definition([
      {
        id: "one",
        title: "One",
        description: "",
        targets: [beat("line"), beat("board"), beat("dispatch")],
      },
    ])),
    /declares 3 beats; two is the maximum/,
  );
});

test("a targetless stop is refused unless it says it is a centered card", () => {
  const steps: readonly Step[] = [{ id: "one", title: "One", description: "", targets: [] }];
  assert.throws(() => assertTourDefinition(definition(steps)), /not marked centered/);
  assert.doesNotThrow(() =>
    assertTourDefinition(definition([{ ...steps[0]!, centered: true }])));
});

test("a stop cannot point outside its own tour's namespace", () => {
  assert.throws(
    () => assertTourDefinition(definition([{
      id: "one",
      title: "One",
      description: "",
      targets: [{ target: "library:line" } as unknown as Step["targets"][number]],
    }])),
    /outside its namespace/,
  );
});

test("beats flatten into Driver screens while the owning stop keeps the progress number", () => {
  const flat = flattenTour(definition([
    { id: "one", title: "One", description: "", targets: [beat("line"), beat("board")] },
    { id: "two", title: "Two", description: "", targets: [beat("dispatch")] },
    { id: "three", title: "Three", description: "", targets: [], centered: true },
  ]));
  assert.deepEqual(
    flat.map((screen) => [screen.stop.id, screen.stopIndex, screen.beat]),
    [["one", 0, 0], ["one", 0, 1], ["two", 1, 0], ["three", 2, 0]],
  );
  // Four screens, three steps: a two-beat stop reads as one step to the operator.
  assert.equal(flat.length, 4);
  assert.equal(new Set(flat.map((screen) => screen.stopIndex)).size, 3);
});

test("a targetless terminal stop still produces exactly one screen", () => {
  const flat = flattenTour(definition([
    { id: "only", title: "Only", description: "", targets: [], centered: true },
  ]));
  assert.equal(flat.length, 1);
  assert.equal(flat[0]!.beat, 0);
});

test("the command helpers name where the engine goes next", () => {
  assert.deepEqual(hold(), { kind: "hold" });
  assert.deepEqual(refresh(), { kind: "refresh" });
  assert.deepEqual(goTo("idle"), { kind: "goto", stopId: "idle", beat: 0 });
  assert.deepEqual(goTo("idle", 1), { kind: "goto", stopId: "idle", beat: 1 });
});

test("See the work is still fourteen stops, one screen each, in the same order", () => {
  assert.equal(SEE_WORK_TOUR.steps.length, 14);
  assert.equal(flattenTour(SEE_WORK_TOUR).length, 14);
  assert.deepEqual(SEE_WORK_TOUR.steps.map((step) => step.id), [
    "line",
    "board",
    "session-detail",
    "dispatch",
    "dispatch-kind",
    "dispatch-input",
    "dispatch-workflow",
    "dispatch-submit",
    "working",
    "needs-you",
    "review",
    "idle",
    "actions",
    "complete",
  ]);
  assert.deepEqual(SEE_WORK_TOUR.steps.map((step) => step.title), [
    "Fleet and the Line",
    "Board View",
    "Session detail",
    "Open Dispatch",
    "Choose the kind",
    "Brief ready",
    "Choose what follows",
    "Dispatch the task",
    "Working",
    "Needs You",
    "Choose and submit",
    "Idle",
    "Complete or run a retro",
    "Complete the tour",
  ]);
});

function seeWorkRuntime(
  overrides: Partial<Parameters<typeof SEE_WORK_TOUR.runtimeKey>[0]> = {},
) {
  return {
    previewSessionId: null,
    previewPhase: "launching" as const,
    previewError: null,
    taskId: null,
    sessionId: null,
    phase: "not-started" as const,
    dispatchOpen: false,
    dispatchBriefReady: false,
    dispatchRepoReady: false,
    completeOpen: false,
    reviewPending: false,
    reviewOpen: false,
    error: null,
    ...overrides,
  };
}

const NAVIGATION_STUB = new Proxy({}, {
  get: () => () => true,
}) as Parameters<NonNullable<(typeof SEE_WORK_TOUR.steps)[number]["prepare"]>>[0]["navigation"];

function context(stopId: string, runtime = seeWorkRuntime(), element: HTMLElement | null = null) {
  const stop = SEE_WORK_TOUR.steps.find((step) => step.id === stopId)!;
  return {
    runtime,
    navigation: NAVIGATION_STUB,
    registry: createTourTargetRegistry(),
    stop,
    beat: 0,
    element,
  };
}

test("a failed demo task outranks a stop's own waiting copy", () => {
  const failed = seeWorkRuntime({ phase: "failed", error: "boom" });
  assert.match(
    SEE_WORK_TOUR.fallback!(context("working", failed))!,
    /The demo task could not continue: boom/,
  );
  assert.equal(SEE_WORK_TOUR.fallback!(context("working")), null);
});

test("the Dispatch stops send the tour back when the modal closes under them", () => {
  for (const stopId of ["dispatch-kind", "dispatch-input", "dispatch-workflow"]) {
    const closed = context(stopId);
    assert.deepEqual(closed.stop.reconcile!(closed), goTo("dispatch"));
    const open = context(stopId, seeWorkRuntime({ dispatchOpen: true }));
    assert.deepEqual(open.stop.reconcile!(open), refresh());
  }
});

test("the submit stop hands off to Working the moment the demo task exists", () => {
  const dispatched = context("dispatch-submit", seeWorkRuntime({
    dispatchOpen: true,
    taskId: "task-1",
  }));
  assert.deepEqual(dispatched.stop.reconcile!(dispatched), goTo("working"));
  // Next is hidden here on purpose: the real Dispatch now button owns the transition.
  assert.equal(dispatched.stop.hideNext!(dispatched), true);
  assert.deepEqual(dispatched.stop.onNext!(dispatched), hold());
});

test("the review stop offers to open the review, then hides Next once it is open", () => {
  const pending = context("review", seeWorkRuntime({ reviewPending: true }));
  assert.equal(pending.stop.nextLabel!(pending), "Open review");
  assert.equal(pending.stop.hideNext!(pending), false);
  assert.equal(pending.stop.ready!(pending), true);

  const open = context("review", seeWorkRuntime({ reviewPending: true, reviewOpen: true }));
  assert.equal(open.stop.hideNext!(open), true);
  assert.equal(open.stop.onNext!(open), null);

  const answered = context("review", seeWorkRuntime({ phase: "idle" }));
  assert.deepEqual(answered.stop.reconcile!(answered), goTo("idle"));
});

test("the review stop keeps the review flag the navigator owns", () => {
  const stop = SEE_WORK_TOUR.steps.find((step) => step.id === "review")!;
  const waiting = context("review", seeWorkRuntime({ reviewPending: true }));
  assert.deepEqual(stop.documentFlags!(waiting), []);
  assert.deepEqual(stop.retainDocumentFlags!(waiting), ["mcTourReview"]);
});

test("the opening chrome stops hold instead of racing a click back", () => {
  for (const stopId of ["line", "board", "dispatch"]) {
    const ctx = context(stopId);
    assert.deepEqual(ctx.stop.reconcile!(ctx), hold());
  }
  // Session detail is the exception: its preview session arrives late, so it restages.
  const detail = context("session-detail");
  assert.deepEqual(detail.stop.reconcile!(detail), { kind: "restage" });
});

test("only the stops that gate Next declare it", () => {
  assert.deepEqual(
    SEE_WORK_TOUR.steps.filter((step) => step.gateNext).map((step) => step.id),
    [
      "session-detail",
      "dispatch-kind",
      "dispatch-input",
      "dispatch-workflow",
      "dispatch-submit",
      "working",
      "needs-you",
      "review",
      "idle",
      "actions",
      "complete",
    ],
  );
});

test("only the two stops that hand the screen to a real surface are interactive", () => {
  assert.deepEqual(
    SEE_WORK_TOUR.steps.filter((step) => step.interactive).map((step) => step.id),
    ["dispatch-submit", "review"],
  );
});

test("the runtime key changes exactly when the tour should re-check its stop", () => {
  const base = SEE_WORK_TOUR.runtimeKey(seeWorkRuntime());
  assert.equal(SEE_WORK_TOUR.runtimeKey(seeWorkRuntime()), base);
  assert.notEqual(SEE_WORK_TOUR.runtimeKey(seeWorkRuntime({ dispatchOpen: true })), base);
  assert.notEqual(SEE_WORK_TOUR.runtimeKey(seeWorkRuntime({ taskId: "t" })), base);
});

test("every registered tour has a definition and one entry point description", () => {
  for (const entry of TOUR_ENTRIES) {
    const registered = TOUR_DEFINITIONS[entry.id];
    assert.ok(registered, `${entry.id} has no definition`);
    assert.equal(registered.id, entry.id);
    assert.equal(registered.title, entry.title);
    assert.equal(tourEntry(entry.id), entry);
  }
  assert.deepEqual(
    Object.keys(TOUR_DEFINITIONS).sort(),
    TOUR_ENTRIES.map((entry) => entry.id).sort(),
  );
  assert.throws(() => tourEntry("nope" as never), /no such tour/);
});

/**
 * The cursor is a stable stop id plus beat, never a Driver index.
 *
 * These are the cases that make the difference observable: the same cursor resolving to a
 * different index after the screen list changes shape, which is exactly what an index-shaped
 * cursor gets wrong and what Phase 2's two-beat stops will do.
 */
const CURSOR_SCREENS = flattenTour(definition([
  { id: "one", title: "One", description: "", targets: [beat("line")] },
  { id: "two", title: "Two", description: "", targets: [beat("board"), beat("dispatch")] },
  { id: "three", title: "Three", description: "", targets: [beat("session-detail")] },
]));

test("a cursor names a stop and a beat, and resolves to that screen", () => {
  assert.deepEqual(cursorAt(CURSOR_SCREENS, 0), { stopId: "one", beat: 0 });
  assert.deepEqual(cursorAt(CURSOR_SCREENS, 2), { stopId: "two", beat: 1 });
  assert.equal(screenIndexOf(CURSOR_SCREENS, { stopId: "two", beat: 1 }), 2);
  assert.equal(screenIndexOf(CURSOR_SCREENS, { stopId: "three", beat: 0 }), 3);
});

test("the same cursor survives a definition growing a beat ahead of it", () => {
  const before = flattenTour(definition([
    { id: "one", title: "One", description: "", targets: [beat("line")] },
    { id: "three", title: "Three", description: "", targets: [beat("session-detail")] },
  ]));
  const cursor = { stopId: "three", beat: 0 };
  // Stop "three" is screen 1 before the middle stop gains a second beat and screen 3 after.
  // An index-shaped cursor would still say 1, which is now a different stop entirely.
  assert.equal(screenIndexOf(before, cursor), 1);
  assert.equal(screenIndexOf(CURSOR_SCREENS, cursor), 3);
  assert.equal(CURSOR_SCREENS[3]!.stop.id, "three");
  assert.equal(before[1]!.stop.id, "three");
});

test("a cursor on a beat a stop no longer has falls back within that stop, never off it", () => {
  // Losing which look of a stop you were on is recoverable; landing on someone else's stop
  // silently is not.
  const index = screenIndexOf(CURSOR_SCREENS, { stopId: "three", beat: 1 });
  assert.equal(CURSOR_SCREENS[index]!.stop.id, "three");
  assert.equal(CURSOR_SCREENS[index]!.beat, 0);
});

test("an unknown stop id resolves to the first screen rather than throwing mid-tour", () => {
  assert.equal(screenIndexOf(CURSOR_SCREENS, { stopId: "gone", beat: 0 }), 0);
  assert.deepEqual(cursorAt([], 0), { stopId: "", beat: 0 });
});

test("every See the work stop is reachable by its own stable id", () => {
  const screens = flattenTour(SEE_WORK_TOUR);
  for (const [position, step] of SEE_WORK_TOUR.steps.entries()) {
    const index = screenIndexOf(screens, { stopId: step.id, beat: 0 });
    assert.equal(screens[index]!.stop.id, step.id);
    // One beat per stop today, so cursor and position still agree - the point is that the
    // engine asks by id, so they no longer HAVE to.
    assert.equal(screens[index]!.stopIndex, position);
  }
});
