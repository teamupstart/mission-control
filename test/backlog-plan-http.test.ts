import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Registry } from "../src/server/registry.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { TaskManager } from "../src/server/tasks.ts";
import type { QueueManager } from "../src/server/queue.ts";

// The channel the Foreman worker stores its reading of the backlog through - it never
// touches the DB, so this route is the only way a plan reaches disk.
//
// What is at stake is the SHAPE of what gets stored. A plan is read back by the
// scheduler to decide whether an agent gets launched and in what order, so a body that
// arrived half-formed - an entry with no `dependsOn` - would read as "nothing blocks
// this" and start work out of order. Hence the schema at the boundary, and hence the
// daemon (not the worker) stamping the timestamp the board displays.

// Throwaway state dir, set before anything opens the DB - see tasks-db.test.ts.
const home = mkdtempSync(join(tmpdir(), "mission-backlog-plan-"));
process.env.HARNESS_HOME = home;
const { buildApp } = await import("../src/server/routes.ts");

after(() => rmSync(home, { recursive: true, force: true }));

// The plan routes read none of the managers - they go straight to app_config.
const app = buildApp(
  {} as unknown as Registry,
  {} as unknown as ReviewManager,
  {} as unknown as TaskManager,
  {} as unknown as QueueManager,
);

const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

const put = async (body: unknown): Promise<Response> =>
  app.request("/api/backlog/plan", { method: "PUT", headers: HEADERS, body: JSON.stringify(body) });

const get = async (): Promise<Response> =>
  app.request("/api/backlog/plan", { headers: { host: "127.0.0.1:7317" } });

test("a plan round-trips, and the daemon stamps when it was made", async () => {
  const before = Date.now();
  const res = await put({
    entries: [
      { taskId: "a", dependsOn: [], reason: "the schema" },
      { taskId: "b", dependsOn: ["a"], reason: null },
    ],
    note: "b builds on a",
  });
  assert.equal(res.status, 200);

  const stored = (await (await get()).json()) as {
    entries: Array<{ taskId: string; dependsOn: string[]; reason: string | null }>;
    note: string | null;
    generatedAt: number;
  };
  assert.deepEqual(stored.entries.map((e) => e.taskId), ["a", "b"]);
  assert.deepEqual(stored.entries[1]!.dependsOn, ["a"]);
  assert.equal(stored.note, "b builds on a");
  assert.ok(stored.generatedAt >= before, "the timestamp is the daemon's clock, not the caller's");
});

test("a caller cannot back-date a plan - generatedAt is never taken from the body", async () => {
  await put({ entries: [{ taskId: "a", dependsOn: [] }], generatedAt: 1 });
  const stored = (await (await get()).json()) as { generatedAt: number };
  assert.ok(stored.generatedAt > 1_000_000_000, "an injected generatedAt must be ignored");
});

test("a plan replaces the previous one whole - a stale entry must not survive a merge", async () => {
  await put({ entries: [{ taskId: "old", dependsOn: [] }] });
  await put({ entries: [{ taskId: "new", dependsOn: [] }] });
  const stored = (await (await get()).json()) as { entries: Array<{ taskId: string }> };
  assert.deepEqual(stored.entries.map((e) => e.taskId), ["new"]);
});

test("an entry that omits dependsOn defaults to blocked-by-nothing, explicitly", async () => {
  await put({ entries: [{ taskId: "a" }] });
  const stored = (await (await get()).json()) as {
    entries: Array<{ dependsOn: string[]; reason: string | null }>;
  };
  assert.deepEqual(stored.entries[0]!.dependsOn, []);
  assert.equal(stored.entries[0]!.reason, null);
});

test("a malformed body is refused rather than half-stored", async () => {
  assert.equal((await put({ entries: [{ dependsOn: [] }] })).status, 400);
  assert.equal((await put({ entries: [{ taskId: "" }] })).status, 400);
  assert.equal((await put({ entries: "not a list" })).status, 400);
  assert.equal((await put({})).status, 400);
});

test("the loopback guard applies here too", async () => {
  const res = await app.request("/api/backlog/plan", {
    method: "PUT",
    headers: { host: "evil.example.com", "content-type": "application/json" },
    body: JSON.stringify({ entries: [] }),
  });
  assert.equal(res.status, 403);
});
