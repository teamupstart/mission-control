import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BacklogColumn } from "../src/web/components/layouts/BacklogColumn.tsx";
import { BacklogDrawer } from "../src/web/components/line/BacklogDrawer.tsx";
import { ReportPanel } from "../src/web/components/ReportPanel.tsx";
import type { BacklogTrustView } from "../src/web/lib/backlog-copy.ts";
import type { Task } from "../src/shared/types.ts";
import { mkTask } from "./helpers/session-fixture.ts";
import { withOverlayHost } from "./helpers/overlay-host.ts";

const noop = (): void => {};
const view: BacklogTrustView = {
  enabled: true,
  mode: "live",
  running: true,
  autoBacklog: true,
  repoAllowlist: [],
};

function board(task: Task): string {
  return renderToStaticMarkup(createElement(BacklogColumn, {
    tasks: [task],
    allTasks: [task],
    plan: null,
    backlogTrust: view,
    onManageTrust: noop,
    onAssignError: noop,
    onDragging: noop,
    onEdit: noop,
  }));
}

function drawer(task: Task): string {
  return renderToStaticMarkup(createElement(BacklogDrawer, {
    tasks: [task],
    backlogPlan: null,
    now: 1,
    autoBacklog: true,
    autopilot: null,
    autopilotLaunches: true,
    backlogTrust: view,
    onManageTrust: noop,
    onClose: noop,
    onEditTask: noop,
    onOpenSitrep: noop,
    onSetAutoBacklog: async () => true,
  }));
}

function sitrep(task: Task): string {
  return renderToStaticMarkup(withOverlayHost(createElement(ReportPanel, {
    sessions: [],
    tasks: [task],
    backlogPlan: null,
    backlogTrust: view,
    onManageTrust: noop,
    onClose: noop,
    onOpenReviews: noop,
    onEditTask: noop,
  })));
}

const trustCopy = "Autopilot cannot schedule this task: calendar-buddy is not trusted for Foreman. Manual launch still works.";

test("derived trust posture uses the established visual slot without live-region semantics", () => {
  const task = mkTask({ title: "Calendar sync", repoRoot: "/work/calendar-buddy" });
  const surfaces = [
    ["Board", board(task), "bl-recovery"],
    ["Backlog drawer", drawer(task), "line-bl-notice"],
    ["Sitrep", sitrep(task), "report-task-notice"],
  ] as const;
  for (const [name, html, slot] of surfaces) {
    assert.ok(html.includes(trustCopy), `${name} must use the shared trust copy`);
    assert.match(html, new RegExp(`class="[^"]*${slot}[^"]*is-trust[^"]*"`));
    assert.match(html, />Manage trust<\/button>/);
    assert.doesNotMatch(html, /role="(?:status|alert)"/);
    assert.doesNotMatch(html, /bl-trust-btn|bl-task-alert|Why autopilot cannot schedule/);
  }
});

test("parked rows stay silent and only persisted errors retain status semantics", () => {
  assert.doesNotMatch(board(mkTask({ enabled: false })), /backlog-task-notice/);

  const task = mkTask({
    repoRoot: "/work/calendar-buddy",
    error: "Retry this launch manually",
  });
  for (const html of [board(task), drawer(task), sitrep(task)]) {
    assert.match(html, /class="[^"]*backlog-task-notice is-error" role="status"/);
    assert.match(html, />Retry this launch manually<\/span>/);
    assert.doesNotMatch(html, /role="alert"/);
    assert.doesNotMatch(html, /Autopilot cannot schedule|Manage trust/);
  }
});

test("trust keeps attention styling while stopped prerequisites keep danger styling", () => {
  const css = readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8");
  const trust = css.match(/\.report-task-notice\.is-trust\s*\{([^}]*)\}/)?.[1] ?? "";
  const error = css.match(/\.report-task-error,\s*\.report-task-notice\.is-error\s*\{([^}]*)\}/)?.[1] ?? "";
  const dead = css.match(/\.bl-deadblock-btn\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(trust, /var\(--attention\)/);
  assert.doesNotMatch(trust, /var\(--danger\)/);
  assert.match(error, /var\(--danger\)/);
  assert.match(dead, /var\(--danger\)/);
  assert.doesNotMatch(css, /\.bl-task-alert|\.bl-trust-(?:btn|pop|lead|list|repo|path|acts)/);
});
