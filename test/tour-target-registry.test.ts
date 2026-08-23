import assert from "node:assert/strict";
import test from "node:test";

import {
  createTourTargetRegistry,
  TOUR_TARGET_IDS,
  TOUR_TARGET_NAMESPACES,
  tourTargetOwner,
  tourTargetScope,
  type TourTargetId,
} from "../src/web/tour/target-registry.ts";

const LINE_TARGET = "see-work:line" as const;

function element(id: string): HTMLElement {
  return { id } as HTMLElement;
}

test("a missing semantic target returns null", () => {
  const registry = createTourTargetRegistry();
  assert.equal(registry.get(LINE_TARGET), null);
});

test("the latest owner replaces the prior registration", () => {
  const registry = createTourTargetRegistry();
  const first = element("first");
  const replacement = element("replacement");

  registry.register(LINE_TARGET, first);
  registry.register(LINE_TARGET, replacement);

  assert.equal(registry.get(LINE_TARGET), replacement);
});

test("a stale owner unmount cannot clear a newer registration", () => {
  const registry = createTourTargetRegistry();
  const first = element("first");
  const replacement = element("replacement");
  const unregisterFirst = registry.register(LINE_TARGET, first);
  const unregisterReplacement = registry.register(LINE_TARGET, replacement);

  unregisterFirst();
  assert.equal(registry.get(LINE_TARGET), replacement);

  unregisterReplacement();
  assert.equal(registry.get(LINE_TARGET), null);
});

test("registration identity survives Strict Mode replay of the same element", () => {
  const registry = createTourTargetRegistry();
  const line = element("line");
  const unregisterFirst = registry.register(LINE_TARGET, line);
  const unregisterReplay = registry.register(LINE_TARGET, line);

  unregisterFirst();
  assert.equal(registry.get(LINE_TARGET), line);

  unregisterReplay();
  assert.equal(registry.get(LINE_TARGET), null);
});

test("the Dispatch modal fields and submit owner remain independent targets", () => {
  const registry = createTourTargetRegistry();
  const modal = element("dispatch-modal");
  const kind = element("dispatch-kind");
  const input = element("dispatch-input");
  const workflow = element("dispatch-workflow");
  const submit = element("dispatch-submit");

  registry.register("see-work:dispatch-modal", modal);
  registry.register("see-work:dispatch-kind", kind);
  registry.register("see-work:dispatch-input", input);
  registry.register("see-work:dispatch-workflow", workflow);
  registry.register("see-work:dispatch-submit", submit);

  assert.equal(registry.get("see-work:dispatch-modal"), modal);
  assert.equal(registry.get("see-work:dispatch-kind"), kind);
  assert.equal(registry.get("see-work:dispatch-input"), input);
  assert.equal(registry.get("see-work:dispatch-workflow"), workflow);
  assert.equal(registry.get("see-work:dispatch-submit"), submit);
});

test("the Complete dialog can register independently from its action-row owner", () => {
  const registry = createTourTargetRegistry();
  const actions = element("session-actions");
  const complete = element("complete-modal");

  registry.register("see-work:session-actions", actions);
  registry.register("see-work:complete-modal", complete);

  assert.equal(registry.get("see-work:session-actions"), actions);
  assert.equal(registry.get("see-work:complete-modal"), complete);
});

test("two tours can want the same target name without either one reaching the other's", () => {
  const registry = createTourTargetRegistry();
  const seeWorkLine = element("see-work-line");
  // A second namespace is exactly what Phase 2 adds. Registering under one now proves the
  // isolation is a property of the id, not of there happening to be one tour today.
  const otherLine = element("other-line");
  const otherTarget = "library:line" as TourTargetId;

  const unregisterOther = registry.register(otherTarget, otherLine);
  registry.register(LINE_TARGET, seeWorkLine);

  assert.equal(registry.get(LINE_TARGET), seeWorkLine);
  assert.equal(registry.get(otherTarget), otherLine);

  unregisterOther();
  assert.equal(registry.get(LINE_TARGET), seeWorkLine);
  assert.equal(registry.get(otherTarget), null);
});

test("every declared id is namespaced by the tour that owns it", () => {
  assert.ok(TOUR_TARGET_IDS.length > 0);
  for (const id of TOUR_TARGET_IDS) {
    const owner = tourTargetOwner(id);
    assert.ok(owner, `${id} has no owning tour`);
    assert.ok(id.startsWith(`${owner}:`));
    assert.ok(tourTargetScope(id));
  }
  assert.equal(new Set(TOUR_TARGET_IDS).size, TOUR_TARGET_IDS.length);
});

test("task scope is declared beside the target, not inferred by a hook's allow-list", () => {
  // These four are the owners rendered once per task. The task-scoped hook refuses anything
  // else, and it learns which is which from here rather than from a literal union.
  assert.deepEqual(
    TOUR_TARGET_IDS.filter((id) => tourTargetScope(id) === "task"),
    [
      "see-work:demo-task",
      "see-work:review-modal",
      "see-work:session-actions",
      "see-work:complete-modal",
    ],
  );
  assert.equal(tourTargetScope("see-work:line"), "page");
  assert.equal(tourTargetScope("see-work:not-a-target"), null);
  assert.equal(tourTargetOwner("nope:line"), null);
});

test("run scope is declared beside the target too, and only the ladder claims it", () => {
  // The Library tour's stage ladder is drawn by one component with two hosts - a session's
  // Workflows tab and every Board tile - so it is scoped to the RUN a tour selected, exactly
  // as a demo task's tile is scoped to the task a run created. Everything else on that tour
  // is ordinary page chrome with one rendered owner.
  assert.deepEqual(
    TOUR_TARGET_IDS.filter((id) => tourTargetScope(id) === "run"),
    ["library:session-workflow-ladder"],
  );
  assert.equal(tourTargetScope("library:library-page"), "page");
  assert.equal(tourTargetOwner("library:library-page"), "library");
});

test("the Library tour's nineteen targets are declared, namespaced, and its own", () => {
  const library = TOUR_TARGET_IDS.filter((id) => tourTargetOwner(id) === "library");
  assert.equal(library.length, 19);
  assert.equal(new Set(library).size, 19);
  for (const id of library) assert.ok(id.startsWith("library:"));
  // Two tours, and no target belongs to both.
  const seeWork = TOUR_TARGET_IDS.filter((id) => tourTargetOwner(id) === "see-work");
  assert.equal(seeWork.length + library.length, TOUR_TARGET_IDS.length);
});

test("the namespace table is the one source of target names", () => {
  for (const tour of Object.keys(TOUR_TARGET_NAMESPACES) as (keyof typeof TOUR_TARGET_NAMESPACES)[]) {
    assert.deepEqual(
      Object.keys(TOUR_TARGET_NAMESPACES[tour]).map((name) => `${tour}:${name}`),
      TOUR_TARGET_IDS.filter((id) => tourTargetOwner(id) === tour),
    );
  }
});
