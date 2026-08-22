import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BacklogColumn } from "../src/web/components/layouts/BacklogColumn.tsx";
import { ReportPanel } from "../src/web/components/ReportPanel.tsx";
import { LabelChips, PriorityChip } from "../src/web/components/session-bits.tsx";
import { TASK_PRIORITIES } from "../src/shared/task.ts";
import { backlogTasks } from "../src/shared/session.ts";
import { mkTask } from "./helpers/session-fixture.ts";
import { withOverlayHost } from "./helpers/overlay-host.ts";
import { containsMarkup, hasTooltip } from "./helpers/markup.ts";

/**
 * What is at stake: an untriaged task must look EXACTLY as it did before priorities
 * and labels existed.
 *
 * Both fields default to nothing and every task that exists today has them unset, so a
 * chip that rendered "none" or an empty pill would put a mark on every card in the
 * backlog on the first run after upgrading - the change would announce itself on work
 * nobody has triaged. That silence is a product decision, not an implementation
 * detail, which is why it is pinned here rather than left to the reader of the JSX.
 *
 * The second thing pinned is that the board draws these from the SHARED leaves in
 * `session-bits.tsx` rather than a private copy: the roundup panel renders the same
 * two chips, and a private copy is how the two drift (see session-leaf-parity.test.ts
 * for the same argument about the session leaves).
 */

const noop = (): void => {};

function column(tasks: ReturnType<typeof mkTask>[]): string {
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

function roundup(tasks: ReturnType<typeof mkTask>[]): string {
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

/** Render one shared leaf on its own, so a layout's output can be checked against it. */
function bit<P extends object>(component: (props: P) => React.JSX.Element | null, props: P): string {
  return renderToStaticMarkup(createElement(component, props));
}

test("an untriaged task carries no priority mark and no label chips", () => {
  const html = column([mkTask({ id: "t1", title: "Untriaged" })]);
  // The backlog card's priority control is always present (it is the triage surface),
  // but on an unset task it must be in its quiet state and carry no colour class.
  assert.ok(html.includes("bl-prio is-unset"), "unset priority renders quiet, not coloured");
  for (const p of TASK_PRIORITIES) {
    assert.equal(html.includes(`prio-${p}`), false, `no ${p} colour on an unset task`);
  }
  assert.equal(html.includes("task-labels"), false, "no label group on a task with no labels");
});

test("the roundup shows no priority mark at all for an untriaged task", () => {
  // The read-only surface is stricter than the editable one: nothing is rendered, so a
  // backlog nobody has triaged looks exactly as it did before priorities existed.
  const html = roundup([mkTask({ id: "t1", title: "Untriaged" })]);
  assert.equal(html.includes("task-priority"), false);
  assert.equal(html.includes("task-labels"), false);
});

test("PriorityChip and LabelChips render nothing at all when unset", () => {
  // Asserted on the components directly too: a caller that forgets to guard the
  // surrounding wrapper still must not emit a stray empty element.
  assert.equal(bit(PriorityChip, { priority: null }), "");
  assert.equal(bit(LabelChips, { labels: [] }), "");
});

test("the roundup's task chips are the shared ones, not a re-inlined copy", () => {
  // Same argument as session-leaf-parity.test.ts: the roundup and the board both draw
  // task marks, so a private copy in either is how the two drift.
  const html = roundup([mkTask({ id: "t1", priority: "high", labels: ["infra"] })]);
  assert.ok(containsMarkup(html, bit(PriorityChip, { priority: "high" })), "shared PriorityChip");
  assert.ok(containsMarkup(html, bit(LabelChips, { labels: ["infra"], max: 3 })), "shared LabelChips");
});

test("the backlog card's label chips are the shared ones too", () => {
  const html = column([mkTask({ id: "t1", labels: ["infra"] })]);
  assert.ok(containsMarkup(html, bit(LabelChips, { labels: ["infra"], max: 3 })), "shared LabelChips");
});

test("the backlog card colours its priority control with the shared token class", () => {
  // It is a select rather than the read-only chip (one affordance, not a chip plus an
  // editor saying the same word), but it must reuse `.prio-*` so the colour cannot
  // drift from what the roundup shows for the same priority.
  const html = column([mkTask({ id: "t1", priority: "blocker" })]);
  assert.ok(html.includes("bl-prio prio-blocker"));
  assert.equal(html.includes("is-unset"), false);
});

test("every priority gets its own class, so the token map can never go half-wired", () => {
  for (const p of TASK_PRIORITIES) {
    assert.ok(bit(PriorityChip, { priority: p }).includes(`prio-${p}`), p);
  }
});

test("labels beyond the card's cap are counted, never silently dropped", () => {
  // A card that showed 3 of 7 tags with no remainder would read as a lightly-tagged
  // task. The overflow is reported as "+N" and the full list stays in the tooltip.
  const labels = ["a", "b", "c", "d", "e"];
  const html = bit(LabelChips, { labels, max: 3 });
  assert.ok(html.includes("+2"), "the remainder must be shown as a count");
  assert.ok(
    hasTooltip(html, `Labels: ${labels.join(", ")}`),
    "the full list stays reachable on hover",
  );
});

test("the backlog column offers retriage on every card", () => {
  // The backlog is the surface triage actually happens on, so this control is what makes
  // the field usable at the one place the backlog is read - even though it no longer
  // moves the card.
  const html = column([mkTask({ id: "t1", title: "Pick me" }), mkTask({ id: "t2", title: "Then me" })]);
  assert.equal(html.split("bl-prio").length - 1, 2, "one retriage control per card");
  assert.ok(html.includes("Priority for Pick me"), "the control is labelled per task");
});

test("fed the shared projection, the column draws the operator's order", () => {
  // The column does NOT sort - BoardView hands it `backlogTasks(...)`, which is the one
  // place the order lives (and is unit-tested in task-triage.test.ts). What this pins is
  // the composition: the column renders in the order it was given rather than regrouping
  // by anything of its own. The fixture is deliberately one where priority and rank
  // DISAGREE, so a column that quietly re-sorted by priority would fail here.
  const html = column(
    backlogTasks([
      mkTask({ id: "t1", title: "Later", createdAt: 100, backlogRank: 2048, priority: "blocker" }),
      mkTask({ id: "t2", title: "First", createdAt: 900, backlogRank: 1024 }),
    ]),
  );
  assert.ok(html.indexOf("First") < html.indexOf("Later"));
});

test("every card carries the four move controls, named for its own task", () => {
  // The keyboard route into reordering, and the reason this phase ships a usable feature
  // rather than a route with no caller. Selected by `aria-label` because the app selects
  // by role and label and never by `data-testid` - and phase 2's drag work and the e2e
  // spec both select by this exact wording.
  const html = column(
    backlogTasks([
      mkTask({ id: "t1", title: "First", backlogRank: 1024 }),
      mkTask({ id: "t2", title: "Second", backlogRank: 2048 }),
    ]),
  );
  for (const move of ["to top", "up", "down", "to bottom"]) {
    assert.ok(html.includes(`Move &quot;First&quot; ${move}`), `First is missing "${move}"`);
    assert.ok(html.includes(`Move &quot;Second&quot; ${move}`), `Second is missing "${move}"`);
  }
});

test("the ends of the column disable the moves that have nowhere to go", () => {
  // A live control that does nothing reads as broken. The first card's `up` and `to top`
  // are disabled and the last card's `down` and `to bottom` are, which is also how the
  // column says "this IS the top" without drawing a second mark to say so.
  const html = column(
    backlogTasks([
      mkTask({ id: "t1", title: "First", backlogRank: 1024 }),
      mkTask({ id: "t2", title: "Last", backlogRank: 2048 }),
    ]),
  );
  // The rendered attribute order is React's, so match the label and the `disabled` flag
  // within one tag rather than assuming they are adjacent.
  const buttons = html.match(/<button[^>]*>/g) ?? [];
  const at = (title: string, move: string): string => {
    const tag = buttons.find((b) => b.includes(`Move &quot;${title}&quot; ${move}`));
    assert.ok(tag, `${title} has no "${move}" control at all`);
    return tag;
  };
  assert.ok(at("First", "up").includes("disabled"), "the first card cannot move up");
  assert.ok(at("First", "to top").includes("disabled"), "the first card is already the top");
  assert.ok(!at("First", "down").includes("disabled"), "the first card can move down");
  assert.ok(at("Last", "down").includes("disabled"), "the last card cannot move down");
  assert.ok(at("Last", "to bottom").includes("disabled"), "the last card is already the bottom");
  assert.ok(!at("Last", "to top").includes("disabled"), "the last card can move to the top");
});
