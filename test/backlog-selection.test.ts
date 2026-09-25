import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  EMPTY_BULK_DRAFT,
  boxFrom,
  boxesOverlap,
  bulkEditRequest,
  changedFieldCount,
  dependencyCounts,
  labelCounts,
  rangeBetween,
  resultingAgent,
  toggled,
  valueSummary,
} from "../src/web/lib/backlog-selection.ts";
import { bulkTaskPatch } from "../src/shared/task-bulk.ts";
import { BacklogColumn } from "../src/web/components/layouts/BacklogColumn.tsx";
import { mkTask } from "./helpers/session-fixture.ts";
import type { TaskDependency } from "../src/shared/types.ts";

const edge = (taskId: string, title = taskId): TaskDependency => ({
  type: "task",
  taskId,
  title,
  sessionId: null,
  episodeId: null,
  agentSessionId: null,
  branch: null,
  prUrl: null,
  selectedAt: 1,
  satisfiedAt: null,
});

test("a shift-click range runs in column order whichever way it was clicked", () => {
  const order = ["a", "b", "c", "d", "e"];
  assert.deepEqual(rangeBetween(order, "b", "d"), ["b", "c", "d"]);
  assert.deepEqual(rangeBetween(order, "d", "b"), ["b", "c", "d"]);
  assert.deepEqual(rangeBetween(order, "c", "c"), ["c"]);
  // No anchor yet, or one that has left the column, takes only the clicked card.
  assert.deepEqual(rangeBetween(order, null, "c"), ["c"]);
  assert.deepEqual(rangeBetween(order, "gone", "c"), ["c"]);
  assert.deepEqual(rangeBetween(order, "a", "gone"), []);
});

test("toggling returns a new set with the id flipped", () => {
  const start = new Set(["a"]);
  const on = toggled(start, "b");
  assert.deepEqual([...on].sort(), ["a", "b"]);
  assert.deepEqual([...toggled(on, "a")], ["b"]);
  assert.deepEqual([...start], ["a"], "the input set is not mutated");
});

test("the marquee box is the same whichever direction it is dragged", () => {
  assert.deepEqual(boxFrom(10, 40, 2, 5), { left: 2, top: 5, right: 10, bottom: 40 });
  const card = { left: 0, top: 100, right: 200, bottom: 160 };
  assert.equal(boxesOverlap(boxFrom(50, 90, 60, 110), card), true);
  assert.equal(boxesOverlap(boxFrom(50, 20, 60, 99), card), false);
});

test("a summary says 'all' when the selection agrees and counts it when it does not", () => {
  assert.equal(valueSummary(["High", "High"]), "all High");
  assert.equal(valueSummary(["Medium", "unset", "Medium"]), "Medium ×2, unset ×1");
  assert.equal(valueSummary([]), "");
});

test("labels and prerequisites are counted across the selection", () => {
  const tasks = [
    mkTask({ id: "a", labels: ["sources", "jira"], dependencies: [edge("p", "Prereq")] }),
    mkTask({ id: "b", labels: ["Sources"], dependencies: [edge("p", "Prereq")] }),
  ];
  assert.deepEqual(labelCounts(tasks), [
    { label: "sources", count: 2 },
    { label: "jira", count: 1 },
  ]);
  assert.deepEqual(dependencyCounts(tasks), [
    { input: { type: "task", taskId: "p" }, title: "Prereq", count: 2 },
  ]);
});

test("model and effort are offered against one agent only", () => {
  const mixed = [mkTask({ id: "a", agent: "claude" }), mkTask({ id: "b", agent: "codex" })];
  assert.equal(resultingAgent(mixed, EMPTY_BULK_DRAFT), null);
  assert.equal(resultingAgent(mixed, { ...EMPTY_BULK_DRAFT, agent: "codex" }), "codex");
  const same = [mkTask({ id: "a", agent: "pi" }), mkTask({ id: "b", agent: "pi" })];
  assert.equal(resultingAgent(same, EMPTY_BULK_DRAFT), "pi");
});

test("the request names only the fields the operator touched", () => {
  assert.equal(bulkEditRequest(["a"], EMPTY_BULK_DRAFT), null);
  assert.equal(bulkEditRequest([], { ...EMPTY_BULK_DRAFT, priority: "high" }), null);
  const draft = {
    ...EMPTY_BULK_DRAFT,
    priority: null,
    enabled: false,
    labelsAdd: ["q4"],
  };
  assert.equal(changedFieldCount(draft), 3);
  assert.deepEqual(bulkEditRequest(["a", "b"], draft), {
    taskIds: ["a", "b"],
    set: { priority: null, enabled: false },
    labels: { add: ["q4"], remove: [] },
  });
});

test("one task's share of a bulk edit resolves labels and prerequisites against its own lists", () => {
  const task = mkTask({ id: "t", labels: ["keep", "drop"], dependencies: [edge("old")] });
  const r = bulkTaskPatch(task, {
    set: { priority: "high" },
    labels: { add: ["new", "KEEP"], remove: ["DROP"] },
    dependencies: {
      add: [{ type: "task", taskId: "p" }, { type: "task", taskId: "t" }],
      remove: [{ type: "task", taskId: "old" }],
    },
  });
  assert.ok(r.ok);
  assert.deepEqual(r.patch, {
    priority: "high",
    labels: ["keep", "new"],
    // The task itself is never added as its own prerequisite.
    dependencies: [{ type: "task", taskId: "p" }],
  });
});

test("a share that changes nothing about a list leaves that key out", () => {
  const task = mkTask({ id: "t", labels: ["a"] });
  const r = bulkTaskPatch(task, { set: {}, labels: { add: ["A"], remove: ["missing"] } });
  assert.ok(r.ok);
  assert.deepEqual(r.patch, {});
});

test("every backlog card carries a labelled selection checkbox", () => {
  const html = renderToStaticMarkup(
    createElement(BacklogColumn, {
      tasks: [mkTask({ id: "a", title: "Fix the flaky test", status: "backlog" })],
      allTasks: [],
      plan: null,
      onAssignError: () => {},
      onDragging: () => {},
      onEdit: () => {},
    }),
  );
  assert.match(html, /role="checkbox"[^>]*aria-checked="false"[^>]*aria-label="Select &quot;Fix the flaky test&quot;"/);
  // Nothing is selected on first render, so there is no selection bar.
  assert.doesNotMatch(html, /Selected backlog tasks/);
});
