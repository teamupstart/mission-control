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
import { RecurringMissionsPanel } from "../src/web/components/RecurringMissionsPanel.tsx";
import { withOverlayHost } from "./helpers/overlay-host.ts";
import { mkSchedule, mkScheduleTemplate } from "./helpers/schedule-fixture.ts";
import { mkTask } from "./helpers/session-fixture.ts";

/**
 * The Recurring Missions React surfaces, rendered statically (this runner has no DOM).
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

/** A published Workflow and an archived one, so the editor's filter has something to do. */
const WORKFLOWS = [
  {
    id: "wf-review",
    name: "No-Mistakes Review",
    description: "",
    draftRevision: 3,
    currentVersionId: "wfv-1",
    publishedVersion: 2,
    archivedAt: null,
    updatedAt: 0,
    errorCount: 0,
    warningCount: 0,
    nodeCount: 4,
    personaCount: 2,
    builtin: true,
  },
  // Archived, so it is not something a mission can newly be pointed at.
  {
    id: "wf-old",
    name: "Retired sweep",
    description: "",
    draftRevision: 1,
    currentVersionId: "wfv-2",
    publishedVersion: 1,
    archivedAt: 1,
    updatedAt: 0,
    errorCount: 0,
    warningCount: 0,
    nodeCount: 1,
    personaCount: 0,
    builtin: false,
  },
] as const;

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
  // Health reaches the rail as a tone AND as a word an assistive reader can hear - never
  // as the bare server token, which is how `attention` used to be printed at an operator.
  assert.match(html, /rm-dot-attention/);
  assert.match(html, /aria-label="Needs attention"/);
  assert.match(html, /aria-label="Healthy"/);
  assert.doesNotMatch(html, />healthy</);
  // The selected row is marked, so an SSE reorder can keep it highlighted.
  assert.match(html, /rm-row is-selected/);
  // The rail is a real list of real list items. `<button role="listitem">` replaced the
  // implicit button role, so assistive tech was never told the row could be activated.
  assert.match(html, /<ul class="rm-catalog-rows"><li>/);
  assert.doesNotMatch(html, /role="listitem"/);
  // Execution mode is uniform in V1, so it is not per-row information - it used to be a
  // column that truncated mid-word to `local-catc…` on every row.
  assert.doesNotMatch(html, /local-catchup/);
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
      workflowSummaries: [],
      schedule,
      onEdit: () => {},
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
  // The exact stored token stays reachable in the Configuration disclosure - an audit view
  // is the one place a raw enum belongs - beside the sentence that reads it.
  assert.match(html, /local-catchup/);
  assert.match(html, /Durable local catch-up/);
  // The machine-readable instant rides `dateTime` rather than being a fifth on-screen
  // restatement of a value the spine already carries.
  assert.ok(html.includes(`dateTime="${new Date(schedule.nextRunAt!).toISOString()}"`));
});

test("the detail leads with what the mission does, not with derived restatements", () => {
  // Agent instructions used to be a `dd` weighing exactly as much as `NEXT (UTC)`, a
  // restatement of a value printed 200px above it. The task is the mission; it reads first.
  const html = renderToStaticMarkup(
    createElement(ScheduleDetail, {
      workflowSummaries: [],
      schedule: mkSchedule(),
      onEdit: () => {},
      onArchived: () => {},
    }),
  );
  const brief = html.indexOf("rm-brief");
  const config = html.indexOf("rm-config");
  const spine = html.indexOf("rm-spine");
  assert.ok(brief > 0 && config > brief, "the task template precedes the configuration dump");
  assert.ok(spine > brief, "the time axis follows what the mission does");
  // The cadence is a sentence, not four notations of one instant.
  assert.match(html, /Every Monday at 8:00 AM · America\/New_York/);
});

test("the detail names the stored after-work Workflow, and says so when there is none", () => {
  const none = renderToStaticMarkup(
    createElement(ScheduleDetail, {
      schedule: mkSchedule(),
      workflowSummaries: [...WORKFLOWS],
      onEdit: () => {},
      onArchived: () => {},
    }),
  );
  assert.match(none, /After work/);
  assert.match(none, /None - each run finishes without a Workflow/);

  const armed = renderToStaticMarkup(
    createElement(ScheduleDetail, {
      schedule: mkSchedule({ template: mkScheduleTemplate({ workflowId: "wf-review" }) }),
      workflowSummaries: [...WORKFLOWS],
      onEdit: () => {},
      onArchived: () => {},
    }),
  );
  assert.match(armed, /No-Mistakes Review · v2/);
});

test("the overlay hands the Workflow catalog down, so the detail names it rather than an id", () => {
  // Omitting the prop is a compile error; passing the WRONG list still renders, as
  // "Unavailable Workflow (wf-review)".
  const html = renderToStaticMarkup(
    withOverlayHost(
      createElement(RecurringMissionsPanel, {
        schedules: [
          mkSchedule({ template: mkScheduleTemplate({ workflowId: "wf-review" }) }),
        ],
        workflowSummaries: [...WORKFLOWS],
        connected: true,
        hasSnapshot: true,
        onClose: () => {},
      }),
    ),
  );
  assert.match(html, /No-Mistakes Review · v2/);
  assert.doesNotMatch(html, /Unavailable Workflow/);
});

test("the detail's Run now explains it files a backlog task, not that it runs an agent", () => {
  const html = renderToStaticMarkup(
    createElement(ScheduleDetail, {
      workflowSummaries: [],
      schedule: mkSchedule(),
      onEdit: () => {},
      onArchived: () => {},
    }),
  );
  assert.match(html, /work now as a backlog task - it does not run an agent/);
});

test("the editor distinguishes Save paused from Save & enable, and only offers local catch-up", () => {
  const html = renderToStaticMarkup(
    createElement(ScheduleEditor, {
      workflowSummaries: [],
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
  assert.match(html, /<option value="ship" selected="">ship - deliver a change<\/option>/);
  assert.match(html, /<option value="plan">plan - produce a reviewed plan<\/option>/);
  assert.doesNotMatch(html, /<option value="chat"/);
});

test("a mission's stored effort survives a switch to an agent that does not offer it", () => {
  // The same silent erasure the Task kinds grid guards: a `<select>` whose value matches no
  // option renders its FIRST option, which here reads "harness default". A mission saved on
  // Claude at `max` and later moved to Inherit - whose list is only the levels EVERY harness
  // offers - would therefore show "harness default" over a stored `max`, and save that
  // erasure the next time anything else on the form changed.
  const html = renderToStaticMarkup(
    createElement(ScheduleEditor, {
      workflowSummaries: [],
      schedule: mkSchedule({ template: mkScheduleTemplate({ agent: null, effort: "max" }) }),
      onSaved: () => {},
      onCancel: () => {},
    }),
  );
  assert.match(html, /max - not offered here/, "the stored level is still on the list");
  // Disabled: it can be read and kept, but not newly chosen - a level no harness is
  // guaranteed to offer is not something to hand somebody as a fresh choice.
  assert.match(html, /value="max" disabled=""/);
  assert.doesNotMatch(
    html,
    /<option value="" selected="">harness default<\/option>\s*<option value="max"/,
    "the stored level, not the inherit option, is the selected one",
  );

  // A level the list DOES offer is an ordinary option with no warning attached.
  const ordinary = renderToStaticMarkup(
    createElement(ScheduleEditor, {
      workflowSummaries: [],
      schedule: mkSchedule({ template: mkScheduleTemplate({ agent: null, effort: "high" }) }),
      onSaved: () => {},
      onCancel: () => {},
    }),
  );
  assert.doesNotMatch(ordinary, /not offered here/);
});

test("a new mission rests on no after-work Workflow, and the published ones are on offer", () => {
  const html = renderToStaticMarkup(
    createElement(ScheduleEditor, {
      schedule: null,
      workflowSummaries: [...WORKFLOWS],
      onSaved: () => {},
      onCancel: () => {},
    }),
  );
  assert.match(html, /<option value="" selected="">None - finish without a Workflow<\/option>/);
  assert.match(html, /No-Mistakes Review/);
  assert.doesNotMatch(html, /Dispatch default/);
  assert.doesNotMatch(html, /Retired sweep/);
});

test("a mission's stored Workflow survives the library archiving it", () => {
  const html = renderToStaticMarkup(
    createElement(ScheduleEditor, {
      schedule: mkSchedule({ template: mkScheduleTemplate({ workflowId: "wf-gone" }) }),
      workflowSummaries: [...WORKFLOWS],
      onSaved: () => {},
      onCancel: () => {},
    }),
  );
  assert.match(html, /<option value="wf-gone" selected="">Unavailable Workflow<\/option>/);
  assert.match(html, /the library no longer publishes/);
});

test("a diffless kind disables the after-work control and shows None", () => {
  const html = renderToStaticMarkup(
    createElement(ScheduleEditor, {
      schedule: mkSchedule({
        template: mkScheduleTemplate({ kind: "scout", workflowId: "wf-review" }),
      }),
      workflowSummaries: [...WORKFLOWS],
      onSaved: () => {},
      onCancel: () => {},
    }),
  );
  assert.match(html, /A scout has no diff to review, so no Workflow runs after it\./);
  assert.match(html, /<option value="" selected="">None - finish without a Workflow<\/option>/);
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
      workflowSummaries: [],
      schedule: mkSchedule({
        executionMode: null,
        unreadable: { reason: "Unknown execution mode", fields: ["executionMode"] },
      }),
      onEdit: () => {},
      onArchived: () => {},
    }),
  );
  assert.match(html, /cannot be edited safely/);
  assert.match(html, /<button class="btn" disabled=""[^>]*>Edit<\/button>/);
});

test("the detail disables Resume for a paused newer-build schedule, but not Pause", () => {
  // Resuming an unreadable schedule would set its durable enabled flag on a config this
  // build cannot run, and a later compatible build would then start it unbidden (Inspector
  // round on #241). Pause must stay available so a running one can always be stopped.
  const paused = renderToStaticMarkup(
    createElement(ScheduleDetail, {
      workflowSummaries: [],
      schedule: mkSchedule({
        enabled: false,
        executionMode: null,
        unreadable: { reason: "Unknown execution mode", fields: ["executionMode"] },
      }),
      onEdit: () => {},
      onArchived: () => {},
    }),
  );
  assert.match(paused, /<button class="btn" disabled=""[^>]*>Resume<\/button>/);
  assert.match(paused, /cannot be resumed until opened in a compatible build/);

  const enabled = renderToStaticMarkup(
    createElement(ScheduleDetail, {
      workflowSummaries: [],
      schedule: mkSchedule({
        enabled: true,
        executionMode: null,
        unreadable: { reason: "Unknown execution mode", fields: ["executionMode"] },
      }),
      onEdit: () => {},
      onArchived: () => {},
    }),
  );
  // Pause is not disabled by unreadability - only busy would disable it.
  assert.match(enabled, /<button class="btn"[^>]*>Pause<\/button>/);
  assert.doesNotMatch(enabled, /<button class="btn" disabled=""[^>]*>Pause<\/button>/);
});

test("the editor preserves a current timezone absent from the browser list", () => {
  const html = renderToStaticMarkup(
    createElement(ScheduleEditor, {
      workflowSummaries: [],
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
        completionPolicy: "manual",
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
          workflowId: null,
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
  const history = readFileSync(path.join(WEB, "components/schedules/ScheduleSpine.tsx"), "utf8");
  assert.match(
    history,
    /function loadOlder\(\): void \{[\s\S]*?setError\(null\);\s+setLoading\(true\);[\s\S]*?if \(!page\) \{[\s\S]*?return;\s+\}\s+setError\(null\);/,
  );
  assert.match(history, /Schedule \{scheduleId\}/);
  assert.match(history, /occurrence \$\{initialOccurrenceId\}/);
});

test("history deep links, row activation, and timestamps preserve the audit", () => {
  const history = readFileSync(path.join(WEB, "components/schedules/ScheduleSpine.tsx"), "utf8");
  // The deep link seeds the cursor from the occurrence's own instant so the exact run lands
  // on the first page (O(1)), and the fallback pages until found or history is exhausted -
  // no artificial page cap, per the Inspector round on #241.
  assert.match(history, /initialScheduledFor \+ 1/);
  assert.doesNotMatch(history, /DEEP_LINK_PAGE_LIMIT/);
  assert.match(history, /Promise\.all\(\[/);
  assert.match(
    history,
    /createFetchedSpineHistoryWindow\([\s\S]*?\{ occurrences: accumulated, nextCursor \},\s+before !== null,/,
  );
  assert.match(history, /Some history is not loaded/);
  assert.match(history, /Load missing history/);
  // The outcome is a focusable, tooltip-wrapped <button> that expands the audit in place,
  // rather than selecting a row that fills a second pane.
  assert.match(history, /className="rm-sp-toggle"/);
  assert.match(history, /aria-expanded=\{open\}/);
  assert.match(history, /setOpenId\(\(prev\) => \(prev === row\.occurrence\.id \? null : row\.occurrence\.id\)\)/);
  // Timestamps stay unambiguous, but the operator's own zone leads and UTC is the audit
  // line beneath it - the reverse of how history read before.
  assert.match(history, /<div>\{formatInstant\(at, timezone, \{/);
  assert.match(history, /<div className="rm-dim rm-tiny rm-mono">\{formatAuditInstantUtc\(at\)\}<\/div>/);
  assert.match(history, /Historical instants use the mission&apos;s current time zone/);
});

test("live occurrence deep links stay in detail and schedule upserts reset history", () => {
  const panel = readFileSync(path.join(WEB, "components/RecurringMissionsPanel.tsx"), "utf8");
  const detail = readFileSync(
    path.join(WEB, "components/schedules/ScheduleDetail.tsx"),
    "utf8",
  );
  const spine = readFileSync(path.join(WEB, "components/schedules/ScheduleSpine.tsx"), "utf8");
  assert.match(panel, /!schedules\.some\(\(schedule\) => schedule\.id === initialScheduleId\)/);
  assert.match(panel, /initialOccurrenceId=\{/);
  assert.match(detail, /initialOccurrenceId=\{initialOccurrenceId\}/);
  assert.match(
    spine,
    /\[initialOccurrenceId, initialScheduledFor, schedule, scheduleId\]/,
  );
  assert.match(spine, /setHistory\(EMPTY_SPINE_HISTORY\)/);
  assert.doesNotMatch(spine, /lastOccurrenceId/);
});

test("future rungs reserve countdown text for the next instant", () => {
  const spine = readFileSync(path.join(WEB, "components/schedules/ScheduleSpine.tsx"), "utf8");
  assert.match(spine, /const countdown = isNext \? formatCountdown\(at, now\) : null/);
  assert.doesNotMatch(spine, /dstShift \? countdown/);
  assert.doesNotMatch(spine, /Nothing ran for/);
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
  const history = readFileSync(path.join(WEB, "components/schedules/ScheduleSpine.tsx"), "utf8");
  assert.match(history, /function TaskLink/);
  assert.match(history, /rm-task-inert/);
});
