import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PushDraft,
  PushResult,
  TaskSourceInstance,
  TaskSourceRef,
} from "../src/shared/task-source.ts";
import type { Task } from "../src/shared/types.ts";
// `import type` only - it is erased, so it cannot pull the server modules in ahead of the
// HARNESS_HOME preamble below the way a value import would.
import type { PushDeps } from "../src/server/task-sources/push.ts";
import { mkTask } from "./helpers/session-fixture.ts";

// What is at stake: this is the outward twin of `ingest.ts`, and the direction where a
// mistake is published to a tracker other people read and cannot be taken back by deleting
// a row here. Three claims carry the whole feature, and each has its own test below:
//
//   1. A refusal and an UNKNOWN OUTCOME are not the same answer. `gh` refusing means
//      nothing was published, so a retry is safe; `gh` never reporting back means the
//      issue MAY exist, so a retry files a duplicate into somebody else's tracker.
//   2. The seen row and the task link land TOGETHER. A link with no seen row means the
//      next sweep re-files the very issue this push just created, as a second backlog task.
//   3. Nothing is written when nothing was created, and nothing is spawned when a local
//      guard can already say no.
//
// Real db, because claims 2 and 3 are about rows: a fake that counted calls could not tell
// a committed seen row from an intended one. The state dir is redirected BEFORE anything
// that resolves it is imported (`openDb` refuses the operator's real dir under the test
// runner, so getting this wrong fails loudly instead of wiping live settings).

const home = mkdtempSync(join(tmpdir(), "mission-task-push-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb, countTaskSourceSeen, getTask, recordTaskSourceSeen, inTransaction } =
  await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { pushTask } = await import("../src/server/task-sources/push.ts");

after(() => rmSync(home, { recursive: true, force: true }));

beforeEach(() => {
  openDb().exec("DELETE FROM tasks; DELETE FROM task_source_seen;");
});

/** A github-issues source filing against `/repo`, everything else at its shipped default. */
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

const REF: TaskSourceRef = {
  sourceId: "src-1",
  externalId: "acme/demo#7",
  url: "https://github.com/acme/demo/issues/7",
};

const created: PushResult = { ref: REF, error: null, outcomeUnknown: false };
const refused: PushResult = {
  ref: null,
  error: "gh issue create failed: could not add label: 'triage' not found",
  outcomeUnknown: false,
};
const unknown: PushResult = {
  ref: null,
  error: "gh issue create did not report back - the issue may exist; check GitHub before retrying",
  outcomeUnknown: true,
};

/** A push implementation that records what it was asked to publish. */
function spy(result: PushResult | (() => Promise<PushResult>)) {
  const calls: PushDraft[] = [];
  const push: NonNullable<PushDeps["push"]> = async (_inst, draft) => {
    calls.push(draft);
    return typeof result === "function" ? await result() : result;
  };
  return { push, calls };
}

function setup(over: Partial<Task> = {}) {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const task = mkTask({
    id: "t1",
    title: "Fix the parser",
    intent: "the parser drops trailing commas",
    status: "backlog",
    repoRoot: "/repo",
    ...over,
  });
  registry.upsertTask(task);
  return { registry, tasks, task };
}

// ---- the local guards: refused before anything is spawned ----
//
// "Before anything is spawned" is the property, not "refused". Each of these is also
// re-checked under the transaction, but asking here first is what guarantees that a
// refusal published nothing - which is the only reason a caller may safely retry one.

test("a kind with no outward verb is refused, and nothing is asked to publish", async () => {
  const { tasks, task } = setup();
  const s = spy(created);
  const r = await pushTask(mkSource({ kind: "jira" }), task, tasks, { push: s.push });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.kind, "unpushable");
  assert.match(r.ok === false ? r.error : "", /jira cannot receive pushed tasks/);
  assert.deepEqual(s.calls, [], "a kind that cannot push was asked to push");
});

test("a task that has left the backlog is refused, and nothing is asked to publish", async () => {
  const { tasks, task } = setup({ status: "running" });
  const s = spy(created);
  const r = await pushTask(mkSource(), task, tasks, { push: s.push });
  assert.equal(r.ok === false && r.kind, "conflict");
  assert.match(r.ok === false ? r.error : "", /task is running, not in the backlog/);
  assert.deepEqual(s.calls, []);
});

// A second issue for a task that already has one is the duplicate this whole file is
// about, arriving by the most ordinary route: two clicks.
test("a task already linked upstream is refused, and nothing is asked to publish", async () => {
  const { tasks, task } = setup({ source: REF });
  const s = spy(created);
  const r = await pushTask(mkSource(), task, tasks, { push: s.push });
  assert.equal(r.ok === false && r.kind, "conflict");
  assert.match(r.ok === false ? r.error : "", /already linked to acme\/demo#7/);
  assert.deepEqual(s.calls, []);
});

// Exact string equality on two values that were BOTH resolved to a git root when stored.
// Re-resolving here would consult a filesystem that may have moved since, and could refuse
// a pair the UI - which cannot run git - had every reason to offer.
test("a source bound to another repo is refused, and nothing is asked to publish", async () => {
  const { tasks, task } = setup({ repoRoot: "/other" });
  const s = spy(created);
  const r = await pushTask(mkSource(), task, tasks, { push: s.push });
  assert.equal(r.ok === false && r.kind, "conflict");
  assert.match(r.ok === false ? r.error : "", /files against \/repo.*based on \/other/);
  assert.deepEqual(s.calls, []);
});

test("the draft carries the task's saved title and intent, and nothing else", async () => {
  const { tasks, task } = setup();
  const s = spy(created);
  await pushTask(mkSource(), task, tasks, { push: s.push });
  assert.deepEqual(s.calls, [
    { title: "Fix the parser", intent: "the parser drops trailing commas" },
  ]);
});

// ---- refusal vs unknown outcome: the distinction that prevents a double-created issue ----

test("an upstream refusal writes nothing at all", async () => {
  const { tasks, task } = setup();
  const r = await pushTask(mkSource(), task, tasks, { push: spy(refused).push });
  assert.equal(r.ok === false && r.kind, "upstream");
  assert.match(r.ok === false ? r.error : "", /'triage' not found/);
  assert.equal(countTaskSourceSeen("src-1"), 0, "a refusal published nothing to remember");
  assert.equal(getTask("t1")!.source, null);
});

// The same shape of failure, the opposite conclusion. If this ever collapses into the test
// above, a retry files a second issue.
test("an unknown outcome writes nothing, and is NOT reported as a refusal", async () => {
  const { tasks, task } = setup();
  const r = await pushTask(mkSource(), task, tasks, { push: spy(unknown).push });
  assert.equal(r.ok === false && r.kind, "unknown-outcome");
  assert.notEqual(r.ok === false && r.kind, "upstream");
  assert.match(r.ok === false ? r.error : "", /check GitHub before retrying/);
  // Deliberately no seen row: a sweep is the operator's best way of finding out whether the
  // issue actually exists, and suppressing it would take that away.
  assert.equal(countTaskSourceSeen("src-1"), 0);
  assert.equal(getTask("t1")!.source, null);
});

// A throw is not a `PushResult`, so it carries no `outcomeUnknown` to read - and letting it
// escape into the route would deliver a generic failure a caller cannot tell from a
// retry-safe refusal. Unknown rather than refused because an exception out of the seam says
// nothing about which side of the request it fell on; assuming "nothing was published" here
// is the one optimistic default this feature cannot afford.
test("a push that THROWS is an unknown outcome, never an escaped exception", async () => {
  const { tasks, task } = setup();
  const r = await pushTask(mkSource(), task, tasks, {
    push: async () => {
      throw new Error("spawn EAGAIN");
    },
  });
  assert.equal(r.ok === false && r.kind, "unknown-outcome");
  assert.notEqual(r.ok === false && r.kind, "upstream", "a throw was read as retry-safe");
  assert.match(r.ok === false ? r.error : "", /spawn EAGAIN/);
  assert.match(r.ok === false ? r.error : "", /may exist/);
  assert.equal(countTaskSourceSeen("src-1"), 0);
  assert.equal(getTask("t1")!.source, null);
});

test("a push that throws still releases its claim, so the task is not wedged", async () => {
  const { tasks, task } = setup();
  await pushTask(mkSource(), task, tasks, {
    push: async () => {
      throw new Error("spawn EAGAIN");
    },
  });
  const after = await pushTask(mkSource(), task, tasks, { push: spy(created).push });
  assert.equal(after.ok, true);
});

test("a result with neither an item nor an error is still a refusal, never a success", async () => {
  const { tasks, task } = setup();
  const r = await pushTask(mkSource(), task, tasks, {
    push: spy({ ref: null, error: null, outcomeUnknown: false }).push,
  });
  assert.equal(r.ok === false && r.kind, "upstream");
  assert.equal(getTask("t1")!.source, null);
});

// ---- the pair that must land together ----

test("a success records the seen row and the link, in that order, in ONE transaction", async () => {
  const { registry, tasks, task } = setup();
  const order: string[] = [];
  // The link is observed through the registry's own event, which `upsertTask` emits
  // synchronously - so its position in this list is the position of the actual write.
  const off = registry.subscribe((e) => {
    if (e.type === "task_upsert" && e.task.source) order.push("link");
  });
  const r = await pushTask(mkSource(), task, tasks, {
    push: spy(created).push,
    remember: (sourceId, externalId, url) => {
      order.push("remember");
      recordTaskSourceSeen(sourceId, externalId, url);
    },
    transaction: (fn) => {
      order.push("begin");
      const out = inTransaction(fn);
      order.push("commit");
      return out;
    },
  });
  off();
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.task.source, REF);
  // Remember FIRST: from the moment the issue exists, stopping the re-sweep matters more
  // than the link, and this is the order the moved-mid-push case below depends on.
  assert.deepEqual(order, ["begin", "remember", "link", "commit"]);
  // Both writes really landed, in the database the sweep reads.
  assert.equal(countTaskSourceSeen("src-1"), 1);
  assert.deepEqual(getTask("t1")!.source, REF);
  assert.equal(getTask("t1")!.status, "backlog", "the task stays in the backlog");
});

// A task the operator launched during the two seconds `gh` was running still takes the
// link. The issue was created FOR it, and `source` is a record of something that happened
// rather than a provisioning field - so refusing on status here would throw away the
// identity of a real issue, and with it the "already linked" guard that stops a later push
// (after a cancel and a reschedule) filing a second one.
test("a task dispatched mid-push still gets its link - provenance is not provisioning", async () => {
  const { registry, tasks, task } = setup();
  const r = await pushTask(mkSource(), task, tasks, {
    push: async () => {
      // What an operator clicking Launch while `gh` is running does.
      registry.upsertTask({ ...task, status: "running", updatedAt: Date.now() });
      return created;
    },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(getTask("t1")!.source, REF, "the created issue's identity was thrown away");
  assert.equal(getTask("t1")!.status, "running", "the push did not move the task back");
  assert.equal(countTaskSourceSeen("src-1"), 1);
});

// THE deliberate exception, and the only place the pair comes apart: there is no row left
// to link. The seen row still commits, because otherwise this source's next sweep files the
// very issue this push just created as a brand-new backlog task.
test("a task deleted mid-push keeps its seen row, and the answer names the issue", async () => {
  const { registry, tasks, task } = setup();
  const r = await pushTask(mkSource(), task, tasks, {
    push: async () => {
      registry.removeTask(task.id);
      return created;
    },
  });
  assert.equal(r.ok === false && r.kind, "conflict");
  assert.match(r.ok === false ? r.error : "", /created acme\/demo#7/);
  assert.match(r.ok === false ? r.error : "", /will not be re-swept/);
  assert.equal(countTaskSourceSeen("src-1"), 1, "the issue this push created could be re-swept");
});

// A commit that fails after the issue exists is the one case where "retry" is the wrong
// advice even though nothing here was written - so it reports as an unknown outcome (504),
// never as a retry-safe refusal (502).
test("a transaction that fails after the issue exists refuses to look retry-safe", async () => {
  const { tasks, task } = setup();
  const r = await pushTask(mkSource(), task, tasks, {
    push: spy(created).push,
    transaction: () => {
      throw new Error("database is locked");
    },
  });
  assert.equal(r.ok === false && r.kind, "unknown-outcome");
  assert.match(r.ok === false ? r.error : "", /created acme\/demo#7/);
  assert.match(r.ok === false ? r.error : "", /do not push again/);
  assert.equal(countTaskSourceSeen("src-1"), 0);
  assert.equal(getTask("t1")!.source, null);
});

// Two concurrent pushes both pass the "already linked" guard - the first has not linked
// anything yet, because `gh` is still running - and both create an issue. The DB cannot
// catch that: the second issue is a genuinely new external item. The window has to close
// before the subprocess.
test("a second push of the same task, while one is in flight, is refused", async () => {
  const { tasks, task } = setup();
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let publishes = 0;
  const push: NonNullable<PushDeps["push"]> = async () => {
    publishes += 1;
    await gate;
    return created;
  };
  const first = pushTask(mkSource(), task, tasks, { push });
  const second = await pushTask(mkSource(), task, tasks, { push });
  assert.equal(second.ok === false && second.kind, "conflict");
  assert.match(second.ok === false ? second.error : "", /already running/);
  release();
  assert.equal((await first).ok, true);
  assert.equal(publishes, 1, "two issues were created for one task");
});

test("the claim is released when a push fails, so a retry is possible", async () => {
  const { tasks, task } = setup();
  const firstTry = await pushTask(mkSource(), task, tasks, { push: spy(refused).push });
  assert.equal(firstTry.ok === false && firstTry.kind, "upstream");
  const secondTry = await pushTask(mkSource(), task, tasks, { push: spy(created).push });
  assert.equal(secondTry.ok, true);
});

// ---- attachSource, against the real database ----

test("attachSource persists the ref and re-emits the task, with no new event type", () => {
  const { registry, tasks } = setup();
  const seen: Task[] = [];
  const off = registry.subscribe((e) => {
    if (e.type === "task_upsert") seen.push(e.task);
  });
  const r = tasks.attachSource("t1", REF);
  off();
  assert.equal(r.ok, true);
  assert.deepEqual(r.task!.source, REF);
  // The three columns the db upsert already wrote for swept tasks, now written for one born
  // here - read back from SQLite rather than from the in-memory registry.
  assert.deepEqual(getTask("t1")!.source, REF);
  assert.equal(seen.length, 1, "the link reached the dashboard over `task_upsert`");
  assert.deepEqual(seen[0]!.source, REF);
});

test("attachSource refuses rather than throws - a throw would roll the seen row back", () => {
  const { tasks, registry, task } = setup();
  assert.deepEqual(tasks.attachSource("nope", REF), { ok: false, error: "no such task" });

  registry.upsertTask({ ...task, source: REF, updatedAt: Date.now() });
  const linked = tasks.attachSource("t1", {
    sourceId: "src-1",
    externalId: "acme/demo#8",
    url: null,
  });
  assert.equal(linked.ok, false);
  assert.match(linked.error!, /already linked to acme\/demo#7/);
  assert.deepEqual(getTask("t1")!.source, REF, "the second push overwrote the first issue");
});

// Status is deliberately NOT a guard here, unlike on `update`. A dispatched task's title
// and repo were cut into a branch name and a terminal home, so rewriting them changes the
// card without propagating; nothing is provisioned from `source`.
test("attachSource records provenance whatever the task's status", () => {
  const { tasks, registry, task } = setup();
  registry.upsertTask({ ...task, status: "done", updatedAt: Date.now() });
  const r = tasks.attachSource("t1", REF);
  assert.equal(r.ok, true);
  assert.deepEqual(getTask("t1")!.source, REF);
  assert.equal(getTask("t1")!.status, "done");
});
