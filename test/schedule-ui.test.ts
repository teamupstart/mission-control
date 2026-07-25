import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ScheduleCatalog } from "../src/web/components/schedules/ScheduleCatalog.tsx";
import { ScheduleDetail } from "../src/web/components/schedules/ScheduleDetail.tsx";
import { ScheduleEditor } from "../src/web/components/schedules/ScheduleEditor.tsx";
import { SchedulePreview } from "../src/web/components/schedules/SchedulePreview.tsx";
import { BacklogColumn } from "../src/web/components/layouts/BacklogColumn.tsx";
import { ReportPanel } from "../src/web/components/ReportPanel.tsx";
import { withOverlayHost } from "./helpers/overlay-host.ts";
import { mkSchedule } from "./helpers/schedule-fixture.ts";
import { mkTask } from "./helpers/session-fixture.ts";

/**
 * The Scheduled Catalog's React surfaces, rendered statically (this runner has no DOM).
 *
 * Two things are at stake and both are load-bearing. First, the honesty of the local
 * catch-up story: the operator must never read a promise that work ran on time or while
 * the laptop was asleep, so the guarantee wording is pinned here. Second, provenance
 * parity: a generated task's origin has to be reachable from the backlog surfaces
 * (Board column, Sitrep) as well as the session renderers covered in
 * session-leaf-parity.test.ts.
 */

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/web");

function scheduledTask(over = {}) {
  return mkTask({
    id: "gen-1",
    title: "Run dependency audit",
    scheduleId: "sched-1",
    scheduleOccurrenceId: "occ-1",
    scheduledFor: 1_753_600_000_000,
    ...over,
  });
}
const NAMES = new Map([["sched-1", "Dependency audit"]]);

test("the catalog lists live schedules with their server-derived health", () => {
  const html = renderToStaticMarkup(
    createElement(ScheduleCatalog, {
      schedules: [mkSchedule({ id: "a", name: "Alpha", health: "healthy" }), mkSchedule({ id: "b", name: "Beta", health: "attention" })],
      selectedId: "b",
      onSelect: () => {},
      connected: true,
      hasSnapshot: true,
    }),
  );
  assert.match(html, /Alpha/);
  assert.match(html, /Beta/);
  assert.match(html, /rm-pill-attention/);
  assert.match(html, /local-catchup/);
  // The selected row is marked, so an SSE reorder can keep it highlighted.
  assert.match(html, /rm-row is-selected/);
});

test("the catalog shows a disconnected banner instead of fetching, and an empty state", () => {
  const disconnected = renderToStaticMarkup(
    createElement(ScheduleCatalog, {
      schedules: [mkSchedule()],
      selectedId: null,
      onSelect: () => {},
      connected: false,
      hasSnapshot: true,
    }),
  );
  assert.match(disconnected, /Live connection lost/);

  const empty = renderToStaticMarkup(
    createElement(ScheduleCatalog, {
      schedules: [],
      selectedId: null,
      onSelect: () => {},
      connected: true,
      hasSnapshot: true,
    }),
  );
  assert.match(empty, /No recurring missions yet/);
});

test("the detail is honest about local catch-up: never on-time, never asleep execution", () => {
  const schedule = mkSchedule();
  const html = renderToStaticMarkup(
    createElement(ScheduleDetail, {
      schedule,
      onEdit: () => {},
      onPreview: () => {},
      onHistory: () => {},
      onArchived: () => {},
    }),
  );
  assert.match(html, /No work runs while this laptop is asleep or powered off/);
  assert.match(html, /not promised to run at the original wall-clock instant/i);
  assert.doesNotMatch(html, /guaranteed on.?time/i);
  // Run now and the pause control are both present.
  assert.match(html, /Run now/);
  assert.match(html, /Pause/);
  assert.match(html, /0 8 \* \* 1/);
  assert.match(html, /Audit dependencies and open a PR if anything changed/);
  assert.match(html, /\/Users\/dev\/workspace\/mission-control/);
  assert.match(html, /local-catchup/);
  assert.ok(html.includes(new Date(schedule.nextRunAt!).toISOString()));
  assert.match(html, /on time/);
});

test("the detail's Run now explains it files a backlog task, not that it runs an agent", () => {
  const html = renderToStaticMarkup(
    createElement(ScheduleDetail, {
      schedule: mkSchedule(),
      onEdit: () => {},
      onPreview: () => {},
      onHistory: () => {},
      onArchived: () => {},
    }),
  );
  assert.match(html, /work now as a backlog task - it does not run an agent/);
});

test("the editor distinguishes Save paused from Save & enable, and only offers local catch-up", () => {
  const html = renderToStaticMarkup(
    createElement(ScheduleEditor, {
      schedule: null,
      onSaved: () => {},
      onCancel: () => {},
    }),
  );
  assert.match(html, /Save paused/);
  assert.match(html, /Save &amp; enable/);
  // Local durable catch-up is the selectable mode; the others are shown but disabled.
  assert.match(html, /Catch up when Mission Control resumes/);
  assert.match(html, /Not available/);
  assert.match(html, /Future/);
  // The availability copy never promises on-time or asleep execution.
  assert.match(html, /No work runs while this laptop is asleep or powered off/);
});

test("the catalog marks an unreadable execution mode", () => {
  const html = renderToStaticMarkup(
    createElement(ScheduleCatalog, {
      schedules: [mkSchedule({ executionMode: null })],
      selectedId: null,
      onSelect: () => {},
      connected: true,
      hasSnapshot: true,
    }),
  );
  assert.match(html, /unreadable/);
});

test("the editor preserves a current timezone absent from the browser list", () => {
  const html = renderToStaticMarkup(
    createElement(ScheduleEditor, {
      schedule: mkSchedule({ timezone: "Etc/UTC" }),
      onSaved: () => {},
      onCancel: () => {},
    }),
  );
  assert.match(html, /<option value="Etc\/UTC" selected="">Etc\/UTC<\/option>/);
});

test("the preview renders the daemon's own results, and shows a loading state until they arrive", () => {
  // The fetch effect never runs under renderToStaticMarkup, so the first paint is the
  // honest loading state rather than an empty list reading as 'nothing is scheduled'.
  const html = renderToStaticMarkup(
    createElement(SchedulePreview, {
      definition: {
        name: "n",
        expression: "0 8 * * 1",
        timezone: "UTC",
        overlapPolicy: "skip-active",
        missedPolicy: "coalesce-latest",
        template: {
          title: "t",
          intent: "i",
          repoRoot: "/repo",
          kind: "ship",
          agent: "claude",
          priority: null,
          labels: [],
          model: null,
          effort: null,
        },
      },
    }),
  );
  assert.match(html, /Enumerating occurrences/);
});

test("Board backlog shows a scheduled task's origin mark", () => {
  const html = renderToStaticMarkup(
    createElement(BacklogColumn, {
      tasks: [scheduledTask()],
      allTasks: [scheduledTask()],
      plan: null,
      onAssignError: () => {},
      onDragging: () => {},
      onEdit: () => {},
      onOpenSchedule: () => {},
      scheduleNameById: NAMES,
    }),
  );
  assert.match(html, /schedule-chip/);
  assert.match(html, /Dependency audit/);
});

test("Sitrep shows scheduled provenance on backlog rows and keeps it on finished tasks", () => {
  const html = renderToStaticMarkup(
    withOverlayHost(
      createElement(ReportPanel, {
        sessions: [],
        tasks: [
          scheduledTask({ id: "b1", status: "backlog" }),
          scheduledTask({ id: "d1", status: "done", outcome: "PR #7", outcomeUrl: null }),
        ],
        backlogPlan: null,
        onClose: () => {},
        onOpenReviews: () => {},
        onEditTask: () => {},
        onOpenSchedule: () => {},
        scheduleNameById: NAMES,
      }),
    ),
  );
  // Both the backlog row and the recent-outcomes row carry the shared chip.
  const chips = html.match(/schedule-chip/g) ?? [];
  assert.ok(chips.length >= 2, `expected the chip on both backlog and recent rows, found ${chips.length}`);
});

test("no catalog poll loop exists: the panel and catalog consume live state only", () => {
  // The catalog is MissionState.schedules over the EventSource. A fetch of the list route
  // in the panel or the catalog component would be the poll the plan forbids; history is
  // the one on-demand read and it goes through fetchScheduleHistory.
  const panel = readFileSync(path.join(WEB, "components/RecurringMissionsPanel.tsx"), "utf8");
  const catalog = readFileSync(path.join(WEB, "components/schedules/ScheduleCatalog.tsx"), "utf8");
  const stream = readFileSync(path.join(WEB, "useEventStream.ts"), "utf8");
  for (const [name, src] of [
    ["RecurringMissionsPanel", panel],
    ["ScheduleCatalog", catalog],
    ["useEventStream", stream],
  ] as const) {
    assert.doesNotMatch(
      src,
      /fetch\(["'`]\/api\/schedules["'`]\)|GET \/api\/schedules|setInterval/,
      `${name} must not poll the schedule catalog`,
    );
  }
  assert.doesNotMatch(stream, /\/api\/schedules/, "useEventStream must not read the schedule route");
});
