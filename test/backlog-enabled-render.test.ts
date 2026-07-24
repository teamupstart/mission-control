import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BacklogColumn } from "../src/web/components/layouts/BacklogColumn.tsx";
import { ReportPanel } from "../src/web/components/ReportPanel.tsx";
import { ScheduleSwitch } from "../src/web/components/session-bits.tsx";
import type { Task } from "../src/shared/types.ts";
import { mkTask } from "./helpers/session-fixture.ts";
import { containsMarkup } from "./helpers/markup.ts";
import { withOverlayHost } from "./helpers/overlay-host.ts";

/**
 * The backlog is drawn twice, so its one scheduling control has to exist twice.
 *
 * The board's column and the Sitrep panel's Backlog section list the same items with the
 * same actions, and a switch that lived on only one of them would be a hold you could
 * set from the board and then fail to find in the list you were reading - or, worse, one
 * you could set and never see, which is how a quiet autopilot gets diagnosed as a broken
 * one. So both render the SAME component out of `session-bits.tsx`, and this asserts the
 * standalone markup appears inside each of them rather than checking two hand-written
 * copies that agree today.
 *
 * The second thing pinned is that ON is silent. Every task that has ever existed is
 * enabled, so a parked-looking mark on an unparked backlog would announce the feature on
 * work nobody has touched - the same bargain the priority chip makes by rendering
 * nothing when unset.
 *
 * `createElement` rather than JSX because the runner's glob only matches .test.ts.
 */

const noop = (): void => {};

function column(tasks: Task[]): string {
  return renderToStaticMarkup(
    createElement(BacklogColumn, {
      tasks,
      allTasks: tasks,
      plan: null,
      onAssignError: noop,
      onDragging: noop,
      onEdit: noop,
    }),
  );
}

function roundup(tasks: Task[]): string {
  // ReportPanel renders into an <Overlay>, which refuses to render without a host.
  return renderToStaticMarkup(
    withOverlayHost(
      createElement(ReportPanel, {
        sessions: [],
        tasks,
        backlogPlan: null,
        onClose: noop,
        onOpenReviews: noop,
        onEditTask: noop,
      }),
    ),
  );
}

/** The shared switch on its own, so each surface's output can be checked against it. */
function bit(enabled: boolean, taskTitle: string): string {
  return renderToStaticMarkup(
    createElement(ScheduleSwitch, { enabled, taskTitle, onChange: noop }),
  );
}

test("both backlog surfaces draw the shared switch, not a private copy", () => {
  const on = mkTask({ id: "t1", title: "Ship it" });
  const off = mkTask({ id: "t2", title: "Not yet", enabled: false });
  for (const [surface, html] of [
    ["board column", column([on, off])],
    ["sitrep", roundup([on, off])],
  ] as const) {
    assert.ok(containsMarkup(html, bit(true, "Ship it")), `${surface} must draw the enabled switch`);
    assert.ok(containsMarkup(html, bit(false, "Not yet")), `${surface} must draw the disabled switch`);
  }
});

test("the switch says the state, never the action", () => {
  // "disable" and "disabled" are a glance apart and mean opposite things, so the visible
  // word is the setting - the verb only ever appears in the tooltip.
  assert.ok(bit(true, "T").includes(">on<"));
  assert.ok(bit(false, "T").includes(">off<"));
  assert.match(bit(true, "T"), /role="switch"/);
  assert.match(bit(true, "T"), /aria-checked="true"/);
  assert.match(bit(false, "T"), /aria-checked="false"/);
});

test("the switch is labelled per task, so a card is identifiable without sight of it", () => {
  assert.ok(column([mkTask({ id: "t1", title: "Pick me" })]).includes("Foreman may schedule Pick me"));
});

test("an unparked backlog carries no disabled mark anywhere", () => {
  const html = column([mkTask({ id: "t1" }), mkTask({ id: "t2" })]);
  assert.ok(!html.includes("bl-off"), "no parked chip on cards nobody parked");
  assert.ok(!html.includes("is-disabled"), "no parked styling on cards nobody parked");
  assert.ok(!roundup([mkTask({ id: "t1" })]).includes("is-disabled"));
});

test("a parked card says what the hold costs, not just that it is set", () => {
  // The switch says which way it is set; this line says what that means for the item -
  // the half a two-letter pill cannot carry.
  const html = column([mkTask({ id: "t1", enabled: false })]);
  assert.ok(html.includes("bl-off"));
  assert.match(html, /autopilot will skip this/);
  // And says it ONCE: the switch carries the setting, this line carries the cost.
  assert.equal(html.split("disabled -").length - 1, 0, "the word is not repeated as a mark");
  assert.ok(html.includes(`class="bl-card is-disabled"`));
});

test("a parked card still offers the launch button - the hold is on the machine", () => {
  const html = column([mkTask({ id: "t1", enabled: false })]);
  const launch = /<button class="bl-launch"[^>]*>/.exec(html)?.[0] ?? "";
  assert.ok(launch, "the card must still offer a launch button");
  assert.ok(!launch.includes("disabled"), "the operator's own button stays live");
  assert.match(html, /launch anyway/);
});

test("the Sitrep row recedes without hiding, and keeps its dispatch button", () => {
  const html = roundup([mkTask({ id: "t1", title: "Not yet", enabled: false })]);
  assert.ok(html.includes("report-row is-disabled"));
  assert.ok(html.includes("Not yet"), "a held item is still work you queued; it stays findable");
  assert.match(html, /Dispatch/);
});
