// Writes, restores and reconnects must agree without losing choices from another build.
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { registerHooks } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { ServerEvent } from "../src/shared/types.ts";
import type { FeatureFlagId } from "../src/shared/feature-flags.ts";

const home = mkdtempSync(join(tmpdir(), "mission-feature-flags-"));
process.env.MISSION_HOME = home;
// Substitute the same module for HTTP intent validation and daemon gate resolution.
const registryUrl = new URL("../src/shared/feature-flag-registry.ts", import.meta.url).href;
const fixtureUrl = new URL("./fixtures/feature-flag-registry.ts", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    return resolved.url === registryUrl ? { ...resolved, url: fixtureUrl } : resolved;
  },
});
const { openDb, closeDb, setAppConfig, getAppConfig } = await import("../src/server/db.ts");
const { APP_CONFIG_ENTRIES } = await import("../src/shared/app-config-entries.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const flags = await import("../src/server/feature-flags/index.ts");
const { WorkflowStore } = await import("../src/server/workflows/store.ts");
const { SettingsBackupService } = await import("../src/server/settings-backups/service.ts");
const { SettingsBackupStore } = await import("../src/server/settings-backups/store.ts");
const { createSettingsBackupEnvelope } = await import("../src/server/settings-backups/format.ts");
const headers = { host: "127.0.0.1:7317", "content-type": "application/json" };
const bridges: Array<() => void> = [];
beforeEach(() => {
  setAppConfig(APP_CONFIG_ENTRIES.featureFlags, { enableAll: false, overrides: {} });
  flags.reloadFeatureFlags();
});
afterEach(() => { for (const stop of bridges.splice(0)) stop(); });
after(() => { closeDb(); hooks.deregister(); rmSync(home, { recursive: true, force: true }); });

function fixture() {
  const registry = new Registry();
  // Match daemon composition: one subscription, independent of all route/restore callers.
  bridges.push(flags.onFeatureFlagsChanged((config) => registry.emitFeatureFlags(config)));
  const events: ServerEvent[] = [];
  registry.subscribe((event) => events.push(event));
  const app = buildApp({ registry, reviews: new ReviewManager(registry), tasks: new TaskManager(registry),
    queues: new QueueManager(registry) });
  const put = (body: unknown) => app.request("/api/feature-flags", { method: "PUT", headers, body: JSON.stringify(body) });
  return { registry, events, app, put };
}

test("GET defaults; validated PUT persists, notifies, emits once, and reaches reconnect snapshots", async () => {
  const { registry, events, app, put } = fixture();
  assert.deepEqual(await (await app.request("/api/feature-flags", { headers })).json(), { config: { enableAll: false, overrides: {} } });
  let notified = 0;
  const unsubscribe = flags.onFeatureFlagsChanged((config) => {
    assert.equal(config, flags.getFeatureFlagsConfig(), "updated before listeners run");
    notified++;
  });
  try {
    assert.equal((await put({ kind: "master", enabled: true })).status, 200);
    const intent = { kind: "flag", id: "fixture-preview", enabled: false };
    assert.equal((await put(intent)).status, 200);
    assert.equal((await put(intent)).status, 200);
    const expected = { enableAll: true, overrides: { "fixture-preview": false } };
    assert.deepEqual(getAppConfig(APP_CONFIG_ENTRIES.featureFlags), expected);
    assert.deepEqual(registry.snapshot().featureFlags, expected);
    assert.deepEqual(events.filter((event) => event.type === "feature_flags"), [
      { type: "feature_flags", config: { enableAll: true, overrides: {} } },
      { type: "feature_flags", config: expected },
    ]);
    assert.equal(notified, 2);
    for (const body of [{ kind: "flag", id: "unknown", enabled: true }, { kind: "master", enabled: "yes" }, {}]) {
      assert.equal((await put(body)).status, 400);
    }
    assert.deepEqual(flags.getFeatureFlagsConfig(), expected);
    assert.equal(events.filter((event) => event.type === "feature_flags").length, 2);
  } finally { unsubscribe(); }
  await put({ kind: "master", enabled: false });
  assert.equal(notified, 2, "unsubscribe removes listener");
});

test("full-record suppression notices a value change and ignores key insertion order", () => {
  const { registry, events } = fixture();
  registry.emitFeatureFlags({ enableAll: false, overrides: { first: true, second: false } });
  registry.emitFeatureFlags({ enableAll: false, overrides: { second: false, first: true } });
  registry.emitFeatureFlags({ enableAll: false, overrides: { second: true, first: true } });
  assert.equal(events.filter((e) => e.type === "feature_flags").length, 2);
});

test("a choice made during Registry delivery reaches every window after the outer choice", async () => {
  const { registry, put } = fixture();
  const windows: ServerEvent[][] = [[], []];
  const off = registry.subscribe((event) => {
    if (event.type === "feature_flags" && event.config.enableAll) {
      flags.applyFeatureFlagIntent({ kind: "master", enabled: false });
    }
  });
  const offWindows = windows.map((events) => registry.subscribe((event) => {
    if (event.type === "feature_flags") events.push(event);
  }));
  try {
    const response = await put({ kind: "master", enabled: true });
    const latest = { enableAll: false, overrides: {} };
    assert.deepEqual(getAppConfig(APP_CONFIG_ENTRIES.featureFlags), latest);
    assert.deepEqual(flags.getFeatureFlagsConfig(), latest);
    assert.deepEqual(registry.snapshot().featureFlags, latest);
    for (const events of windows) assert.deepEqual(events, [
      { type: "feature_flags", config: { enableAll: true, overrides: {} } },
      { type: "feature_flags", config: latest },
    ]);
    assert.deepEqual(await response.json(), { config: latest });
  } finally { off(); offWindows.forEach((unsubscribe) => unsubscribe()); }
});

test("reentrant daemon listeners receive each committed config in order", () => {
  const seen: boolean[] = [];
  const offWrite = flags.onFeatureFlagsChanged((config) => {
    if (config.enableAll) flags.applyFeatureFlagIntent({ kind: "master", enabled: false });
  });
  const offRead = flags.onFeatureFlagsChanged((config) => seen.push(config.enableAll));
  try {
    flags.applyFeatureFlagIntent({ kind: "master", enabled: true });
    assert.deepEqual(seen, [true, false]);
  } finally { offWrite(); offRead(); }
});

test("direct daemon choices publish to connected registries without a route call", () => {
  const { events } = fixture();
  flags.applyFeatureFlagIntent({ kind: "master", enabled: true });
  flags.applyFeatureFlagIntent({ kind: "master", enabled: true });
  assert.deepEqual(events.filter((event) => event.type === "feature_flags"), [
    { type: "feature_flags", config: { enableAll: true, overrides: {} } },
  ]);
});

test("a daemon listener's nested choice keeps HTTP, gates and both windows on the latest config", async () => {
  // Register before the Registry bridge too: delivery order must not depend on composition order.
  const off = flags.onFeatureFlagsChanged((config) => {
    if (config.enableAll && !Object.hasOwn(config.overrides, "fixture-preview")) {
      flags.applyFeatureFlagIntent({ kind: "flag", id: "fixture-preview", enabled: false });
    }
  });
  const { registry, events, put } = fixture();
  const peer: ServerEvent[] = [];
  const offPeer = registry.subscribe((event) => { if (event.type === "feature_flags") peer.push(event); });
  try {
    const response = await put({ kind: "master", enabled: true });
    const latest = { enableAll: true, overrides: { "fixture-preview": false } };
    const expected = [
      { type: "feature_flags", config: { enableAll: true, overrides: {} } },
      { type: "feature_flags", config: latest },
    ];
    assert.deepEqual(events.filter((event) => event.type === "feature_flags"), expected);
    assert.deepEqual(peer, expected);
    assert.deepEqual(await response.json(), { config: latest });
    assert.deepEqual(registry.snapshot().featureFlags, latest);
    assert.deepEqual(getAppConfig(APP_CONFIG_ENTRIES.featureFlags), latest);
    assert.equal(flags.featureEnabled("fixture-preview" as FeatureFlagId), false);
  } finally { off(); offPeer(); }
});

test("HTTP choices and daemon gates use the same declared registry", async () => {
  const { put } = fixture();
  const id = "fixture-preview" as FeatureFlagId;
  const gated = new Hono();
  gated.get("/preview", flags.requireFeature(id), (c) => c.text("visible"));
  for (const enabled of [true, false]) {
    const response = await put({ kind: "flag", id, enabled });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { config: { enableAll: false, overrides: { [id]: enabled } } });
    assert.equal(flags.featureEnabled(id), enabled);
    assert.equal((await gated.request("/preview")).status, enabled ? 200 : 404);
  }
  assert.equal((await put({ kind: "flag", id: "unknown", enabled: true })).status, 400);
});

test("throwing subscribers do not prevent persistence or later subscribers", (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args));
  const offThrow = flags.onFeatureFlagsChanged(() => { throw new Error("fixture failure"); });
  let calls = 0;
  const offGood = flags.onFeatureFlagsChanged(() => { calls++; });
  try {
    assert.equal(flags.applyFeatureFlagIntent({ kind: "master", enabled: true }).ok, true);
    assert.equal(calls, 1);
    assert.equal(warnings.length, 1);
    assert.equal(getAppConfig(APP_CONFIG_ENTRIES.featureFlags)?.enableAll, true);
  } finally { offThrow(); offGood(); }
});

test("bounded writes fail atomically; middleware refuses an unknown flag even with enableAll", async () => {
  const { put } = fixture();
  const full = { enableAll: true, overrides: Object.fromEntries(Array.from({ length: 512 }, (_, i) => [`future-${i}`, false])) };
  setAppConfig(APP_CONFIG_ENTRIES.featureFlags, full);
  flags.reloadFeatureFlags();
  assert.equal((await put({ kind: "flag", id: "fixture-preview", enabled: true })).status, 500);
  assert.deepEqual(flags.getFeatureFlagsConfig(), full);
  assert.deepEqual(getAppConfig(APP_CONFIG_ENTRIES.featureFlags), full);
  assert.equal(flags.featureEnabled("constructor" as FeatureFlagId), false);
  const gated = new Hono();
  gated.get("/hidden", flags.requireFeature("unknown" as FeatureFlagId), (c) => c.text("visible"));
  const response = await gated.request("/hidden");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "This feature is disabled.", feature: "unknown" });
});

test("real settings restore reloads the cache, subscribers and event; legacy backup leaves flags alone", async () => {
  const { registry, events } = fixture();
  flags.applyFeatureFlagIntent({ kind: "flag", id: "fixture-preview", enabled: false });
  const backupStore = new SettingsBackupStore(join(home, "snapshots"));
  const service = new SettingsBackupService(new WorkflowStore(openDb()), backupStore,
    () => new Date("2026-11-18T12:00:00Z"), "test", {
      // No Registry passed to restore: the daemon's shared subscription owns publication.
      preflightSkills: () => [], preflightCost: () => {}, reconcileSkills: () => {}, reconcileCost: () => {},
    });
  const saved = await service.ensureDailySnapshot();
  assert.equal(saved.status, "ready");
  flags.applyFeatureFlagIntent({ kind: "master", enabled: true, enableDisabled: true });
  events.length = 0;
  let notifications = 0;
  const unsubscribe = flags.onFeatureFlagsChanged(() => { notifications++; });
  try {
    const result = await service.restore(saved.snapshot.id, saved.snapshot.digest);
    assert.equal(result.status, "restored");
    if (result.status === "restored") assert.deepEqual(result.warnings, []);
    const expected = { enableAll: false, overrides: { "fixture-preview": false } };
    assert.deepEqual(flags.getFeatureFlagsConfig(), expected);
    assert.deepEqual(registry.snapshot().featureFlags, expected);
    assert.deepEqual(events.filter((event) => event.type === "feature_flags"), [{ type: "feature_flags", config: expected }]);
    assert.equal(notifications, 1);
    const { digest: _digest, ...body } = saved.snapshot;
    const legacy = createSettingsBackupEnvelope({ ...body, id: "daily-2026-11-17", localDate: "2026-11-17",
      domains: body.domains.filter((domain) => domain.domain !== "feature-flags") });
    backupStore.write(legacy);
    flags.applyFeatureFlagIntent({ kind: "master", enabled: true });
    assert.equal((await service.restore(legacy.id, legacy.digest)).status, "restored");
    assert.deepEqual(flags.getFeatureFlagsConfig(), { ...expected, enableAll: true });
  } finally { unsubscribe(); }
});

test("reopened database reads persisted choices instead of retaining cached state or subscribers", () => {
  flags.applyFeatureFlagIntent({ kind: "master", enabled: true });
  let calls = 0;
  const off = flags.onFeatureFlagsChanged(() => { calls++; });
  closeDb();
  assert.equal(flags.getFeatureFlagsConfig().enableAll, true);
  flags.applyFeatureFlagIntent({ kind: "master", enabled: false });
  assert.equal(calls, 0);
  off();
});
