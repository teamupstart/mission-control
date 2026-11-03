import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { mkTask } from "./helpers/session-fixture.ts";
import type { Task } from "../src/shared/types.ts";
import {
  FailedLaunchList,
  LaunchFailureNotice,
  LaunchFailureProvider,
  fleetFailureGroups,
  type LaunchFailureControls,
} from "../src/web/components/LaunchFailures.tsx";

// The exact shape each surface draws for a dispatch that never started. The browser spec
// drives the not-started and returned outcomes through a real daemon; the kept outcome needs a
// launch that fails after its session exists, which no fake reaches on demand, so its card
// notice is pinned here. So is the rule that a report session's own failure offers no Report
// bug, which would otherwise be a loop one click long.

const failure = (over: Partial<NonNullable<Task["launchFailure"]>> = {}): NonNullable<Task["launchFailure"]> => ({
  at: 1_000,
  phase: "launch",
  dismissedAt: null,
  reportTaskId: null,
  residentProfileId: null,
  sessionKept: false,
  ...over,
});

function render(tasks: Task[], node: React.ReactElement): string {
  const controls: LaunchFailureControls = {
    tasks,
    openReport: () => {},
    launchResident: () => {},
    openProfile: () => {},
    openSession: () => {},
  };
  return renderToStaticMarkup(createElement(LaunchFailureProvider, { value: controls }, node));
}

test("a failed tile names the work, the phase and the reason, with the kind's own way back in", () => {
  const tasks = [
    mkTask({
      id: "w1",
      kind: "resident",
      workspaceKind: "resident-workspace",
      title: "Agent Wrangler",
      status: "failed",
      error: "could not connect to its MCP server commonroom",
      launchFailure: failure({ residentProfileId: "p1" }),
    }),
    mkTask({
      id: "w2",
      kind: "resident",
      workspaceKind: "resident-workspace",
      title: "Agent Wrangler",
      status: "failed",
      error: "could not connect to its MCP server commonroom",
      launchFailure: failure({ at: 2_000, residentProfileId: "p1" }),
    }),
  ];
  const html = render(tasks, createElement(FailedLaunchList, { groups: fleetFailureGroups(tasks), variant: "tile" }));
  assert.match(html, /role="list" aria-label="Did not start"/);
  assert.match(html, /aria-label="Agent Wrangler did not start"/);
  assert.match(html, /id="launch-failure-w2"/, "anchored on the newest attempt");
  assert.match(html, /×2/);
  assert.match(html, /at launch/);
  assert.match(html, /could not connect to its MCP server commonroom/);
  assert.match(html, />Launch again</);
  assert.match(html, />Open profile</);
  assert.doesNotMatch(html, />Retry</, "a resident launches again from its profile, never as a retried task");
  assert.match(html, />Report bug</);
  assert.match(html, />Dismiss</);
});

test("a session that survived its failed launch says why on its own card", () => {
  const tasks = [
    mkTask({ id: "kept", status: "failed", sessionId: "s1", error: "the first prompt was not delivered", launchFailure: failure() }),
  ];
  const html = render(tasks, createElement(LaunchFailureNotice, { sessionId: "s1" }));
  assert.match(html, /Launch failed after its session started/);
  assert.match(html, /the first prompt was not delivered/);
  assert.match(html, />Open</);
  assert.equal(render(tasks, createElement(LaunchFailureNotice, { sessionId: "another" })), "");
});

test("a report session that itself did not start offers no Report bug, even after its original was retried", () => {
  const tasks = [
    // The failure it was started for has been retried: that task is running again and carries
    // no record any more, so nothing on it still points at the report.
    mkTask({ id: "origin", kind: "chat", title: "Talk", status: "running", sessionId: "s-origin", launchFailure: null }),
    mkTask({
      id: "report", kind: "chat", title: "Report: Talk did not start", status: "failed", error: "boom",
      launchFailure: failure(), launchReportFor: "origin",
    }),
  ];
  const html = render(tasks, createElement(FailedLaunchList, { groups: fleetFailureGroups(tasks), variant: "tile" }));
  assert.match(html, /Report: Talk did not start/);
  assert.match(html, />Retry</);
  assert.doesNotMatch(html, />Report bug</, "a report session never reports itself, so it cannot loop");
});

test("a grouped failure is drawn on one card - its newest attempt's - never repeated on the others", () => {
  const returned = (id: string, at: number) => mkTask({
    id, kind: "ship", title: "Rename the helper", status: "backlog", error: "git fetch origin failed",
    launchFailure: failure({ at }),
  });
  const kept = (id: string, at: number, sessionId: string) => mkTask({
    id, kind: "ship", title: "Ship the parser", status: "failed", sessionId, error: "the first prompt was not delivered",
    launchFailure: failure({ at, sessionKept: true }),
  });
  const tasks = [returned("old-card", 1), returned("new-card", 2), kept("old-kept", 1, "s-old"), kept("new-kept", 2, "s-new")];

  const newest = render(tasks, createElement(LaunchFailureNotice, { taskId: "new-card" }));
  assert.match(newest, /Did not start, back in Backlog/);
  assert.match(newest, /id="launch-failure-new-card"/);
  assert.match(newest, /×2/);
  assert.equal(render(tasks, createElement(LaunchFailureNotice, { taskId: "old-card" })), "", "the older Backlog card draws nothing");

  assert.match(render(tasks, createElement(LaunchFailureNotice, { sessionId: "s-new" })), /id="launch-failure-new-kept"/);
  assert.equal(render(tasks, createElement(LaunchFailureNotice, { sessionId: "s-old" })), "", "the older session card draws nothing");
});
