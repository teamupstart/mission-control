import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

import type { MissionSchedule } from "../src/shared/schedules.ts";
import type { ServerEvent } from "../src/shared/types.ts";

// What is at stake: the Recurring Missions catalog is SSE state, not a second poller. The
// live map, the reconnect snapshot, and the two incremental events must all converge on ONE
// catalog - otherwise the dashboard is right until you reload it, or right only after you
// reload it. Archived schedules leave the LIVE collection (remove) but stay reachable through
// the page-oriented history route, which is deliberately not on this channel.
//
// The browser half is reduced from the same events `useEventStream` reduces, mirroring the
// ensemble/workflow SSE tests: the Registry emits, a Map is folded from the stream, and it
// has to equal the snapshot. The switch's compile-time exhaustiveness is enforced by tsc's
// `never` branch and covered by typecheck; here the runtime convergence is pinned.

const home = mkdtempSync(join(tmpdir(), "mission-schedule-sse-"));
process.env.MISSION_HOME = home;

const { openDb } = await import("../src/server/db.ts");
const store = await import("../src/server/schedules/store.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { ScheduleManager } = await import("../src/server/schedules/manager.ts");
type ScheduleManagerT = InstanceType<typeof ScheduleManager>;
type RegistryT = InstanceType<typeof Registry>;

after(() => rmSync(home, { recursive: true, force: true }));
openDb();

const T0 = Date.parse("2026-07-23T08:00:00Z");
const REPO = "/repos/main";
let uuidN = 0;

function managerFor(registry: RegistryT): ScheduleManagerT {
  return new ScheduleManager({
    tasks: new TaskManager(registry),
    now: () => T0,
    uuid: () => `sse-${++uuidN}`,
    resolveRepoRoot: async (path: string) =>
      path === REPO ? { ok: true as const, repoRoot: path } : { ok: false as const, error: "no repo" },
    notifier: {
      upsert: (schedule) => registry.upsertSchedule(schedule),
      remove: (id) => registry.removeSchedule(id),
    },
    log: () => {},
  });
}

function definition(over: Record<string, unknown> = {}) {
  return {
    name: "Nightly sweep",
    expression: "0 9 * * *",
    timezone: "UTC",
    overlapPolicy: "skip-active" as const,
    missedPolicy: "coalesce-latest" as const,
    completionPolicy: "manual" as const,
    template: {
      title: "Sweep",
      intent: "sweep",
      repoRoot: REPO,
      kind: "ship" as const,
      agent: "claude" as const,
      priority: null,
      labels: [],
      model: null,
      effort: null,
    },
    ...over,
  };
}

/** Retire every live schedule so a reconnect Registry sees only this test's rows. */
function resetCatalog(): void {
  for (const s of store.listSchedules()) store.archiveSchedule(s.id, T0 - 1);
}

/** The reduction `useEventStream` performs, kept honest against the same event stream. */
function reduceSchedules(events: ServerEvent[]): Map<string, MissionSchedule> {
  const map = new Map<string, MissionSchedule>();
  for (const event of events) {
    if (event.type === "snapshot") {
      map.clear();
      for (const schedule of event.schedules) map.set(schedule.id, schedule);
    } else if (event.type === "schedule_upsert") {
      map.set(event.schedule.id, event.schedule);
    } else if (event.type === "schedule_remove") {
      map.delete(event.id);
    }
  }
  return map;
}

test("snapshot, upsert, archive and reconnect produce one equivalent schedule catalog", async () => {
  resetCatalog();
  const registry = new Registry();
  assert.deepEqual(registry.snapshot().schedules, []);
  const empty = { type: "snapshot", ...registry.snapshot() } satisfies ServerEvent;
  assert.deepEqual(empty.type === "snapshot" ? empty.schedules : null, []);

  const events: ServerEvent[] = [];
  const unsub = registry.subscribe((e) => events.push(e));
  const manager = managerFor(registry);
  const created = await manager.create(definition());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(registry.snapshot().schedules.length, 1);
  const archived = await manager.archive(created.schedule.id);
  assert.ok(archived);
  unsub();

  assert.deepEqual(events.map((e) => e.type), ["schedule_upsert", "schedule_remove"]);
  assert.deepEqual(registry.snapshot().schedules, []);

  // Folding the incremental stream lands on the same catalog the snapshot serves.
  assert.deepEqual([...reduceSchedules(events).values()], registry.snapshot().schedules);

  // A browser that reconnects cold lands where one that watched every event did.
  const reconnect = new Registry();
  assert.deepEqual(reconnect.snapshot().schedules, registry.snapshot().schedules);
});

test("a schedule saved before this process started is in the first snapshot", async () => {
  resetCatalog();
  const seed = new Registry();
  const created = await managerFor(seed).create(definition({ name: "Persisted" }));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  // A fresh Registry loads non-archived schedules from the store in its constructor.
  const cold = new Registry();
  assert.ok(cold.snapshot().schedules.some((s) => s.id === created.schedule.id));
});

test("a reconnect snapshot replaces stale schedule map contents", async () => {
  resetCatalog();
  const registry = new Registry();
  const manager = managerFor(registry);
  const a = await manager.create(definition({ name: "A" }));
  assert.ok(a.ok);
  if (!a.ok) return;

  // A browser's live map after watching A appear.
  const browser = new Map(registry.snapshot().schedules.map((s) => [s.id, s]));
  assert.equal(browser.size, 1);

  // While the browser is disconnected, A is archived and B is created.
  await manager.archive(a.schedule.id);
  const b = await manager.create(definition({ name: "B" }));
  assert.ok(b.ok);
  if (!b.ok) return;

  // Reconnect replaces the map wholesale from the snapshot: A is gone, B is present. A merge
  // would leave the archived A on screen for ever.
  const replaced = reduceSchedules([{ type: "snapshot", ...registry.snapshot() } as ServerEvent]);
  assert.equal(replaced.size, 1);
  assert.ok(replaced.has(b.schedule.id));
  assert.ok(!replaced.has(a.schedule.id));
});

test("schedule upsert and remove events mutate the reduced MissionState collection", async () => {
  resetCatalog();
  const registry = new Registry();
  const events: ServerEvent[] = [];
  const unsub = registry.subscribe((e) => events.push(e));
  const manager = managerFor(registry);
  const created = await manager.create(definition());
  assert.ok(created.ok);
  if (!created.ok) return;
  // Pause is an upsert, not a remove: the schedule is still in the catalog, just disabled.
  await manager.setEnabled(created.schedule.id, false);
  await manager.archive(created.schedule.id);
  unsub();

  assert.deepEqual(events.map((e) => e.type), [
    "schedule_upsert",
    "schedule_upsert",
    "schedule_remove",
  ]);
  assert.equal(reduceSchedules(events).size, 0);
});

test("the schedule catalog rides SSE only - no poll of /api/schedules", () => {
  // The whole promise of live-state ownership: the hook fetches nothing to reconcile the
  // catalog. If a poll of /api/schedules is ever added here, this fails and the reviewer has
  // to justify the second source of truth.
  const source = readFileSync(
    fileURLToPath(new URL("../src/web/useEventStream.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(!source.includes("/api/schedules"), "useEventStream must not fetch /api/schedules");
  assert.ok(!source.includes("fetch("), "useEventStream must not fetch at all");
});
