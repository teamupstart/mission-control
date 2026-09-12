import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitIn, mkCloneOnBranch } from "./helpers/git-fixture.ts";

// Isolate the daemon's state dir (token + sqlite) BEFORE anything reads config.
process.env.MISSION_HOME = mkdtempSync(join(tmpdir(), "mission-reset-queue-"));

const { openDb, getQueueRow, listQueueItems } = await import("../src/server/db.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { Session } from "../src/shared/types.ts";

openDb();
const TOKEN = ensureToken();
const LOOPBACK = { host: "127.0.0.1:7317" };
const authed = { ...LOOPBACK, "content-type": "application/json", "x-harness-token": TOKEN };

const registry = new Registry();
const queues = new QueueManager(registry);
const app = buildApp({
  registry,
  reviews: new ReviewManager(registry),
  tasks: new TaskManager(registry),
  queues,
});

/** A claude session sitting in the real checkout at `cwd`, on `branch`. */
function mkDisco(id: string, cwd: string, branch: string): DiscoveredSession {
  return {
    syntheticId: id,
    agent: "claude",
    name: "work",
    nameSource: "tmux",
    cwd,
    gitBranch: branch,
    gitRoot: cwd,
    repoRoot: cwd,
    pid: 4242,
    tty: "ttys003",
    terminals: [],
    startedAt: 0,
  } as DiscoveredSession;
}

function authorizeQueue(id: string, cwd: string): void {
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: `agent-${id}`,
    cwd,
    transcriptPath: null,
    env: {},
  });
}

/** Read a card back off the dashboard API, exactly as the renderer sees it. */
async function card(id: string): Promise<Session> {
  const res = await app.request("/api/sessions", { headers: LOOPBACK });
  const all = (await res.json()) as Session[];
  const s = all.find((x) => x.id === id);
  assert.ok(s, `session ${id} is on the dashboard`);
  return s;
}

async function reset(id: string, clear: boolean): Promise<Response> {
  return app.request(`/api/sessions/${id}/reset`, {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ clear }),
  });
}

/**
 * The end-user "Reset to origin & clear context" flow: a session with a backlog of
 * queued + in-flight work hits POST /reset, and the whole batch must be gone -
 * blanked on its card AND removed from the store - not stranded as an orphan.
 */
test("POST /reset clears the session's whole work queue (clear:true)", async () => {
  const branch = "mancej/feature";
  const clone = mkCloneOnBranch("harness-reset-q-true-", branch);
  registry.applyDiscovery([mkDisco("s-true", clone, branch)]);
  authorizeQueue("s-true", clone);

  // A realistic backlog: two waiting items and one already in flight against the
  // agent's now-doomed context - the state a per-item `remove` would refuse.
  const first = queues.add("s-true", "wire up the retry")!;
  queues.add("s-true", "add a regression test");
  assert.ok(queues.setState(first.id, { state: "sending" }, 1).ok, "one item is in flight");

  const before = await card("s-true");
  console.log("[reset-queue] BEFORE clear:true ->", JSON.stringify(before.queue));
  assert.equal(before.queue?.openCount, 2, "card shows two open items before the reset");
  assert.equal(before.queue?.inFlightState, "sending", "and one of them in flight");
  assert.equal(getQueueRow(first.noteKey)?.noteKey, first.noteKey, "the queue row exists in the store");
  assert.equal(listQueueItems(first.noteKey).length, 2, "both items persisted (one queued, one in flight)");

  const res = await reset("s-true", true);
  assert.equal(res.status, 200, "the reset succeeds");
  const body = (await res.json()) as { ok: boolean };
  assert.equal(body.ok, true);

  const after = await card("s-true");
  console.log("[reset-queue] AFTER  clear:true ->", JSON.stringify(after.queue));
  assert.equal(after.queue, null, "the card no longer shows any queue");
  assert.equal(getQueueRow(first.noteKey), undefined, "the queue row is gone from the store");
  assert.deepEqual(listQueueItems(first.noteKey), [], "and every item with it, in-flight included");
  assert.equal(gitIn(clone, "branch", "--show-current"), "", "the reset also released the branch");
});

/**
 * The clear is ungated on the `clear` flag: the git reset invalidated the queued
 * work regardless of whether the agent's context was wiped, so even a reset that
 * skips /clear must still take the batch.
 */
test("POST /reset clears the queue even with clear:false", async () => {
  const branch = "mancej/second";
  const clone = mkCloneOnBranch("harness-reset-q-false-", branch);
  registry.applyDiscovery([mkDisco("s-false", clone, branch)]);
  authorizeQueue("s-false", clone);
  registry.applyRuntimeMeta(
    "s-false",
    {
      modelId: "claude-opus-4-8",
      contextTokens: 20_000,
      contextWindow: 200_000,
      contextPct: 10,
      longContext: false,
      thinkingLevel: "high",
      effortRevision: "turn-1",
    },
    "transcript",
  );
  registry.recordObservedSessionEffort("s-false", "xhigh");

  const item = queues.add("s-false", "the only task")!;
  const before = await card("s-false");
  console.log("[reset-queue] BEFORE clear:false ->", JSON.stringify(before.queue));
  assert.equal(before.queue?.openCount, 1, "one queued item before");

  const res = await reset("s-false", false);
  assert.equal(res.status, 200);

  const after = await card("s-false");
  assert.equal(after.meta?.thinkingLevel, null, "the reset drops the previous conversation's effort");
  console.log("[reset-queue] AFTER  clear:false ->", JSON.stringify(after.queue));
  assert.equal(after.queue, null, "still cleared, even though /clear was not sent");
  assert.equal(getQueueRow(item.noteKey), undefined, "the row is gone");
});

/**
 * The clear is scoped to the resetting session's key: a sibling agent's own queue
 * in a different checkout must be untouched by one session's reset.
 */
test("POST /reset leaves an unrelated session's queue alone", async () => {
  const branch = "mancej/mine";
  const mine = mkCloneOnBranch("harness-reset-q-mine-", branch);
  const other = mkCloneOnBranch("harness-reset-q-other-", "mancej/other");
  registry.applyDiscovery([mkDisco("s-mine", mine, branch), mkDisco("s-other", other, "mancej/other")]);
  authorizeQueue("s-mine", mine);
  authorizeQueue("s-other", other);

  queues.add("s-mine", "reset wipes this");
  const keep = queues.add("s-other", "this must survive")!;

  const res = await reset("s-mine", true);
  assert.equal(res.status, 200);

  assert.equal((await card("s-mine")).queue, null, "the resetting session's queue is gone");
  const neighbour = await card("s-other");
  console.log("[reset-queue] neighbour after sibling reset ->", JSON.stringify(neighbour.queue));
  assert.equal(neighbour.queue?.openCount, 1, "the neighbour's queue is untouched");
  assert.equal(getQueueRow(keep.noteKey)?.noteKey, keep.noteKey, "and its row survives in the store");
});
