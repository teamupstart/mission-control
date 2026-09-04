import { after, test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/server/db.ts";
import { Registry } from "../src/server/registry.ts";
import { ReviewManager } from "../src/server/reviews.ts";
import { TaskManager } from "../src/server/tasks.ts";
import { QueueManager } from "../src/server/queue.ts";
import { buildApp } from "../src/server/routes.ts";
import { WorktreeManager } from "../src/server/worktrees/manager.ts";
import { WorktreeOperationsService } from "../src/server/worktrees/operations.ts";
import { CheckLeaseManager } from "../src/server/workflows/check-lease.ts";
import { LegacyTreehouseService } from "../src/server/worktrees/legacy-treehouse.ts";
import type { WorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";
import type { TerminalLaunchSpec } from "../src/server/terminal/targets.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";

const db = openDb();
const registry = new Registry();
const tasks = new TaskManager(registry);
const manager = new WorktreeManager(db, {
  occupancy: (paths: readonly string[]): Promise<Map<string, WorktreeOccupancy>> =>
    Promise.resolve(new Map(paths.map((path) => [path, { status: "known", occupants: [] }]))),
  resolvePolicy: () => ({ enabled: true, maxSlots: 2, setupArgv: null }),
});
const checks = new CheckLeaseManager(db, { manager, legacy: new LegacyTreehouseService(db) });
const operations = new WorktreeOperationsService(manager, {
  legacy: new LegacyTreehouseService(db),
  tasks: { get: () => null, reclaim: (id) => tasks.reclaim(id) },
  checks,
  checkRecovery: async () => "unknown",
  notifyChanged: () => registry.emitWorktreesChanged(),
  diskBytes: async () => 0,
});
const launched: TerminalLaunchSpec[] = [];
const launch = async (_backend: "tmux" | "cmux" | "wezterm" | "ghostty" | "iterm", spec: TerminalLaunchSpec) => {
  launched.push(spec);
  return { ok: true, label: "Test terminal", homeName: null, status: 200 };
};
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
  launch,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  manager,
  operations,
);
const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

after(() => db.exec("DELETE FROM worktree_slots; DELETE FROM worktree_pools; DELETE FROM app_config WHERE key = 'worktrees';"));

test("inventory/config routes are bounded, validated, future-only, and content-free invalidated", async () => {
  const { clone } = mkOriginAndClone("mission-worktree-route-");
  const acquired = await manager.acquire({
    repositoryPath: clone,
    baseSha: gitIn(clone, "rev-parse", "HEAD"),
    owner: { kind: "manual", key: "manual-route" },
  });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;

  const inventory = await app.request("/api/worktrees", { headers: HEADERS });
  assert.equal(inventory.status, 200);
  const body = await inventory.json() as { repositories: Array<{ slots: Array<{ id: string }> }>; revision: string };
  assert.equal(body.repositories[0]?.slots[0]?.id, acquired.lease.slotId);
  assert.match(body.revision, /^[a-f0-9]{64}$/);

  const events: unknown[] = [];
  registry.subscribe((event) => events.push(event));
  const update = await app.request("/api/worktrees/config", {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify({ maxSlots: 1, repositories: { [manager.store.pool(acquired.lease.poolId)!.gitCommonDirectory]: { setupArgv: ["npm", "install"] } } }),
  });
  assert.equal(update.status, 200);
  assert.equal(manager.store.slot(acquired.lease.slotId)?.state, "leased", "capacity reduction has no cleanup side effect");
  assert.deepEqual(events.at(-1), { type: "worktrees_changed" });

  const invalid = await app.request("/api/worktrees/config", {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify({ maxSlots: 0 }),
  });
  assert.equal(invalid.status, 400);
});

test("preview/execute status vocabulary and injected terminal launcher stay exact", async () => {
  const inventory = await app.request("/api/worktrees", { headers: HEADERS });
  const body = await inventory.json() as { repositories: Array<{ slots: Array<{ id: string }> }> };
  const slotId = body.repositories[0]!.slots[0]!.id;

  const unknown = await app.request("/api/worktrees/actions/preview", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ action: "destroy", target: { kind: "slot", slotId: "missing" } }),
  });
  assert.equal(unknown.status, 404);

  const opened = await app.request(`/api/worktrees/${slotId}/open`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ backend: "wezterm" }),
  });
  assert.equal(opened.status, 200);
  assert.equal(launched.at(-1)?.cwd, await operations.slotPath(slotId));
  assert.deepEqual(launched.at(-1)?.argv.slice(-1), ["-l"]);

  const expired = await app.request("/api/worktrees/actions/execute", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ token: "00000000-0000-4000-8000-000000000000", acknowledgements: [] }),
  });
  assert.equal(expired.status, 409);
});

test("worktree routes fail with 503 when the singleton operation service is absent", async () => {
  const bare = buildApp(registry, new ReviewManager(registry), tasks, new QueueManager(registry));
  assert.equal((await bare.request("/api/worktrees", { headers: HEADERS })).status, 503);
});

test("legacy observation changes invalidate once and unexpected outages stay explicit", async () => {
  let version = "v2.1.1";
  let unavailable = false;
  const legacy = {
    capabilities: async () => ({ kind: "conditional-json" as const, version }),
    inventory: async () => {
      if (unavailable) throw new Error("provider read failed");
      return [];
    },
  } as unknown as LegacyTreehouseService;
  const events: unknown[] = [];
  const observer = new WorktreeOperationsService(manager, {
    legacy,
    tasks: { get: () => null, reclaim: (id) => tasks.reclaim(id) },
    checks,
    checkRecovery: async () => "unknown",
    notifyChanged: () => events.push({ type: "worktrees_changed" }),
    diskBytes: async () => 0,
  });
  await observer.inventory();
  await observer.inventory();
  assert.deepEqual(events, [], "restating the same legacy view emits nothing");
  version = "v2.2.0";
  await observer.inventory();
  assert.deepEqual(events, [{ type: "worktrees_changed" }]);
  unavailable = true;
  await assert.rejects(
    observer.inventory(),
    (error: unknown) => error instanceof Error && /legacy worktree inventory unavailable/.test(error.message),
  );
});
