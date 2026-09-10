import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  TaskSourceInstance,
  WritebackNotice,
  WritebackResult,
} from "../src/shared/task-source.ts";
import type { Task, TaskRepoEntry } from "../src/shared/types.ts";
// `import type` only, as above - erased, so it cannot pull the server modules in ahead of
// the HARNESS_HOME preamble.
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
// `import type` only - erased, so it cannot pull the server modules in ahead of the
// HARNESS_HOME preamble below the way a value import would.
import type { WritebackDeps } from "../src/server/task-sources/writeback.ts";
import { mkTask } from "./helpers/session-fixture.ts";

// What is at stake: this is the direction where a mistake is published onto an item other
// people are watching, automatically and with nobody clicking anything. Five claims carry
// the feature, and each has its own group below:
//
//   1. NOTHING is written without per-source consent, and a task with no `source` produces
//      nothing at all - which is nearly every task in a normal installation.
//   2. The ledger key makes a re-observation free, while a task that reopens and completes
//      AGAIN gets a fresh delivery rather than being silently swallowed.
//   3. A refusal and an unknown outcome are not the same answer. A refusal backs off and
//      is eventually given up on; an unknown is never retried automatically, because a
//      retried transition can undo a person.
//   4. A resolve waits out a settle window and re-checks the live task, because
//      `reopenIfWorkResumed` can put a completed task back and closing an issue whose work
//      resumed is the one mistake here that a human has to undo by hand.
//   5. The payload is a snapshot, so a task deleted between observation and delivery still
//      reports what was true.
//
// Real db, because most of these are claims about ROWS: a fake that counted calls could
// not tell a committed ledger row from an intended one. The state dir is redirected BEFORE
// anything that resolves it is imported (`openDb` refuses the operator's real dir under the
// test runner, so getting this wrong fails loudly instead of writing to live state).

const home = mkdtempSync(join(tmpdir(), "mission-writeback-"));
process.env.HARNESS_HOME = join(home, "state");

const {
  openDb,
  closeDb,
  claimDueWritebacks,
  countWritebacks,
  discardWritebacks,
  enqueueWriteback,
  retryWritebacks,
  settleWriteback,
} = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
type TaskPrLinkedEvent = import("../src/server/registry.ts").TaskPrLinked;
const { backoffFor, drainWritebacks, makeWritebackEnqueuer, startWritebackWorker } =
  await import("../src/server/task-sources/writeback.ts");
const { TASK_SOURCES } = await import("../src/server/task-sources/index.ts");

after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => {
  openDb().exec("DELETE FROM tasks; DELETE FROM task_source_writeback;");
});

const NOW = 1_700_000_000_000;
const SETTLE = 300_000;

/** A github-issues source with the write-back switches this test needs, and nothing else. */
function mkSource(over: Partial<TaskSourceInstance> = {}): TaskSourceInstance {
  return {
    id: "src-1",
    kind: "github-issues",
    label: "issues",
    enabled: true,
    repoRoot: "/repo",
    intervalMs: 900_000,
    defaults: { kind: "ship", agent: "claude", priority: null, labels: [], enabled: false },
    maxPerSweep: 25,
    writeback: { onPrOpened: false, onCompleted: false, resolve: false },
    config: {},
    ...over,
  } as TaskSourceInstance;
}

/** A task swept from `acme/demo#7`, done, with a pull request. */
function mkSwept(over: Partial<Task> = {}): Task {
  return mkTask({
    id: "t1",
    title: "Fix the parser",
    status: "done",
    repoRoot: "/repo",
    outcome: "opened a pull request",
    outcomeUrl: "https://github.com/acme/demo/pull/9",
    completedAt: NOW,
    source: {
      sourceId: "src-1",
      externalId: "acme/demo#7",
      url: "https://github.com/acme/demo/issues/7",
    },
    ...over,
  });
}

/** An implementation that records what it was asked to write, and answers however told. */
function spy(result: WritebackResult) {
  const calls: WritebackNotice[] = [];
  const fn = async (
    _inst: TaskSourceInstance,
    notice: WritebackNotice,
  ): Promise<WritebackResult> => {
    calls.push(notice);
    return result;
  };
  return { fn, calls };
}

const delivered: WritebackResult = { error: null, outcomeUnknown: false, detail: "commented" };
const refused: WritebackResult = {
  error: "gh refused: Could not resolve to an Issue",
  outcomeUnknown: false,
  detail: null,
};
const unknown: WritebackResult = {
  error: "gh did not report back - the write may have landed",
  outcomeUnknown: true,
  detail: null,
};

/** The seams every test replaces: a fixed clock, a fixed config, a fake implementation. */
function deps(over: Partial<WritebackDeps> = {}): WritebackDeps {
  return { now: () => NOW, settleMs: SETTLE, log: () => {}, ...over };
}

/**
 * The same seams with the clock past the settle window.
 *
 * A completion's comment and its close both wait that window out, so a drain at `NOW` finds
 * neither. Tests about what a completion DELIVERS use this; tests about what it ENQUEUES do
 * not, because enqueue happens at the completion instant.
 */
function past(over: Partial<WritebackDeps> = {}): WritebackDeps {
  return deps({ now: () => NOW + SETTLE, ...over });
}

/** Every ledger row, oldest first. */
function rows(): Array<{
  id: number;
  action: string;
  signal: string;
  external_id: string;
  state: string;
  next_at: number;
  attempts: number;
  dedupe_key: string;
  last_error: string | null;
  last_detail: string | null;
}> {
  return openDb()
    .prepare(`SELECT * FROM task_source_writeback ORDER BY id`)
    .all() as never;
}

function setup(source: TaskSourceInstance | null, task: Task | null) {
  const registry = new Registry();
  if (task) registry.upsertTask(task);
  return { registry, sources: () => (source ? [source] : []) };
}

// ---- 1. consent, and the task that produces nothing ----
//
// "Before anything is enqueued" is the property, not "refused". A row that reaches the
// ledger is a row the worker will try to deliver, so each of these has to say no while the
// answer is still local, cheap and certain.

// The first line of both enqueue paths, and the reason this feature is invisible to people
// who do not use task sources at all.
test("a task that was never swept enqueues nothing", () => {
  const s = mkSource({ writeback: { onPrOpened: true, onCompleted: true, resolve: false } });
  const { registry, sources } = setup(s, mkSwept({ source: null }));
  makeWritebackEnqueuer(registry, deps({ sources })).completed(mkSwept({ source: null }));
  assert.deepEqual(rows(), []);
});

// The default, and therefore every source in every installation that predates this.
test("a source with every switch off enqueues nothing, on either trigger", () => {
  const s = mkSource();
  const task = mkSwept();
  const { registry, sources } = setup(s, task);
  const enq = makeWritebackEnqueuer(registry, deps({ sources }));
  enq.completed(task);
  enq.prLinked({
    taskId: task.id,
    repoRoot: "/repo",
    prUrl: "https://github.com/acme/demo/pull/9",
    observedAt: NOW,
  });
  assert.deepEqual(rows(), [], "a source nobody switched on wrote to the ledger");
});

test("each trigger is asked about separately", () => {
  const s = mkSource({ writeback: { onPrOpened: true, onCompleted: false, resolve: false } });
  const task = mkSwept();
  const { registry, sources } = setup(s, task);
  const enq = makeWritebackEnqueuer(registry, deps({ sources }));
  enq.completed(task);
  assert.deepEqual(rows(), [], "the completion trigger is off and a row was written anyway");
  enq.prLinked({
    taskId: task.id,
    repoRoot: "/repo",
    prUrl: "https://github.com/acme/demo/pull/9",
    observedAt: NOW,
  });
  assert.equal(rows().length, 1);
  assert.equal(rows()[0]!.signal, "pr-opened");
});

// A source removed between the sweep that filed the task and the completion that would
// write back. Its consent went with it.
test("a source that is no longer configured enqueues nothing", () => {
  const task = mkSwept();
  const { registry, sources } = setup(null, task);
  makeWritebackEnqueuer(registry, deps({ sources })).completed(task);
  assert.deepEqual(rows(), []);
});

// Asked through `canAnnotateTo` / `canResolveTo`, never by testing `inst.kind`: a build
// whose kind honestly cannot write back must not queue work it can never deliver.
//
// Both shipped kinds declare `true` as of Phase 2 of the write-back plan, so the state is
// reached by clearing the flags rather than by naming a kind that is in it. What is being
// pinned is the enqueuer asking the capability at all - which stays load-bearing for the
// next kind added, and for either of these two on a build that drops a verb. Restored in a
// `finally`, since the registry is shared with every test in this file.
test("a kind that cannot write back enqueues nothing even with the switches on", () => {
  const entry = TASK_SOURCES["jira"];
  const flags = { canAnnotate: entry.canAnnotate, canResolve: entry.canResolve };
  entry.canAnnotate = false;
  entry.canResolve = false;
  try {
    const s = mkSource({
      kind: "jira",
      writeback: { onPrOpened: true, onCompleted: true, resolve: true },
    });
    const task = mkSwept();
    const { registry, sources } = setup(s, task);
    makeWritebackEnqueuer(registry, deps({ sources })).completed(task);
    assert.deepEqual(rows(), []);
  } finally {
    Object.assign(entry, flags);
  }
});

// ---- 2. the ledger key ----

test("the same observation enqueued twice inserts once, and says which was first", () => {
  const s = mkSource({ writeback: { onPrOpened: true, onCompleted: false, resolve: false } });
  const task = mkSwept();
  const { registry, sources } = setup(s, task);
  const enq = makeWritebackEnqueuer(registry, deps({ sources }));
  const e = {
    taskId: task.id,
    repoRoot: "/repo",
    prUrl: "https://github.com/acme/demo/pull/9",
    observedAt: NOW,
  };
  enq.prLinked(e);
  enq.prLinked(e);
  enq.prLinked({ ...e, observedAt: NOW + 60_000 });
  assert.equal(rows().length, 1, "a re-observed pull request cost a second comment");

  // The boolean is what lets the chokepoint log a first observation without logging every
  // poller tick, so it has to be honest about which one this was.
  const notice: WritebackNotice = {
    signal: "pr-opened",
    action: "annotate",
    externalId: "acme/demo#7",
    externalUrl: null,
    taskTitle: "T",
    prUrl: "https://github.com/acme/demo/pull/9",
    repoRoot: "/repo",
    outcome: null,
    observedAt: NOW,
  };
  const row = {
    sourceId: "src-1",
    externalId: "acme/demo#7",
    signal: "pr-opened" as const,
    action: "annotate" as const,
    dedupeKey: "https://github.com/acme/demo/pull/9",
    taskId: "t1",
    notice,
    nextAt: NOW,
  };
  assert.equal(enqueueWriteback(row, NOW), false, "the existing row was reported as new");
  assert.equal(
    enqueueWriteback({ ...row, dedupeKey: "other" }, NOW),
    true,
    "a genuinely new delivery was reported as a duplicate",
  );
});

// A multi-repo task opened a pull request in each of its repositories, and the issue should
// name all of them. The per-repo emission is what makes that happen, and the url in the
// dedupe key is what keeps the two apart.
test("a multi-repo task owes one comment per pull request", () => {
  const s = mkSource({ writeback: { onPrOpened: true, onCompleted: false, resolve: false } });
  const task = mkSwept();
  const { registry, sources } = setup(s, task);
  const enq = makeWritebackEnqueuer(registry, deps({ sources }));
  enq.prLinked({
    taskId: task.id,
    repoRoot: "/repo",
    prUrl: "https://github.com/acme/demo/pull/9",
    observedAt: NOW,
  });
  enq.prLinked({
    taskId: task.id,
    repoRoot: "/other",
    prUrl: "https://github.com/acme/other/pull/3",
    observedAt: NOW,
  });
  assert.equal(rows().length, 2);
});

test("a completion with auto-resolve on owes the comment first and the close later", () => {
  const s = mkSource({ writeback: { onPrOpened: false, onCompleted: true, resolve: true } });
  const task = mkSwept();
  const { registry, sources } = setup(s, task);
  makeWritebackEnqueuer(registry, deps({ sources })).completed(task);

  const all = rows();
  assert.equal(all.length, 2);
  // The ordering is bought by the ids alone, which is what `claimDueWritebacks` reads -
  // no dependency machinery, and no half-delivered row.
  assert.equal(all[0]!.action, "annotate");
  assert.equal(all[1]!.action, "resolve");
  assert.ok(all[0]!.id < all[1]!.id);
  // BOTH wait the window out now. The comment asserts "finished", which a reversed
  // inference falsifies, so it is held for the same reason the close is - and the id
  // ordering still puts the comment first once they come due together.
  assert.equal(all[0]!.next_at, NOW + SETTLE, "the completion comment did not wait");
  assert.equal(all[1]!.next_at, NOW + SETTLE, "the resolve did not wait out the settle window");
});

// The correction this key exists for. `settleIfEpisodeFinished` concludes a task on an idle
// agent, `reopenIfWorkResumed` puts it back, and the task then completes again FOR REAL.
// Keyed on the task id alone, that second, genuine completion collides with the first
// cycle's row - whatever became of it - and `ON CONFLICT DO NOTHING` drops it in silence,
// so the issue is never resolved at all. Asserted against every reachable first-cycle
// state, because the collision does not care what became of the earlier row.
for (const first of ["delivered", "cancelled", "failed", "unknown"] as const) {
  test(`a reopened task that completes again owes a fresh pair (first cycle: ${first})`, () => {
    const s = mkSource({ writeback: { onPrOpened: false, onCompleted: true, resolve: true } });
    const task = mkSwept();
    const { registry, sources } = setup(s, task);
    const enq = makeWritebackEnqueuer(registry, deps({ sources }));

    enq.completed(task);
    for (const r of rows()) settleWriteback(r.id, first, {}, NOW);

    // Reopened, worked, and completed again - a genuinely different completion, at a
    // different instant.
    const again = { ...task, completedAt: NOW + 3_600_000 };
    registry.upsertTask(again);
    enq.completed(again);

    const all = rows();
    assert.equal(all.length, 4, "the second, genuine completion was swallowed as a duplicate");
    assert.equal(all.filter((r) => r.state === "pending").length, 2);
    assert.notEqual(all[0]!.dedupe_key, all[2]!.dedupe_key);
  });
}

// ---- 3. claiming ----

test("a tick claims at most one row per item, so the comment goes before the close", () => {
  const s = mkSource({ writeback: { onPrOpened: false, onCompleted: true, resolve: true } });
  const task = mkSwept();
  const { registry, sources } = setup(s, task);
  makeWritebackEnqueuer(registry, deps({ sources })).completed(task);

  // Past the settle window, so both rows are due and only the ordering decides.
  const due = claimDueWritebacks(NOW + SETTLE + 1, 20);
  assert.equal(due.length, 1);
  assert.equal(due[0]!.action, "annotate");
});

// The ordering this feature actually promises, and the case the per-item cap alone does NOT
// cover. `claimDueWritebacks` compares a row only against other rows that are pending AND
// due; a completion comment that was refused has its `next_at` pushed into the future by the
// backoff, so it drops out of that comparison entirely. Once the settle window expires the
// resolve is the only due row for the item, and without the state guard it is delivered
// first - closing somebody's issue with no explanation on the thread, and leaving the
// comment to arrive later or never.
test("a resolve is not claimed while its comment sits in a backoff longer than the settle window", async () => {
  const s = mkSource({ writeback: { onPrOpened: false, onCompleted: true, resolve: true } });
  const task = mkSwept();
  const { registry, sources } = setup(s, task);
  makeWritebackEnqueuer(registry, deps({ sources })).completed(task);

  // The comment is refused, so it backs off. One attempt is already 60s; the settle window
  // is 300s, so by attempt 5 the retry time is well past the resolve's due time.
  const annotate = spy(refused);
  const resolve = spy(delivered);
  let clock = NOW;
  const d = deps({ sources, annotate: annotate.fn, resolve: resolve.fn, now: () => clock });

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await drainWritebacks(registry, d);
    clock = rows()[0]!.next_at;
  }

  const [comment, close] = rows();
  assert.equal(comment!.state, "pending", "the comment gave up early");
  assert.ok(
    comment!.next_at > NOW + SETTLE,
    "the fixture did not reach a backoff past the settle window, so it proves nothing",
  );
  assert.equal(close!.state, "pending");
  assert.deepEqual(resolve.calls, [], "an issue was closed before its outcome comment landed");

  // The sharpest moment: past the resolve's settle window, but still inside the comment's
  // backoff. The resolve is the ONLY due row for this item, which is exactly the state the
  // per-item cap could not see, and the claim must still hand over nothing.
  const between = comment!.next_at - 1;
  assert.ok(between >= NOW + SETTLE, "the resolve is not yet due, so this proves nothing");
  assert.deepEqual(
    claimDueWritebacks(between, 20).map((r) => r.action),
    [],
    "the resolve was claimable while it was the only due row and its comment was unfinished",
  );

  // And when the comment does come due again, it is the one claimed - the close still waits.
  assert.deepEqual(claimDueWritebacks(comment!.next_at, 20).map((r) => r.action), ["annotate"]);
});

// The other half: once the comment lands, the resolve is released.
test("a resolve is released as soon as its comment is delivered", async () => {
  const s = mkSource({ writeback: { onPrOpened: false, onCompleted: true, resolve: true } });
  const task = mkSwept();
  const { registry, sources } = setup(s, task);
  makeWritebackEnqueuer(registry, deps({ sources })).completed(task);

  // Refused once, so the comment is pending with a future next_at.
  const annotate = spy(refused);
  await drainWritebacks(registry, past({ sources, annotate: annotate.fn }));
  assert.equal(rows()[0]!.state, "pending");
  // The refusal pushed the comment's next attempt a backoff beyond the settle window, so at
  // this instant the comment is not yet due and the resolve is - which is exactly the state
  // the guard exists for. Nothing is claimable.
  assert.deepEqual(
    claimDueWritebacks(NOW + SETTLE + 1, 20).map((r) => r.action),
    [],
    "the resolve was claimable while its comment was still owed",
  );
  // And when the comment does come due, it is the row claimed, not the close.
  assert.deepEqual(
    claimDueWritebacks(rows()[0]!.next_at, 20).map((r) => r.action),
    ["annotate"],
  );

  // The retry succeeds, and only then is the resolve released.
  const ok = spy(delivered);
  await drainWritebacks(
    registry,
    deps({ sources, annotate: ok.fn, now: () => rows()[0]!.next_at }),
  );
  assert.equal(rows()[0]!.state, "delivered");
  assert.deepEqual(
    claimDueWritebacks(NOW + SETTLE + 1, 20).map((r) => r.action),
    ["resolve"],
    "the resolve stayed blocked after its comment landed",
  );
});

// A comment that exhausted its retries is not a comment that landed, so the close stays
// held. The operator's Retry is what releases it, by letting the comment go out first -
// which is why a blocked resolve waits rather than being cancelled out of existence.
for (const state of ["failed", "unknown"] as const) {
  test(`a resolve stays held while its comment is ${state}, and Retry releases it`, () => {
    const s = mkSource({ writeback: { onPrOpened: false, onCompleted: true, resolve: true } });
    const task = mkSwept();
    const { registry, sources } = setup(s, task);
    makeWritebackEnqueuer(registry, deps({ sources })).completed(task);
    settleWriteback(rows()[0]!.id, state, { attempts: 6, lastError: "nope" }, NOW);

    const after = NOW + SETTLE + 1;
    assert.deepEqual(
      claimDueWritebacks(after, 20).map((r) => r.action),
      [],
      `an issue was closed while its comment was ${state}`,
    );

    // Retry puts the comment back, and the resolve is still behind it rather than ahead.
    retryWritebacks("src-1", true, after);
    assert.deepEqual(claimDueWritebacks(after, 20).map((r) => r.action), ["annotate"]);
    settleWriteback(rows()[0]!.id, "delivered", {}, after);
    assert.deepEqual(claimDueWritebacks(after, 20).map((r) => r.action), ["resolve"]);
  });
}

// The interaction between the two rules, and the reason the resolve guard has to be applied
// BEFORE the per-item cap rather than after it. A blocked resolve sitting at the minimum id
// for its item used to strike out the whole item for that tick, so every LATER row - which
// necessarily carries a higher id - was excluded by the cap and never claimed at all.
//
// Reachable, and with a real consequence: a completion comment gives up, its resolve comes
// due and is blocked behind that failure, and a pull request is linked afterwards. The new
// comment is owed, deliverable, and about a different fact entirely - it must not wait
// behind a close that is itself waiting on a comment that already stopped trying.
test("a comment linked after a stalled completion is claimed past the blocked resolve", async () => {
  const s = mkSource({ writeback: { onPrOpened: true, onCompleted: true, resolve: true } });
  const task = mkSwept();
  const { registry, sources } = setup(s, task);
  const enq = makeWritebackEnqueuer(registry, deps({ sources }));

  // The completion pair: the comment fails outright, so the resolve is blocked behind it.
  enq.completed(task);
  const [comment, close] = rows();
  settleWriteback(comment!.id, "failed", { attempts: 6, lastError: "gh refused" }, NOW);

  // A pull request is linked afterwards, on the same item, so its row has the higher id.
  enq.prLinked({
    taskId: task.id,
    repoRoot: "/repo",
    prUrl: "https://github.com/acme/demo/pull/9",
    observedAt: NOW,
  });
  const linked = rows()[2]!;
  assert.equal(linked.signal, "pr-opened");
  assert.ok(linked.id > close!.id, "the fixture did not order the rows as the bug requires");

  // Past the settle window, so the blocked resolve is due and would otherwise be the
  // minimum row for this item.
  const after = NOW + SETTLE + 1;
  const due = claimDueWritebacks(after, 20);
  assert.deepEqual(
    due.map((r) => r.signal),
    ["pr-opened"],
    "a deliverable comment was starved behind a blocked resolve",
  );

  // And it really delivers, rather than merely being claimable.
  const annotate = spy(delivered);
  await drainWritebacks(registry, deps({ sources, annotate: annotate.fn, now: () => after }));
  assert.equal(annotate.calls.length, 1);
  assert.equal(annotate.calls[0]!.signal, "pr-opened");
  assert.equal(rows()[2]!.state, "delivered");

  // The close is still held: the comment it was meant to follow is still `failed`, and
  // delivering an unrelated comment does not answer for it.
  assert.equal(rows()[1]!.state, "pending");
  assert.deepEqual(
    claimDueWritebacks(after, 20).map((r) => r.action),
    [],
    "the close was released by an unrelated comment",
  );
});

// A cancelled comment is not owed at all, so it must not hold the close forever. This is
// the one earlier state that does not block.
test("a cancelled comment does not hold its resolve", () => {
  const s = mkSource({ writeback: { onPrOpened: false, onCompleted: true, resolve: true } });
  const task = mkSwept();
  const { registry, sources } = setup(s, task);
  makeWritebackEnqueuer(registry, deps({ sources })).completed(task);
  settleWriteback(rows()[0]!.id, "cancelled", { lastError: "switched off" }, NOW);
  assert.deepEqual(
    claimDueWritebacks(NOW + SETTLE + 1, 20).map((r) => r.action),
    ["resolve"],
  );
});

// An annotate is deliberately NOT held behind an earlier annotate. A multi-repo task's
// per-repository pull requests share an external_id, and the two comments have no order
// between them - suppressing the second because the first failed would withhold a true
// statement for no benefit.
test("a comment is not held behind another comment that failed", () => {
  const s = mkSource({ writeback: { onPrOpened: true, onCompleted: false, resolve: false } });
  const task = mkSwept();
  const { registry, sources } = setup(s, task);
  const enq = makeWritebackEnqueuer(registry, deps({ sources }));
  enq.prLinked({
    taskId: task.id,
    repoRoot: "/repo",
    prUrl: "https://github.com/acme/demo/pull/9",
    observedAt: NOW,
  });
  enq.prLinked({
    taskId: task.id,
    repoRoot: "/other",
    prUrl: "https://github.com/acme/other/pull/3",
    observedAt: NOW,
  });
  settleWriteback(rows()[0]!.id, "failed", { attempts: 6, lastError: "nope" }, NOW);
  assert.deepEqual(claimDueWritebacks(NOW, 20).map((r) => r.action), ["annotate"]);
});

test("a row not yet due is not claimed", () => {
  const s = mkSource({ writeback: { onPrOpened: false, onCompleted: true, resolve: true } });
  const task = mkSwept();
  const { registry, sources } = setup(s, task);
  makeWritebackEnqueuer(registry, deps({ sources })).completed(task);
  settleWriteback(rows()[0]!.id, "delivered", {}, NOW);
  assert.deepEqual(claimDueWritebacks(NOW, 20), [], "the resolve fired inside its settle window");
  assert.equal(claimDueWritebacks(NOW + SETTLE, 20).length, 1);
});

// ---- 4. delivery, refusal, and the answer that is neither ----

test("a delivered row records what was said and is never claimed again", async () => {
  const s = mkSource({ writeback: { onPrOpened: false, onCompleted: true, resolve: false } });
  const task = mkSwept();
  const { registry, sources } = setup(s, task);
  makeWritebackEnqueuer(registry, deps({ sources })).completed(task);

  const annotate = spy(delivered);
  await drainWritebacks(registry, past({ sources, annotate: annotate.fn }));

  assert.equal(annotate.calls.length, 1);
  assert.equal(annotate.calls[0]!.externalId, "acme/demo#7");
  assert.equal(annotate.calls[0]!.outcome, "opened a pull request");
  assert.equal(rows()[0]!.state, "delivered");
  assert.equal(rows()[0]!.last_detail, "commented");
  assert.deepEqual(claimDueWritebacks(NOW + 86_400_000, 20), []);
});

test("a refusal backs off, doubling to a ceiling, and is given up on at six attempts", async () => {
  const s = mkSource({ writeback: { onPrOpened: false, onCompleted: true, resolve: false } });
  const task = mkSwept();
  const { registry, sources } = setup(s, task);
  makeWritebackEnqueuer(registry, deps({ sources })).completed(task);

  const annotate = spy(refused);
  // The clock has to move, or a backed-off row would never come due again - and it starts
  // past the settle window, because the completion comment now waits that out first.
  let clock = NOW + SETTLE;
  const d = deps({ sources, annotate: annotate.fn, now: () => clock });

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await drainWritebacks(registry, d);
    const row = rows()[0]!;
    assert.equal(row.state, "pending", `attempt ${attempt} gave up early`);
    assert.equal(row.attempts, attempt);
    assert.equal(row.next_at, clock + backoffFor(attempt));
    assert.match(row.last_error!, /Could not resolve to an Issue/);
    clock = row.next_at;
  }

  await drainWritebacks(registry, d);
  assert.equal(rows()[0]!.state, "failed");
  assert.equal(rows()[0]!.attempts, 6);
  assert.equal(annotate.calls.length, 6, "the implementation was asked a seventh time");
});

test("the backoff doubles and is capped", () => {
  assert.equal(backoffFor(1), 60_000);
  assert.equal(backoffFor(2), 120_000);
  assert.equal(backoffFor(3), 240_000);
  // Capped, so a wedged upstream is retried on a schedule rather than in a decade.
  assert.equal(backoffFor(20), 30 * 60_000);
});

// The rule this whole direction turns on, and it matters more for a resolve than it ever
// did for a push: a duplicate comment is noise, a duplicate transition undoes a person.
test("an unknown outcome is recorded as unknown and never retried automatically", async () => {
  const s = mkSource({ writeback: { onPrOpened: false, onCompleted: true, resolve: false } });
  const task = mkSwept();
  const { registry, sources } = setup(s, task);
  makeWritebackEnqueuer(registry, deps({ sources })).completed(task);

  const annotate = spy(unknown);
  await drainWritebacks(registry, past({ sources, annotate: annotate.fn }));
  assert.equal(rows()[0]!.state, "unknown");
  assert.match(rows()[0]!.last_error!, /may have landed/);

  // Not even a year later. Only an operator, having gone and looked, moves this.
  assert.deepEqual(claimDueWritebacks(NOW + 365 * 86_400_000, 20), []);
  await drainWritebacks(registry, deps({ sources, annotate: annotate.fn, now: () => NOW + 1e10 }));
  assert.equal(annotate.calls.length, 1, "an unknown outcome was retried on its own");
});

// ---- 5. the live re-check, and the asymmetry between the two actions ----

for (const [why, patch] of [
  ["reopened", { status: "running" as const }],
  ["rescheduled", { status: "backlog" as const }],
]) {
  test(`a resolve whose task was ${why} is cancelled without asking the implementation`, async () => {
    const s = mkSource({ writeback: { onPrOpened: false, onCompleted: true, resolve: true } });
    const task = mkSwept();
    const { registry, sources } = setup(s, task);
    makeWritebackEnqueuer(registry, deps({ sources })).completed(task);
    // Deliver the annotate so the resolve is the row a later tick claims.
    settleWriteback(rows()[0]!.id, "delivered", {}, NOW);

    registry.upsertTask({ ...task, ...(patch as Partial<Task>) });
    const resolve = spy(delivered);
    await drainWritebacks(
      registry,
      deps({ sources, resolve: resolve.fn, now: () => NOW + SETTLE }),
    );

    assert.deepEqual(resolve.calls, [], "an issue was closed for work that had resumed");
    assert.equal(rows()[1]!.state, "cancelled");
    assert.match(rows()[1]!.last_error!, /not finished|is /);
  });
}

test("a resolve whose task was deleted is cancelled - its completion cannot be confirmed", async () => {
  const s = mkSource({ writeback: { onPrOpened: false, onCompleted: true, resolve: true } });
  const task = mkSwept();
  const { registry, sources } = setup(s, task);
  makeWritebackEnqueuer(registry, deps({ sources })).completed(task);
  settleWriteback(rows()[0]!.id, "delivered", {}, NOW);

  openDb().exec("DELETE FROM tasks");
  const fresh = new Registry();
  const resolve = spy(delivered);
  await drainWritebacks(fresh, deps({ sources, resolve: resolve.fn, now: () => NOW + SETTLE }));
  assert.deepEqual(resolve.calls, []);
  assert.equal(rows()[1]!.state, "cancelled");
});

// The other side of that asymmetry, and it is deliberate. "A pull request opened for this"
// was true when it was observed and stays true; the comment is worth posting whatever
// became of the task afterwards - which is also what makes the payload a snapshot.
test("a pr-opened comment whose task was deleted still delivers, from the snapshot", async () => {
  // The payload is a snapshot, so this survives the task - and it is the PR-LINKED comment
  // that does, deliberately: it says a pull request opened, which stays true whatever became
  // of the task. A COMPLETION comment whose task has gone is cancelled instead, because
  // "finished" is a claim the missing task can no longer support.
  const s = mkSource({ writeback: { onPrOpened: true, onCompleted: false, resolve: false } });
  const task = mkSwept();
  const { registry, sources } = setup(s, task);
  makeWritebackEnqueuer(registry, deps({ sources })).prLinked({
    taskId: task.id,
    repoRoot: "/repo",
    prUrl: "https://github.com/acme/demo/pull/9",
    observedAt: NOW,
  });

  openDb().exec("DELETE FROM tasks");
  const annotate = spy(delivered);
  await drainWritebacks(new Registry(), deps({ sources, annotate: annotate.fn }));

  assert.equal(annotate.calls.length, 1);
  assert.equal(annotate.calls[0]!.taskTitle, "Fix the parser");
  assert.equal(rows()[0]!.state, "delivered");
});

test("a trigger switched off between the observation and the tick cancels the delivery", async () => {
  const on = mkSource({ writeback: { onPrOpened: false, onCompleted: true, resolve: false } });
  const task = mkSwept();
  const { registry } = setup(on, task);
  makeWritebackEnqueuer(registry, deps({ sources: () => [on] })).completed(task);

  const off = mkSource();
  const annotate = spy(delivered);
  await drainWritebacks(registry, past({ sources: () => [off], annotate: annotate.fn }));
  assert.deepEqual(annotate.calls, []);
  assert.equal(rows()[0]!.state, "cancelled");
  assert.match(rows()[0]!.last_error!, /switched off/);
});

test("a source removed between the observation and the tick cancels the delivery", async () => {
  const s = mkSource({ writeback: { onPrOpened: false, onCompleted: true, resolve: false } });
  const task = mkSwept();
  const { registry } = setup(s, task);
  makeWritebackEnqueuer(registry, deps({ sources: () => [s] })).completed(task);

  const annotate = spy(delivered);
  await drainWritebacks(registry, past({ sources: () => [], annotate: annotate.fn }));
  assert.deepEqual(annotate.calls, []);
  assert.equal(rows()[0]!.state, "cancelled");
  assert.match(rows()[0]!.last_error!, /no longer configured/);
});

// The row stores `signal` and `action` twice - as columns, because they are half of the
// identity index, and inside the serialized notice, because that notice is what an
// implementation reads. Nothing in SQLite keeps the copies in step, and the worker reads
// them from different places: the VERB comes off the column, the comment's wording off the
// payload. A row whose copies disagree would run one and announce the other.
test("a delivery whose payload contradicts its own row is failed, and nothing is written", async () => {
  const s = mkSource({ writeback: { onPrOpened: false, onCompleted: true, resolve: false } });
  const task = mkSwept();
  const { registry, sources } = setup(s, task);
  makeWritebackEnqueuer(registry, deps({ sources })).completed(task);

  // The row's columns still say task-completed / annotate; the payload now says pr-opened.
  const row = rows()[0]!;
  openDb()
    .prepare(`UPDATE task_source_writeback SET payload = ? WHERE id = ?`)
    .run(
      JSON.stringify({
        signal: "pr-opened",
        action: "annotate",
        externalId: "acme/demo#7",
        externalUrl: null,
        taskTitle: "Fix the parser",
        prUrl: "https://github.com/acme/demo/pull/9",
        repoRoot: "/repo",
        outcome: null,
        observedAt: NOW,
      }),
      row.id,
    );

  const annotate = spy(delivered);
  await drainWritebacks(registry, past({ sources, annotate: annotate.fn }));
  assert.deepEqual(annotate.calls, [], "a contradictory row was published anyway");
  assert.equal(rows()[0]!.state, "failed");
  assert.match(rows()[0]!.last_error!, /disagree/);
});

// The same refusal for a payload whose ACTION contradicts the row, which is the half that
// would have run the wrong verb.
test("a payload naming a different action than its row is refused", async () => {
  const s = mkSource({ writeback: { onPrOpened: false, onCompleted: true, resolve: false } });
  const task = mkSwept();
  const { registry, sources } = setup(s, task);
  makeWritebackEnqueuer(registry, deps({ sources })).completed(task);
  openDb()
    .prepare(
      `UPDATE task_source_writeback
          SET payload = json_set(payload, '$.action', 'resolve')
        WHERE id = ?`,
    )
    .run(rows()[0]!.id);

  const annotate = spy(delivered);
  const resolve = spy(delivered);
  await drainWritebacks(
    registry,
    past({ sources, annotate: annotate.fn, resolve: resolve.fn }),
  );
  assert.deepEqual(annotate.calls, []);
  assert.deepEqual(resolve.calls, [], "a close ran under a row that calls itself a comment");
  assert.equal(rows()[0]!.state, "failed");
});

// The third duplicated field, and the one whose disagreement cannot be taken back. The queue
// groups, de-duplicates, orders and counts by the COLUMN (`external_id` is in the identity
// index, in claimDueWritebacks' per-item cap and its resolve guard, and in countWritebacks),
// while `issueTargetFor` builds the argv gh is actually pointed at from the PAYLOAD. A row
// whose copies disagree would be tracked and reported as one issue while commenting on -
// or closing - somebody else's.
test("a payload naming a different external item than its row is refused", async () => {
  const s = mkSource({ writeback: { onPrOpened: false, onCompleted: true, resolve: false } });
  const task = mkSwept();
  const { registry, sources } = setup(s, task);
  makeWritebackEnqueuer(registry, deps({ sources })).completed(task);
  assert.equal(rows()[0]!.dedupe_key.startsWith("t1:"), true);

  openDb()
    .prepare(
      `UPDATE task_source_writeback
          SET payload = json_set(payload, '$.externalId', 'acme/other#99')
        WHERE id = ?`,
    )
    .run(rows()[0]!.id);

  const annotate = spy(delivered);
  await drainWritebacks(registry, past({ sources, annotate: annotate.fn }));
  assert.deepEqual(
    annotate.calls,
    [],
    "a delivery tracked as acme/demo#7 was published against acme/other#99",
  );
  assert.equal(rows()[0]!.state, "failed");
  assert.match(rows()[0]!.last_error!, /disagree/);
  // The ledger still says what it always said, so the operator's queue is not lying about
  // where this went.
  assert.equal(
    (openDb()
      .prepare(`SELECT external_id FROM task_source_writeback WHERE id = ?`)
      .get(rows()[0]!.id) as { external_id: string }).external_id,
    "acme/demo#7",
  );
});

// The delivered notice carries the ROW's item, not the payload's, so what is published and
// what the queue is keyed on are the same string by construction.
test("a delivered notice carries the item its row is keyed on", async () => {
  const s = mkSource({ writeback: { onPrOpened: false, onCompleted: true, resolve: false } });
  const task = mkSwept();
  const { registry, sources } = setup(s, task);
  makeWritebackEnqueuer(registry, deps({ sources })).completed(task);

  const annotate = spy(delivered);
  await drainWritebacks(registry, past({ sources, annotate: annotate.fn }));
  assert.equal(annotate.calls[0]!.externalId, rows()[0]!.external_id);
});

// A payload this build cannot read will never deliver. Settled rather than left pending, or
// it would be re-claimed on every tick for the rest of the daemon's life.
test("a delivery whose stored details cannot be read is failed rather than retried forever", async () => {
  const s = mkSource({ writeback: { onPrOpened: false, onCompleted: true, resolve: false } });
  const task = mkSwept();
  const { registry, sources } = setup(s, task);
  makeWritebackEnqueuer(registry, deps({ sources })).completed(task);
  openDb().exec(`UPDATE task_source_writeback SET payload = 'not json'`);

  const annotate = spy(delivered);
  await drainWritebacks(registry, past({ sources, annotate: annotate.fn }));
  assert.deepEqual(annotate.calls, []);
  assert.equal(rows()[0]!.state, "failed");
  assert.deepEqual(claimDueWritebacks(NOW + 86_400_000, 20), []);
});

// ---- the completion comment states a fact that can stop being true ----
//
// The resolve waits out the settle window and re-checks the live task, because
// `settleIfEpisodeFinished` concludes a task from an idle agent and `reopenIfWorkResumed`
// reverses that minutes later. The COMMENT that says "Mission Control finished the task for
// this issue" makes the same claim, and until this was fixed it went out on the very next
// tick - so a reversed inference left a public completion announcement on somebody's tracker
// while the task was still running, with nothing to walk it back. The resolve being
// correctly cancelled does not help: the sentence is already there.

test("the completion comment waits out the settle window, like the close it precedes", () => {
  const s = mkSource({ writeback: { onPrOpened: false, onCompleted: true, resolve: true } });
  const task = mkSwept();
  const { registry, sources } = setup(s, task);
  makeWritebackEnqueuer(registry, deps({ sources })).completed(task);

  const [comment, close] = rows();
  assert.equal(comment!.action, "annotate");
  assert.equal(
    comment!.next_at,
    NOW + SETTLE,
    "the completion comment was due before the window that exists to catch a reversal",
  );
  assert.equal(close!.next_at, NOW + SETTLE);
  // Nothing is claimable until the window has passed.
  assert.deepEqual(claimDueWritebacks(NOW + SETTLE - 1, 20), []);
  assert.deepEqual(
    claimDueWritebacks(NOW + SETTLE, 20).map((r) => r.action),
    ["annotate"],
    "the comment still goes first once both are due",
  );
});

for (const [why, patch] of [
  ["reopened", { status: "running" as const }],
  ["rescheduled", { status: "backlog" as const }],
]) {
  test(`a completion comment whose task was ${why} is cancelled, not posted`, async () => {
    const s = mkSource({ writeback: { onPrOpened: false, onCompleted: true, resolve: false } });
    const task = mkSwept();
    const { registry, sources } = setup(s, task);
    makeWritebackEnqueuer(registry, deps({ sources })).completed(task);

    registry.upsertTask({ ...task, ...(patch as Partial<Task>) });
    const annotate = spy(delivered);
    await drainWritebacks(
      registry,
      deps({ sources, annotate: annotate.fn, now: () => NOW + SETTLE }),
    );

    assert.deepEqual(
      annotate.calls,
      [],
      "a public 'finished' was posted for a task that had gone back to work",
    );
    assert.equal(rows()[0]!.state, "cancelled");
    assert.match(rows()[0]!.last_error!, /not finished|is /);
  });
}

// The exemption, and the reason it is safe. A pull request opening is not a claim that can
// go stale, so its comment is neither delayed nor re-checked.
test("a pr-opened comment is neither delayed nor re-checked against the task", async () => {
  const s = mkSource({ writeback: { onPrOpened: true, onCompleted: false, resolve: false } });
  const task = mkSwept();
  const { registry, sources } = setup(s, task);
  makeWritebackEnqueuer(registry, deps({ sources })).prLinked({
    taskId: task.id,
    repoRoot: "/repo",
    prUrl: "https://github.com/acme/demo/pull/9",
    observedAt: NOW,
  });
  assert.equal(rows()[0]!.next_at, NOW, "the pull request comment was delayed for no reason");

  // Even with the task back at work, the comment still delivers: it says a pull request
  // opened, which remains true.
  registry.upsertTask({ ...task, status: "running" });
  const annotate = spy(delivered);
  await drainWritebacks(registry, past({ sources, annotate: annotate.fn }));
  assert.equal(annotate.calls.length, 1);
  assert.equal(annotate.calls[0]!.signal, "pr-opened");
});

// ---- the environment overrides ----
//
// `Math.max(floor, NaN)` is NaN, not the floor, so `Number(envVar(x) ?? default)` does not
// fall back on a TYPO - only on an absent value. Both directions of that bug are real: a NaN
// tick becomes setTimeout(NaN), which Node fires at 1ms and which turns the worker into a
// tight loop against somebody's GitHub; a NaN settle window makes next_at NaN, which
// node:sqlite binds as NULL against a NOT NULL column, so the resolve insert throws and the
// row is silently never enqueued.

test("a mistyped tick override falls back to the default instead of becoming NaN", async () => {
  const prior = process.env.MISSION_TASK_SOURCE_WRITEBACK_TICK_MS;
  process.env.MISSION_TASK_SOURCE_WRITEBACK_TICK_MS = "twenty seconds";
  try {
    const mod = await import(
      `../src/server/task-sources/writeback.ts?nan-tick=${Date.now()}`
    );
    // The worker starts and schedules a real timer rather than a 1ms one. Stopping it
    // immediately is enough: a NaN tick would have thrown or spun before this returned.
    const stop = mod.startWritebackWorker(new Registry(), deps({ sources: () => [] }));
    await stop();
  } finally {
    if (prior === undefined) delete process.env.MISSION_TASK_SOURCE_WRITEBACK_TICK_MS;
    else process.env.MISSION_TASK_SOURCE_WRITEBACK_TICK_MS = prior;
  }
});

test("a mistyped settle override still enqueues a resolve with a usable due time", async () => {
  const prior = process.env.MISSION_TASK_SOURCE_WRITEBACK_SETTLE_MS;
  process.env.MISSION_TASK_SOURCE_WRITEBACK_SETTLE_MS = "five minutes";
  try {
    const mod = await import(
      `../src/server/task-sources/writeback.ts?nan-settle=${Date.now()}`
    );
    const s = mkSource({ writeback: { onPrOpened: false, onCompleted: true, resolve: true } });
    const task = mkSwept();
    const { registry, sources } = setup(s, task);
    // No settleMs override, so the module's own constant is used - which is the thing under
    // test. A NaN there would make next_at NULL and the insert throw, leaving one row.
    mod.makeWritebackEnqueuer(registry, { sources, now: () => NOW, log: () => {} })
      .completed(task);

    const all = rows();
    assert.equal(all.length, 2, "the resolve row was lost to a NaN due time");
    for (const r of all) {
      assert.ok(Number.isFinite(r.next_at), `next_at is not a finite number: ${r.next_at}`);
    }
  } finally {
    if (prior === undefined) delete process.env.MISSION_TASK_SOURCE_WRITEBACK_SETTLE_MS;
    else process.env.MISSION_TASK_SOURCE_WRITEBACK_SETTLE_MS = prior;
  }
});

// ---- shutdown ----
//
// Clearing the timer only stops the NEXT tick. The one already running may be awaiting a gh
// subprocess on a row it has not settled, and exiting there would leave that row `pending`
// for the next boot to deliver a second time - a duplicate comment, and with auto-resolve on
// a second close.
test("stopping the worker waits for the tick that is already running", async () => {
  const s = mkSource({ writeback: { onPrOpened: false, onCompleted: true, resolve: false } });
  const task = mkSwept();
  const { registry, sources } = setup(s, task);
  makeWritebackEnqueuer(registry, deps({ sources })).completed(task);

  let released: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    released = resolve;
  });
  let finished = false;
  const annotate = async (): Promise<WritebackResult> => {
    await gate;
    finished = true;
    return delivered;
  };

  const stop = startWritebackWorker(
    registry,
    deps({ sources, annotate, now: () => NOW + SETTLE }),
  );
  // Let the tick start and reach the gated delivery.
  await new Promise((r) => setTimeout(r, 10));
  const stopping = stop();
  assert.equal(finished, false, "the fixture did not reach the in-flight state it needs");

  released!();
  await stopping;
  assert.equal(finished, true, "the stopper returned before the in-flight delivery finished");
  assert.equal(rows()[0]!.state, "delivered", "the row was not settled before shutdown returned");
});

// ---- 6. the operator's controls over the queue ----

test("the queue reports what is waiting, what failed, and what nobody can vouch for", () => {
  const s = mkSource({ writeback: { onPrOpened: false, onCompleted: true, resolve: true } });
  const task = mkSwept();
  const { registry, sources } = setup(s, task);
  makeWritebackEnqueuer(registry, deps({ sources })).completed(task);
  settleWriteback(rows()[0]!.id, "delivered", { lastDetail: "commented" }, NOW);
  settleWriteback(rows()[1]!.id, "failed", { lastError: "gh refused: nope" }, NOW + 1);

  const status = countWritebacks("src-1");
  assert.equal(status.delivered, 1);
  assert.equal(status.failed, 1);
  assert.equal(status.pending, 0);
  assert.equal(status.lastDeliveredAt, NOW);
  assert.match(status.lastError!, /nope/);
  // A different source's queue is a different queue.
  assert.equal(countWritebacks("src-2").failed, 0);
});

test("retry moves failed rows back, and leaves unknown ones alone unless asked", () => {
  const s = mkSource({ writeback: { onPrOpened: false, onCompleted: true, resolve: true } });
  const task = mkSwept();
  const { registry, sources } = setup(s, task);
  makeWritebackEnqueuer(registry, deps({ sources })).completed(task);
  settleWriteback(rows()[0]!.id, "failed", { attempts: 6, lastError: "nope" }, NOW);
  settleWriteback(rows()[1]!.id, "unknown", { attempts: 1, lastError: "no answer" }, NOW);

  assert.equal(retryWritebacks("src-1", false, NOW), 1);
  assert.equal(rows()[0]!.state, "pending");
  assert.equal(rows()[0]!.attempts, 0, "the retried row kept its exhausted attempt count");
  assert.equal(rows()[1]!.state, "unknown", "an unknown outcome was retried without being asked");

  // The second flag is an operator asserting they have gone and looked upstream.
  assert.equal(retryWritebacks("src-1", true, NOW), 1);
  assert.equal(rows()[1]!.state, "pending");
});

test("a cancelled delivery is not resurrected by either retry flag", () => {
  const s = mkSource({ writeback: { onPrOpened: false, onCompleted: true, resolve: false } });
  const task = mkSwept();
  const { registry, sources } = setup(s, task);
  makeWritebackEnqueuer(registry, deps({ sources })).completed(task);
  settleWriteback(rows()[0]!.id, "cancelled", { lastError: "switched off" }, NOW);
  assert.equal(retryWritebacks("src-1", true, NOW), 0);
  assert.equal(rows()[0]!.state, "cancelled");
});

test("discarding a queue drops that source's rows and nobody else's", () => {
  const s = mkSource({ writeback: { onPrOpened: false, onCompleted: true, resolve: false } });
  const task = mkSwept();
  const { registry, sources } = setup(s, task);
  makeWritebackEnqueuer(registry, deps({ sources })).completed(task);
  enqueueWriteback(
    {
      sourceId: "src-2",
      externalId: "acme/demo#8",
      signal: "task-completed",
      action: "annotate",
      dedupeKey: "t2:1",
      taskId: "t2",
      notice: {
        signal: "task-completed",
        action: "annotate",
        externalId: "acme/demo#8",
        externalUrl: null,
        taskTitle: "Other",
        prUrl: null,
        repoRoot: "/repo",
        outcome: null,
        observedAt: NOW,
      },
      nextAt: NOW,
    },
    NOW,
  );

  assert.equal(discardWritebacks("src-1"), 1);
  assert.equal(rows().length, 1);
  assert.equal(countWritebacks("src-2").pending, 1);
});

// ---- the migration ----
//
// The table arrives in the schema block as `CREATE TABLE IF NOT EXISTS`, with its indexes
// beside it, so an existing database gains it by opening - no `addColumn`, no backfill, no
// ordering to get wrong. Asserted by taking it away from a database that has everything
// else and opening again, which is exactly the shape of an upgrade.
test("an existing database gains the ledger, and its indexes, by opening", () => {
  const db = openDb();
  db.exec("DROP TABLE task_source_writeback");
  closeDb();

  const upgraded = openDb();
  const found = upgraded
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE name IN ('task_source_writeback', 'idx_writeback_identity', 'idx_writeback_due')
        ORDER BY name`,
    )
    .all() as unknown as Array<{ name: string }>;
  assert.deepEqual(found.map((r) => r.name), [
    "idx_writeback_due",
    "idx_writeback_identity",
    "task_source_writeback",
  ]);

  // And it works: the identity index is what makes a second observation free, so a table
  // that came back without it would be a table that silently duplicates every comment.
  const notice: WritebackNotice = {
    signal: "task-completed",
    action: "annotate",
    externalId: "acme/demo#7",
    externalUrl: null,
    taskTitle: "T",
    prUrl: null,
    repoRoot: "/repo",
    outcome: null,
    observedAt: NOW,
  };
  const row = {
    sourceId: "src-1",
    externalId: "acme/demo#7",
    signal: "task-completed" as const,
    action: "annotate" as const,
    dedupeKey: "t1:1",
    taskId: "t1",
    notice,
    nextAt: NOW,
  };
  assert.equal(enqueueWriteback(row, NOW), true);
  assert.equal(enqueueWriteback(row, NOW), false);
});

// ---- the trigger: a pull request becoming a task's ----
//
// The other half of `pr-opened`, and the half the enqueuer cannot prove on its own: the
// Registry has to ANNOUNCE the association, once, from the two places the durable record
// actually gains a pull request. Driven through `reconcilePrs` / `reconcileRepoPrs` rather
// than by emitting the event by hand, because what is being tested is that those functions
// fire it - a hand-emitted event would prove only that a listener can be called.

const PR_PRIMARY = "https://github.com/acme/demo/pull/9";
const PR_EXTRA = "https://github.com/acme/other/pull/3";

function discovered(id: string, cwd: string): DiscoveredSession {
  return {
    syntheticId: id,
    agent: "claude",
    name: `agent-${id}`,
    nameSource: "process",
    cwd,
    gitBranch: "feat/work",
    gitRoot: "/repo",
    repoRoot: "/repo",
    pid: 100,
    tty: null,
    terminals: [],
    startedAt: 0,
  };
}

function extraEntry(over: Partial<TaskRepoEntry> = {}): TaskRepoEntry {
  return {
    repoRoot: "/other",
    worktreePath: "/wt/linked-1",
    branch: "feat/work",
    provider: "git",
    worktreeLeaseId: null,
    baseSha: "b".repeat(40),
    prUrl: null,
    prState: null,
    mergedAt: null,
    ...over,
  };
}

/** A live session bound to a running task, with one attached repository. */
function linkedFixture(extras: TaskRepoEntry[] = []) {
  const registry = new Registry();
  const id = "linked";
  const cwd = "/wt/linked-0";
  registry.applyDiscovery([discovered(id, cwd)]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: `${id}-episode`,
    cwd,
    transcriptPath: null,
    env: {},
  });
  registry.upsertTask(
    mkTask({
      id: "t1",
      title: "Fix the parser",
      status: "running",
      sessionId: id,
      repoRoot: "/repo",
      worktreePath: cwd,
      branch: "feat/work",
      provider: "git",
      baseSha: "a".repeat(40),
      extraRepos: extras,
      source: {
        sourceId: "src-1",
        externalId: "acme/demo#7",
        url: "https://github.com/acme/demo/issues/7",
      },
    }),
  );
  registry.bindTaskToWorkEpisode("t1", id);
  const episode = registry.workEpisodeForSession(id)!;
  const seen: TaskPrLinkedEvent[] = [];
  registry.onTaskPrLinked((e) => seen.push(e));
  return { registry, id, episode, seen };
}

test("the registry announces a pull request that first became a task's, and only once", () => {
  const f = linkedFixture();
  const match = {
    url: PR_PRIMARY,
    number: 9,
    state: "open" as const,
    checks: null,
    branch: "feat/work",
    agentSessionId: `${f.id}-episode`,
    episodeId: f.episode.episodeId,
    createdAt: f.episode.startedAt,
    mergedAt: null,
    headSha: "head",
    worktreeHeadSha: "head",
  };
  f.registry.reconcilePrs(new Map([[f.id, match]]), new Set());

  assert.equal(f.seen.length, 1);
  assert.deepEqual(
    { taskId: f.seen[0]!.taskId, repoRoot: f.seen[0]!.repoRoot, prUrl: f.seen[0]!.prUrl },
    { taskId: "t1", repoRoot: "/repo", prUrl: PR_PRIMARY },
  );

  // The poller keeps reporting the same pull request on every tick. A second observation of
  // an association that already exists is not news, and announcing it again would put the
  // ledger's identity index in the position of being the only thing between an operator and
  // a comment per poll.
  f.registry.reconcilePrs(new Map([[f.id, match]]), new Set());
  assert.equal(f.seen.length, 1, "a re-observed pull request was announced twice");
});

// The per-repository twin, and the reason `TaskPrLinked` carries a repoRoot at all: a
// multi-repo task opened a pull request in each of its repositories, and an upstream item
// that named only the primary's would be a report that is quietly incomplete.
test("the registry announces an attached repository's pull request under that repository", () => {
  const f = linkedFixture([extraEntry()]);
  const target = f.registry
    .extraRepoPrPollTargets()
    .find((t) => t.taskId === "t1" && t.repoRoot === "/other");
  assert.ok(target, "the attached repo is polled");

  f.registry.reconcileRepoPrs(
    new Map([[
      target.key,
      {
        url: PR_EXTRA,
        number: 3,
        state: "open" as const,
        checks: null,
        branch: target.branch,
        agentSessionId: target.agentSessionId,
        episodeId: target.episodeId,
        createdAt: f.episode.startedAt,
        mergedAt: null,
        headSha: "extra-head",
        worktreeHeadSha: "extra-head",
      },
    ]]),
    new Set(),
  );

  assert.equal(f.seen.length, 1);
  assert.deepEqual(
    { taskId: f.seen[0]!.taskId, repoRoot: f.seen[0]!.repoRoot, prUrl: f.seen[0]!.prUrl },
    { taskId: "t1", repoRoot: "/other", prUrl: PR_EXTRA },
  );
});

// A session working outside a task has no upstream item, so there is nothing to announce.
test("a pull request on a session bound to no task announces nothing", () => {
  const f = linkedFixture();
  openDb().exec("DELETE FROM task_work_episode_bindings");
  f.registry.reconcilePrs(
    new Map([[f.id, {
      url: PR_PRIMARY,
      number: 9,
      state: "open" as const,
      checks: null,
      branch: "feat/work",
      agentSessionId: `${f.id}-episode`,
      episodeId: f.episode.episodeId,
      createdAt: f.episode.startedAt,
      mergedAt: null,
      headSha: "head",
      worktreeHeadSha: "head",
    }]]),
    new Set(),
  );
  assert.deepEqual(f.seen, []);
});
