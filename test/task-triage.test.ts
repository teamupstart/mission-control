import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LABEL_MAX,
  MAX_LABELS,
  TASK_PRIORITIES,
  byPriorityThenAge,
  normalizeLabels,
  priorityRank,
} from "../src/shared/task.ts";
import { backlogTasks } from "../src/shared/session.ts";
import { DispatchSchema, UpdateTaskSchema } from "../src/shared/protocol.ts";
import { mkTask } from "./helpers/session-fixture.ts";

/**
 * What is at stake: priority and labels are OPTIONAL fields bolted onto a type that
 * every existing task already has rows for, and the whole design rests on "unset" being
 * a real, distinct answer rather than a synonym for `low` or for `[]`.
 *
 * Two ways that goes wrong and neither would fail a typecheck. If unset sorted to the
 * bottom, one task marked `low` would outrank an entire untriaged backlog and the
 * board's order would change for everyone on upgrade. And if label cleaning lived
 * anywhere but the schema, a task source writing without a human in the loop could put
 * duplicates, whitespace and an unbounded list onto a card. These pin both.
 */

test("priority ranks ascending, with unset between low and med", () => {
  // The load-bearing claim: `low` is an explicit demotion BELOW the default, so an
  // untriaged task outranks one somebody deliberately deprioritised.
  assert.ok(priorityRank(null) > priorityRank("low"));
  assert.ok(priorityRank(null) < priorityRank("med"));
  // And the named levels stay in the order the array declares them.
  const ranks = TASK_PRIORITIES.map(priorityRank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  assert.equal(new Set(ranks).size, ranks.length, "no two priorities may share a rank");
});

test("an untriaged backlog keeps the oldest-first order it always had", () => {
  // The upgrade case: nobody has set a priority, so nothing may reorder.
  const tasks = [
    mkTask({ id: "c", createdAt: 300 }),
    mkTask({ id: "a", createdAt: 100 }),
    mkTask({ id: "b", createdAt: 200 }),
  ];
  assert.deepEqual(
    backlogTasks(tasks).map((t) => t.id),
    ["a", "b", "c"],
  );
});

test("the backlog sorts urgent first, then oldest first within a priority", () => {
  const tasks = [
    mkTask({ id: "old-low", createdAt: 100, priority: "low" }),
    mkTask({ id: "new-blocker", createdAt: 900, priority: "blocker" }),
    mkTask({ id: "untriaged", createdAt: 200 }),
    mkTask({ id: "older-high", createdAt: 300, priority: "high" }),
    mkTask({ id: "newer-high", createdAt: 400, priority: "high" }),
  ];
  assert.deepEqual(
    backlogTasks(tasks).map((t) => t.id),
    ["new-blocker", "older-high", "newer-high", "untriaged", "old-low"],
  );
});

test("the backlog projection still filters to backlog status", () => {
  // Priority must not smuggle a running task into the column: a `blocker` that is
  // already dispatched belongs on its agent's card, not back in the supply.
  const tasks = [
    mkTask({ id: "running", status: "running", priority: "blocker" }),
    mkTask({ id: "waiting", status: "backlog" }),
  ];
  assert.deepEqual(
    backlogTasks(tasks).map((t) => t.id),
    ["waiting"],
  );
});

test("byPriorityThenAge is a total order - equal tasks compare equal", () => {
  const a = mkTask({ id: "a", createdAt: 5, priority: "med" });
  const b = mkTask({ id: "b", createdAt: 5, priority: "med" });
  assert.equal(byPriorityThenAge(a, b), 0);
  // Antisymmetry, compared by SIGN: swapping the arguments of a comparator that
  // returned 0 gives -0, which `assert.equal` treats as a different value.
  const c = mkTask({ id: "c", createdAt: 9, priority: "blocker" });
  assert.equal(Math.sign(byPriorityThenAge(a, c)), -Math.sign(byPriorityThenAge(c, a)));
  // `===` rather than assert.equal, which distinguishes -0 from 0 and would fail on a
  // comparator that is behaving correctly.
  assert.ok(byPriorityThenAge(b, a) === 0, "equal tasks must compare equal both ways");
});

test("normalizeLabels trims, drops empties, and dedupes case-insensitively", () => {
  assert.deepEqual(normalizeLabels(["  bug ", "", "   ", "perf"]), ["bug", "perf"]);
  // First spelling wins, so a tag swept from an external system keeps the case it
  // was authored with rather than being lowercased into something that no longer
  // matches the issue it came from.
  assert.deepEqual(normalizeLabels(["Type: Bug", "type: bug", "TYPE: BUG"]), ["Type: Bug"]);
});

test("normalizeLabels caps both the label length and the list length", () => {
  const long = "x".repeat(LABEL_MAX + 20);
  assert.equal(normalizeLabels([long])[0]?.length, LABEL_MAX);
  const many = Array.from({ length: MAX_LABELS + 10 }, (_, i) => `l${i}`);
  assert.equal(normalizeLabels(many).length, MAX_LABELS);
});

test("normalizeLabels is idempotent - running it twice changes nothing", () => {
  // It runs on the way in (the schema) AND on the way out of the db, so a second pass
  // must be a no-op or a stored row would drift every time it was read.
  const once = normalizeLabels([" A ", "a", "b", "x".repeat(LABEL_MAX + 5)]);
  assert.deepEqual(normalizeLabels(once), once);
});

test("a dispatch with no triage fields parses to unset, not to defaults", () => {
  const parsed = DispatchSchema.parse({ repoRoot: "/repo", intent: "do it" });
  assert.equal(parsed.priority, null, "priority must be null, never a guessed level");
  assert.deepEqual(parsed.labels, []);
});

test("DispatchSchema normalizes labels itself, so no writer can bypass it", () => {
  // This is the guarantee that covers task sources, which have no human to tidy up
  // after them: the cleaning lives in the schema `parseBody` runs, not at a call site.
  const parsed = DispatchSchema.parse({
    repoRoot: "/repo",
    intent: "do it",
    labels: [" bug ", "BUG", "", "perf"],
  });
  assert.deepEqual(parsed.labels, ["bug", "perf"]);
});

test("DispatchSchema rejects an unknown priority rather than coercing it", () => {
  assert.equal(DispatchSchema.safeParse({ repoRoot: "/r", intent: "i", priority: "urgent" }).success, false);
  // …but null is explicitly allowed: it is how a caller says "no priority".
  assert.equal(DispatchSchema.parse({ repoRoot: "/r", intent: "i", priority: null }).priority, null);
});

test("DispatchSchema refuses an oversized label list instead of silently truncating it", () => {
  // Truncation would accept the POST and quietly drop tags the caller believes landed.
  const many = Array.from({ length: MAX_LABELS + 1 }, (_, i) => `l${i}`);
  assert.equal(DispatchSchema.safeParse({ repoRoot: "/r", intent: "i", labels: many }).success, false);
});

test("UpdateTaskSchema keeps absent and null apart", () => {
  // An absent key means "leave it"; an explicit null means "clear it back to unset".
  // TaskManager.update reads them with `in`, so the schema must not fill either one in.
  const cleared = UpdateTaskSchema.parse({ priority: null });
  assert.ok("priority" in cleared);
  assert.equal(cleared.priority, null);

  const labelsOnly = UpdateTaskSchema.parse({ labels: ["a"] });
  assert.equal("priority" in labelsOnly, false, "an omitted priority must not appear as null");
});

test("UpdateTaskSchema refuses an empty patch", () => {
  // A PATCH that says nothing would still bump updatedAt and re-emit over SSE.
  assert.equal(UpdateTaskSchema.safeParse({}).success, false);
});
