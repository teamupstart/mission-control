import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  MissionSchedule,
  ScheduleHistoryPage,
  ScheduleOccurrence,
  SchedulePreviewResult,
} from "../src/shared/schedules.ts";
import type { ServerEvent } from "../src/shared/types.ts";

// What is at stake: these routes are the ONLY door an operator has onto a subsystem that
// spends money, and a route that maps an outcome to the wrong status - a not-a-repo saved as
// a 200, a sub-hour cadence accepted, a Run now that silently moves the cron cursor - is a
// mistake nobody sees until an agent task appears that nobody scheduled. The routes are thin
// adapters, so what is pinned here is exactly the mapping: shape validation through
// parseBody, existence and archive to 404, service validation to a field-carrying 400, and
// the two write-free reads (preview, history) staying write-free.
//
// It runs against a REAL schedule service, a real TaskManager, and an isolated database:
// the point of Phase 3 is that the routes reopen no policy, so a fake service would only
// prove the routes call the methods they call. The clock, uuid allocation, and the repo
// resolver are injected because they are the only things a request cannot drive - a fixed
// clock makes cursor assertions deterministic, and a resolver a test controls is how a
// non-repo is refused without touching the disk.

const home = mkdtempSync(join(tmpdir(), "mission-schedule-http-"));
process.env.MISSION_HOME = home;

const { openDb } = await import("../src/server/db.ts");
const store = await import("../src/server/schedules/store.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { ScheduleManager } = await import("../src/server/schedules/manager.ts");
const { buildApp } = await import("../src/server/routes.ts");
type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;

after(() => rmSync(home, { recursive: true, force: true }));
openDb();

const T0 = Date.parse("2026-07-23T08:00:00Z");
const NINE = Date.parse("2026-07-23T09:00:00Z");
const REPO = "/repos/main";

const registry = new Registry();
const tasks = new TaskManager(registry);
let uuidN = 0;
const manager = new ScheduleManager({
  tasks,
  now: () => T0,
  uuid: () => `http-${++uuidN}`,
  // Canonicalizes any path under REPO to REPO itself, and refuses everything else. This is
  // how "create canonicalizes the repo root" and "create refuses a non-repo" are both
  // provable without a real checkout on disk.
  resolveRepoRoot: async (path: string) =>
    path === REPO || path.startsWith(`${REPO}/`)
      ? { ok: true as const, repoRoot: REPO }
      : { ok: false as const, error: `not a git repository: ${path}` },
  notifier: {
    upsert: (schedule) => registry.upsertSchedule(schedule),
    remove: (id) => registry.removeSchedule(id),
  },
  log: () => {},
});

const app = buildApp(
  registry,
  {} as ReviewManager,
  tasks,
  {} as QueueManager,
  undefined,
  undefined,
  undefined,
  manager,
);

const LOOPBACK = { host: "127.0.0.1:7317" };
const authed = { ...LOOPBACK, "content-type": "application/json" };

function definition(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Nightly sweep",
    expression: "0 9 * * *",
    timezone: "UTC",
    overlapPolicy: "skip-active",
    missedPolicy: "coalesce-latest",
    template: {
      title: "Sweep the inbox",
      intent: "Read the inbox and file whatever needs filing.",
      repoRoot: REPO,
      kind: "ship",
      agent: "claude",
      priority: null,
      labels: [],
      model: null,
      effort: null,
    },
    ...over,
  };
}

/** Retire every live schedule so each test's counts and reconnects are attributable. */
function resetCatalog(): void {
  for (const s of store.listSchedules()) store.archiveSchedule(s.id, T0 - 1);
}

async function get(path: string): Promise<Response> {
  return app.request(path, { headers: LOOPBACK });
}
async function post(path: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: authed,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createSchedule(over: Record<string, unknown> = {}): Promise<MissionSchedule> {
  const res = await post("/api/schedules", definition(over));
  // Read the body once. `await res.text()` inside an assert message would consume it before
  // the json() below, so failures report from a clone instead.
  if (res.status !== 201) assert.fail(`create failed ${res.status}: ${await res.clone().text()}`);
  return (await res.json()) as MissionSchedule;
}

test("GET /api/schedules lists the live catalog and matches the SSE snapshot", async () => {
  resetCatalog();
  const created = await createSchedule({ name: "Catalog row" });
  const res = await get("/api/schedules");
  assert.equal(res.status, 200);
  const list = (await res.json()) as MissionSchedule[];
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, created.id);
  // The route returns the same live collection the snapshot carries.
  assert.deepEqual(list, registry.snapshot().schedules);
});

test("create canonicalizes the repo root and refuses a non-repo on the repoRoot field", async () => {
  resetCatalog();
  // A path UNDER the repo comes back canonicalized to the repo root.
  const nested = await createSchedule({ template: (definition().template as Record<string, unknown>) });
  assert.equal(nested.template?.repoRoot, REPO);
  const undernested = await createSchedule({
    template: { ...(definition().template as Record<string, unknown>), repoRoot: `${REPO}/packages/app` },
  });
  assert.equal(undernested.template?.repoRoot, REPO);

  const bad = await post(
    "/api/schedules",
    definition({ template: { ...(definition().template as Record<string, unknown>), repoRoot: "/tmp/not-a-repo" } }),
  );
  assert.equal(bad.status, 400);
  const body = (await bad.json()) as { error: string; field?: string };
  assert.equal(body.field, "repoRoot");
});

test("create rejects an unsupported execution mode and a non-null runner id", async () => {
  resetCatalog();
  const mode = await post("/api/schedules", definition({ executionMode: "os-wake" }));
  assert.equal(mode.status, 400);
  const runner = await post("/api/schedules", definition({ runnerId: "home-server" }));
  assert.equal(runner.status, 400);
});

test("every schedule mutation rejects a malformed body through parseBody", async () => {
  resetCatalog();
  const schedule = await createSchedule();
  // Missing required fields.
  assert.equal((await post("/api/schedules", {})).status, 400);
  // Four cron fields, not five - refused at the shape layer.
  assert.equal((await post("/api/schedules", definition({ expression: "0 9 * *" }))).status, 400);
  // Update on an existing schedule still validates the body first.
  assert.equal((await post(`/api/schedules/${schedule.id}/update`, { name: "" })).status, 400);
  // set-enabled needs a boolean.
  assert.equal((await post(`/api/schedules/${schedule.id}/set-enabled`, {})).status, 400);
  // Run now is bodyless: a stray key is refused, not ignored.
  assert.equal((await post(`/api/schedules/${schedule.id}/run-now`, { force: true })).status, 400);
  // Archive is bodyless too.
  assert.equal((await post(`/api/schedules/${schedule.id}/archive`, { hard: true })).status, 400);
});

test("mutations on a missing or archived schedule are 404, not 400", async () => {
  resetCatalog();
  assert.equal((await post("/api/schedules/nope/update", definition())).status, 404);
  assert.equal((await post("/api/schedules/nope/set-enabled", { enabled: true })).status, 404);
  assert.equal((await post("/api/schedules/nope/run-now", {})).status, 404);
  assert.equal((await get("/api/schedules/nope/occurrences")).status, 404);

  const schedule = await createSchedule();
  assert.equal((await post(`/api/schedules/${schedule.id}/archive`, {})).status, 200);
  // Archived: present in history but out of the editable catalog.
  assert.equal((await post(`/api/schedules/${schedule.id}/update`, definition())).status, 404);
  assert.equal((await post(`/api/schedules/${schedule.id}/set-enabled`, { enabled: true })).status, 404);
  assert.equal((await post(`/api/schedules/${schedule.id}/run-now`, {})).status, 404);
});

test("preview accepts the same definition as save and writes nothing", async () => {
  resetCatalog();
  const before = store.listSchedules().length;
  const events: ServerEvent[] = [];
  const unsub = registry.subscribe((e) => events.push(e));
  const res = await post("/api/schedules/preview", definition());
  unsub();
  assert.equal(res.status, 200);
  const result = (await res.json()) as SchedulePreviewResult;
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.instants.length, 10);
  assert.ok(result.instants.every((i) => typeof i.at === "number"));
  // Non-mutating: no schedule was written and no ServerEvent was emitted.
  assert.equal(store.listSchedules().length, before);
  assert.deepEqual(events, []);
  // The exact body that just previewed also saves.
  assert.equal((await post("/api/schedules", definition())).status, 201);
});

test("preview bounds the count and validates the standby window", async () => {
  resetCatalog();
  assert.equal((await post("/api/schedules/preview", definition({ count: 5 }))).status, 400);
  assert.equal((await post("/api/schedules/preview", definition({ count: 60 }))).status, 400);
  // A lone standby timestamp describes no window.
  assert.equal(
    (await post("/api/schedules/preview", definition({ sleepStartedAt: T0 }))).status,
    400,
  );
  // Resumed before slept describes one that ran backwards.
  assert.equal(
    (await post("/api/schedules/preview", definition({ sleepStartedAt: T0, resumedAt: T0 - 1000 }))).status,
    400,
  );
  // Both, ordered: accepted.
  const ok = await post(
    "/api/schedules/preview",
    definition({ sleepStartedAt: T0 - 3 * 24 * 3600_000, resumedAt: T0 }),
  );
  assert.equal(ok.status, 200);
});

test("save paused holds no cursor; save enabled computes the next run", async () => {
  resetCatalog();
  const paused = await createSchedule({ enabled: false });
  assert.equal(paused.enabled, false);
  assert.equal(paused.nextRunAt, null);
  const live = await createSchedule({ enabled: true });
  assert.equal(live.enabled, true);
  assert.equal(live.nextRunAt, NINE);
});

test("pause then resume recomputes the cursor from the resume anchor", async () => {
  resetCatalog();
  const schedule = await createSchedule({ enabled: true });
  assert.equal(schedule.nextRunAt, NINE);

  const paused = (await (await post(`/api/schedules/${schedule.id}/set-enabled`, { enabled: false })).json()) as MissionSchedule;
  assert.equal(paused.enabled, false);
  assert.equal(paused.nextRunAt, null);

  const resumed = (await (await post(`/api/schedules/${schedule.id}/set-enabled`, { enabled: true })).json()) as MissionSchedule;
  assert.equal(resumed.enabled, true);
  // Recomputed strictly after the fixed clock (08:00), so the next 09:00 - never a debt of
  // the runs it slept through.
  assert.equal(resumed.nextRunAt, NINE);
});

test("Run now works paused, records an occurrence, and leaves the cron cursor untouched", async () => {
  resetCatalog();
  const schedule = await createSchedule({ enabled: false });
  assert.equal(schedule.nextRunAt, null);
  const res = await post(`/api/schedules/${schedule.id}/run-now`, {});
  if (res.status !== 200) assert.fail(`run-now failed ${res.status}: ${await res.clone().text()}`);
  const body = (await res.json()) as { occurrence: ScheduleOccurrence; schedule: MissionSchedule };
  assert.equal(body.occurrence.triggerKind, "manual");
  assert.equal(body.occurrence.status, "created");
  assert.ok(body.occurrence.taskId);
  // A paused schedule that was Run now is still paused, still holds no cron cursor.
  assert.equal(body.schedule.enabled, false);
  assert.equal(body.schedule.nextRunAt, null);
});

test("archive is idempotent, emits remove after commit, and keeps direct history", async () => {
  resetCatalog();
  const schedule = await createSchedule({ enabled: false });
  // Give it one real occurrence to preserve.
  await post(`/api/schedules/${schedule.id}/run-now`, {});

  const events: ServerEvent[] = [];
  const unsub = registry.subscribe((e) => events.push(e));
  const first = await post(`/api/schedules/${schedule.id}/archive`, {});
  assert.equal(first.status, 200);
  const second = await post(`/api/schedules/${schedule.id}/archive`, {});
  assert.equal(second.status, 200);
  unsub();
  // The archive announced a removal from the live catalog - after the durable write.
  assert.ok(events.some((e) => e.type === "schedule_remove" && e.id === schedule.id));
  assert.ok(!registry.snapshot().schedules.some((s) => s.id === schedule.id));

  // History outlives the catalog entry: the page still names its (archived) schedule and
  // carries the occurrence Run now filed.
  const hist = await get(`/api/schedules/${schedule.id}/occurrences`);
  assert.equal(hist.status, 200);
  const page = (await hist.json()) as ScheduleHistoryPage;
  assert.notEqual(page.schedule.archivedAt, null);
  assert.equal(page.occurrences.length, 1);
});

test("occurrence history refuses an unparseable cursor or an out-of-range limit", async () => {
  resetCatalog();
  const schedule = await createSchedule();
  assert.equal((await get(`/api/schedules/${schedule.id}/occurrences?before=abc`)).status, 400);
  assert.equal((await get(`/api/schedules/${schedule.id}/occurrences?limit=0`)).status, 400);
  assert.equal((await get(`/api/schedules/${schedule.id}/occurrences?limit=1000`)).status, 400);
  // A valid empty query is fine.
  assert.equal((await get(`/api/schedules/${schedule.id}/occurrences`)).status, 200);
});

test("the SSE snapshot includes the live schedule collection", async () => {
  resetCatalog();
  const created = await createSchedule();
  const snapshot = { type: "snapshot", ...registry.snapshot() } satisfies ServerEvent;
  assert.equal(snapshot.type, "snapshot");
  if (snapshot.type !== "snapshot") return;
  assert.ok(snapshot.schedules.some((s) => s.id === created.id));
});
