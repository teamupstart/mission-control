import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskSourcesPanel } from "../src/web/components/TaskSourcesPanel.tsx";
import type { TaskSourceInstance, TaskSourcesView } from "../src/shared/task-source.ts";
import type { TaskSourcesState } from "../src/web/useTaskSources.ts";

// What is at stake: this panel is where an operator decides to let something create work
// on their behalf, so it has to be honest about two things a control cannot say by itself.
//
//  - What a source actually DOES. It files backlog rows and nothing else - it never
//    dispatches an agent, cuts a worktree or types into a session. Turning one on is a
//    far smaller decision than the Inspector or Shipping, and the panel is the only place
//    that can say so.
//  - Which of "off", "never swept" and "swept, found nothing" it is looking at. Those
//    three render identically if nobody insists otherwise, and reading the first two as
//    the third is how a source broken since setup goes unnoticed for a week.
//
// Rendered rather than driven through a browser, for the reason every other settings test
// is: the dashboard's SSE stream holds the connection open and hangs headless automation.
// Static markup runs no effects, so nothing fetches and the pre-poll state is what draws -
// which is also the state a first-run user sees.

const KINDS = [
  { kind: "github-issues" as const, label: "GitHub issues", blurb: "Files an open issue." },
];

function mkSource(over: Partial<TaskSourceInstance> = {}): TaskSourceInstance {
  return {
    id: "src-1",
    kind: "github-issues",
    label: "widgets bugs",
    enabled: false,
    repoRoot: "/repo/widgets",
    intervalMs: 900_000,
    defaults: { kind: "ship", agent: "claude", priority: null, labels: [] },
    maxPerSweep: 25,
    config: {},
    ...over,
  } as TaskSourceInstance;
}

function mkState(view: TaskSourcesView | null): TaskSourcesState {
  return {
    view,
    save: async () => true,
    sweep: async () => null,
    preflight: async () => null,
    forget: async () => {},
    error: null,
  };
}

function render(view: TaskSourcesView | null): string {
  return renderToStaticMarkup(createElement(TaskSourcesPanel, { state: mkState(view) }));
}

const viewOf = (sources: TaskSourceInstance[], status: TaskSourcesView["status"] = []) => ({
  sources,
  status,
  kinds: KINDS,
});

// The claim the whole feature rests on, and the one an operator cannot verify from the
// controls. If this sentence ever goes, the panel is asking for consent to something it
// has stopped describing.
test("the panel says a source never dispatches, provisions or types", () => {
  const html = render(viewOf([]));
  assert.match(html, /never dispatches an agent/);
  assert.match(html, /never cuts a worktree/);
  assert.match(html, /never types into a session/);
});

// The other half of the bargain: a task you delete stays deleted, which is what makes the
// backlog a list you can say no to rather than one that refills behind you.
test("the panel says a deleted task stays deleted", () => {
  assert.match(render(viewOf([])), /a task you\s*delete stays deleted/);
});

// A static render is the pre-poll state. Drawing an empty list there tells an operator
// that nothing is being swept, while the stored config may be sweeping four things.
test("with no answer from the daemon, the panel says so rather than drawing an empty list", () => {
  const html = render(null);
  assert.match(html, /ts-unknown/);
  assert.match(html, /is unknown/);
  assert.doesNotMatch(html, /No sources yet/, "an unanswered panel must not assert emptiness");
});

// The answered-and-genuinely-empty case, which is a different sentence.
test("an answered, empty config says nothing is being swept", () => {
  const html = render(viewOf([]));
  assert.match(html, /No sources yet - nothing is being swept/);
  assert.doesNotMatch(html, /ts-unknown/);
});

test("a configured source is a compact overview row with its health", () => {
  const html = render(viewOf([mkSource()]));
  assert.match(html, /widgets bugs/);
  assert.match(html, /GitHub issues/);
  assert.match(html, /Paused/);
  assert.match(html, /Configured task sources/);
});

// "Never swept" and "swept, found nothing" are the two states most easily confused, and
// the confusion is expensive: the first can mean broken since setup.
test("the overview counts a never-swept enabled source as running rather than failing", () => {
  const html = render(
    viewOf([mkSource({ enabled: true })], [
      { sourceId: "src-1", lastSweepAt: null, lastError: null, lastFiled: 0, seenCount: 0, sweeping: false },
    ]),
  );
  assert.match(html, /running normally/);
  assert.match(html, /Enabled 1/);
});

test("a sweep that found nothing remains healthy in the overview", () => {
  const html = render(
    viewOf([mkSource({ enabled: true })], [
      {
        sourceId: "src-1",
        lastSweepAt: Date.now() - 120_000,
        lastError: null,
        lastFiled: 0,
        seenCount: 4,
        sweeping: false,
      },
    ]),
  );
  assert.match(html, /Healthy/);
  assert.match(html, /Enabled 1/);
});

// A failing source has to be legible as failing. Without this it reads as a source that
// keeps finding nothing, which is what a healthy quiet one looks like.
test("a failed sweep is shown in the attention summary and row", () => {
  const html = render(
    viewOf([mkSource({ enabled: true })], [
      {
        sourceId: "src-1",
        lastSweepAt: Date.now() - 60_000,
        lastError: "gh is not authenticated - run `gh auth login`",
        lastFiled: 0,
        seenCount: 0,
        sweeping: false,
      },
    ]),
  );
  assert.match(html, /need attention/);
  assert.match(html, /Attention:.*1 source had a failed sweep/);
  assert.match(html, /Failed/);
});

test("the overview exposes filtering and an add-source entry point", () => {
  const html = render(viewOf([]));
  assert.match(html, /\+ Add source/);
  assert.match(html, /No sources yet - nothing is being swept/);
});
