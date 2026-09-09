import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { QueueManager } from "../src/server/queue.ts";
import type { ServerEvent, SettingsStatus } from "../src/shared/types.ts";
import type { TaskSourceInstance } from "../src/shared/task-source.ts";

// What is at stake: the Settings rail dots and the topbar gear are meant to be right
// whenever the app is open, which is only true if the daemon PUSHES the small status tuple
// on the writes that move it. Two failure modes matter. A write that changes a fact and
// emits nothing leaves the dots lying until the next full snapshot - a live Inspector shown
// dark, a failing source shown clean. And the snapshot itself has to carry the tuple, or a
// dashboard opened before any write happens sits blank over subsystems that are already
// armed. Both are exercised here against real stores through `buildApp`, per the house
// pattern, because the whole point is the read reflecting what a route just wrote.
//
// The reverse contract - a dashboard OLD enough not to know this event - is not tested here
// because it is not the daemon's to keep: `useEventStream`'s switch has a `default` branch
// that warns once and continues, so an unknown variant is ignored rather than thrown on.
// That branch predates this change; `session-contracts.test.ts` pins the exhaustiveness
// that keeps the NEW client's own case from silently falling out of the switch.

const home = mkdtempSync(join(tmpdir(), "mission-settings-status-"));
const bin = join(home, "bin");
const fakeGh = join(bin, "gh");
const previousGhBin = process.env.MISSION_GH_BIN;
const previousConductorBin = process.env.MISSION_CONDUCTOR_BIN;
mkdirSync(bin);
// A `gh` that fails deterministically, so a github-issues sweep records an error and the
// failing count moves - the transition the red dot exists to show. A non-zero exit becomes
// `{items: [], error}` (never an empty success), so the sweep returns rather than throws.
writeFileSync(fakeGh, "#!/bin/sh\necho 'gh: boom' 1>&2\nexit 1\n");
chmodSync(fakeGh, 0o755);
process.env.HARNESS_HOME = join(home, "state");
process.env.MISSION_GH_BIN = fakeGh;
// Presence detection has its own binary seam. Point it at a missing fixture path so an
// operator's installed Conductor cannot flip the status this test promises is absent.
process.env.MISSION_CONDUCTOR_BIN = join(bin, "no-such-conductor");

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { settingsStatus } = await import("../src/server/settings-status.ts");
const { setInspectorConfig } = await import("../src/server/inspector/config.ts");
const { setShippingConfig } = await import("../src/server/shipping/config.ts");
const { setTaskSourcesConfig } = await import("../src/server/task-sources/config.ts");
const { sweepOnce } = await import("../src/server/task-sources/sweeper.ts");

after(() => {
  rmSync(home, { recursive: true, force: true });
  if (previousGhBin === undefined) delete process.env.MISSION_GH_BIN;
  else process.env.MISSION_GH_BIN = previousGhBin;
  if (previousConductorBin === undefined) delete process.env.MISSION_CONDUCTOR_BIN;
  else process.env.MISSION_CONDUCTOR_BIN = previousConductorBin;
});
// A fresh config store per test, so one test's armed YOLO does not read into the next. The
// sweeper's in-memory health map is process-global and is NOT cleared here, so each source
// carries a UNIQUE id and the compose reads only sources that are in the (cleared) config.
beforeEach(() => openDb().exec("DELETE FROM app_config"));

const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

const isStatus = (e: ServerEvent): e is Extract<ServerEvent, { type: "settings_status" }> =>
  e.type === "settings_status";

function setup() {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const app = buildApp({
    registry,
    reviews: {} as unknown as ReviewManager,
    tasks,
    queues: {} as unknown as QueueManager,
  });
  const events: ServerEvent[] = [];
  registry.subscribe((e) => events.push(e));
  return { registry, tasks, app, statuses: () => events.filter(isStatus) };
}

async function put(app: ReturnType<typeof setup>["app"], path: string, body: unknown): Promise<Response> {
  return app.request(path, { method: "PUT", headers: HEADERS, body: JSON.stringify(body) });
}

/** A github-issues source pointed at the throwaway home, so its sweep hits the failing gh. */
function ghSource(id: string): TaskSourceInstance {
  return {
    id,
    kind: "github-issues",
    label: "issues",
    enabled: true,
    repoRoot: home,
    intervalMs: 900_000,
    defaults: { kind: "ship", agent: "claude", priority: null, labels: [], enabled: true },
    maxPerSweep: 25,
    config: {},
  } as TaskSourceInstance;
}

const ALL_OFF: SettingsStatus = {
  inspector: { enabled: false, mode: "dry-run" },
  shipping: { autoMerge: false },
  taskSources: { failing: 0 },
  // No engine at this test's configured binary path and nothing configured, which is what an
  // ordinary installation looks like and the state in which the Conductor rail row does not exist.
  pipelines: {
    present: false,
    observing: 0,
    observedRepoKeys: [],
    launchRuntime: "agent-sdk",
  },
};

// ---- compose ----

test("the compose reads the Inspector and Shipping stores", () => {
  assert.deepEqual(settingsStatus(), ALL_OFF);
  setInspectorConfig({ enabled: true, mode: "live" });
  setShippingConfig({ autoMerge: true });
  assert.deepEqual(settingsStatus().inspector, { enabled: true, mode: "live" });
  assert.equal(settingsStatus().shipping.autoMerge, true);
});

test("the compose counts a task source that failed its last sweep", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const inst = ghSource("compose-fail");
  setTaskSourcesConfig({ sources: [inst] });
  const report = await sweepOnce(inst, tasks);
  assert.ok(report.error, "the failing gh should surface an error on the report");
  assert.equal(settingsStatus().taskSources.failing, 1);
});

// ---- emission on the three writes + a sweep ----

test("PUT /api/inspector/config pushes the new tuple", async () => {
  const { app, statuses } = setup();
  const res = await put(app, "/api/inspector/config", { enabled: true, mode: "live" });
  assert.equal(res.status, 200);
  const last = statuses().at(-1);
  assert.ok(last, "a settings_status should have been emitted");
  assert.deepEqual(last.status.inspector, { enabled: true, mode: "live" });
});

test("PUT /api/shipping/config pushes the new tuple", async () => {
  const { app, statuses } = setup();
  const res = await put(app, "/api/shipping/config", { autoMerge: true });
  assert.equal(res.status, 200);
  assert.equal(statuses().at(-1)?.status.shipping.autoMerge, true);
});

test("PUT /api/task-sources/config recomposes from all three stores and pushes", async () => {
  // A fact set in ANOTHER store before this write: the handler recomposes rather than
  // patching, so the emitted tuple must carry it.
  setShippingConfig({ autoMerge: true });
  const { app, statuses } = setup();
  const res = await put(app, "/api/task-sources/config", { sources: [] });
  assert.equal(res.status, 200);
  const last = statuses().at(-1);
  assert.ok(last, "a settings_status should have been emitted");
  assert.equal(last.status.shipping.autoMerge, true);
});

test("a failing sweep over the route pushes a tuple whose failing count moved", async () => {
  const inst = ghSource("sweep-emit");
  setTaskSourcesConfig({ sources: [inst] });
  const { app, statuses } = setup();
  const res = await app.request(`/api/task-sources/${inst.id}/sweep`, { method: "POST", headers: HEADERS });
  assert.equal(res.status, 200);
  const last = statuses().at(-1);
  assert.ok(last, "the sweep should have pushed a settings_status");
  assert.equal(last.status.taskSources.failing, 1);
});

test("an unchanged recompose is suppressed rather than waking every browser", async () => {
  const { app, statuses } = setup();
  await put(app, "/api/shipping/config", { autoMerge: true });
  await put(app, "/api/shipping/config", { autoMerge: true });
  assert.equal(statuses().length, 1, "the identical second write should not emit again");
});

test("the suppression compares every field, so no change can be dropped in silence", () => {
  // The other half of the rule above, and the one that fails silently. A field missing from
  // the comparison is not compared loosely - it is a field whose change never reaches a
  // browser at all, because the tuple that moved only there compares equal and no frame is
  // sent. This includes exact observed repository keys, because A -> B at the same count
  // still has to invalidate an open Dispatch modal.
  //
  // Walked over the composed tuple rather than over a hand-written list, so a field added to
  // `SettingsStatus` is in this test the moment it exists.
  const registry = new Registry();
  const base = settingsStatus();
  const moved: Record<string, SettingsStatus> = {
    "inspector.enabled": { ...base, inspector: { ...base.inspector, enabled: !base.inspector.enabled } },
    "inspector.mode": {
      ...base,
      inspector: { ...base.inspector, mode: base.inspector.mode === "live" ? "dry-run" : "live" },
    },
    "shipping.autoMerge": { ...base, shipping: { autoMerge: !base.shipping.autoMerge } },
    "taskSources.failing": { ...base, taskSources: { failing: base.taskSources.failing + 1 } },
    "pipelines.present": { ...base, pipelines: { ...base.pipelines, present: !base.pipelines.present } },
    "pipelines.observing": {
      ...base,
      pipelines: { ...base.pipelines, observing: base.pipelines.observing + 1 },
    },
    "pipelines.launchRuntime": {
      ...base,
      pipelines: {
        ...base.pipelines,
        launchRuntime: base.pipelines.launchRuntime === "terminal" ? "agent-sdk" : "terminal",
      },
    },
    "pipelines.observedRepoKeys": {
      ...base,
      pipelines: {
        ...base.pipelines,
        observedRepoKeys: [...(base.pipelines.observedRepoKeys ?? []), "ai-conductor::/moved"],
      },
    },
  };
  // Every leaf of the tuple has a case above. A new field with none is a field this test
  // cannot speak for, which is exactly the state `pipelines` was in.
  const leaves = Object.entries(base).flatMap(([group, value]) =>
    Object.keys(value as Record<string, unknown>).map((field) => `${group}.${field}`),
  );
  assert.deepEqual(
    leaves.filter((leaf) => !(leaf in moved)),
    [],
    "add the new SettingsStatus field to this test's `moved` map",
  );

  for (const [leaf, status] of Object.entries(moved)) {
    const events: ServerEvent[] = [];
    registry.emitSettingsStatus(base);
    const unsubscribe = registry.subscribe((e) => events.push(e));
    registry.emitSettingsStatus(status);
    unsubscribe();
    assert.equal(events.filter(isStatus).length, 1, `a change to ${leaf} must reach the browser`);
  }
});

// ---- snapshot ----

test("the snapshot carries the composed tuple so a fresh dashboard is not blank", () => {
  const { registry } = setup();
  assert.deepEqual(registry.snapshot().settingsStatus, settingsStatus());
  setInspectorConfig({ enabled: true, mode: "live" });
  // Composed fresh on each snapshot, so a later write is reflected without a restart.
  assert.equal(registry.snapshot().settingsStatus.inspector.mode, "live");
});
