import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Upgrade safety, against a database shaped like one this feature never existed in.
//
// What is at stake is the promise an operator was given without being asked: their existing
// settings and history open unchanged, and collection is off. A migration that quietly turned
// telemetry on, or that could not open a pre-telemetry database at all, would both be the same
// class of failure - a feature deciding something about someone else's data on their behalf.
//
// `upgradeDatabaseToCurrentSchema` is called directly here rather than through `openDb`,
// because it is the exported forward-upgrade contract shared by the live database and by
// disposable restore verification, and this test needs to run it against a database it built.

const home = mkdtempSync(join(tmpdir(), "mission-telemetry-migration-"));
process.env.HARNESS_HOME = join(home, "state");

const { CURRENT_DATABASE_SCHEMA_VERSION, upgradeDatabaseToCurrentSchema } = await import(
  "../src/server/db.ts"
);
const { TelemetryConfigSchema } = await import("../src/shared/telemetry.ts");
const { APP_CONFIG_ENTRIES } = await import("../src/shared/app-config-entries.ts");

after(() => rmSync(home, { recursive: true, force: true }));

/** A database as an older build left it: real settings, no telemetry tables, older marker. */
function preTelemetryDatabase(): DatabaseSync {
  const d = new DatabaseSync(join(home, `pre-telemetry-${Math.random().toString(36).slice(2)}.db`));
  d.exec(`
    CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO app_config (key, value) VALUES
      ('harnesses', '{"defaultModel":"opus","defaultEffort":"high"}'),
      ('ui', '{"layout":"board"}');
    PRAGMA user_version = 1;
  `);
  return d;
}

test("a pre-telemetry database opens and keeps every existing setting", () => {
  const d = preTelemetryDatabase();
  upgradeDatabaseToCurrentSchema(d);

  const harnesses = d
    .prepare(`SELECT value FROM app_config WHERE key = 'harnesses'`)
    .get() as { value: string };
  assert.deepEqual(JSON.parse(harnesses.value), { defaultModel: "opus", defaultEffort: "high" });
  const ui = d.prepare(`SELECT value FROM app_config WHERE key = 'ui'`).get() as { value: string };
  assert.deepEqual(JSON.parse(ui.value), { layout: "board" });
  d.close();
});

test("the upgrade creates the telemetry tables and leaves every one of them empty", () => {
  const d = preTelemetryDatabase();
  upgradeDatabaseToCurrentSchema(d);

  const tables = [
    "telemetry_resources",
    "telemetry_contexts",
    "telemetry_journal",
    "telemetry_source_identities",
    "telemetry_projection_state",
    "telemetry_series",
    "telemetry_batches",
    "telemetry_delivery",
    "telemetry_destinations",
    "telemetry_secrets",
    "telemetry_gaps",
  ];
  for (const table of tables) {
    const row = d.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    assert.equal(row.n, 0, `${table} must exist and start empty`);
  }
  d.close();
});

test("an upgraded database has collection off and no destination configured", () => {
  const d = preTelemetryDatabase();
  upgradeDatabaseToCurrentSchema(d);

  const stored = d
    .prepare(`SELECT value FROM app_config WHERE key = ?`)
    .get(APP_CONFIG_ENTRIES.telemetry.key) as { value: string } | undefined;
  assert.equal(stored, undefined, "the upgrade writes no telemetry configuration at all");

  // And what an absent row resolves to, which is the thing that actually governs behaviour.
  const resolved = TelemetryConfigSchema.parse({});
  assert.equal(resolved.enabled, false);
  assert.equal(resolved.user.enabled, false);
  assert.equal(resolved.user.endpoint, "");
  assert.equal(resolved.product.enabled, false);
  d.close();
});

test("the upgrade is idempotent, because it runs on every open and not only on upgrades", () => {
  const d = preTelemetryDatabase();
  upgradeDatabaseToCurrentSchema(d);
  upgradeDatabaseToCurrentSchema(d);
  upgradeDatabaseToCurrentSchema(d);
  const row = d.prepare(`SELECT COUNT(*) AS n FROM telemetry_journal`).get() as { n: number };
  assert.equal(row.n, 0);
  d.close();
});

test("the schema marker advances so one verified recovery point is taken before the upgrade", () => {
  // The marker is what makes `openDb` capture a pre-migration backup. Adding tables without
  // moving it would skip that recovery point for every existing installation.
  assert.ok(CURRENT_DATABASE_SCHEMA_VERSION >= 2);
  const d = preTelemetryDatabase();
  upgradeDatabaseToCurrentSchema(d);
  const version = d.prepare(`PRAGMA user_version`).get() as { user_version: number };
  assert.equal(version.user_version, CURRENT_DATABASE_SCHEMA_VERSION);
  d.close();
});

test("telemetry configuration is excluded from settings snapshots", () => {
  // Consent is not a portable setting. A snapshot restored from another installation - or from
  // before a withdrawal - must not be able to turn collection back on or point it somewhere it
  // was never pointed.
  assert.equal(APP_CONFIG_ENTRIES.telemetry.backupDomain, null);
  assert.equal(APP_CONFIG_ENTRIES.telemetryIdentity.backupDomain, null);
  assert.equal(APP_CONFIG_ENTRIES.telemetry.classification.kind, "whole");
  assert.equal(
    APP_CONFIG_ENTRIES.telemetry.classification.kind === "whole" &&
      APP_CONFIG_ENTRIES.telemetry.classification.valueClass,
    "operational",
  );
});
