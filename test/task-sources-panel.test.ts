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

test("a configured source renders with its switch OFF until it is turned on", () => {
  const html = render(viewOf([mkSource()]));
  assert.match(html, /widgets bugs/);
  const toggle = (html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [])[0];
  assert.ok(toggle, "the source has an enable switch");
  assert.doesNotMatch(toggle, /checked/);
});

// "Never swept" and "swept, found nothing" are the two states most easily confused, and
// the confusion is expensive: the first can mean broken since setup.
test("a never-swept source says so, rather than reporting a clean empty sweep", () => {
  const html = render(
    viewOf([mkSource()], [
      { sourceId: "src-1", lastSweepAt: null, lastError: null, lastFiled: 0, seenCount: 0, sweeping: false },
    ]),
  );
  assert.match(html, /Never swept yet/);
  assert.doesNotMatch(html, /filed nothing new/);
});

test("a sweep that found nothing says that instead", () => {
  const html = render(
    viewOf([mkSource()], [
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
  assert.match(html, /filed nothing new/);
  assert.match(html, /4 item\(s\) already filed/);
  assert.doesNotMatch(html, /Never swept yet/);
});

// A failing source has to be legible as failing. Without this it reads as a source that
// keeps finding nothing, which is what a healthy quiet one looks like.
test("a failed sweep is shown as a failure, not as a quiet one", () => {
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
  assert.match(html, /ts-status-failed/);
  assert.match(html, /gh is not authenticated/);
});

// The pair that selects nothing is refused by the schema, so the panel must not offer a
// shape that can express it - hence one radio group rather than two checkboxes.
test("the assignee filter is a single choice, so the empty-selection pair is unreachable", () => {
  const html = render(viewOf([mkSource()]));
  const radios = (html.match(/<input[^>]*type="radio"[^>]*name="ts-assignee"[^>]*>/g) ?? []);
  assert.equal(radios.length, 3, "anyone / assigned to me / unassigned");
  assert.equal(radios.filter((r) => r.includes("checked")).length, 1);
});

// "Forget seen items" is the only thing that undoes a delete, and offering it on a source
// that has filed nothing would promise an effect it cannot have.
test("Forget seen items is offered, and disabled while there is nothing to forget", () => {
  const empty = render(
    viewOf([mkSource()], [
      { sourceId: "src-1", lastSweepAt: null, lastError: null, lastFiled: 0, seenCount: 0, sweeping: false },
    ]),
  );
  assert.match(empty, /Forget seen items/);
  assert.match(empty, /<button[^>]*disabled[^>]*>Forget seen items<\/button>/);

  const filed = render(
    viewOf([mkSource()], [
      { sourceId: "src-1", lastSweepAt: 1, lastError: null, lastFiled: 2, seenCount: 2, sweeping: false },
    ]),
  );
  assert.match(filed, /<button[^>]*>Forget seen items<\/button>/);
});

// A sweep already in flight must not be startable a second time: two concurrent sweeps
// read the seen set separately and would file the same item twice.
test("Sweep now is disabled while a sweep is running", () => {
  const html = render(
    viewOf([mkSource({ enabled: true })], [
      { sourceId: "src-1", lastSweepAt: 1, lastError: null, lastFiled: 0, seenCount: 0, sweeping: true },
    ]),
  );
  assert.match(html, /Sweeping now…/);
  assert.match(html, /<button[^>]*disabled[^>]*>Sweep now<\/button>/);
});

test("the add control offers every kind this build registers", () => {
  const html = render(viewOf([]));
  for (const k of KINDS) assert.ok(html.includes(k.label), `add control missing ${k.label}`);
  assert.match(html, /Add a source/);
});
