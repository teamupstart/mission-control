import assert from "node:assert/strict";
import test from "node:test";

import { NO_MISTAKES_REVIEW_WORKFLOW_ID } from "../src/shared/builtin-workflow.ts";
import {
  WORKFLOW_CHECK_SLOTS,
  WORKFLOW_RUN_TERMINAL_STATUSES,
  type WorkflowRunStatus,
  type WorkflowRunSummary,
} from "../src/shared/workflow.ts";
import { TOUR_DEFINITIONS } from "../src/web/tour/definitions.ts";
import { TOUR_ENTRIES } from "../src/web/tour/entries.ts";
import { flattenTour, type TourStepContext } from "../src/web/tour/contracts.ts";
import {
  LIBRARY_TOUR,
  LIBRARY_TOUR_COMMAND_SLOT,
  selectLibraryTourRun,
  type LibraryTourNavigation,
  type LibraryTourRuntime,
} from "../src/web/tour/tours/library.ts";
import {
  createTourTargetRegistry,
  TOUR_TARGET_NAMESPACES,
  type TourTargetId,
} from "../src/web/tour/target-registry.ts";

/**
 * The Library tour as DATA, checked without a browser.
 *
 * Its stops, its targets, and the route each stop asks for are a definition rather than a
 * component, so everything except "does the spotlight land on the right pixels" is decidable
 * here in milliseconds. The browser proof is `e2e/specs/library-tour.spec.ts`.
 */

type Runtime = LibraryTourRuntime;

const READY_RUNTIME: Runtime = {
  personaId: "builtin:code-quality-judge",
  actionId: "builtin:pull-request",
  workflowReady: true,
  run: { id: "run-1", sessionId: "session-1", sessionName: "Fix the diff link" },
  runSessionLive: true,
};

interface Move {
  kind: keyof LibraryTourNavigation;
  argument?: string;
}

/** A navigator that records where a stop asked to go, and accepts every move. */
function recorder(accept = true): { moves: Move[]; navigation: LibraryTourNavigation } {
  const moves: Move[] = [];
  const record = (kind: keyof LibraryTourNavigation, argument?: string): boolean => {
    moves.push(argument === undefined ? { kind } : { kind, argument });
    return accept;
  };
  return {
    moves,
    navigation: {
      showLibrary: () => record("showLibrary"),
      showPersona: (personaId) => record("showPersona", personaId),
      showAction: (actionId) => record("showAction", actionId),
      showCommandSlot: () => record("showCommandSlot"),
      showWorkflow: () => record("showWorkflow"),
      showRun: (runId) => record("showRun", runId),
      showRunSession: (sessionId) => record("showRunSession", sessionId),
    },
  };
}

function contextFor(
  stopId: string,
  runtime: Runtime,
  navigation: LibraryTourNavigation,
  element: HTMLElement | null = {} as HTMLElement,
): TourStepContext<Runtime, LibraryTourNavigation> {
  const stop = LIBRARY_TOUR.steps.find((candidate) => candidate.id === stopId);
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

const summary = (patch: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary => ({
  id: "run-1",
  bindingId: "binding-1",
  workflowId: NO_MISTAKES_REVIEW_WORKFLOW_ID,
  workflowName: "No-Mistakes Review",
  workflowVersion: 10,
  sessionId: "session-1",
  noteKey: "note-1",
  sessionName: "Fix the diff link",
  status: "completed",
  phase: "done",
  round: 1,
  maxRepairRounds: 5,
  activePersonaNames: [],
  failedPersonaCount: 0,
  bypassedPersonaReview: false,
  gate: { state: "none", required: false } as unknown as WorkflowRunSummary["gate"],
  gatePrNumber: null,
  gateHeadShort: null,
  reviewPosture: null,
  updatedAt: 1_000,
  ...patch,
});

test("both tours are registered once, and discovery derives one row each in a stable order", () => {
  assert.deepEqual(Object.keys(TOUR_DEFINITIONS), ["see-work", "library"]);
  assert.deepEqual(TOUR_ENTRIES.map((entry) => entry.id), ["see-work", "library"]);
  assert.deepEqual(TOUR_ENTRIES.map((entry) => entry.title), ["See the work", "Author what runs"]);
  assert.equal(new Set(TOUR_ENTRIES.map((entry) => entry.palette.rowId)).size, TOUR_ENTRIES.length);
  // The tour opens on the shelves index, and that route is what App preflights before it
  // commits a run - so a dirty draft answers for it with no tour active.
  assert.deepEqual(
    TOUR_ENTRIES.find((entry) => entry.id === "library")?.entryRoute,
    { page: "library" },
  );
  assert.equal(LIBRARY_TOUR.title, "Author what runs");
});

test("the tour is fifteen stops, nineteen beats, and one deliberate centered close", () => {
  const stops = LIBRARY_TOUR.steps;
  assert.equal(stops.length, 15);
  assert.equal(new Set(stops.map((stop) => stop.id)).size, 15);

  const screens = flattenTour(LIBRARY_TOUR);
  const beats = screens.filter((screen) => screen.stop.targets.length > 0);
  assert.equal(beats.length, 19);
  // Nineteen spotlights plus the closing card: twenty Driver screens, fifteen rail steps.
  assert.equal(screens.length, 20);

  const centered = stops.filter((stop) => stop.targets.length === 0);
  assert.equal(centered.length, 1);
  assert.equal(centered[0]?.centered, true);
  assert.equal(centered[0]?.id, "close");
  for (const stop of stops) {
    assert.ok(stop.targets.length <= 2, `${stop.id} declares more than two beats`);
  }
});

test("every beat names a target this tour's namespace declares, and each is used once", () => {
  const declared = new Set(
    Object.keys(TOUR_TARGET_NAMESPACES.library).map((name) => `library:${name}`),
  );
  const used = LIBRARY_TOUR.steps.flatMap((stop) => stop.targets.map((beat) => beat.target));
  assert.equal(used.length, 19);
  assert.equal(new Set(used).size, 19, "a target is spotlighted by two different stops");
  for (const target of used) assert.ok(declared.has(target), `${target} is not declared`);
  // Declared and used are the same set: no target is plumbed into a component with no stop
  // pointing at it, and no stop points at a name nothing registers.
  assert.deepEqual([...declared].sort(), [...new Set(used)].sort());
});

test("the stop order is the dependency order the plan chose, bottom-up through the shelves", () => {
  assert.deepEqual(LIBRARY_TOUR.steps.map((stop) => stop.id), [
    "library",
    "persona-library",
    "persona-anatomy",
    "persona-editing",
    "action-library",
    "action-contract",
    "command-slot",
    "command-overrides",
    "workflow-builder",
    "workflow-draft",
    "workflow-no-mistakes",
    "workflow-bind",
    "run-moving",
    "run-watched",
    "close",
  ]);
});

test("each stop asks for the route its lesson lives on", () => {
  const { moves, navigation } = recorder();
  for (const stop of LIBRARY_TOUR.steps) {
    stop.prepare?.(contextFor(stop.id, READY_RUNTIME, navigation));
  }
  assert.deepEqual(moves, [
    { kind: "showLibrary" },
    { kind: "showPersona", argument: "builtin:code-quality-judge" },
    { kind: "showPersona", argument: "builtin:code-quality-judge" },
    { kind: "showPersona", argument: "builtin:code-quality-judge" },
    { kind: "showAction", argument: "builtin:pull-request" },
    { kind: "showAction", argument: "builtin:pull-request" },
    { kind: "showCommandSlot" },
    { kind: "showCommandSlot" },
    { kind: "showWorkflow" },
    { kind: "showWorkflow" },
    { kind: "showWorkflow" },
    { kind: "showWorkflow" },
    { kind: "showRun", argument: "run-1" },
    { kind: "showRunSession", argument: "session-1" },
  ]);
  assert.ok((WORKFLOW_CHECK_SLOTS as readonly string[]).includes(LIBRARY_TOUR_COMMAND_SLOT));
});

test("a refused first move ends the tour instead of starting it behind the leave dialog", () => {
  const { navigation } = recorder(false);
  const first = LIBRARY_TOUR.steps[0];
  assert.ok(first);
  // The engine ends the tour on a falsy `prepare`, which is what makes the dirty-draft gate
  // the owner of the decision rather than a tour that half-started under a modal.
  assert.equal(first.prepare?.(contextFor(first.id, READY_RUNTIME, navigation)), false);
});

test("an asset stop waits on the shelves page until the catalog names the asset it teaches", () => {
  const { moves, navigation } = recorder();
  const runtime: Runtime = { ...READY_RUNTIME, personaId: null, actionId: null };
  for (const stopId of ["persona-library", "persona-anatomy", "persona-editing", "action-library"]) {
    const context = contextFor(stopId, runtime, navigation);
    LIBRARY_TOUR.steps.find((stop) => stop.id === stopId)?.prepare?.(context);
    const stop = LIBRARY_TOUR.steps.find((candidate) => candidate.id === stopId);
    assert.equal(stop?.ready?.(context), false, `${stopId} claimed to be ready`);
    assert.match(String(stop?.fallback?.(context)), /still loading|still opening/);
    // A restage re-runs `prepare`, which is the only thing that can navigate to the asset
    // once its id lands: these surfaces take their selection at mount.
    assert.deepEqual(stop?.reconcile?.(context), { kind: "restage" });
  }
  assert.deepEqual(moves, [
    { kind: "showLibrary" },
    { kind: "showLibrary" },
    { kind: "showLibrary" },
    { kind: "showLibrary" },
  ]);
});

test("with no qualifying run, both run stops stay real stops on the built-in graph", () => {
  const { moves, navigation } = recorder();
  const runtime: Runtime = { ...READY_RUNTIME, run: null, runSessionLive: false };
  for (const stopId of ["run-moving", "run-watched"]) {
    const stop = LIBRARY_TOUR.steps.find((candidate) => candidate.id === stopId);
    const context = contextFor(stopId, runtime, navigation, null);
    stop?.prepare?.(context);
    assert.equal(stop?.ready?.(context), false);
    assert.match(String(stop?.fallback?.(context)), /Back, Next, and Exit remain available/);
    // Not gated: the operator walks through the fallback rather than being stuck on it.
    assert.notEqual(stop?.gateNext, true);
    // The beat resolves to nothing, which centers the card rather than pointing at a target
    // that will never mount.
    assert.equal(stop?.targets[0]?.resolve?.(context) ?? null, null);
  }
  assert.deepEqual(moves, [{ kind: "showWorkflow" }, { kind: "showWorkflow" }]);
});

test("a session evicted between the two run stops falls back in place, by its durable name", () => {
  const { moves, navigation } = recorder();
  const runtime: Runtime = { ...READY_RUNTIME, runSessionLive: false };
  const stop = LIBRARY_TOUR.steps.find((candidate) => candidate.id === "run-watched");
  const context = contextFor("run-watched", runtime, navigation, null);
  // In place: the run is still on screen from the previous stop, so this must NOT navigate.
  assert.equal(stop?.prepare?.(context), true);
  assert.deepEqual(moves, []);
  assert.equal(stop?.ready?.(context), false);
  const copy = String(stop?.fallback?.(context));
  assert.match(copy, /Fix the diff link/);
  assert.match(copy, /no longer live/);
  // A refresh, never a restage: re-running `prepare` would ask to open a session that is gone.
  assert.deepEqual(stop?.reconcile?.(context), { kind: "refresh" });
});

test("the run stops are ready only when the run AND its session are actually there", () => {
  const { navigation } = recorder();
  const moving = LIBRARY_TOUR.steps.find((stop) => stop.id === "run-moving");
  const watched = LIBRARY_TOUR.steps.find((stop) => stop.id === "run-watched");
  assert.equal(moving?.ready?.(contextFor("run-moving", READY_RUNTIME, navigation)), true);
  assert.equal(watched?.ready?.(contextFor("run-watched", READY_RUNTIME, navigation)), true);
  assert.equal(
    watched?.ready?.(contextFor(
      "run-watched",
      { ...READY_RUNTIME, runSessionLive: false },
      navigation,
    )),
    false,
  );
  // The run stop stands even when the session has gone: the run itself is still open.
  assert.equal(
    moving?.ready?.(contextFor("run-moving", { ...READY_RUNTIME, runSessionLive: false }, navigation)),
    true,
  );
});

test("the tour turns on no document flag, and declares no task-scoped target", () => {
  assert.deepEqual(LIBRARY_TOUR.documentFlags, []);
  for (const stop of LIBRARY_TOUR.steps) {
    assert.equal(stop.documentFlags?.(contextFor(stop.id, READY_RUNTIME, recorder().navigation)) ?? undefined, undefined);
  }
  const scopes: readonly string[] = Object.values(TOUR_TARGET_NAMESPACES.library);
  // Nothing here is task-scoped: this tour creates no task to scope anything to.
  assert.equal(scopes.filter((scope) => scope === "task").length, 0);
  assert.equal(scopes.filter((scope) => scope === "run").length, 1);
  assert.equal(TOUR_TARGET_NAMESPACES.library["session-workflow-ladder"], "run");
});

test("the closing card names what its primary verb does", () => {
  const close = LIBRARY_TOUR.steps.at(-1);
  assert.equal(close?.id, "close");
  assert.equal(
    close?.nextLabel?.(contextFor("close", READY_RUNTIME, recorder().navigation, null)),
    "Finish tour",
  );
  // A centered stop navigates nowhere: it is about what the tour left behind.
  assert.equal(close?.prepare, undefined);
});

test("the runtime key changes exactly when the tour has something to react to", () => {
  const key = LIBRARY_TOUR.runtimeKey;
  assert.equal(key(READY_RUNTIME), key({ ...READY_RUNTIME }));
  assert.notEqual(key(READY_RUNTIME), key({ ...READY_RUNTIME, runSessionLive: false }));
  assert.notEqual(key(READY_RUNTIME), key({ ...READY_RUNTIME, personaId: null }));
  assert.notEqual(key(READY_RUNTIME), key({ ...READY_RUNTIME, workflowReady: false }));
  assert.notEqual(
    key(READY_RUNTIME),
    key({ ...READY_RUNTIME, run: { id: "run-2", sessionId: "session-1", sessionName: null } }),
  );
});

test("run selection takes the newest terminal built-in run whose session is still here", () => {
  const live = new Set(["session-1", "session-2"]);
  const chosen = selectLibraryTourRun(
    [
      summary({ id: "older", updatedAt: 10 }),
      summary({ id: "newer", updatedAt: 20, sessionId: "session-2", sessionName: "Second" }),
    ],
    live,
  );
  assert.deepEqual(chosen, { id: "newer", sessionId: "session-2", sessionName: "Second" });
});

test("run selection refuses every summary that is not this exact finished workflow", () => {
  const live = new Set(["session-1"]);
  // Another workflow entirely, and an operator's own duplicate: a different id either way.
  assert.equal(selectLibraryTourRun([summary({ workflowId: "wf-other" })], live), null);
  assert.equal(
    selectLibraryTourRun([summary({ workflowId: "builtin-workflow:no-mistakes-review-copy" })], live),
    null,
  );
  // Still running.
  const open: WorkflowRunStatus[] = ["running", "waiting_for_session", "blocked"];
  for (const status of open) {
    assert.equal(selectLibraryTourRun([summary({ status })], live), null, status);
  }
  // Finished, but the session it reviewed is gone - which is the COMMON case for a finished
  // run, and the one that would strand the tour's last stop on a target that cannot mount.
  assert.equal(selectLibraryTourRun([summary({ sessionId: null })], live), null);
  assert.equal(selectLibraryTourRun([summary({ sessionId: "evicted" })], live), null);
  assert.equal(selectLibraryTourRun([], live), null);
  // Every terminal status qualifies, because each of them is a run that has stopped moving.
  for (const status of WORKFLOW_RUN_TERMINAL_STATUSES) {
    assert.equal(selectLibraryTourRun([summary({ status })], live)?.id, "run-1", status);
  }
});

test("run selection is deterministic when two qualifying runs share a timestamp", () => {
  const live = new Set(["session-1"]);
  const a = summary({ id: "aaa", updatedAt: 5 });
  const b = summary({ id: "zzz", updatedAt: 5 });
  assert.equal(selectLibraryTourRun([a, b], live)?.id, "zzz");
  assert.equal(selectLibraryTourRun([b, a], live)?.id, "zzz");
});

test("the selected run carries the durable session name the summary already holds", () => {
  const live = new Set(["session-1"]);
  assert.equal(selectLibraryTourRun([summary()], live)?.sessionName, "Fix the diff link");
  // Absent rather than empty on an older daemon's payload, and read as "no name" rather than
  // as the string "undefined" in the fallback copy.
  const unnamed = summary();
  delete unnamed.sessionName;
  assert.equal(selectLibraryTourRun([unnamed], live)?.sessionName, null);
});

test("a registered target id is reachable under this tour's namespace and nobody else's", () => {
  const registry = createTourTargetRegistry();
  const ladder = { id: "ladder" } as HTMLElement;
  registry.register("library:session-workflow-ladder", ladder);
  assert.equal(registry.get("library:session-workflow-ladder"), ladder);
  assert.equal(registry.get("see-work:line" as TourTargetId), null);
});
