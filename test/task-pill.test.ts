import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionCard } from "../src/web/components/SessionCard.tsx";
import { ConsoleDetail } from "../src/web/components/layouts/ConsoleDetail.tsx";
import { ScheduleOriginChip } from "../src/web/components/session-bits.tsx";
import { taskPillParts } from "../src/shared/task.ts";
import type { Session, TaskSummary } from "../src/shared/types.ts";
import { mkSession, mkTaskSummary } from "./helpers/session-fixture.ts";
import { mkSessionView } from "./helpers/session-view.ts";
import { containsMarkup } from "./helpers/markup.ts";

/**
 * The task pill, reduced to what it can actually tell a reader.
 *
 * Two of its three parts were usually saying nothing. `TaskKind` has two values, every
 * automated writer defaults to `ship`, and the MCP `create_task` tool cannot produce a
 * `scout` at all - so the badge read `SHIP` in almost every session, uncoloured and frozen
 * from the moment the task left the backlog. The title was a duplicate of the `h2` two rows
 * above it, because a dispatched session is named after its task.
 *
 * Both reductions live in ONE shared predicate rather than in each component, because a
 * session is drawn by four of them and only one is `SessionCard`. That is the same rule
 * `task-multi-session.test.ts` states, and the reason the title is a comparison rather than
 * a deletion: a re-assigned session keeps the FIRST task's title as its name, so the pill is
 * the only place the task now executing is written.
 *
 * `createElement` rather than JSX because the runner's glob only matches .test.ts.
 */

/** The two layouts that draw this pill, rendered from the same session. */
function card(session: Session): string {
  return renderToStaticMarkup(createElement(SessionCard, { session, onOpenReviews: () => {} }));
}

function detail(session: Session): string {
  return renderToStaticMarkup(
    createElement(ConsoleDetail, { session, view: mkSessionView(session) }),
  );
}

/** A session running `task`, named after it the way a dispatch names one. */
function dispatched(task: Partial<TaskSummary> = {}): Session {
  const summary = mkTaskSummary(task);
  return mkSession({ name: summary.title, task: summary });
}

test("the predicate keeps only the kind that says something", () => {
  assert.equal(taskPillParts(dispatched({ kind: "ship" })).kind, null);
  assert.equal(taskPillParts(dispatched({ kind: "scout" })).kind, "scout");
});

test("the predicate keeps the title only when the session's name does not carry it", () => {
  // The common case: `dispatcher.ts` names the session after the task, so the pill would
  // repeat the title in the header two rows below it.
  assert.equal(taskPillParts(dispatched({ title: "Fix the parser" })).title, null);
  // The case F3 is about: this agent has moved on to a second task, and its name still
  // holds the first one's title. Deleting the title outright would lose the only mention
  // of what is executing.
  const reassigned = mkSession({
    name: "Ship A",
    task: mkTaskSummary({ id: "task-b", title: "Ship B" }),
  });
  assert.equal(taskPillParts(reassigned).title, "Ship B");
});

test("a session with no task has no pill to draw", () => {
  assert.deepEqual(taskPillParts(mkSession({ task: null })), {
    kind: null,
    title: null,
    silent: true,
  });
});

test("the predicate reports a pill with nothing left in it as silent", () => {
  // The common case once both text parts went conditional: an ordinary running ship task
  // on the session it named. The chip is not an empty frame - it has a background, a
  // border and a tone-coloured left edge - so an empty one is chrome saying less than
  // nothing, which is what this band was tightened to stop drawing.
  assert.equal(taskPillParts(dispatched()).silent, true);
});

test("anything the pill hosts keeps it, one at a time", () => {
  // Each of the four parts on its own, because "silent" is an AND and a wrong operand
  // would only show up for the case that has exactly that one thing to say.
  assert.equal(taskPillParts(dispatched({ kind: "scout" })).silent, false, "a scout badge");
  assert.equal(
    taskPillParts(mkSession({ name: "Ship A", task: mkTaskSummary({ title: "Ship B" }) })).silent,
    false,
    "a title the name does not carry",
  );
  assert.equal(
    taskPillParts(dispatched({ outcome: "merged https://example.test/pr/7" })).silent,
    false,
    "an outcome",
  );
  // `scheduleId` is exactly the field `scheduleProvenance` gates the chip on, so these two
  // answer together - the helper cannot import the component to ask it.
  const scheduled = dispatched({ scheduleId: "sched-1", scheduleOccurrenceId: "occ-1" });
  assert.equal(taskPillParts(scheduled).silent, false, "a schedule origin");
  assert.ok(
    renderToStaticMarkup(
      createElement(ScheduleOriginChip, { task: scheduled.task!, scheduleNames: new Map() }),
    ),
    "and the chip that field gates really does draw for it",
  );
});

test("a silent pill is not drawn at all on either layout", () => {
  const session = dispatched();
  for (const [name, html] of [["card", card(session)], ["console detail", detail(session)]] as const) {
    assert.ok(!html.includes("task-chip"), `${name} should draw no empty pill`);
  }
});

test("the card keeps a pill for the transient status only it draws", () => {
  // `dispatching…` / `failed` are the card's alone, so the card ORs them into the gate at
  // the point it draws them rather than the shared helper asserting them for everyone.
  const session = dispatched({ status: "failed" });
  assert.equal(taskPillParts(session).silent, true, "nothing the shared parts host");
  const html = card(session);
  assert.ok(html.includes("task-chip task-failed"), "the card should keep the pill");
  assert.match(html, /class="task-status">failed</, "for the word it has to draw in it");
});

test("a ship task draws no kind badge on either layout", () => {
  // A task whose title the session does NOT carry, so the pill is drawn and the badge's
  // absence is a fact about the badge rather than about the whole chip having stood down.
  const session = mkSession({ name: "agent-1", task: mkTaskSummary({ kind: "ship" }) });
  for (const [name, html] of [["card", card(session)], ["console detail", detail(session)]] as const) {
    assert.ok(html.includes("task-chip"), `${name} should draw the pill for this fixture`);
    assert.ok(!html.includes('class="task-kind"'), `${name} should draw no kind badge for a ship task`);
    // And the word itself is nowhere near the pill, tooltip included - the tooltip used to
    // read "ship task", which is the same constant in a second place.
    assert.ok(!html.includes("ship task"), `${name} should not describe a ship task as one`);
  }
});

test("a scout task draws its kind badge on both layouts", () => {
  // The whole point of the reduction: the value that IS worth reading survives.
  const session = dispatched({ kind: "scout" });
  for (const [name, html] of [["card", card(session)], ["console detail", detail(session)]] as const) {
    // `Tooltip` merges `aria-describedby` onto the span it wraps, so match the class and
    // its text rather than an exact tag.
    assert.match(html, /class="task-kind"[^>]*>scout</, `${name} should draw the scout badge`);
    assert.ok(html.includes("scout task"), `${name} should keep the badge's tooltip`);
  }
});

test("a session named after its task shows that title once, not twice", () => {
  // Given a reason to draw the pill anyway (this task came from a recurring mission), so
  // the missing title is the reduction rather than the absent chip.
  const summary = mkTaskSummary({
    title: "Fix the parser",
    scheduleId: "sched-1",
    scheduleOccurrenceId: "occ-1",
  });
  const session = mkSession({ name: summary.title, task: summary });
  for (const [name, html] of [["card", card(session)], ["console detail", detail(session)]] as const) {
    assert.ok(html.includes("task-chip"), `${name} should still draw the pill`);
    assert.ok(!html.includes('class="task-title"'), `${name} should not repeat the title in the pill`);
    // Still on screen - it is the session's name, which is what made the pill a duplicate.
    assert.ok(html.includes("Fix the parser"), `${name} should still name the work`);
  }
});

test("a session working on a task its name does not carry keeps the pill's title", () => {
  const session = mkSession({
    name: "Ship A",
    task: mkTaskSummary({ id: "task-b", title: "Ship B" }),
  });
  for (const [name, html] of [["card", card(session)], ["console detail", detail(session)]] as const) {
    assert.match(html, /class="task-title"[^>]*>Ship B</, `${name} should name the task now executing`);
  }
});

test("the pill survives its own text going quiet when it is still hosting something", () => {
  // The half of the reduction that must NOT overreach: the chip is the host for the
  // schedule-origin mark `session-leaf-parity.test.ts` pins on all four surfaces, so
  // suppressing the container along with its text would take that with it.
  const summary = mkTaskSummary({
    kind: "ship",
    status: "running",
    scheduleId: "sched-1",
    scheduleOccurrenceId: "occ-1",
    scheduledFor: 1_753_600_000_000,
  });
  const session = mkSession({ name: summary.title, task: summary });
  const scheduleNameById = new Map([["sched-1", "Dependency audit"]]);
  const chip = renderToStaticMarkup(
    createElement(ScheduleOriginChip, { task: summary, scheduleNames: scheduleNameById }),
  );

  const cardHtml = renderToStaticMarkup(
    createElement(SessionCard, {
      session,
      onOpenReviews: () => {},
      onOpenSchedule: () => {},
      scheduleNameById,
    }),
  );
  const detailHtml = renderToStaticMarkup(
    createElement(ConsoleDetail, {
      session,
      view: mkSessionView(session, { scheduleNameById }),
    }),
  );

  for (const [name, html] of [["card", cardHtml], ["console detail", detailHtml]] as const) {
    assert.ok(html.includes('class="task-chip task-running"'), `${name} should keep the pill`);
    assert.ok(containsMarkup(html, chip), `${name} should keep the schedule-origin mark inside it`);
  }
});
