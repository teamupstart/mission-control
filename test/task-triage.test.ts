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
 * Two ways that goes wrong and neither would fail a typecheck. If unset ranked below
 * `low`, every surface that COMPARES urgency would say an untriaged task is less urgent
 * than one somebody deliberately deprioritised. And if label cleaning lived anywhere but
 * the schema, a task source writing without a human in the loop could put duplicates,
 * whitespace and an unbounded list onto a card. These pin both.
 *
 * Priority no longer ORDERS the backlog - `byBacklogRank` does, and the operator writes it
 * (`test/backlog-rank.test.ts`). What survives here is priority as annotation, and the
 * `byPriorityThenAge` comparator that the one-time `backlog_rank` backfill still runs.
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

test("the backlog is in RANK order, and priority does not move a card", () => {
  // The decision this whole feature turns on, stated as a test rather than as a comment:
  // a `blocker` ranked last stays last. An order a priority chip could rearrange is not
  // an order the operator set.
  const tasks = [
    mkTask({ id: "old-low", createdAt: 100, priority: "low", backlogRank: 1024 }),
    mkTask({ id: "new-blocker", createdAt: 900, priority: "blocker", backlogRank: 5120 }),
    mkTask({ id: "untriaged", createdAt: 200, backlogRank: 2048 }),
    mkTask({ id: "older-high", createdAt: 300, priority: "high", backlogRank: 3072 }),
    mkTask({ id: "newer-high", createdAt: 400, priority: "high", backlogRank: 4096 }),
  ];
  assert.deepEqual(
    backlogTasks(tasks).map((t) => t.id),
    ["old-low", "untriaged", "older-high", "newer-high", "new-blocker"],
  );
});

test("an unranked row sorts LAST, whatever its priority or its age", () => {
  // A row an older build wrote, or a restored one. It must not lead the column on the
  // strength of being old - the daemon repairs it (`normalizeBacklogRanks`), and until it
  // does the comparator has to put it where an unplaced arrival belongs.
  const tasks = [
    mkTask({ id: "unranked-blocker", createdAt: 1, priority: "blocker", backlogRank: null }),
    mkTask({ id: "ranked", createdAt: 900, backlogRank: 4096 }),
  ];
  assert.deepEqual(
    backlogTasks(tasks).map((t) => t.id),
    ["ranked", "unranked-blocker"],
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

// `byPriorityThenAge` orders nothing in the product any more; its ONE caller is the
// one-time `backlog_rank` backfill in `migrate()`, which numbers an upgrading operator's
// backlog in the order their board was already showing. That one call has to be right,
// which is why this stays.
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
  assert.deepEqual(parsed.dependencies, []);
});

test("task dependency inputs are bounded, typed, and deduplicated", () => {
  const input = { repoRoot: "/repo", intent: "do it" };
  assert.deepEqual(
    DispatchSchema.parse({ ...input, dependencies: [{ type: "task", taskId: "t1" }] }).dependencies,
    [{ type: "task", taskId: "t1" }],
  );
  assert.equal(
    DispatchSchema.safeParse({
      ...input,
      dependencies: [{ type: "task", taskId: "t1" }, { type: "task", taskId: "t1" }],
    }).success,
    false,
  );
  assert.equal(
    DispatchSchema.safeParse({ ...input, dependencies: [{ type: "session", taskId: "t1" }] }).success,
    false,
  );
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
