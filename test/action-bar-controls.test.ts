import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActionBar } from "../src/web/components/ActionBar.tsx";
import type { Session, TaskSummary } from "../src/shared/types.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";
import { hasTooltip } from "./helpers/markup.ts";

// The shared Console and Board detail footer has one control set. Send lives in the
// conversation tab and Queue is a detail tab, while their keyboard handles remain
// registered by ActionBar.

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    pid: 1,
    agent: "claude",
    name: "session",
    nameSource: "tmux",
    terminals: [mkMuxHandle({ session: "dev", windowName: "@1" })],
    state: "idle",
    cwd: "/repo",
    startedAt: 0,
    lastActivity: null,
    instrumented: true,
    hooksSeen: true,
    activity: null,
    pendingReviews: 0,
    pendingTurns: [],
    ...over,
  } as Session;
}

function render(props: Record<string, unknown>): string {
  return renderToStaticMarkup(
    createElement(ActionBar, {
      session: mkSession(),
      onReset: () => {},
      onToggleQueue: () => {},
      // Complete and Kill open app-level dialogs, so like Reset they are drawn only
      // where the caller supplied a way to open one. Every real call site does, and
      // `kill-returns-to-overview.test.ts` is what holds them to it.
      onComplete: () => {},
      onKill: () => {},
      onRequeue: () => {},
      ...props,
    }),
  );
}

test("the detail footer exposes only the surviving Console and Board controls", () => {
  const html = render({});
  for (const label of ["focus", "reset", "backlog", "complete", "kill"]) {
    assert.match(html, new RegExp(`(?:>|</kbd> )${label}`), `detail lost ${label}: ${html}`);
  }
  assert.doesNotMatch(html, /(?:>|<\/kbd> )Send/);
  assert.doesNotMatch(html, /(?:>|<\/kbd> )Queue/);
  // Diff is a detail tab and Interrupt is ⌃C; neither has a footer button any more.
  assert.doesNotMatch(html, /(?:>|<\/kbd> )diff</);
  assert.doesNotMatch(html, /(?:>|<\/kbd> )interrupt</);
  assert.doesNotMatch(html, /act-interrupt/);
});

test("the detail does not start with a fallback compose box open", () => {
  assert.ok(!render({ hasReply: false }).includes("compose-input"));
  assert.ok(!render({ hasReply: true }).includes("compose-input"));
});

/** The backlog button's opening tag, so `disabled` can be read off it alone. */
function backlogButton(html: string): string {
  const at = html.indexOf("act-requeue");
  assert.notEqual(at, -1, `no backlog control was drawn: ${html}`);
  return html.slice(html.lastIndexOf("<button", at), html.indexOf(">", at) + 1);
}

function taskSummary(over: Partial<TaskSummary> = {}): TaskSummary {
  return { id: "t1", title: "Fix login flow", kind: "ship", status: "running", ...over } as TaskSummary;
}

test("an idle session's running task can go back to the backlog", () => {
  const html = render({ session: mkSession({ task: taskSummary() }) });
  assert.doesNotMatch(backlogButton(html), /disabled/);
  assert.ok(
    hasTooltip(
      html,
      'Stop "Fix login flow" and put it back in the Backlog at its old position - confirms first (b)',
    ),
    html,
  );
});

test("the backlog control says why when the task cannot go back", () => {
  const cases: [Partial<Session>, string][] = [
    [{ task: null }, "This session has no Mission Control task to return to the backlog"],
    [{ task: taskSummary({ status: "done" }) }, "Task is done; its result is recorded, not re-run"],
    [{ task: taskSummary({ kind: "chat" }) }, "Chat tasks must be launched immediately from Dispatch."],
    [
      { task: taskSummary({ kind: "pipeline", pipelineCommissionId: "pc1" as TaskSummary["pipelineCommissionId"] }) },
      "A Pipeline commission cannot return to the backlog; create a new Pipeline task",
    ],
  ];
  for (const [over, why] of cases) {
    const html = render({ session: mkSession(over) });
    assert.match(backlogButton(html), /disabled/, why);
    assert.ok(hasTooltip(html, why), `${why}: ${html}`);
  }
});

test("the backlog control is absent where the caller cannot open its confirm", () => {
  const html = renderToStaticMarkup(
    createElement(ActionBar, { session: mkSession({ task: taskSummary() }) }),
  );
  assert.doesNotMatch(html, /act-requeue/);
});
