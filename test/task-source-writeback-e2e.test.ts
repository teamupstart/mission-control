import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { QueueManager } from "../src/server/queue.ts";
// Pure and browser-safe (no `node:` imports), so a static import cannot open the DB ahead
// of the HARNESS_HOME preamble below.
import { TaskSourcesConfigSchema } from "../src/shared/task-source.ts";

// The phase's merge criteria, end to end, against the real chain: the config route stores
// the write-back consent, a completion through `TaskManager.complete` reaches the ledger,
// the worker drives the actual `github-issues` implementation, and a real `gh` process
// receives the actual argv - comment first, close after the settle window.
//
// A FAKE `gh` on disk rather than a stubbed dependency, reached through the existing
// `MISSION_GH_BIN` seam, exactly as `task-push-http.test.ts` does and for the same reason:
// what is being proved is that the daemon wired these together, and a stub at any seam
// would prove only that the seam can be handed the answer. It also means no test process
// can reach an operator's authenticated `gh` and comment on somebody's real issue.
//
// Three claims:
//
//   1. `writeback` rides `PUT /api/task-sources/config` with no route change, which is what
//      makes this phase operable before any panel exists.
//   2. A completion enqueues, and the worker delivers - the comment, then the close.
//   3. A restart mid-queue loses nothing: the ledger is on disk, and the rows a fresh
//      process claims are the ones the old one had not delivered.

const home = mkdtempSync(join(tmpdir(), "mission-writeback-e2e-"));
process.env.HARNESS_HOME = home;

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { setTaskSourcesConfig, getTaskSourcesConfig } = await import(
  "../src/server/task-sources/config.ts"
);
const { drainWritebacks, makeWritebackEnqueuer } = await import(
  "../src/server/task-sources/writeback.ts"
);

/**
 * The repo the source is bound to - a real directory, since `gh` gets a cwd.
 *
 * Realpath'd, because macOS's temp dir is a symlink into `/private/var` and an unresolved
 * path would not match what the child reports back.
 */
const repo = realpathSync(mkdtempSync(join(tmpdir(), "mission-writeback-repo-")));
// `PUT /api/task-sources/config` resolves every source's repoRoot to a git root, and this
// file goes through that route rather than around it - so the fixture has to be one.
execFileSync("git", ["init", "-q"], { cwd: repo });
const bin = mkdtempSync(join(tmpdir(), "mission-writeback-bin-"));
const record = join(bin, "gh-argv.txt");

after(() => {
  for (const dir of [home, repo, bin]) rmSync(dir, { recursive: true, force: true });
});

/** A `gh` that records the cwd and one argv entry per line, then succeeds. */
const GH = (() => {
  const path = join(bin, "gh");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      // Appended, so one file holds every call the queue made in order.
      `{ pwd; for a in "$@"; do printf '%s\\n' "$a"; done; echo '--'; } >> "$MC_GH_RECORD"`,
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
})();

/** Every `gh` invocation so far, each as its recorded cwd followed by its argv. */
function calls(): string[][] {
  let raw = "";
  try {
    raw = readFileSync(record, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("--\n")
    .filter((c) => c.trim().length > 0)
    .map((c) => c.trim().split("\n"));
}

const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };
const SETTLE = 300_000;

beforeEach(() => {
  openDb().exec("DELETE FROM tasks; DELETE FROM task_source_writeback;");
  setTaskSourcesConfig(TaskSourcesConfigSchema.parse({ sources: [] }));
  rmSync(record, { force: true });
  process.env.MISSION_GH_BIN = GH;
  process.env.MC_GH_RECORD = record;
});

function daemon() {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  // Exactly the wiring `src/server/index.ts` performs.
  // `settleMs` is the only seam pinned: a completion carries its own `completedAt`, which
  // is what both the ledger key and the due time are built from, so the clock here is the
  // real one and the assertions below move it rather than the fixture.
  const enqueuer = makeWritebackEnqueuer(registry, { settleMs: SETTLE });
  registry.onTaskPrLinked((e) => enqueuer.prLinked(e));
  tasks.registerWritebackEnqueuer(enqueuer);
  const app = buildApp({
    registry,
    reviews: {} as unknown as ReviewManager,
    tasks,
    queues: {} as unknown as QueueManager,
  });
  return { registry, tasks, app, enqueuer };
}

function ledger(): Array<{ action: string; state: string; last_detail: string | null }> {
  return openDb()
    .prepare(`SELECT action, state, last_detail FROM task_source_writeback ORDER BY id`)
    .all() as never;
}

// ---- 1. the consent rides the route that already exists ----

test("write-back consent stores and reads back through the config route", async () => {
  const { app } = daemon();
  const body = {
    sources: [
      {
        id: "src-1",
        kind: "github-issues",
        label: "issues",
        repoRoot: repo,
        writeback: { onPrOpened: true, onCompleted: true, resolve: true },
        config: { closeReason: "not-planned" },
      },
    ],
  };
  const res = await app.request("/api/task-sources/config", {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  const view = (await res.json()) as {
    sources: Array<{ writeback: unknown }>;
    writeback: Array<{ sourceId: string }>;
  };
  assert.deepEqual(view.sources[0]!.writeback, {
    onPrOpened: true,
    onCompleted: true,
    resolve: true,
  });
  // One queue summary per configured source, owing nothing yet. A source that has only
  // just been switched on has an EMPTY queue rather than no queue, and the two are
  // different answers: the panel draws a line for the first and nothing for the second.
  assert.deepEqual(view.writeback, [
    {
      sourceId: "src-1",
      pending: 0,
      failed: 0,
      unknown: 0,
      delivered: 0,
      lastError: null,
      lastDeliveredAt: null,
    },
  ]);
  assert.deepEqual(getTaskSourcesConfig().sources[0]!.writeback, {
    onPrOpened: true,
    onCompleted: true,
    resolve: true,
  });
});

// The schema's refusal, reaching an HTTP client as a 400 rather than as a stored switch
// that can never fire.
test("the config route refuses auto-resolve with no completion trigger", async () => {
  const { app } = daemon();
  const res = await app.request("/api/task-sources/config", {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify({
      sources: [
        {
          id: "src-1",
          kind: "github-issues",
          repoRoot: repo,
          writeback: { resolve: true },
        },
      ],
    }),
  });
  assert.equal(res.status, 400);
});

// ---- 2. a completion, delivered ----

async function configure(writeback: Record<string, boolean>): Promise<void> {
  setTaskSourcesConfig(
    TaskSourcesConfigSchema.parse({
      sources: [
        { id: "src-1", kind: "github-issues", label: "issues", repoRoot: repo, writeback },
      ],
    }),
  );
}

function swept() {
  return mkTask({
    id: "t1",
    title: "Fix the parser",
    status: "running",
    repoRoot: repo,
    source: {
      sourceId: "src-1",
      externalId: "acme/demo#7",
      url: "https://github.com/acme/demo/issues/7",
    },
  });
}

test("a swept task completing comments on its issue, then closes it after the settle window", async () => {
  await configure({ onPrOpened: false, onCompleted: true, resolve: true });
  const { registry, tasks } = daemon();
  registry.upsertTask(swept());

  await tasks.complete("t1", "shipped in #9", "https://github.com/acme/demo/pull/9");
  assert.deepEqual(
    ledger().map((r) => [r.action, r.state]),
    [
      ["annotate", "pending"],
      ["resolve", "pending"],
    ],
  );

  // A tick INSIDE the settle window delivers neither. Both rows make a claim about the
  // task having finished, and that claim is exactly what `reopenIfWorkResumed` can reverse -
  // so the comment waits the window out alongside the close it precedes.
  await drainWritebacks(registry);
  assert.deepEqual(
    ledger().map((r) => r.state),
    ["pending", "pending"],
    "something was published before the window that exists to catch a reversal",
  );
  assert.deepEqual(calls(), [], "gh was spawned inside the settle window");

  // Past the window the comment goes first, and the close still waits its turn behind it.
  await drainWritebacks(registry, { now: () => Date.now() + SETTLE + 1_000 });
  assert.equal(ledger()[0]!.state, "delivered");
  assert.equal(ledger()[0]!.last_detail, "commented");
  assert.equal(ledger()[1]!.state, "pending", "the close overtook its own comment");

  const comment = calls()[0]!;
  assert.equal(comment[0], repo, "gh ran outside the source's checkout");
  assert.deepEqual(comment.slice(1, 6), [
    "issue",
    "comment",
    "7",
    "--repo",
    "acme/demo",
  ]);
  assert.match(comment.join("\n"), /Mission Control finished the task/);
  assert.match(comment.join("\n"), /shipped in #9/);

  // The next tick past the window takes the close. The clock is the only thing moved
  // forward: the same queue, the same source, the same implementation.
  await drainWritebacks(registry, { now: () => Date.now() + SETTLE + 1_000 });
  assert.equal(ledger()[1]!.state, "delivered");
  assert.equal(ledger()[1]!.last_detail, "closed as completed");
  const close = calls()[1]!;
  assert.deepEqual(close.slice(1), [
    "issue",
    "close",
    "7",
    "--repo",
    "acme/demo",
    "--reason",
    "completed",
  ]);
});

// The first trigger, through the same chain: a pull request becoming this task's produces
// a comment naming it on the issue the task was swept from. Driven through the enqueuer the
// daemon subscribes to `onTaskPrLinked` with - which is exactly what the Registry hands it -
// so what is proved from here on is the ledger, the worker, the implementation and the argv
// a real `gh` process received. That the Registry fires it at all, once per (task, repo), is
// pinned separately in `task-source-writeback.test.ts` against `reconcilePrs` itself.
test("a pull request becoming a swept task's is commented onto its issue", async () => {
  await configure({ onPrOpened: true, onCompleted: false, resolve: false });
  const { registry, enqueuer } = daemon();
  registry.upsertTask(swept());

  enqueuer.prLinked({
    taskId: "t1",
    repoRoot: repo,
    prUrl: "https://github.com/acme/demo/pull/9",
    observedAt: Date.now(),
  });
  assert.deepEqual(
    ledger().map((r) => [r.action, r.state]),
    [["annotate", "pending"]],
  );

  await drainWritebacks(registry);
  assert.equal(ledger()[0]!.state, "delivered");
  assert.equal(ledger()[0]!.last_detail, "commented");

  const comment = calls()[0]!;
  assert.equal(comment[0], repo, "gh ran outside the source's checkout");
  assert.deepEqual(comment.slice(1, 6), ["issue", "comment", "7", "--repo", "acme/demo"]);
  const body = comment.join("\n");
  assert.match(body, /Mission Control opened a pull request for this issue/);
  assert.match(body, /https:\/\/github\.com\/acme\/demo\/pull\/9/);
  // The task is still running - a pull request opening says nothing about a completion, and
  // an issue closed at this point would be closed on work that has not landed.
  assert.equal(
    calls().some((c) => c.includes("close")),
    false,
    "opening a pull request closed the issue",
  );
});

// The consent that is separate from the trigger. With the completion trigger on and
// auto-resolve off, the comment goes and the issue is LEFT OPEN - which is the whole
// difference between a source that reports and a source that decides.
test("with auto-resolve off a completion comments and never closes the issue", async () => {
  await configure({ onPrOpened: false, onCompleted: true, resolve: false });
  const { registry, tasks } = daemon();
  registry.upsertTask(swept());

  await tasks.complete("t1", "shipped in #9", "https://github.com/acme/demo/pull/9");
  assert.deepEqual(
    ledger().map((r) => r.action),
    ["annotate"],
    "auto-resolve was off and a close was queued anyway",
  );

  // Well past the settle window, so nothing is merely waiting its turn.
  await drainWritebacks(registry, { now: () => Date.now() + SETTLE * 10 });
  assert.equal(ledger()[0]!.state, "delivered");
  assert.equal(calls().length, 1);
  assert.deepEqual(calls()[0]!.slice(1, 3), ["issue", "comment"]);
  assert.equal(
    calls().some((c) => c.includes("close")),
    false,
    "an issue was closed without the operator asking for it",
  );
});

// The default, and therefore every installation that predates this feature: the ledger
// stays empty and NOTHING is spawned. The empty `gh` record is the second half of that
// claim and the one a row count cannot make.
test("with every switch off a completion writes nothing and spawns nothing", async () => {
  await configure({ onPrOpened: false, onCompleted: false, resolve: false });
  const { registry, tasks } = daemon();
  registry.upsertTask(swept());

  await tasks.complete("t1", "shipped in #9", "https://github.com/acme/demo/pull/9");
  await drainWritebacks(registry, { now: () => Date.now() + SETTLE + 1_000 });

  assert.deepEqual(ledger(), []);
  assert.deepEqual(calls(), [], "a source nobody switched on spawned gh");
});

// ---- 3. the restart ----

test("a restart mid-queue loses nothing - the pending rows are still pending", async () => {
  await configure({ onPrOpened: false, onCompleted: true, resolve: false });
  const first = daemon();
  first.registry.upsertTask(swept());
  await first.tasks.complete("t1", "shipped in #9", "https://github.com/acme/demo/pull/9");
  assert.equal(ledger()[0]!.state, "pending");

  // A new process, sharing only the database - which is the whole point of a ledger over a
  // listener: the observation survived the process that made it.
  const second = daemon();
  // Past the settle window, because the completion comment waits it out - the point here is
  // that the OBSERVATION survived the process, not that it fires immediately.
  await drainWritebacks(second.registry, { now: () => Date.now() + SETTLE + 1_000 });
  assert.equal(ledger()[0]!.state, "delivered");
  assert.equal(calls().length, 1);
});
