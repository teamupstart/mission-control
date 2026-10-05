import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A recognized organization's managed telemetry lane: first application, the pilot invariant,
// keeping in step with a newer preset, withdrawal, the resource environment and the managed
// lock - each against real storage and a real delivery pass. Collectors are injected `fetch`
// routes, so nothing here opens a socket, and the organization is forced onto a loopback
// endpoint, which is the only way any test can make one active.

const home = mkdtempSync(join(tmpdir(), "mission-telemetry-organization-"));
process.env.HARNESS_HOME = join(home, "state");

const { closeDb, openDb, getAppConfig, setAppConfig } = await import("../src/server/db.ts");
const { PORT } = await import("../src/server/config.ts");
const { captureTelemetry, resourceAttributes } = await import("../src/server/telemetry/capture.ts");
const { environmentName, getTelemetryConfig, setTelemetryConfig, telemetryStatus } = await import(
  "../src/server/telemetry/config.ts"
);
const { runDeliveryPass } = await import("../src/server/telemetry/delivery.ts");
const { runProjectionPass } = await import("../src/server/telemetry/projection.ts");
const { registerBuiltinTelemetry } = await import("../src/server/telemetry/service.ts");
const {
  applyOrganization,
  recheckOrganization,
  setPilotEnrollment,
  telemetryOrganizationRecord,
} = await import("../src/server/telemetry/organization.ts");
const {
  currentOrganization,
  defaultOrganizationDetectionDeps,
  publishOrganization,
  refreshOrganization,
} = await import("../src/server/environment/organization.ts");
const { ORGANIZATIONS } = await import("../src/server/environment/organizations.ts");
const { DAEMON_STARTED_EVENT } = await import("../src/shared/telemetry-catalog.ts");
const { APP_CONFIG_ENTRIES } = await import("../src/shared/app-config-entries.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { buildApp } = await import("../src/server/routes.ts");

type DetectionDeps = import("../src/server/environment/organization.ts").OrganizationDetectionDeps;

registerBuiltinTelemetry();

const GATEWAY = "http://127.0.0.1:4999";
const ORIGINAL = "https://original-collector.example.com";

const TABLES = [
  "telemetry_journal",
  "telemetry_source_identities",
  "telemetry_projection_state",
  "telemetry_series",
  "telemetry_batches",
  "telemetry_delivery",
  "telemetry_destinations",
  "telemetry_secrets",
  "telemetry_gaps",
  "telemetry_contexts",
  "telemetry_resources",
];

/** Detection deps that force Upstart onto the fake gateway, or that detect nothing. */
function deps(forced: boolean): DetectionDeps {
  return {
    ...defaultOrganizationDetectionDeps(),
    env: forced
      ? { MISSION_ORGANIZATION: "upstart", MISSION_ORGANIZATION_ENDPOINT: GATEWAY }
      : { MISSION_ORGANIZATION: "none" },
    warn: () => {},
  };
}

async function manage(): Promise<void> {
  const outcome = await recheckOrganization(deps(true), 1_000);
  assert.ok(outcome.kind === "applied", JSON.stringify(outcome));
}

beforeEach(async () => {
  const d = openDb();
  for (const table of TABLES) d.exec(`DELETE FROM ${table}`);
  d.exec("DELETE FROM app_config");
  await refreshOrganization(deps(false));
});

afterEach(async () => {
  await refreshOrganization(deps(false));
});

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

/** A collector per base URL, recording which one each metrics request reached. */
function collectors() {
  const received: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    received.push(url);
    return new Response(null, { status: 200 });
  };
  return {
    fetch,
    to: (base: string) => received.filter((url) => url.startsWith(base)),
  };
}

let sequence = 0;
function captureStart(now: number): void {
  const captured = captureTelemetry({
    event: DAEMON_STARTED_EVENT,
    source: { kind: "mission.daemon", id: `organization-${++sequence}`, revision: 1 },
    facts: { startup_ms: 100, schema_upgraded: false, launch_mode: "desktop" },
    now,
  });
  assert.equal(captured.kind, "accepted", JSON.stringify(captured));
}

function queuedProductBatches(): number {
  const row = openDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM telemetry_delivery
        WHERE profile = 'product' AND state IN ('pending', 'retry', 'leased')`,
    )
    .get() as { n: number };
  return row.n;
}

const PRESET = ORGANIZATIONS.upstart.preset;

function assertPreset(enabled: boolean): void {
  const product = getTelemetryConfig().product;
  assert.deepEqual(product, {
    enabled,
    endpoint: GATEWAY,
    headerName: "authorization",
    paused: false,
    temporality: PRESET.temporality,
    networkGate: PRESET.networkGate,
    lateAfterMs: PRESET.lateAfterMs,
    exportShape: PRESET.exportShape,
  });
}

test("first application keeps the prior state and writes the preset, switched off, in one write", async () => {
  const configured = setTelemetryConfig({
    enabled: true,
    product: { enabled: false, endpoint: ORIGINAL, exportShape: "full" },
  });
  assert.ok(configured.ok);
  const before = getTelemetryConfig();

  await manage();

  const after = getTelemetryConfig();
  assert.equal(after.revision, before.revision + 1, "one setTelemetryConfig call, one revision");
  assertPreset(false);
  assert.equal(after.enabled, true, "the master switch did not move");
  assert.deepEqual(after.user, before.user, "the person's own backend is untouched");

  const record = telemetryOrganizationRecord();
  assert.ok(record);
  assert.equal(record.organization, "upstart");
  assert.equal(record.presetVersion, ORGANIZATIONS.upstart.presetVersion);
  assert.deepEqual(record.previous, { product: before.product, enabled: true });
  assert.equal(record.pilotEnrolledAt, null);
  assert.equal(record.enabledByDefault, false);
  assert.equal(record.noticeAcknowledgedAt, null);

  // Applying again with nothing different stores nothing.
  const again = applyOrganization(currentOrganization(), 2_000);
  assert.deepEqual(again, { kind: "applied", first: false, changed: false });
  assert.equal(getTelemetryConfig().revision, after.revision);
});

test("an already-sending product destination stops, and neither collector gets anything more", async () => {
  const configured = setTelemetryConfig({
    enabled: true,
    product: { enabled: true, endpoint: ORIGINAL },
  });
  assert.ok(configured.ok);
  captureStart(10);
  assert.ok(runProjectionPass(11).batches > 0);
  assert.ok(queuedProductBatches() > 0, "batches are queued for the original collector");

  await manage();

  assertPreset(false);
  assert.equal(getTelemetryConfig().enabled, true);
  assert.equal(queuedProductBatches(), 0, "queued batches were dropped with the switch-off");
  const net = collectors();
  captureStart(20);
  runProjectionPass(21);
  await runDeliveryPass({ fetch: net.fetch, now: () => 22 });
  assert.deepEqual(net.to(GATEWAY), [], "nothing reached the gateway before enrollment");
  assert.deepEqual(net.to(ORIGINAL), [], "nothing more reached the original collector");
});

test("joining the pilot turns the lane and the master switch on, and the gateway receives data", async () => {
  await manage();
  assert.equal(getTelemetryConfig().enabled, false);

  const joined = setPilotEnrollment(true, 3_000);
  assert.deepEqual(joined, { ok: true, changed: true });
  assertPreset(true);
  assert.equal(getTelemetryConfig().enabled, true);
  assert.equal(telemetryOrganizationRecord()?.pilotEnrolledAt, 3_000);
  assert.equal(telemetryStatus().organization?.pilotEnrolled, true);

  const net = collectors();
  captureStart(3_100);
  assert.ok(runProjectionPass(3_101).batches > 0);
  const delivered = await runDeliveryPass({ fetch: net.fetch, now: () => 3_102 });
  assert.ok(delivered.accepted > 0);
  assert.ok(net.to(`${GATEWAY}/v1/metrics`).length > 0);

  // Joining twice is not a second change.
  assert.deepEqual(setPilotEnrollment(true, 4_000), { ok: true, changed: false });
  assert.equal(telemetryOrganizationRecord()?.pilotEnrolledAt, 3_000);
});

test("leaving the pilot turns the lane off and restores the master switch", async () => {
  await manage();
  assert.ok(setPilotEnrollment(true, 3_000).ok);
  assert.deepEqual(setPilotEnrollment(false, 4_000), { ok: true, changed: true });
  assertPreset(false);
  assert.equal(getTelemetryConfig().enabled, false, "back to what it was before application");
  assert.equal(telemetryOrganizationRecord()?.pilotEnrolledAt, null);
});

test("the pilot route refuses when no organization is active", () => {
  const refused = setPilotEnrollment(true);
  assert.equal(refused.ok, false);
  assert.equal(refused.ok ? 0 : refused.status, 409);
  assert.equal(getAppConfig(APP_CONFIG_ENTRIES.telemetryOrganization), undefined);
});

test("a newer preset rewrites every preset field and re-asserts the pilot invariant", async () => {
  for (const enrolled of [false, true]) {
    const d = openDb();
    for (const table of TABLES) d.exec(`DELETE FROM ${table}`);
    d.exec("DELETE FROM app_config");
    await manage();
    if (enrolled) assert.ok(setPilotEnrollment(true, 3_000).ok);
    // Something moved the destination underneath - the invariant flipped and a field changed.
    assert.ok(
      setTelemetryConfig({ product: { enabled: !enrolled, exportShape: "full", lateAfterMs: 1 } }).ok,
    );

    const organization = currentOrganization();
    assert.ok(organization);
    const newer = {
      ...organization,
      entry: {
        ...organization.entry,
        presetVersion: organization.entry.presetVersion + 1,
        preset: { ...organization.entry.preset, lateAfterMs: 1_800_000 },
      },
    };
    const outcome = applyOrganization(newer, 5_000);
    assert.deepEqual(outcome, { kind: "applied", first: false, changed: true });
    const product = getTelemetryConfig().product;
    assert.equal(product.enabled, enrolled, `invariant with enrolled=${enrolled}`);
    assert.equal(product.exportShape, PRESET.exportShape);
    assert.equal(product.lateAfterMs, 1_800_000);
    assert.equal(product.endpoint, GATEWAY);
    assert.equal(telemetryOrganizationRecord()?.presetVersion, newer.entry.presetVersion);
  }
});

test("withdrawal restores the prior destination, switch included, and deletes the record", async () => {
  assert.ok(setTelemetryConfig({ enabled: true, product: { enabled: true, endpoint: ORIGINAL } }).ok);
  const before = getTelemetryConfig();
  await manage();
  assert.ok(setPilotEnrollment(true, 3_000).ok);

  const outcome = await recheckOrganization(deps(false), 6_000);
  assert.deepEqual(outcome, { kind: "withdrawn", restored: "previous" });
  assert.equal(currentOrganization(), null);
  const restored = getTelemetryConfig();
  assert.deepEqual(restored.product, before.product);
  assert.equal(restored.enabled, true);
  assert.equal(getAppConfig(APP_CONFIG_ENTRIES.telemetryOrganization), undefined);
  assert.equal(telemetryStatus().organization, null);

  const net = collectors();
  captureStart(6_100);
  assert.ok(runProjectionPass(6_101).batches > 0);
  await runDeliveryPass({ fetch: net.fetch, now: () => 6_102 });
  assert.ok(net.to(`${ORIGINAL}/v1/metrics`).length > 0, "the original collector receives again");
  assert.deepEqual(net.to(GATEWAY), []);
});

test("withdrawal clears and disables a saved destination that no longer validates", async () => {
  // Collection on before management, so it is on again after withdrawal and the delivery pass
  // below has something to send.
  assert.ok(setTelemetryConfig({ enabled: true }).ok);
  await manage();
  assert.ok(setPilotEnrollment(true, 3_000).ok);
  // The saved destination stopped passing the transport rules after it was saved - here, this
  // daemon's own port now answers at its address, which `setTelemetryConfig` refuses.
  const record = telemetryOrganizationRecord();
  assert.ok(record);
  const invalid = `http://127.0.0.1:${PORT}`;
  setAppConfig(APP_CONFIG_ENTRIES.telemetryOrganization, {
    ...record,
    previous: { ...record.previous, product: { ...record.previous.product, enabled: true, endpoint: invalid } },
  });
  assert.equal(setTelemetryConfig({ product: { endpoint: invalid } }).ok, false, "the saved destination is refused");

  const outcome = await recheckOrganization(deps(false), 6_000);
  assert.deepEqual(outcome, { kind: "withdrawn", restored: "cleared" });
  assert.equal(currentOrganization(), null);
  assert.equal(getAppConfig(APP_CONFIG_ENTRIES.telemetryOrganization), undefined);
  const product = getTelemetryConfig().product;
  assert.equal(product.enabled, false);
  assert.equal(product.endpoint, "", "the managed endpoint is no longer configured");
  assert.equal(getTelemetryConfig().enabled, true, "the master switch is back to its saved value");
  assert.equal(telemetryStatus().organization, null);

  const net = collectors();
  captureStart(6_100);
  runProjectionPass(6_101);
  await runDeliveryPass({ fetch: net.fetch, now: () => 6_102 });
  assert.deepEqual(net.to(GATEWAY), [], "nothing reaches the gateway after withdrawal");
  assert.deepEqual(net.to(invalid), [], "nor the refused saved destination");
});

test("an unreadable record on a Mac that left clears the gateway before the record goes", async () => {
  assert.ok(setTelemetryConfig({ enabled: true }).ok);
  await manage();
  assert.ok(setPilotEnrollment(true, 3_000).ok);
  assertPreset(true);
  // The row is still there, but this build cannot read it - corrupted, or written by a newer
  // build. Its saved destination is gone with it.
  openDb()
    .prepare("UPDATE app_config SET value = ? WHERE key = ?")
    .run(JSON.stringify({ organization: "upstart", presetVersion: "garbled" }), "telemetry.organization");
  assert.equal(telemetryOrganizationRecord(), null);

  const outcome = await recheckOrganization(deps(false), 6_000);
  assert.deepEqual(outcome, { kind: "withdrawn", restored: "cleared" });
  assert.equal(getAppConfig(APP_CONFIG_ENTRIES.telemetryOrganization), undefined);
  const product = getTelemetryConfig().product;
  assert.equal(product.enabled, false);
  assert.equal(product.endpoint, "", "the gateway is no longer configured");

  const net = collectors();
  captureStart(6_100);
  runProjectionPass(6_101);
  await runDeliveryPass({ fetch: net.fetch, now: () => 6_102 });
  assert.deepEqual(net.to(GATEWAY), [], "nothing reaches the gateway after withdrawal");
});

test("an unreadable record on a still-managed Mac never saves the gateway as what to restore", async () => {
  await manage();
  assert.ok(setPilotEnrollment(true, 3_000).ok);
  openDb()
    .prepare("UPDATE app_config SET value = ? WHERE key = ?")
    .run("{not json", "telemetry.organization");

  // Re-applied: the record is rebuilt, and with the saved destination lost, withdrawal will
  // restore a cleared, switched-off one - never the gateway that is configured right now.
  const reapplied = await recheckOrganization(deps(true), 6_000);
  assert.equal(reapplied.kind, "applied");
  const record = telemetryOrganizationRecord();
  assert.ok(record);
  assert.equal(record.previous.product.endpoint, "");
  assert.equal(record.previous.product.enabled, false);
  assertPreset(false);

  assert.deepEqual(await recheckOrganization(deps(false), 7_000), { kind: "withdrawn", restored: "previous" });
  assert.equal(getTelemetryConfig().product.endpoint, "");
  assert.equal(getTelemetryConfig().product.enabled, false);
});

test("settings requests during startup recognition wait for it, then see the lock", async () => {
  // A production-shaped detection whose `profiles` call is held open, standing in for the
  // window between the daemon listening and its startup detection finishing.
  let answer!: () => void;
  const held = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const slow: DetectionDeps = {
    ...defaultOrganizationDetectionDeps(),
    platform: "darwin",
    env: {},
    launchMode: "desktop",
    stateHome: "/Users/someone/.mission-control",
    tmpdir: "/private/var/folders/xy/T",
    realpath: async (path) => path,
    warn: () => {},
    run: (async () => {
      await held;
      return {
        stdout:
          "MDM enrollment: Yes (User Approved)\nMDM server: https://upstart.jamfcloud.com/mdm/ServerURL\n",
        stderr: "",
        code: 0,
        outcomeUnknown: false,
        overflowed: false,
      };
    }) as DetectionDeps["run"],
  };
  const startup = recheckOrganization(slow, 8_000);

  const server = app();
  let putDone = false;
  let getDone = false;
  const put = Promise.resolve(
    server.request("/api/telemetry/config", {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ enabled: true }),
    }),
  ).then((res) => {
    putDone = true;
    return res;
  });
  const get = Promise.resolve(server.request("/api/telemetry/config", { headers: HEADERS })).then(
    (res) => {
      getDone = true;
      return res;
    },
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(putDone, false, "the write is not answered while recognition is running");
    assert.equal(getDone, false, "the panel is not answered while recognition is running");
    assert.equal(getTelemetryConfig().enabled, false, "and nothing was stored in the window");
  } finally {
    // Released whatever happened above. A held detection left pending would queue every later
    // recheck in this file behind it.
    answer();
  }
  assert.equal((await startup).kind, "applied");
  const putRes = await put;
  assert.equal(putRes.status, 403);
  assert.equal(((await putRes.json()) as { managedBy: string }).managedBy, "upstart");
  const status = (await (await get).json()) as { organization: { id: string; managed: boolean } };
  assert.equal(status.organization.id, "upstart");
  assert.equal(status.organization.managed, true);
  assert.equal(getTelemetryConfig().enabled, false, "the refused write stored nothing");
});

// ---- a withdrawal whose write fails ----

/** Make every write of the telemetry config row abort, as a full or locked disk would. */
function failTelemetryWrites(): () => void {
  openDb().exec(`CREATE TRIGGER fail_telemetry_write BEFORE UPDATE ON app_config
    WHEN NEW.key = 'telemetry' BEGIN SELECT RAISE(ABORT, 'disk I/O error (simulated)'); END`);
  return () => openDb().exec("DROP TRIGGER IF EXISTS fail_telemetry_write");
}

async function assertStillLockedWithdrawing(): Promise<void> {
  const organization = currentOrganization();
  assert.equal(organization?.entry.id, "upstart", "the lock holds while the record remains");
  assert.equal(organization?.withdrawing, true);
  assert.ok(getAppConfig(APP_CONFIG_ENTRIES.telemetryOrganization), "the record is still stored");
  assert.equal(getTelemetryConfig().product.endpoint, GATEWAY, "the gateway is still stored");
  const put = await send("/api/telemetry/config", "PUT", { enabled: false });
  assert.equal(put.status, 403);
  const status = telemetryStatus().organization;
  assert.equal(status?.withdrawing, true);
  assert.match(status?.evidence ?? "", /removing Upstart's telemetry settings has not finished/);
  assert.equal(setPilotEnrollment(true).ok, false, "the pilot cannot be joined while withdrawing");
  // Nothing reaches the gateway in the meantime, though collection itself keeps running.
  const net = collectors();
  captureStart(9_100);
  runProjectionPass(9_101);
  await runDeliveryPass({ fetch: net.fetch, now: () => 9_102 });
  assert.deepEqual(net.to(GATEWAY), [], "nothing is sent to the gateway while withdrawing");
}

test("a withdrawal that fails at startup keeps the lock and sends nothing to the gateway", async () => {
  assert.ok(setTelemetryConfig({ enabled: true }).ok);
  await manage();
  assert.ok(setPilotEnrollment(true, 3_000).ok);
  // A fresh daemon: nothing is cached yet, and the managed record is on disk.
  publishOrganization(null);
  const restore = failTelemetryWrites();
  try {
    await assert.rejects(recheckOrganization(deps(false), 9_000), /disk I\/O error/);
    await assertStillLockedWithdrawing();
  } finally {
    restore();
  }
  // The next start completes it, and only then does the lock come off.
  assert.deepEqual(await recheckOrganization(deps(false), 10_000), {
    kind: "withdrawn",
    restored: "previous",
  });
  assert.equal(currentOrganization(), null);
  assert.equal(getAppConfig(APP_CONFIG_ENTRIES.telemetryOrganization), undefined);
  assert.equal((await send("/api/telemetry/config", "PUT", { enabled: true })).status, 200);
});

test("a withdrawal that fails on Re-check keeps the lock and reports the failure", async () => {
  assert.ok(setTelemetryConfig({ enabled: true }).ok);
  await manage();
  assert.ok(setPilotEnrollment(true, 3_000).ok);
  const restore = failTelemetryWrites();
  try {
    // The route re-detects with this process's own environment, which forces nothing.
    const rechecked = await send("/api/telemetry/organization/recheck", "POST", {});
    assert.equal(rechecked.status, 500);
    assert.match(String(rechecked.body.error), /Could not update telemetry settings/);
    await assertStillLockedWithdrawing();
  } finally {
    restore();
  }
  const retried = await send("/api/telemetry/organization/recheck", "POST", {});
  assert.equal(retried.status, 200);
  assert.equal(retried.body.organization, null);
  assert.equal(getAppConfig(APP_CONFIG_ENTRIES.telemetryOrganization), undefined);
});

test("a first application that fails sends nothing to the previous destination or the gateway", async () => {
  // A person's own Product analytics destination, on and with batches queued.
  assert.ok(setTelemetryConfig({ enabled: true, product: { enabled: true, endpoint: ORIGINAL } }).ok);
  const restore = failTelemetryWrites();
  try {
    await assert.rejects(recheckOrganization(deps(true), 9_000), /disk I\/O error/);
    // The write rolled back - the previous destination is still stored, and on - but the Mac
    // is recognized, so the lock holds and the panel is view-only.
    assert.equal(currentOrganization()?.entry.id, "upstart");
    assert.equal(getAppConfig(APP_CONFIG_ENTRIES.telemetryOrganization), undefined);
    const product = getTelemetryConfig().product;
    assert.equal(product.endpoint, ORIGINAL);
    assert.equal(product.enabled, true);
    assert.equal((await send("/api/telemetry/config", "PUT", { enabled: false })).status, 403);
    // Nothing leaves while the managed configuration is not what is stored.
    const net = collectors();
    captureStart(9_100);
    runProjectionPass(9_101);
    await runDeliveryPass({ fetch: net.fetch, now: () => 9_102 });
    assert.deepEqual(net.to(ORIGINAL), [], "nothing reaches the previous destination");
    assert.deepEqual(net.to(GATEWAY), [], "nor the gateway");
  } finally {
    restore();
  }
  // Once the store accepts the write, the first application completes: preset written, off.
  const applied = await recheckOrganization(deps(true), 10_000);
  assert.deepEqual(applied, { kind: "applied", first: true, changed: true });
  assertPreset(false);
  assert.deepEqual(telemetryOrganizationRecord()?.previous.product.endpoint, ORIGINAL);
});

test("an undetected machine with no record is left exactly as it was", async () => {
  assert.ok(setTelemetryConfig({ enabled: true, product: { endpoint: ORIGINAL } }).ok);
  const before = getTelemetryConfig();
  assert.deepEqual(await recheckOrganization(deps(false), 7_000), { kind: "unmanaged" });
  assert.deepEqual(getTelemetryConfig(), before);
  assert.equal(getAppConfig(APP_CONFIG_ENTRIES.telemetryOrganization), undefined);
});

test("the environment is the operator's override, then the organization's, then local", async () => {
  const original = process.env.MISSION_TELEMETRY_ENVIRONMENT;
  try {
    delete process.env.MISSION_TELEMETRY_ENVIRONMENT;
    assert.equal(environmentName(), "local");
    await manage();
    assert.equal(environmentName(), "corp");
    assert.equal(resourceAttributes()["deployment.environment.name"], "corp");
    assert.equal(telemetryStatus().organization?.effective.environment, "corp");
    process.env.MISSION_TELEMETRY_ENVIRONMENT = "test";
    assert.equal(environmentName(), "test");
    process.env.MISSION_TELEMETRY_ENVIRONMENT = "   ";
    assert.equal(environmentName(), "corp");
  } finally {
    if (original === undefined) delete process.env.MISSION_TELEMETRY_ENVIRONMENT;
    else process.env.MISSION_TELEMETRY_ENVIRONMENT = original;
  }
});

// ---- the managed lock, through the routes ----

const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

function app() {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  return buildApp({ registry, reviews: {} as never, tasks, queues: {} as never });
}

async function send(path: string, method: string, body: unknown) {
  const res = await app().request(path, { method, headers: HEADERS, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("while managed, settings writes and destructive operations answer 403; probe and retry work", async () => {
  await manage();
  const refusal = {
    error: "Telemetry settings on this Mac are managed by Upstart",
    managedBy: "upstart",
  };
  assert.deepEqual(await send("/api/telemetry/config", "PUT", { enabled: true }), {
    status: 403,
    body: refusal,
  });
  for (const operation of [
    { action: "purge", profile: "product" },
    { action: "purge", profile: "local" },
    { action: "reset_identity" },
  ]) {
    assert.deepEqual(await send("/api/telemetry/operation", "POST", operation), {
      status: 403,
      body: refusal,
    });
  }
  assert.equal((await send("/api/telemetry/operation", "POST", { action: "retry", profile: "product" })).status, 200);
  assert.equal((await send("/api/telemetry/probe", "POST", { profile: "product" })).status, 200);
  assertPreset(false);

  // The status the panel renders while managed.
  const status = await app().request("/api/telemetry/config", { headers: HEADERS });
  const organization = ((await status.json()) as { organization: Record<string, unknown> }).organization;
  assert.equal(organization.id, "upstart");
  assert.equal(organization.managed, true);
  assert.equal(organization.pilotEnrolled, false);
  assert.equal(organization.rollout, "pilot");

  // After withdrawal, the same write succeeds.
  await recheckOrganization(deps(false));
  assert.equal((await send("/api/telemetry/config", "PUT", { enabled: true })).status, 200);
});

test("the pilot route enrolls through the apply path and answers 409 when unmanaged", async () => {
  assert.equal((await send("/api/telemetry/organization/pilot", "POST", { enrolled: true })).status, 409);
  assert.equal((await send("/api/telemetry/organization/pilot", "POST", { enrolled: "yes" })).status, 400);
  await manage();
  const joined = await send("/api/telemetry/organization/pilot", "POST", { enrolled: true });
  assert.equal(joined.status, 200);
  assert.equal((joined.body.organization as { pilotEnrolled: boolean }).pilotEnrolled, true);
  assertPreset(true);
});

test("re-check under the test runner detects nothing and withdraws a forced organization", async () => {
  await manage();
  // The route re-detects with this process's own environment, which forces nothing - and the
  // test-runner guard refuses real detection - so the managed lane is withdrawn.
  const rechecked = await send("/api/telemetry/organization/recheck", "POST", {});
  assert.equal(rechecked.status, 200);
  assert.equal(rechecked.body.organization, null);
  assert.equal(currentOrganization(), null);
  assert.equal(getAppConfig(APP_CONFIG_ENTRIES.telemetryOrganization), undefined);
});
