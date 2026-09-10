import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { QueueManager } from "../src/server/queue.ts";
// Pure and browser-safe (no `node:` imports), so a static import cannot open the DB ahead
// of the HARNESS_HOME preamble below.
import {
  TaskSourcesConfigSchema,
  type TaskSourcesView,
  type WritebackNotice,
} from "../src/shared/task-source.ts";

// The two write-back queue routes as an HTTP client sees them, and the summary the panel
// reads in the same GET it already made.
//
// What is at stake is one distinction, and it is the same one the ledger is built around:
// **`failed` and `unknown` are not interchangeable.** A `failed` row is proof that nothing
// was written, so putting it back costs nothing. An `unknown` row may already have
// commented on somebody's issue or closed it, so putting THAT back can duplicate a comment
// or re-close an item a human deliberately reopened. The route separates them behind a flag
// that defaults to false, which means the safe request is the one you get by asking for
// nothing - and no unit test of `retryWritebacks` can prove the route wired that flag up
// rather than passing a constant.
//
// The refusals need no ledger at all, and that they need none is the property: a 404 from
// here moved no row, so a mistyped id cannot empty a queue that belongs to a source that
// does exist.

const home = mkdtempSync(join(tmpdir(), "mission-writeback-http-"));
process.env.HARNESS_HOME = home;

const { openDb, enqueueWriteback, countWritebacks, settleWriteback } = await import(
  "../src/server/db.ts"
);
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { setTaskSourcesConfig } = await import("../src/server/task-sources/config.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const SOURCE_ID = "src-gh";

/** The source the ledger rows below belong to. Written straight through the config module,
 *  so the fixture needs no real git checkout to satisfy the PUT route's repo resolution. */
function configure(): void {
  setTaskSourcesConfig(
    TaskSourcesConfigSchema.parse({
      sources: [
        {
          id: SOURCE_ID,
          kind: "github-issues",
          label: "demo issues",
          repoRoot: "/repo/demo",
          writeback: { onPrOpened: true, onCompleted: true, resolve: false },
          config: {},
        },
      ],
    }),
  );
}

function notice(externalId: string): WritebackNotice {
  return {
    signal: "pr-opened",
    action: "annotate",
    externalId,
    externalUrl: `https://github.com/acme/demo/issues/${externalId.split("#")[1] ?? "1"}`,
    taskTitle: "Fix the parser",
    prUrl: "https://github.com/acme/demo/pull/9",
    repoRoot: "/repo/demo",
    outcome: null,
    observedAt: 1_700_000_000_000,
  };
}

/**
 * Put one row in the ledger, already settled into the state this test needs.
 *
 * Enqueued and then settled rather than inserted in the target state directly, because
 * that is the only path the daemon itself has: a row reaches `failed` or `unknown` by
 * being attempted, and a fixture that wrote the state straight in could pass while the
 * real transition wrote something the retry query does not match.
 */
function seed(
  externalId: string,
  state: "pending" | "failed" | "unknown" | "delivered" | "cancelled",
  lastError: string | null = null,
): void {
  enqueueWriteback({
    sourceId: SOURCE_ID,
    externalId,
    signal: "pr-opened",
    action: "annotate",
    dedupeKey: `pr:${externalId}`,
    taskId: null,
    notice: notice(externalId),
    nextAt: 0,
  });
  if (state === "pending") return;
  const id = (
    openDb()
      .prepare(`SELECT id FROM task_source_writeback WHERE external_id = ?`)
      .get(externalId) as { id: number }
  ).id;
  settleWriteback(id, state, { attempts: 6, lastError });
}

function setup(): {
  retry: (id: string, body: unknown) => Promise<Response>;
  discard: (id: string) => Promise<Response>;
  view: () => Promise<TaskSourcesView>;
} {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const app = buildApp(
    registry,
    {} as unknown as ReviewManager,
    tasks,
    {} as unknown as QueueManager,
  );
  const headers = { host: "127.0.0.1:7317", "content-type": "application/json" };
  return {
    retry: async (id, body) =>
      app.request(`/api/task-sources/${id}/writeback/retry`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    discard: async (id) =>
      app.request(`/api/task-sources/${id}/writeback`, { method: "DELETE", headers }),
    view: async () =>
      (await (
        await app.request("/api/task-sources/config", { headers })
      ).json()) as TaskSourcesView,
  };
}

beforeEach(() => {
  openDb().exec("DELETE FROM task_source_writeback; DELETE FROM app_config;");
  configure();
});

// ---- the summary the panel reads ----

test("the config view carries one queue summary per configured source", async () => {
  seed("acme/demo#1", "pending");
  seed("acme/demo#2", "failed", "gh refused: no such issue");
  seed("acme/demo#3", "unknown", "gh did not report back");
  seed("acme/demo#4", "delivered");

  const view = await setup().view();
  assert.equal(view.writeback.length, 1);
  assert.partialDeepStrictEqual(view.writeback[0], {
    sourceId: SOURCE_ID,
    pending: 1,
    failed: 1,
    unknown: 1,
    delivered: 1,
  });
  assert.match(view.writeback[0]!.lastError ?? "", /gh /);
});

// The summary is per CONFIGURED source, not per source the ledger holds rows for: a count
// reported against a source nobody has any more is a number with no control beside it.
//
// Removing a source already discards its rows (`setTaskSourcesConfig`), so this seeds rows
// under an id nothing configures - which is the state a database restored from a backup, or
// one whose config blob was hand-edited, can be in.
test("a queue under an id nothing configures is not reported", async () => {
  seed("acme/demo#1", "failed", "gh refused");
  openDb()
    .prepare(
      `INSERT INTO task_source_writeback
         (source_id, external_id, signal, action, dedupe_key, task_id, payload,
          state, attempts, next_at, created_at, updated_at)
       VALUES ('src-orphan', 'acme/demo#9', 'pr-opened', 'annotate', 'pr:9', NULL, '{}',
               'failed', 6, 0, 0, 0)`,
    )
    .run();

  const view = await setup().view();
  assert.equal(view.writeback.length, 1);
  assert.equal(view.writeback[0]!.sourceId, SOURCE_ID);
  assert.equal(view.writeback[0]!.failed, 1);
});

// ---- retry ----

test("retry moves the failed rows back and leaves the unknown ones alone", async () => {
  seed("acme/demo#1", "failed", "gh refused: no such issue");
  seed("acme/demo#2", "unknown", "gh did not report back");

  const res = await setup().retry(SOURCE_ID, {});
  assert.equal(res.status, 200);
  const body = (await res.json()) as { retried: number; view: TaskSourcesView };
  assert.equal(body.retried, 1);
  // The refreshed view rides back with it, so the panel's counts move with the press rather
  // than on its next four-second poll - and it is NESTED under `view`, because
  // `TaskSourcesView.status` would otherwise be overwritten by the HTTP status the browser's
  // request helper stamps onto every reply.
  assert.partialDeepStrictEqual(body.view.writeback[0], { pending: 1, failed: 0, unknown: 1 });
  assert.ok(Array.isArray(body.view.status), "the per-source health array must survive the trip");
});

// The load-bearing half: an omitted flag must make the SAFE request. A route that read a
// missing body as "retry everything" would put a delivery that may already have commented
// back on the wire without anybody saying so.
test("an empty body does not retry the unknown rows", async () => {
  seed("acme/demo#2", "unknown", "gh did not report back");
  const res = await setup().retry(SOURCE_ID, {});
  assert.equal(((await res.json()) as { retried: number }).retried, 0);
  assert.equal(countWritebacks(SOURCE_ID).unknown, 1);
});

test("includeUnknown is what puts an unknown delivery back on the wire", async () => {
  seed("acme/demo#1", "failed", "gh refused");
  seed("acme/demo#2", "unknown", "gh did not report back");

  const res = await setup().retry(SOURCE_ID, { includeUnknown: true });
  const body = (await res.json()) as { retried: number; view: TaskSourcesView };
  assert.equal(body.retried, 2);
  assert.partialDeepStrictEqual(body.view.writeback[0], { pending: 2, failed: 0, unknown: 0 });
});

// `cancelled` is not a stalled delivery: the world moved on - the source was removed, a
// trigger was switched off, the task came back to life - and re-running it against a
// decision that has been reversed is a new decision rather than a retry.
test("a cancelled delivery is retried by neither flag", async () => {
  seed("acme/demo#5", "cancelled", "this source's trigger was switched off");
  const res = await setup().retry(SOURCE_ID, { includeUnknown: true });
  assert.equal(((await res.json()) as { retried: number }).retried, 0);
});

test("a body the schema refuses is a 400 and moves nothing", async () => {
  seed("acme/demo#1", "failed", "gh refused");
  const res = await setup().retry(SOURCE_ID, { includeUnknown: "yes please" });
  assert.equal(res.status, 400);
  assert.equal(countWritebacks(SOURCE_ID).failed, 1);
});

test("retrying an unknown source id is a 404 in the wording its siblings use", async () => {
  seed("acme/demo#1", "failed", "gh refused");
  const res = await setup().retry("src-gone", { includeUnknown: true });
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as { error: string }).error, "no such task source");
  // And the source that DOES exist keeps its queue, which is the point of asking first.
  assert.equal(countWritebacks(SOURCE_ID).failed, 1);
});

// ---- discard ----

test("discard drops the whole queue and answers with the emptied view", async () => {
  seed("acme/demo#1", "pending");
  seed("acme/demo#2", "failed", "gh refused");
  seed("acme/demo#3", "delivered");

  const res = await setup().discard(SOURCE_ID);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { discarded: number; view: TaskSourcesView };
  assert.equal(body.discarded, 3);
  assert.partialDeepStrictEqual(body.view.writeback[0], {
    pending: 0,
    failed: 0,
    unknown: 0,
    delivered: 0,
    lastError: null,
  });
});

test("discarding an unknown source id is a 404 and empties nothing", async () => {
  seed("acme/demo#1", "pending");
  const res = await setup().discard("src-gone");
  assert.equal(res.status, 404);
  assert.equal(countWritebacks(SOURCE_ID).pending, 1);
});

// Discarding is about the QUEUE and nothing else. An operator clearing a backlog of
// deliveries has not asked to stop writing back, and silently switching their consent off
// would be a second decision they did not make.
test("discarding leaves the source's switches exactly as they were", async () => {
  seed("acme/demo#1", "failed", "gh refused");
  const body = (await (await setup().discard(SOURCE_ID)).json()) as { view: TaskSourcesView };
  assert.deepEqual(body.view.sources[0]?.writeback, {
    onPrOpened: true,
    onCompleted: true,
    resolve: false,
  });
});
