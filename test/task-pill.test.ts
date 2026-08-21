import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConsoleDetail } from "../src/web/components/layouts/ConsoleDetail.tsx";
import { ScheduleOriginChip } from "../src/web/components/session-bits.tsx";
import { taskPillParts } from "../src/shared/task.ts";
import { DEFAULT_TASK_KIND, TASK_KINDS } from "../src/shared/types.ts";
import type { Session, TaskSummary } from "../src/shared/types.ts";
import { mkSession, mkTaskSummary } from "./helpers/session-fixture.ts";
import { mkSessionView } from "./helpers/session-view.ts";
import { containsMarkup } from "./helpers/markup.ts";

/**
 * The task pill, reduced to what it can actually tell a reader.
 *
 * Two of its three parts were usually saying nothing. Every automated writer defaults to
 * `ship` and the MCP `create_task` tool cannot produce anything else - so the badge read
 * `SHIP` in almost every session, uncoloured and frozen from the moment the task left the
 * backlog. The title was a duplicate of the `h2` two rows above it, because a dispatched
 * session is named after its task.
 *
 * The rule the reduction settled on is "draw every kind except the default", not "draw
 * scout", which is why `plan` arrived already drawn and this file gained a case rather
 * than a change. `ship` is silent because it is what you get by NOT choosing; a kind
 * somebody picked on purpose is worth a badge whatever it is called.
 *
 * Both reductions live in ONE shared predicate rather than in each component. The title is
 * a comparison rather than a deletion because a re-assigned session keeps the first task's
 * title as its name, so the pill is the only place the task now executing is written.
 *
 * `createElement` rather than JSX because the runner's glob only matches .test.ts.
 */

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
  // Deliberately chosen, therefore worth drawing - the same reasoning that draws `scout`,
  // applied by a rule that reads the default rather than naming the kinds.
  assert.equal(taskPillParts(dispatched({ kind: "plan" })).kind, "plan");
  // Stated as the rule, so a fourth kind is covered by this file the day it is added and
  // a change that made `ship` loud would fail here rather than in a screenshot.
  for (const kind of TASK_KINDS) {
    assert.equal(
      taskPillParts(dispatched({ kind })).kind,
      kind === DEFAULT_TASK_KIND ? null : kind,
      `${kind} should be drawn exactly when it is not the default`,
    );
  }
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

test("a silent pill is not drawn in the shared detail", () => {
  const session = dispatched();
  assert.ok(!detail(session).includes("task-chip"));
});

test("a silent pill does not take the multi-repo pull-request row with it", () => {
  // The row is a SIBLING of the pill, not pill content, and it gates itself on having
  // entries - so a multi-repo ship task named after its own session, before anything has
  // merged, draws the row with no pill above it. That is the intended shape: each chip
  // names its repo and that repo's PR state, and the alternative (folding `repoPrs` into
  // `silent`) draws an empty stub over the row instead of a heading.
  const summary = mkTaskSummary({
    repoPrs: [
      {
        repoRoot: "/repos/demo",
        primary: true,
        prUrl: null,
        prState: null,
        mergedAt: null,
        feedback: null,
      },
      {
        repoRoot: "/repos/second",
        primary: false,
        prUrl: null,
        prState: null,
        mergedAt: null,
        feedback: null,
      },
    ],
  });
  const session = mkSession({ name: summary.title, task: summary });
  assert.equal(taskPillParts(session).silent, true, "the pill itself still has nothing to say");

  const html = detail(session);
  assert.ok(!html.includes("task-chip"));
  assert.ok(html.includes("task-repo-prs"));
  assert.ok(html.includes("demo") && html.includes("second"));
});

test("a ship task draws no kind badge in the shared detail", () => {
  // A task whose title the session does NOT carry, so the pill is drawn and the badge's
  // absence is a fact about the badge rather than about the whole chip having stood down.
  const session = mkSession({ name: "agent-1", task: mkTaskSummary({ kind: "ship" }) });
  const html = detail(session);
  assert.ok(html.includes("task-chip"));
  assert.ok(!html.includes('class="task-kind"'));
  assert.ok(!html.includes("ship task"));
});

test("non-default task kinds draw their badges in the shared detail", () => {
  for (const kind of TASK_KINDS.filter((candidate) => candidate !== DEFAULT_TASK_KIND)) {
    const html = detail(dispatched({ kind }));
    assert.match(html, new RegExp(`class="task-kind"[^>]*>${kind}<`));
    assert.ok(html.includes(`${kind} task`));
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
  const html = detail(session);
  assert.ok(html.includes("task-chip"));
  assert.ok(!html.includes('class="task-title"'));
  assert.ok(html.includes("Fix the parser"));
});

test("a session working on a task its name does not carry keeps the pill's title", () => {
  const session = mkSession({
    name: "Ship A",
    task: mkTaskSummary({ id: "task-b", title: "Ship B" }),
  });
  assert.match(detail(session), /class="task-title"[^>]*>Ship B</);
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

  const detailHtml = renderToStaticMarkup(
    createElement(ConsoleDetail, {
      session,
      view: mkSessionView(session, { scheduleNameById }),
    }),
  );

  assert.ok(detailHtml.includes('class="task-chip task-running"'));
  assert.ok(containsMarkup(detailHtml, chip));
});
