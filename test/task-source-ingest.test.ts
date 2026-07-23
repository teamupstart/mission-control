import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SweepResult, TaskCandidate, TaskSourceInstance } from "../src/shared/task-source.ts";
import type { CreateTaskInput, TaskManager } from "../src/server/tasks.ts";
// `import type` only - it is erased, so it cannot pull `repos.ts` in ahead of the
// HARNESS_HOME preamble below the way a value import would.
import type { TaskRepoRoot } from "../src/server/repos.ts";
import { mkTask } from "./helpers/session-fixture.ts";

// What is at stake: this is the file that makes the task-source interface safe to hand
// out. A source that got de-duplication wrong would re-file the same issue every sweep,
// forever, and no amount of documentation makes that impossible - enforcing it in one
// place does. So the two claims below are the load-bearing ones:
//
//   1. A re-sweep of the same item files nothing.
//   2. An item whose TASK WAS DELETED still files nothing.
//
// The second is the whole reason `task_source_seen` is its own table rather than three
// columns on `tasks`. De-duplicating against live tasks would mean deleting a swept task
// un-sees it, so the next sweep files it again: the source becomes impossible to say no
// to, and the delete button becomes a snooze button that does not even snooze.
//
// Real db, so the seen rows genuinely outlive the tasks rather than being asserted about
// in a fake. The state dir is redirected BEFORE anything that resolves it is imported
// (the ui-config-store.test.ts preamble) - `openDb` refuses the operator's real dir under
// the test runner, so getting this wrong fails loudly instead of wiping live settings.

const home = mkdtempSync(join(tmpdir(), "mission-task-src-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb, deleteTask, getTask, listTasks, countTaskSourceSeen, forgetTaskSourceSeen } =
  await import("../src/server/db.ts");
const dbMod = await import("../src/server/db.ts");
const { ingestSweep } = await import("../src/server/task-sources/ingest.ts");

after(() => rmSync(home, { recursive: true, force: true }));

beforeEach(() => {
  openDb().exec("DELETE FROM tasks; DELETE FROM task_source_seen;");
});

/** A source that files against `/repo`, with everything else at its shipped default. */
function mkSource(over: Partial<TaskSourceInstance> = {}): TaskSourceInstance {
  return {
    id: "src-1",
    kind: "github-issues",
    label: "issues",
    enabled: true,
    repoRoot: "/repo",
    intervalMs: 900_000,
    defaults: { kind: "ship", agent: "claude", priority: null, labels: [] },
    maxPerSweep: 25,
    config: {},
    ...over,
  } as TaskSourceInstance;
}

function mkCandidate(over: Partial<TaskCandidate> = {}): TaskCandidate {
  return {
    ref: { sourceId: "src-1", externalId: "owner/repo#1", url: "https://example.test/1" },
    title: "Fix the thing",
    intent: "GitHub issue #1: Fix the thing\nhttps://example.test/1\n\nit is broken",
    repoRoot: "/repo",
    ...over,
  };
}

function sweep(items: TaskCandidate[], error: string | null = null): SweepResult {
  return { items, error };
}

/**
 * A TaskManager that really writes, so a "deleted" task is deleted from the same database
 * the seen rows live in. A fake that only counted calls could not tell the two tables
 * apart, which is exactly the distinction under test.
 */
function fakeTasks(): TaskManager {
  return {
    create(input: CreateTaskInput) {
      const task = mkTask({
        id: `t-${Math.random().toString(36).slice(2, 10)}`,
        title: input.title ?? "T",
        intent: input.intent,
        kind: input.kind,
        agent: input.agent,
        priority: input.priority ?? null,
        labels: input.labels ?? [],
        repoRoot: input.repoRoot,
        source: input.source ?? null,
        status: "backlog",
      });
      dbMod.upsertTask(task);
      return task;
    },
  } as unknown as TaskManager;
}

/**
 * `/repo` and its children are main checkouts; nothing else is. Stands in for the git
 * call, refusal sentence and all - the ingest loop reports whatever the resolver says,
 * so the stub returns the same shape rather than a boolean the loop would have to word.
 */
const resolveRepoRoot = async (p: string): Promise<TaskRepoRoot> =>
  p.startsWith("/repo")
    ? { ok: true, repoRoot: p }
    : { ok: false, error: `not a git repository: ${p}` };

const deps = { resolveRepoRoot };

test("a sweep files its items into the BACKLOG, never dispatched", async () => {
  const report = await ingestSweep(mkSource(), sweep([mkCandidate()]), fakeTasks(), deps);
  assert.equal(report.filed, 1);
  const [task] = listTasks();
  assert.equal(task!.status, "backlog");
  assert.equal(task!.worktreePath, null, "nothing was provisioned");
  assert.deepEqual(task!.source, {
    sourceId: "src-1",
    externalId: "owner/repo#1",
    url: "https://example.test/1",
  });
});

test("a re-sweep of the same item files nothing", async () => {
  const src = mkSource();
  const tasks = fakeTasks();
  await ingestSweep(src, sweep([mkCandidate()]), tasks, deps);
  const again = await ingestSweep(src, sweep([mkCandidate()]), tasks, deps);
  assert.equal(again.filed, 0);
  assert.equal(again.alreadySeen, 1);
  assert.equal(listTasks().length, 1);
});

// THE test. Delete the task the way an operator does, then sweep again: the item must
// stay gone. If this ever fails, the delete button has become a no-op.
test("an item whose task was DELETED still files nothing", async () => {
  const src = mkSource();
  const tasks = fakeTasks();
  await ingestSweep(src, sweep([mkCandidate()]), tasks, deps);
  const [filed] = listTasks();
  deleteTask(filed!.id);
  assert.equal(getTask(filed!.id), undefined, "the task really is gone");

  const again = await ingestSweep(src, sweep([mkCandidate()]), tasks, deps);
  assert.equal(again.filed, 0, "a deleted task was re-filed - delete has become a snooze");
  assert.equal(again.alreadySeen, 1);
  assert.equal(listTasks().length, 0);
  // The seen row outlived the task, which is why. It holds no reference to one.
  assert.equal(countTaskSourceSeen("src-1"), 1);
});

// The deliberate act that undoes the above, and the only one.
test("forgetting a source's seen items lets them be filed again", async () => {
  const src = mkSource();
  const tasks = fakeTasks();
  await ingestSweep(src, sweep([mkCandidate()]), tasks, deps);
  assert.equal(forgetTaskSourceSeen("src-1"), 1);
  const again = await ingestSweep(src, sweep([mkCandidate()]), tasks, deps);
  assert.equal(again.filed, 1);
});

// Dedupe is per source: two sources watching the same repo each file their own copy,
// because each keeps its own ledger. Sharing them would make removing one silence the other.
test("two sources do not inherit each other's seen items", async () => {
  const tasks = fakeTasks();
  await ingestSweep(mkSource({ id: "a" }), sweep([mkCandidate()]), tasks, deps);
  const b = await ingestSweep(mkSource({ id: "b" }), sweep([mkCandidate()]), tasks, deps);
  assert.equal(b.filed, 1);
});

// A paginated list that shifted between pages can hand back the same item twice in ONE
// sweep. Without the in-memory half of the dedupe, the second copy is filed as new.
test("a duplicate inside a single sweep is filed once", async () => {
  const report = await ingestSweep(
    mkSource(),
    sweep([mkCandidate(), mkCandidate()]),
    fakeTasks(),
    deps,
  );
  assert.equal(report.filed, 1);
  assert.equal(report.alreadySeen, 1);
});

test("a candidate whose repoRoot is not a git repo is refused, and stays fileable", async () => {
  const src = mkSource();
  const tasks = fakeTasks();
  const report = await ingestSweep(
    src,
    sweep([mkCandidate({ repoRoot: "/not-a-repo" })]),
    tasks,
    deps,
  );
  assert.equal(report.filed, 0);
  assert.equal(report.refused.length, 1);
  assert.match(report.refused[0]!, /not a git repository/);
  // Refused is not "seen": fix the repo and the next sweep files it.
  assert.equal(countTaskSourceSeen("src-1"), 0);
});

// Machine-authored tasks go through the same schema a typed one does, so a source cannot
// invent a priority level or flood a card with tags.
test("labels and priority go through the shared normalizer", async () => {
  await ingestSweep(
    mkSource({ defaults: { kind: "ship", agent: "claude", priority: "med", labels: ["swept"] } }),
    sweep([
      mkCandidate({
        labels: ["Type: Bug", "type: bug", "  ", "x".repeat(60)],
        priority: undefined,
      }),
    ]),
    fakeTasks(),
    deps,
  );
  const [task] = listTasks();
  // Case-insensitively deduped, first spelling kept (so a swept label still matches the
  // issue it came from), empties dropped, each one capped at 32 characters.
  assert.deepEqual(task!.labels, ["swept", "Type: Bug", "x".repeat(32)]);
  // The source's default applies where the candidate said nothing.
  assert.equal(task!.priority, "med");
});

test("a candidate that says `null` priority is not given the source's default", async () => {
  await ingestSweep(
    mkSource({ defaults: { kind: "ship", agent: "claude", priority: "high", labels: [] } }),
    sweep([mkCandidate({ priority: null })]),
    fakeTasks(),
    deps,
  );
  assert.equal(listTasks()[0]!.priority, null);
});

// A silent truncation reads as "that's all there was", which is the one thing a capped
// sweep must never say.
test("the maxPerSweep cap is reported, not silent - and the rest stay fileable", async () => {
  const logged: string[] = [];
  const src = mkSource({ maxPerSweep: 2 });
  const tasks = fakeTasks();
  const items = [1, 2, 3, 4, 5].map((n) =>
    mkCandidate({
      ref: { sourceId: "src-1", externalId: `owner/repo#${n}`, url: `https://example.test/${n}` },
    }),
  );
  const report = await ingestSweep(src, sweep(items), tasks, {
    ...deps,
    log: (m) => logged.push(m),
  });
  assert.equal(report.filed, 2);
  assert.equal(report.overCap, 3);
  assert.ok(
    logged.some((m) => /maxPerSweep/.test(m) && /3 left for the next sweep/.test(m)),
    `the drop was not logged: ${JSON.stringify(logged)}`,
  );
  // The three it did not take were never marked seen, so the next sweep picks them up.
  assert.equal(countTaskSourceSeen("src-1"), 2);
  const next = await ingestSweep(src, sweep(items), tasks, deps);
  assert.equal(next.filed, 2);
});

// An unreachable API means "unknown", not "there is no work" - so a failed sweep carries
// its error through and retracts nothing.
test("a failed sweep files nothing and keeps its error", async () => {
  const report = await ingestSweep(
    mkSource(),
    sweep([], "gh issue list failed: not authenticated"),
    fakeTasks(),
    deps,
  );
  assert.equal(report.filed, 0);
  assert.match(report.error!, /not authenticated/);
});

// A create that throws must leave the item neither filed nor seen, or a transient failure
// would swallow the issue permanently.
test("a failed create rolls its seen row back, so the next sweep retries", async () => {
  const src = mkSource();
  const exploding = {
    create() {
      throw new Error("db is on fire");
    },
  } as unknown as TaskManager;
  const first = await ingestSweep(src, sweep([mkCandidate()]), exploding, deps);
  assert.equal(first.filed, 0);
  assert.equal(first.refused.length, 1);
  assert.equal(countTaskSourceSeen("src-1"), 0, "a swallowed item would never be retried");

  const second = await ingestSweep(src, sweep([mkCandidate()]), fakeTasks(), deps);
  assert.equal(second.filed, 1);
});
