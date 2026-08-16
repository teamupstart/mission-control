import { after, test } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/server/db.ts";
import { Registry } from "../src/server/registry.ts";
import { ReviewManager } from "../src/server/reviews.ts";
import { TaskManager } from "../src/server/tasks.ts";
import { QueueManager } from "../src/server/queue.ts";
import { buildApp } from "../src/server/routes.ts";
import {
  WorktreeManager,
  type WorktreeManagerDeps,
} from "../src/server/worktrees/manager.ts";
import type { WorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";

const db = openDb();

function emptyOccupancy(paths: readonly string[]): Promise<Map<string, WorktreeOccupancy>> {
  return Promise.resolve(new Map(paths.map((path) => [path, { status: "known", occupants: [] }])));
}

function manager(deps: Partial<WorktreeManagerDeps> = {}): WorktreeManager {
  return new WorktreeManager(db, {
    occupancy: emptyOccupancy,
    resolvePolicy: () => ({ enabled: true, maxSlots: 2, setupArgv: null }),
    ...deps,
  });
}

const registry = new Registry();
const worktrees = manager();
const tasks = new TaskManager(registry);
const app = buildApp(
  registry,
  new ReviewManager(registry),
  tasks,
  new QueueManager(registry),
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  worktrees,
);
const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

after(() => {
  db.exec("DELETE FROM worktree_slots; DELETE FROM worktree_pools;");
});

async function post(path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
}

test("manual routes acquire, protect dirty work, return exactly, and retain the warm slot", async () => {
  const { clone } = mkOriginAndClone("mission-manual-http-");
  const head = gitIn(clone, "rev-parse", "HEAD");

  const acquired = await post("/api/worktrees/manual/acquire", {
    repositoryPath: clone,
    label: "manual review",
  });
  assert.equal(acquired.status, 201);
  const lease = await acquired.json() as { path: string; leaseId: string; baseSha: string };
  assert.equal(lease.baseSha, head);
  assert.equal(gitIn(lease.path, "rev-parse", "HEAD"), head);
  const stored = worktrees.lookupLease({ leaseId: lease.leaseId, path: lease.path });
  assert.equal(stored.state, "active");
  if (stored.state === "active") {
    assert.equal(stored.lease.owner.kind, "manual");
    assert.match(stored.lease.owner.key, /:manual review$/);
  }

  const untracked = join(lease.path, "manual-work.txt");
  writeFileSync(untracked, "do not discard\n");
  const dirty = await post("/api/worktrees/manual/return", { leaseId: lease.leaseId });
  assert.equal(dirty.status, 409);
  assert.match((await dirty.json() as { error: string }).error, /dirty/);
  assert.equal(worktrees.lookupLease({ leaseId: lease.leaseId }).state, "active");

  unlinkSync(untracked);
  const returned = await post("/api/worktrees/manual/return", { leaseId: lease.leaseId });
  assert.equal(returned.status, 200);
  assert.deepEqual(await returned.json(), { ok: true, alreadyReleased: false });
  assert.equal(worktrees.lookupLease({ leaseId: lease.leaseId }).state, "released");
  assert.equal(gitIn(lease.path, "rev-parse", "HEAD"), head);

  const again = await post("/api/worktrees/manual/return", { leaseId: lease.leaseId });
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { ok: true, alreadyReleased: true });

  const reacquired = await post("/api/worktrees/manual/acquire", { repositoryPath: clone });
  assert.equal(reacquired.status, 201);
  const next = await reacquired.json() as { path: string; leaseId: string };
  assert.equal(next.path, lease.path);
  assert.notEqual(next.leaseId, lease.leaseId);
  const byPath = await post("/api/worktrees/manual/return", { path: next.path });
  assert.equal(byPath.status, 200);
});

test("manual return refuses a native lease owned by a task", async () => {
  const { clone } = mkOriginAndClone("mission-manual-owner-http-");
  const acquired = await worktrees.acquire({
    repositoryPath: clone,
    baseSha: gitIn(clone, "rev-parse", "HEAD"),
    owner: { kind: "task", key: "task-route-guard:0" },
  });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;

  const refused = await post("/api/worktrees/manual/return", { leaseId: acquired.lease.leaseId });
  assert.equal(refused.status, 409);
  assert.match((await refused.json() as { error: string }).error, /task or workflow check/);
  assert.equal((await worktrees.release(acquired.lease)).outcome, "released");
});
