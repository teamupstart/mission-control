import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { closeDb, openDb } from "../src/server/db.ts";
import { Registry } from "../src/server/registry.ts";

beforeEach(() => openDb().exec("DELETE FROM claude_rate_limit_cache"));

test("Claude's exhausted quota survives closing the database and rebuilding the Registry", () => {
  const registry = new Registry();
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  registry.applyStatusLine({
    sessionId: "exhausted", cwd: null, env: {},
    rateLimits: { fiveHour: { usedPercentage: 100, resetsAt } },
  });
  assert.equal(registry.snapshot().fleetCost?.rateLimits?.fiveHour?.usedPercentage, 100);
  closeDb();
  openDb();
  const restored = new Registry();
  assert.equal(restored.snapshot().fleetCost?.rateLimits?.fiveHour?.usedPercentage, 100);
  restored.applyStatusLine({ sessionId: "unavailable", cwd: null, env: {} });
  assert.equal(restored.snapshot().fleetCost?.rateLimits?.fiveHour?.usedPercentage, 100);
});

test("partial updates preserve each window's value and recording time across restarts", () => {
  const registry = new Registry();
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  registry.applyStatusLine({ sessionId: "first", cwd: null, env: {}, rateLimits: {
    fiveHour: { usedPercentage: 95, resetsAt },
    sevenDay: { usedPercentage: 90, resetsAt: resetsAt + 86_400 },
  } });
  const first = registry.snapshot().fleetCost!.lastKnownRateLimits!;
  registry.applyStatusLine({ sessionId: "partial", cwd: null, env: {}, rateLimits: {
    sevenDay: { usedPercentage: 98, resetsAt: resetsAt + 86_400 },
  } });
  const restored = new Registry().snapshot().fleetCost!;
  assert.deepEqual(restored.lastKnownRateLimits?.fiveHour, first.fiveHour);
  assert.equal(restored.lastKnownRateLimits?.sevenDay?.usedPercentage, 98);
  assert.equal(openDb().prepare("SELECT count(*) AS n FROM claude_rate_limit_cache").get()!.n, 1);
});

test("expired windows survive as historical readings without entering current quota", () => {
  const registry = new Registry();
  registry.applyStatusLine({ sessionId: "expired", cwd: null, env: {}, rateLimits: {
    fiveHour: { usedPercentage: 100, resetsAt: Math.floor(Date.now() / 1000) - 1 },
  } });
  const restored = new Registry().snapshot().fleetCost!;
  assert.equal(restored.rateLimits, null);
  assert.equal(restored.lastKnownRateLimits?.fiveHour?.usedPercentage, 100);
  assert.ok(restored.lastKnownRateLimits?.fiveHour?.recordedAt);
});

test("an existing database acquires the quota cache without losing its settings", () => {
  const db = openDb();
  db.exec("DROP TABLE claude_rate_limit_cache");
  db.prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)")
    .run("claude-quota-upgrade-sentinel", JSON.stringify({ preserved: true }));
  const settings = db.prepare("SELECT * FROM app_config").all();
  closeDb();
  const upgraded = openDb();
  assert.deepEqual(upgraded.prepare("SELECT * FROM app_config").all(), settings);
  assert.equal(new Registry().snapshot().fleetCost?.lastKnownRateLimits, null);
});

test("missing and invalid cache contents do not invent a quota reading or prevent startup", () => {
  assert.equal(new Registry().snapshot().fleetCost?.lastKnownRateLimits, null);
  for (const json of ["{broken", '{"fiveHour":{"usedPercentage":101,"resetsAt":123}}', "null"]) {
    openDb().prepare("INSERT OR REPLACE INTO claude_rate_limit_cache VALUES (1, ?)").run(json);
    assert.equal(new Registry().snapshot().fleetCost?.lastKnownRateLimits, null);
  }
});
