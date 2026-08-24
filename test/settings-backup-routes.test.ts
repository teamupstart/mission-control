import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/server/routes.ts";
import { Registry } from "../src/server/registry.ts";
import { ReviewManager } from "../src/server/reviews.ts";
import { TaskManager } from "../src/server/tasks.ts";
import { QueueManager } from "../src/server/queue.ts";
import type { SettingsBackupService } from "../src/server/settings-backups/service.ts";
import type {
  SettingsRestorePreviewResult,
  SettingsRestoreResult,
} from "../src/shared/settings-backups.ts";

const headers = { host: "127.0.0.1:7317", "content-type": "application/json" };
const digest = "a".repeat(64);
const requestId = "00000000-0000-4000-8000-000000000001";
const snapshotId = "daily-2026-08-24";
const preview = {
  snapshotId,
  digest,
  settingsDomains: ["ui" as const],
  personas: { added: 0, changed: 1, archived: 0, reactivated: 0 },
  sessionActions: { added: 0, changed: 0, archived: 0, reactivated: 0 },
  workflowCommandsChanged: 0,
  workflows: { added: 0, changed: 0, archived: 0, reactivated: 0 },
  workflowVersions: { inserted: 0, retained: 1 },
  externalEffects: [],
  exclusions: ["Tasks and runs"],
  warnings: [],
  blockers: [],
};

function appWith(
  registry: Registry,
  settingsBackups?: SettingsBackupService,
) {
  const tasks = new TaskManager(registry);
  return buildApp(
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
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    settingsBackups,
  );
}

function serviceStub(overrides: Partial<SettingsBackupService> = {}): SettingsBackupService {
  return {
    lastError: null,
    list: () => [{
      status: "ready",
      id: snapshotId,
      filename: `${snapshotId}.json`,
      size: 1234,
      modifiedAt: Date.parse("2026-08-24T12:00:00.000Z"),
      kind: "daily",
      createdAt: "2026-08-24T12:00:00.000Z",
      localDate: "2026-08-24",
      appVersion: "1.1.0",
      counts: {
        personas: 1,
        sessionActions: 2,
        workflowCommands: 3,
        workflowDefinitions: 4,
        workflowVersions: 5,
      },
      digest,
    }],
    previewRestore: () => ({ status: "ready", preview }),
    restore: async () => ({
      status: "restored",
      snapshotId,
      digest,
      restoredAt: "2026-08-24T12:05:00.000Z",
      safetySnapshotId: "pre-restore-20260824T120459.000Z-abcdef123456",
      warnings: [],
    }),
    ...overrides,
  } as unknown as SettingsBackupService;
}

test("settings backup routes are optional and return only bounded public metadata", async () => {
  const registry = new Registry();
  assert.equal((await appWith(registry).request("/api/settings-backups", { headers })).status, 503);

  const response = await appWith(registry, serviceStub()).request("/api/settings-backups", { headers });
  assert.equal(response.status, 200);
  const text = await response.text();
  const body = JSON.parse(text) as { snapshots: Array<Record<string, unknown>>; retention: unknown };
  assert.equal(body.snapshots[0]?.id, snapshotId);
  assert.equal(body.snapshots[0]?.status, "ready");
  assert.ok(body.retention);
  assert.doesNotMatch(text, /"filename"|"snapshot":|"payload"|"domains"|\.json/);
  assert.doesNotMatch(text, /\/Users\/|\\\\/);

  const ready = serviceStub().list()[0]!;
  const unsafe = serviceStub({
    lastError: { at: "2026-08-24T12:01:00.000Z", message: "EACCES /Users/operator/private" },
    list: (() => [ready, {
      status: "unreadable",
      id: "daily-2026-08-23",
      filename: "daily-2026-08-23.json",
      size: null,
      modifiedAt: null,
      reason: "EACCES /Users/operator/private/daily-2026-08-23.json",
    }]) as SettingsBackupService["list"],
  });
  const sanitized = await appWith(new Registry(), unsafe).request("/api/settings-backups", { headers });
  const sanitizedText = await sanitized.text();
  assert.doesNotMatch(sanitizedText, /Users|operator|\.json/);
  assert.match(sanitizedText, /Snapshot could not be read/);
  assert.match(sanitizedText, /Automatic settings snapshot failed/);
});

test("preview maps Phase 2 results without reimplementing validation", async () => {
  const cases: Array<[SettingsRestorePreviewResult, number]> = [
    [{ status: "ready", preview }, 200],
    [{ status: "preflight_blocked", preview: { ...preview, blockers: ["Skills reconcile blocked"] } }, 409],
    [{ status: "not_found", reason: "gone" }, 404],
    [{ status: "incompatible", reason: "newer" }, 422],
    [{ status: "io_error", reason: "unreadable" }, 422],
  ];
  for (const [result, status] of cases) {
    const app = appWith(new Registry(), serviceStub({ previewRestore: () => result }));
    assert.equal((await app.request(`/api/settings-backups/${snapshotId}/preview`, { headers })).status, status);
  }
  const malformed = await appWith(new Registry(), serviceStub()).request(
    "/api/settings-backups/not-owned/preview",
    { headers },
  );
  assert.equal(malformed.status, 404);
});

test("public restore results consume complete local paths including spaces and platform forms", async () => {
  const unsafePreview = {
    ...preview,
    exclusions: ["Excluded /Users/operator/My Project/private.json after validation"],
    warnings: [
      "Warning C:\\Users\\operator\\My Project\\private.json after validation",
      "Warning ~/My Project/private.json after validation",
    ],
    blockers: ["Blocked \\\\server\\share\\My Project\\private.json after validation"],
  };
  const previewResponse = await appWith(new Registry(), serviceStub({
    previewRestore: () => ({ status: "preflight_blocked", preview: unsafePreview }),
  })).request(`/api/settings-backups/${snapshotId}/preview`, { headers });
  assert.equal(previewResponse.status, 409);
  assert.deepEqual((await previewResponse.json()).preview, {
    ...unsafePreview,
    exclusions: ["Excluded [local path]"],
    warnings: ["Warning [local path]", "Warning [local path]"],
    blockers: ["Blocked [local path]"],
  });

  const incompatibleResponse = await appWith(new Registry(), serviceStub({
    previewRestore: () => ({
      status: "incompatible",
      reason: "Incompatible source file:///Users/operator/My Project/private.json after validation",
    }),
  })).request(`/api/settings-backups/${snapshotId}/preview`, { headers });
  assert.equal(incompatibleResponse.status, 422);
  assert.deepEqual(await incompatibleResponse.json(), {
    status: "incompatible",
    reason: "Incompatible source [local path]",
  });

  const restoreResponse = await appWith(new Registry(), serviceStub({
    restore: async () => ({
      status: "restored",
      snapshotId,
      digest,
      restoredAt: "2026-08-24T12:05:00.000Z",
      safetySnapshotId: "pre-restore-20260824T120459.000Z-abcdef123456",
      warnings: ["Reconcile warning /Users/operator/My Project/private.json after validation"],
    }),
  })).request(`/api/settings-backups/${snapshotId}/restore`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedDigest: digest, requestId, confirmation: "RESTORE SETTINGS" }),
  });
  assert.equal(restoreResponse.status, 200);
  const restoreText = await restoreResponse.text();
  assert.match(restoreText, /Reconcile warning \[local path\]/);
  assert.doesNotMatch(restoreText, /Users|operator|Project|private|server|share/);
});

test("restore requires the exact confirmation and emits once only after reconciliation", async () => {
  const registry = new Registry();
  const order: string[] = [];
  const events: unknown[] = [];
  registry.subscribe((event) => {
    if (event.type === "settings_restored") {
      order.push("event");
      events.push(event);
    }
  });
  let calls = 0;
  const service = serviceStub({
    restore: async () => {
      calls += 1;
      order.push("service-reconciled");
      return {
        status: "restored",
        snapshotId,
        digest,
        restoredAt: "2026-08-24T12:05:00.000Z",
        safetySnapshotId: "pre-restore-20260824T120459.000Z-abcdef123456",
        warnings: [],
      };
    },
  });
  const app = appWith(registry, service);
  for (const confirmation of [undefined, "restore settings", "RESTORE SETTINGS "]) {
    const response = await app.request(`/api/settings-backups/${snapshotId}/restore`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedDigest: digest, requestId, confirmation }),
    });
    assert.equal(response.status, 400);
  }
  assert.equal(calls, 0);

  const response = await app.request(`/api/settings-backups/${snapshotId}/restore`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedDigest: digest, requestId, confirmation: "RESTORE SETTINGS" }),
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.deepEqual(order, ["service-reconciled", "event"]);
  assert.deepEqual(events, [{
    type: "settings_restored",
    snapshotId,
    restoredAt: "2026-08-24T12:05:00.000Z",
    requestId,
  }]);
});

test("refused and failed restores preserve status mapping and emit nothing", async () => {
  const cases: Array<[SettingsRestoreResult, number]> = [
    [{ status: "in_progress" }, 409],
    [{ status: "stale_digest", reason: "stale" }, 409],
    [{ status: "preflight_blocked", preview: { ...preview, blockers: ["blocked"] } }, 409],
    [{ status: "not_found", reason: "gone" }, 404],
    [{ status: "incompatible", reason: "newer" }, 422],
    [{ status: "io_error", reason: "read failed" }, 422],
    [{ status: "restore_failed", reason: "rolled back" }, 500],
  ];
  for (const [result, status] of cases) {
    const registry = new Registry();
    const events: unknown[] = [];
    registry.subscribe((event) => {
      if (event.type === "settings_restored") events.push(event);
    });
    const app = appWith(registry, serviceStub({ restore: async () => result }));
    const response = await app.request(`/api/settings-backups/${snapshotId}/restore`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedDigest: digest, requestId, confirmation: "RESTORE SETTINGS" }),
    });
    assert.equal(response.status, status);
    assert.deepEqual(events, []);
  }
});
