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

test("editing sequences enable/pause to the safe side, and rolls back a failed save", () => {
  // Phase 3 has no atomic update-and-enabled route, so the editor's request ORDER carries
  // the safety across two Inspector rounds on #241: pausing pauses FIRST (so no tick can
  // run a just-saved, immediately-due cadence before the pause is durable), enabling enables
  // LAST (so a revision is only runnable once saved), and a failed update rolls the pre-empt
  // pause back (so a rejected edit never silently stops a running mission).
  const editor = readFileSync(path.join(WEB, "components/schedules/ScheduleEditor.tsx"), "utf8");
  assert.match(editor, /const pauseFirst = !enable && wasEnabled/);
  assert.match(editor, /if \(pauseFirst\)[\s\S]*?setScheduleEnabled\(schedule\.id, false\)/);
  assert.match(editor, /if \(pauseFirst\) await setScheduleEnabled\(schedule\.id, true\)/);
  assert.match(editor, /if \(enable && !wasEnabled\)[\s\S]*?setScheduleEnabled\(schedule\.id, true\)/);
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

test("the detail prevents newer-build schedules from being edited", () => {
  const html = renderToStaticMarkup(
    createElement(ScheduleDetail, {
      schedule: mkSchedule({
        executionMode: null,
        unreadable: { reason: "Unknown execution mode", fields: ["executionMode"] },
      }),
      onEdit: () => {},
      onPreview: () => {},
      onHistory: () => {},
      onArchived: () => {},
    }),
  );
  assert.match(html, /cannot be edited safely/);
  assert.match(html, /<button class="btn" disabled=""[^>]*>Edit<\/button>/);
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

test("confirmation and standby simulation seal their underlying controls", () => {
  const panel = readFileSync(path.join(WEB, "components/RecurringMissionsPanel.tsx"), "utf8");
  const preview = readFileSync(
    path.join(WEB, "components/schedules/SchedulePreview.tsx"),
    "utf8",
  );
  assert.match(panel, /className="rm-topline" inert=\{confirmDiscard !== null\}/);
  assert.match(panel, /className="rm-content" inert=\{confirmDiscard !== null\}/);
  assert.match(panel, /className="btn btn-danger"\s+disabled=\{editorBusy\}/);
  assert.match(preview, /sleepStartedAt !== standbyWindowRef\.current\.sleepStartedAt/);
  assert.match(preview, /resumedAt !== standbyWindowRef\.current\.resumedAt/);
  assert.match(
    preview,
    /value=\{sleepValue\}[\s\S]*?disabled=\{standbyBusy\}[\s\S]*?value=\{resumeValue\}[\s\S]*?disabled=\{standbyBusy\}/,
  );
});

test("history errors preserve provenance and clear after pagination recovers", () => {
  const history = readFileSync(
    path.join(WEB, "components/schedules/ScheduleHistory.tsx"),
    "utf8",
  );
  assert.match(
    history,
    /function loadOlder\(\): void \{[\s\S]*?setError\(null\);\s+setLoading\(true\);[\s\S]*?if \(!page\) \{[\s\S]*?return;\s+\}\s+setError\(null\);/,
  );
  assert.match(history, /Schedule \{scheduleId\}/);
  assert.match(history, /occurrence \$\{initialOccurrenceId\}/);
});

test("history deep links, row activation, and timestamps preserve the audit", () => {
  const history = readFileSync(
    path.join(WEB, "components/schedules/ScheduleHistory.tsx"),
    "utf8",
  );
  // The deep link seeds the cursor from the occurrence's own instant so the exact run lands
  // on the first page (O(1)), and the fallback pages until found or history is exhausted -
  // no artificial page cap, per the Inspector round on #241.
  assert.match(history, /initialScheduledFor \+ 1/);
  assert.doesNotMatch(history, /DEEP_LINK_PAGE_LIMIT/);
  assert.match(history, /page\.nextCursor === null/);
  // Row selection is a focusable, tooltip-wrapped <button> (a <tr> cannot be Tooltip-wrapped
  // - its description span would be an invalid tbody child), per the Inspector round on #241.
  assert.match(history, /className="rm-history-select"/);
  assert.match(history, /aria-pressed=\{occ\.id === selectedId\}/);
  assert.match(history, /onClick=\{\(\) => setSelectedId\(occ\.id\)\}/);
  // Timestamps stay unambiguous: UTC with year in both the row and the audit head.
  assert.match(history, /Current zone \(\{timezone\}\):/);
  assert.match(history, /<h3>\{formatAuditInstantUtc\(occurrence\.scheduledFor\)\}<\/h3>/);
});

test("generated-task links route without abandoning retained audits", () => {
  const app = readFileSync(path.join(WEB, "App.tsx"), "utf8");
  assert.match(app, /if \(task\.status === "backlog"\)/);
  assert.match(app, /sessions\.find\(\(session\) => session\.id === task\.sessionId\)/);
  assert.match(app, /if \(liveSession\)[\s\S]*?navigate\(\{ page: "fleet" \}\)/);
  assert.match(app, /if \(liveSession\)[\s\S]*?setFilter\(""\)/);
  assert.match(app, /if \(liveSession\)[\s\S]*?setSelectedId\(liveSession\.id\)/);
  assert.match(app, /if \(layout === "board"\) setBoardOpen\(true\)/);
  assert.match(app, /window\.open\(task\.outcomeUrl, "_blank", "noopener"\)/);
  // A finished task with no live surface is not a dead link: App reports it un-openable
  // with a reason, and history renders it disabled rather than a click that does nothing.
  assert.match(app, /resolveTaskLink=\{/);
  assert.match(app, /openable: false, blockedReason:/);
  const history = readFileSync(path.join(WEB, "components/schedules/ScheduleHistory.tsx"), "utf8");
  assert.match(history, /function TaskLinkCell/);
  assert.match(history, /rm-task-inert/);
});
