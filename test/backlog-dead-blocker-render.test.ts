import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BacklogColumn } from "../src/web/components/layouts/BacklogColumn.tsx";
import { ReportPanel } from "../src/web/components/ReportPanel.tsx";
import { DeadBlockerButton } from "../src/web/components/session-bits.tsx";
import type { BacklogPlan, Task } from "../src/shared/types.ts";
import { mkTask } from "./helpers/session-fixture.ts";
import { containsMarkup } from "./helpers/markup.ts";
import { withOverlayHost } from "./helpers/overlay-host.ts";

/**
 * The backlog is drawn twice, so its way OUT of a dead prerequisite has to exist twice.
 *
 * A card stranded behind a cancelled task will never clear on its own, and the fix - run
 * the dead task again, or mark it done - has to be reachable from whichever backlog
 * surface the operator happens to be reading. So the board column and the Sitrep row both
 * render the SAME `DeadBlockerButton` out of `session-bits.tsx`, and this asserts the
 * standalone markup appears inside each rather than trusting two hand-written copies.
 *
 * The second thing pinned is that a card waiting on live work carries none of it: the
 * warning is an alarm, and an alarm on an item that is merely queued behind another would
 * cry wolf on the whole backlog.
 *
 * `createElement` rather than JSX because the runner's glob only matches .test.ts.
 */

const noop = (): void => {};

function column(backlog: Task[], allTasks: Task[], plan: BacklogPlan | null): string {
  return renderToStaticMarkup(
    createElement(BacklogColumn, {
      tasks: backlog,
      allTasks,
      plan,
      onAssignError: noop,
      onDragging: noop,
      onEdit: noop,
    }),
  );
}

function roundup(tasks: Task[], plan: BacklogPlan | null): string {
  return renderToStaticMarkup(
    withOverlayHost(
      createElement(ReportPanel, {
        sessions: [],
        tasks,
        backlogPlan: plan,
        onClose: noop,
        onOpenReviews: noop,
        onEditTask: noop,
      }),
    ),
  );
}

/** The shared button on its own, so each surface's output can be checked against it. */
function bit(deadBlockers: Task[]): string {
  return renderToStaticMarkup(
    createElement(DeadBlockerButton, { deadBlockers, onReschedule: noop, onComplete: noop }),
  );
}

function planFor(edges: Array<[string, string[]]>): BacklogPlan {
  return {
    entries: edges.map(([taskId, dependsOn]) => ({ taskId, dependsOn, reason: null })),
    note: null,
    generatedAt: 0,
  };
}

test("both backlog surfaces draw the shared dead-blocker button, not a private copy", () => {
  const dead = mkTask({ id: "dead", title: "Phase 2", status: "cancelled" });
  const dependent = mkTask({ id: "dep", title: "Phase 5" });
  const all = [dead, dependent];
  const plan = planFor([["dep", ["dead"]]]);
  const standalone = bit([dead]);

  assert.ok(
    containsMarkup(column([dependent], all, plan), standalone),
    "the board card must draw the shared dead-blocker button",
  );
  assert.ok(
    containsMarkup(roundup(all, plan), standalone),
    "the Sitrep row must draw the same shared button",
  );
});

test("the button names the dead prerequisite so it is identifiable without opening it", () => {
  const dead = mkTask({ id: "dead", title: "Trust matrix", status: "cancelled" });
  const dependent = mkTask({ id: "dep", title: "Settings search" });
  const html = column([dependent], [dead, dependent], planFor([["dep", ["dead"]]]));
  assert.ok(html.includes("bl-deadblock-btn"), "the warning button is present");
  assert.match(html, /Trust matrix.*was cancelled/);
});

test("a card waiting on live work carries no dead-blocker warning", () => {
  // The prerequisite is a normal backlog task, not a stopped one: nothing to act on, so
  // the alarm must stay silent on both surfaces.
  const upstream = mkTask({ id: "up", title: "Phase 1", status: "backlog" });
  const dependent = mkTask({ id: "dep", title: "Phase 2" });
  const all = [upstream, dependent];
  const plan = planFor([["dep", ["up"]]]);
  assert.ok(!column([upstream, dependent], all, plan).includes("bl-deadblock"));
  assert.ok(!roundup(all, plan).includes("bl-deadblock"));
});

test("a downstream card inherits the warning through a chain, not just the direct dependent", () => {
  // dep2 -> dep1 (backlog) -> dead (cancelled). dep2 never declared the dead edge, but it
  // is just as stuck, so its card must carry the warning too.
  const dead = mkTask({ id: "dead", title: "Phase 3", status: "cancelled" });
  const dep1 = mkTask({ id: "dep1", title: "Phase 4", status: "backlog" });
  const dep2 = mkTask({ id: "dep2", title: "Phase 5" });
  const all = [dead, dep1, dep2];
  const plan = planFor([
    ["dep1", ["dead"]],
    ["dep2", ["dep1"]],
  ]);
  assert.ok(
    containsMarkup(column([dep1, dep2], all, plan), bit([dead])),
    "the downstream card must inherit the same dead-blocker button",
  );
});
