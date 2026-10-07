/**
 * One deterministic telemetry scenario, replayed against a destination to pin its batches.
 *
 * Shared by the export-shape tests and by the fixture they compare against, so the fixture in
 * `test/fixtures/telemetry-full-shape-batches.json` was produced by exactly the events the test
 * still replays. The caller owns the state home: import this only after `HARNESS_HOME` is set.
 */
import assert from "node:assert/strict";
import type { z } from "zod";
import { APP_CONFIG_ENTRIES } from "../../src/shared/app-config-entries.ts";
import { setAppConfig, openDb } from "../../src/server/db.ts";
import { captureTelemetry } from "../../src/server/telemetry/capture.ts";
import { setTelemetryConfig } from "../../src/server/telemetry/config.ts";
import { runProjectionPass, type MetricsBatchPayload } from "../../src/server/telemetry/projection.ts";
import { DAEMON_STARTED_EVENT, DISPATCH_FINISHED_EVENT } from "../../src/shared/telemetry-catalog.ts";
import { HEALTH_EVENT } from "../../src/shared/telemetry-sources/health.ts";
import type { TelemetryConfigPatch, TelemetryProfileId } from "../../src/shared/telemetry.ts";

export const SCENARIO_INSTALLATION_ID = "fixture-installation";

/** Pin the installation identity so every resource attribute is reproducible. */
export function pinScenarioIdentity(): void {
  setAppConfig(APP_CONFIG_ENTRIES.telemetryIdentity, {
    installationId: SCENARIO_INSTALLATION_ID,
    epoch: 1,
  });
}

export function captureDaemonStart(
  profile: TelemetryProfileId | TelemetryProfileId[],
  id: string,
  now: number,
  startupMs: number,
): void {
  const captured = captureTelemetry({
    event: DAEMON_STARTED_EVENT,
    source: { kind: "mission.daemon", id, revision: 1 },
    profiles: [profile].flat(),
    facts: { startup_ms: startupMs, schema_upgraded: false, launch_mode: "daemon" },
    now,
  });
  assert.equal(captured.kind, "accepted");
}

export function captureDispatch(
  profile: TelemetryProfileId | TelemetryProfileId[],
  id: string,
  now: number,
  facts: Partial<
    Pick<z.infer<typeof DISPATCH_FINISHED_EVENT.facts>, "resolution_source" | "resolved_effort" | "duration_ms">
  > = {},
): void {
  const captured = captureTelemetry({
    event: DISPATCH_FINISHED_EVENT,
    source: { kind: "mission.dispatch", id, revision: 1 },
    profiles: [profile].flat(),
    facts: {
      outcome: "launched",
      agent: "claude",
      runtime: "terminal",
      task_kind: "ship",
      resolved_model: "",
      resolved_effort: facts.resolved_effort ?? "high",
      resolution_source: facts.resolution_source ?? "task",
      repo_count: 1,
      duration_ms: facts.duration_ms ?? 1_500,
    },
    now,
  });
  assert.equal(captured.kind, "accepted");
}

export function captureHealth(
  profile: TelemetryProfileId | TelemetryProfileId[],
  id: string,
  now: number,
  pending: number,
): void {
  const captured = captureTelemetry({
    event: HEALTH_EVENT,
    source: { kind: "mission.telemetry.health", id, revision: 1 },
    profiles: [profile].flat(),
    facts: {
      profile: [profile].flat()[0],
      pending,
      retrying: 0,
      accepted: 0,
      rejected: 0,
      expired: 0,
      pending_bytes: 0,
      oldest_pending_age: 0,
      last_accepted_at: 0,
      observed_at: now,
    },
    now,
  });
  assert.equal(captured.kind, "accepted");
}

/** Every metrics batch queued for a profile, in a stable order, with the release normalized. */
export function metricBatches(profile: TelemetryProfileId): MetricsBatchPayload[] {
  const rows = openDb()
    .prepare(
      `SELECT payload_json, created_at FROM telemetry_batches
        WHERE profile = ? AND signal = 'metrics'`,
    )
    .all(profile) as Array<{ payload_json: string; created_at: number }>;
  return rows
    .sort((a, b) => a.created_at - b.created_at || a.payload_json.localeCompare(b.payload_json))
    .map((row) => JSON.parse(row.payload_json) as MetricsBatchPayload);
}

/** The release changes on every version bump; nothing else in a resource may. */
export function normalizeRelease(payloads: MetricsBatchPayload[]): MetricsBatchPayload[] {
  return payloads.map((payload) => ({
    ...payload,
    resource: { ...payload.resource, "service.version": "<release>" },
  }));
}

/**
 * Two projection passes over daemon, dispatch and health facts for the `user` destination.
 *
 * Covers a counter with every trimmed label, a distribution histogram, a minor histogram and the
 * health gauges, which is each path an export shape can change.
 */
export function runShapeScenario(user: NonNullable<TelemetryConfigPatch["user"]>): MetricsBatchPayload[] {
  pinScenarioIdentity();
  const applied = setTelemetryConfig(
    { enabled: true, user: { enabled: true, endpoint: "https://otlp.example.com", ...user } },
    100,
  );
  assert.equal(applied.ok, true, applied.ok ? "" : applied.error);
  captureDaemonStart("user", "scenario-start", 1_000, 250);
  captureDispatch("user", "scenario-dispatch-1", 2_000, { resolution_source: "task" });
  captureDispatch("user", "scenario-dispatch-2", 2_100, {
    resolution_source: "kind",
    resolved_effort: "low",
    duration_ms: 4_000,
  });
  captureHealth("user", "scenario-health-1", 2_200, 3);
  runProjectionPass(10_000);
  captureDispatch("user", "scenario-dispatch-3", 20_000, { resolution_source: "automation" });
  captureHealth("user", "scenario-health-2", 20_100, 1);
  runProjectionPass(30_000);
  return normalizeRelease(metricBatches("user"));
}
