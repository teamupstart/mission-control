import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Phase 2's control surface: the transitions between collection and export states, the
// concurrency guard on consent, the maintenance operations, and the boundaries a settings
// restore may not cross.
//
// What is at stake is the difference between a consent surface and a consent CLAIM. An
// operator who switches sharing off has to have the backlog go with it; one who saves the same
// form twice must not invalidate their other tab; a credential must have no read path at all;
// and a snapshot restored from another machine must not be able to turn any of it on. Each of
// those is a sentence this app puts on screen, so each one is asserted here against real
// storage rather than against a mock that would agree with whatever the code does.

const home = mkdtempSync(join(tmpdir(), "mission-telemetry-controls-"));
process.env.HARNESS_HOME = join(home, "state");

const { closeDb, openDb, getAppConfig } = await import("../src/server/db.ts");
const {
  getTelemetryConfig,
  installProductIngestForTesting,
  setTelemetryConfig,
  telemetryIdentity,
  telemetryStatus,
  userCredentialConfigured,
} = await import("../src/server/telemetry/config.ts");
const { recordTelemetryControl, runTelemetryOperation } = await import(
  "../src/server/telemetry/controls.ts"
);
const { captureTelemetry } = await import("../src/server/telemetry/capture.ts");
const { telemetryHealth, telemetrySettingsSummary } = await import(
  "../src/server/telemetry/health.ts"
);
const { runProjectionPass } = await import("../src/server/telemetry/projection.ts");
const { registerBuiltinTelemetry, startTelemetry } = await import(
  "../src/server/telemetry/service.ts"
);
const { getSecret, telemetryTransaction } = await import("../src/server/telemetry/store.ts");
const { DAEMON_STARTED_EVENT, TELEMETRY_CONTROL_EVENT } = await import(
  "../src/shared/telemetry-catalog.ts"
);
const { APP_CONFIG_ENTRIES } = await import("../src/shared/app-config-entries.ts");
const { SETTINGS_BACKUP_DOMAIN_IDS } = await import(
  "../src/shared/settings-backup-domains.ts"
);
const { resolveOperationContext } = await import("../src/shared/telemetry-ingress.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { publishSettingsStatus } = await import("../src/server/settings-status.ts");
type ServerEvent = import("../src/shared/types.ts").ServerEvent;

registerBuiltinTelemetry();

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

const TELEMETRY_TABLES = [
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

beforeEach(() => {
  const d = openDb();
  for (const table of TELEMETRY_TABLES) d.exec(`DELETE FROM ${table}`);
  d.exec("DELETE FROM app_config");
  installProductIngestForTesting(null);
});

/** An operation context with nothing in it - the honest default for a bare request. */
const ANONYMOUS = resolveOperationContext(new Headers());

/** What the dashboard's own client produces. */
const FROM_APP = resolveOperationContext(
  new Headers({
    "x-mission-operation-id": "abcdef0123456789",
    "x-mission-operation-surface": "settings",
    "x-mission-operation-actor": "human",
  }),
);

function capture(): void {
  captureTelemetry({
    event: DAEMON_STARTED_EVENT,
    source: { kind: "mission.daemon", id: `boot-${Math.random()}`, revision: 1 },
    facts: { startup_ms: 12, schema_upgraded: false, launch_mode: "daemon" },
  });
}

// ---- the transition table ----
//
// Five states an operator can be in, and the moves between them. These are asserted as a table
// because the failures that matter are the ones where two of them blur: a paused destination
// that quietly stopped collecting, or a disabled one that kept a queue.

test("collection on with no endpoint is local-only capture, not a broken export", () => {
  assert.equal(setTelemetryConfig({ enabled: true }).ok, true);
  const summary = telemetrySettingsSummary();
  const local = summary.profiles.find((p) => p.profile === "local");
  assert.equal(local?.capturing, true, "local capture needs no endpoint at all");
  assert.equal(local?.exporting, false, "and it exports nowhere");
  assert.equal(
    summary.profiles.find((p) => p.profile === "user")?.capturing,
    false,
    "the operator's own backend is a separate opt-in",
  );
});

test("pausing stops sending and keeps the queue; disabling stops capture and drops it", () => {
  assert.equal(
    setTelemetryConfig({
      enabled: true,
      user: { enabled: true, endpoint: "http://127.0.0.1:14318" },
    }).ok,
    true,
  );
  capture();
  runProjectionPass();
  assert.ok(queued("user") > 0, "a captured fact produces a batch for an enabled destination");

  // Pause: still capturing, no longer exporting, the queue is untouched.
  assert.equal(setTelemetryConfig({ user: { paused: true } }).ok, true);
  let summary = telemetrySettingsSummary();
  let user = summary.profiles.find((p) => p.profile === "user");
  assert.equal(user?.capturing, true, "pausing does not stop collection");
  assert.equal(user?.exporting, false, "pausing stops sending");
  assert.ok(queued("user") > 0, "pausing keeps the backlog");

  // Disable: capture stops AND the backlog goes, because consent withdrawn is not consent to
  // keep what was already collected for that audience.
  assert.equal(setTelemetryConfig({ user: { enabled: false } }).ok, true);
  summary = telemetrySettingsSummary();
  user = summary.profiles.find((p) => p.profile === "user");
  assert.equal(user?.capturing, false);
  assert.equal(queued("user"), 0, "withdrawal purges the unsent queue");
});

test("withdrawing one audience leaves the other's queue alone", () => {
  installProductIngestForTesting("http://127.0.0.1:14319");
  assert.equal(
    setTelemetryConfig({
      enabled: true,
      user: { enabled: true, endpoint: "http://127.0.0.1:14318" },
      product: { enabled: true, endpoint: "http://127.0.0.1:14319" },
    }).ok,
    true,
  );
  capture();
  runProjectionPass();
  assert.ok(queued("user") > 0 && queued("product") > 0, "both audiences queued the same fact");

  assert.equal(setTelemetryConfig({ product: { enabled: false } }).ok, true);
  assert.equal(queued("product"), 0, "the withdrawn audience's queue goes");
  assert.ok(queued("user") > 0, "the audience that was not withdrawn keeps its own");
});

test("the product audience cannot be enabled while there is nowhere to send it", () => {
  // The rule that has not changed: switching this on with no address would claim to be sharing
  // while queueing for somewhere that cannot answer.
  const refused = setTelemetryConfig({ enabled: true, product: { enabled: true } });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /no ingest service/i);
  assert.equal(telemetrySettingsSummary().productEnrollment, "unavailable");
});

test("configuring a product endpoint enrolls this installation, with no hosted service involved", () => {
  // The operable path. No descriptor seam here on purpose: this is exactly what a real operator
  // running their own minimized collector does, with no test-only affordance in the way.
  const applied = setTelemetryConfig({
    enabled: true,
    product: { enabled: true, endpoint: "http://127.0.0.1:14398" },
  });
  assert.equal(applied.ok, true, applied.ok ? "" : applied.error);
  assert.equal(telemetrySettingsSummary().productEnrollment, "available");
  const product = telemetrySettingsSummary().profiles.find((p) => p.profile === "product");
  assert.equal(product?.capturing, true);
  assert.equal(product?.exporting, true);
});

test("one write may supply the product endpoint and the opt-in together", () => {
  // Checked against the post-patch configuration rather than the stored one. Against the store,
  // this write would refuse itself: the endpoint it is saving is not visible yet.
  const applied = setTelemetryConfig({
    enabled: true,
    product: { enabled: true, endpoint: "http://127.0.0.1:14398" },
  });
  assert.equal(applied.ok, true);
  assert.equal(getTelemetryConfig().product.enabled, true);
});

test("clearing the product endpoint un-enrolls and stops that audience", () => {
  assert.equal(
    setTelemetryConfig({
      enabled: true,
      product: { enabled: true, endpoint: "http://127.0.0.1:14398" },
    }).ok,
    true,
  );
  capture();
  runProjectionPass();
  assert.ok(queued("product") > 0);

  assert.equal(setTelemetryConfig({ product: { endpoint: "" } }).ok, true);
  assert.equal(telemetrySettingsSummary().productEnrollment, "unavailable");
  const product = telemetrySettingsSummary().profiles.find((p) => p.profile === "product");
  assert.equal(product?.capturing, false, "no address means no eligible audience");
  // Losing the address is a withdrawal, so the unsent queue goes with it rather than waiting
  // for an endpoint that may never come back.
  assert.equal(queued("product"), 0);
});

test("a failed purge leaves the installation identity alone", () => {
  // The ordering guarantee, tested from its failure side. The mint writes through `app_config`
  // and cannot join the queue transaction, so if the queues are cleared SECOND a purge that
  // throws leaves a rotated pseudonym stored beside batches still carrying the old one - and
  // delivering those is exactly what a reset promises not to do.
  //
  // The fault is injected by renaming a table the purge depends on, which is the only way to
  // make that transaction fail without mocking the store out from under the operation.
  assert.equal(
    setTelemetryConfig({
      enabled: true,
      user: { enabled: true, endpoint: "http://127.0.0.1:14318" },
    }).ok,
    true,
  );
  capture();
  runProjectionPass();
  const before = telemetryIdentity();

  const d = openDb();
  d.exec("ALTER TABLE telemetry_delivery RENAME TO telemetry_delivery_hidden");
  try {
    assert.throws(() => runTelemetryOperation("reset_identity"));
  } finally {
    d.exec("ALTER TABLE telemetry_delivery_hidden RENAME TO telemetry_delivery");
  }

  const after = telemetryIdentity();
  assert.equal(after.installationId, before.installationId, "the pseudonym did not rotate");
  assert.equal(after.epoch, before.epoch, "and neither did its epoch");
  // The queued batch is still there under the identity that built it, which is the consistent
  // state: nothing was rotated, so nothing is mismatched.
  assert.ok(queued("user") > 0);

  // And the operation still works once the fault is gone, so the guard is not a dead end.
  const result = runTelemetryOperation("reset_identity");
  assert.notEqual(result.identity?.installationId, before.installationId);
  assert.equal(queued("user"), 0);
});

test("a retry that clears a pause over an empty queue says the pause was lifted", () => {
  // Three outcomes, not two. This one used to report "0 queued batches will be attempted on the
  // next cycle", which reads as nothing having happened when the pause was in fact cleared.
  assert.equal(
    setTelemetryConfig({
      enabled: true,
      user: { enabled: true, endpoint: "http://127.0.0.1:14318" },
    }).ok,
    true,
  );
  const d = openDb();
  d.prepare(
    `INSERT INTO telemetry_destinations
       (profile, generation, policy_epoch, endpoint_digest, paused_reason,
        last_accepted_at, last_error, updated_at)
     VALUES ('user', 1, 1, '', 'auth', NULL, NULL, 0)
     ON CONFLICT(profile) DO UPDATE SET paused_reason = 'auth'`,
  ).run();

  const result = runTelemetryOperation("retry", "user");
  assert.equal(result.resumed, true);
  assert.match(result.detail, /resumed/i, "the sentence says the pause was lifted");
  assert.doesNotMatch(result.detail, /^0 queued/, "and does not read as a no-op");
});

test("re-entering an address cannot silently resume product sharing", () => {
  // The consent hazard behind forcing the switch off when the address is cleared. If `enabled`
  // survived an empty endpoint, typing an address back in would resume sharing without anybody
  // deciding to - and the switch would have read "on" the whole time over a destination that
  // was not sending.
  assert.equal(
    setTelemetryConfig({
      enabled: true,
      product: { enabled: true, endpoint: "http://127.0.0.1:14398" },
    }).ok,
    true,
  );
  assert.equal(setTelemetryConfig({ product: { endpoint: "" } }).ok, true);
  assert.equal(getTelemetryConfig().product.enabled, false, "the switch goes with the address");

  // The address comes back. Sharing does not, until somebody says so.
  assert.equal(setTelemetryConfig({ product: { endpoint: "http://127.0.0.1:14398" } }).ok, true);
  assert.equal(getTelemetryConfig().product.enabled, false);
  assert.equal(
    telemetrySettingsSummary().profiles.find((p) => p.profile === "product")?.capturing,
    false,
  );
});

test("the product endpoint is its own, and enabling it never borrows the personal one", () => {
  assert.equal(
    setTelemetryConfig({
      enabled: true,
      user: { enabled: true, endpoint: "http://127.0.0.1:14318" },
    }).ok,
    true,
  );
  // A personal backend is configured and working. The product audience is still unavailable,
  // because "unavailable" is about ITS address - it is never silently redirected to the other.
  assert.equal(telemetrySettingsSummary().productEnrollment, "unavailable");
  const refused = setTelemetryConfig({ product: { enabled: true } });
  assert.equal(refused.ok, false, "the personal endpoint does not enroll the product audience");
  assert.equal(getTelemetryConfig().product.endpoint, "");
});

// ---- concurrency and duplicate saves ----

test("a duplicate configuration update changes nothing and moves no revision", () => {
  assert.equal(setTelemetryConfig({ enabled: true }).ok, true);
  const first = getTelemetryConfig().revision;
  const again = setTelemetryConfig({ enabled: true });
  assert.equal(again.ok, true);
  assert.equal(again.ok && again.changed, false, "an identical save is not a change");
  assert.equal(getTelemetryConfig().revision, first, "so the concurrency token does not move");
});

test("an edit composed against a stale revision is refused rather than merged", () => {
  assert.equal(setTelemetryConfig({ enabled: true }).ok, true);
  const stale = getTelemetryConfig().revision;
  // Somebody else saves first.
  assert.equal(setTelemetryConfig({ user: { endpoint: "http://127.0.0.1:14318" } }).ok, true);
  assert.notEqual(getTelemetryConfig().revision, stale);

  const refused = setTelemetryConfig({ enabled: false, ifRevision: stale });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok ? false : refused.conflict, true, "reported as a conflict, not a bad value");
  assert.equal(getTelemetryConfig().enabled, true, "and the losing write did not land");
});

test("a write with a current revision applies", () => {
  assert.equal(setTelemetryConfig({ enabled: true }).ok, true);
  const current = getTelemetryConfig().revision;
  assert.equal(setTelemetryConfig({ enabled: false, ifRevision: current }).ok, true);
  assert.equal(getTelemetryConfig().enabled, false);
});

// ---- endpoints and credentials ----

test("a credential on a plaintext remote endpoint is refused as a unit", () => {
  const refused = setTelemetryConfig({
    enabled: true,
    user: { enabled: true, endpoint: "http://telemetry.example.com:4318" },
    userCredential: "secret-token",
  });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /HTTPS/);
  assert.equal(userCredentialConfigured(), false, "nothing was stored by the refused write");
});

test("a loopback Collector over plain HTTP stays usable, credential and all", () => {
  const applied = setTelemetryConfig({
    enabled: true,
    user: { enabled: true, endpoint: "http://127.0.0.1:14318" },
    userCredential: "secret-token",
  });
  assert.equal(applied.ok, true);
  assert.equal(userCredentialConfigured(), true);
});

test("removing HTTPS from an endpoint that already carries a credential is refused", () => {
  assert.equal(
    setTelemetryConfig({
      enabled: true,
      user: { enabled: true, endpoint: "https://telemetry.example.com" },
      userCredential: "secret-token",
    }).ok,
    true,
  );
  const refused = setTelemetryConfig({ user: { endpoint: "http://telemetry.example.com" } });
  assert.equal(refused.ok, false, "the stored credential is what makes this unsafe");
});

test("no read path returns a stored credential", () => {
  assert.equal(
    setTelemetryConfig({
      enabled: true,
      user: { enabled: true, endpoint: "http://127.0.0.1:14318" },
      userCredential: "super-secret-token",
    }).ok,
    true,
  );
  // The three things a browser or an operator can actually read.
  const serialized = [
    JSON.stringify(telemetryStatus()),
    JSON.stringify(telemetryHealth()),
    JSON.stringify(telemetrySettingsSummary()),
  ].join("\n");
  assert.ok(
    !serialized.includes("super-secret-token"),
    "a credential must not appear in any operator-facing read",
  );
  assert.equal(telemetryStatus().userCredentialConfigured, true, "only its EXISTENCE is reported");
  // And it really is stored - this assertion is what stops the one above passing vacuously.
  assert.equal(
    telemetryTransaction((d) => getSecret(d, "user")?.headerValue),
    "super-secret-token",
  );
});

test("an endpoint change bumps the destination generation rather than moving the backlog", () => {
  assert.equal(
    setTelemetryConfig({
      enabled: true,
      user: { enabled: true, endpoint: "http://127.0.0.1:14318" },
    }).ok,
    true,
  );
  const before = telemetryHealth().profiles.find((p) => p.profile === "user");
  assert.equal(setTelemetryConfig({ user: { endpoint: "http://127.0.0.1:14319" } }).ok, true);
  const after = telemetryHealth().profiles.find((p) => p.profile === "user");
  assert.equal(
    (after?.destinationGeneration ?? 0) > (before?.destinationGeneration ?? 0),
    true,
    "batches built for the previous endpoint cannot silently follow",
  );
});

// ---- maintenance operations ----

test("purge drops one profile's unsent work and nothing else", () => {
  installProductIngestForTesting("http://127.0.0.1:14319");
  assert.equal(
    setTelemetryConfig({
      enabled: true,
      user: { enabled: true, endpoint: "http://127.0.0.1:14318" },
      product: { enabled: true, endpoint: "http://127.0.0.1:14319" },
    }).ok,
    true,
  );
  capture();
  runProjectionPass();
  const productBefore = queued("product");
  assert.ok(queued("user") > 0 && productBefore > 0);

  const result = runTelemetryOperation("purge", "user");
  assert.ok(result.purged > 0, "it reports what it dropped");
  assert.equal(queued("user"), 0);
  assert.equal(queued("product"), productBefore, "the other audience is untouched");
  assert.equal(getTelemetryConfig().enabled, true, "and purging is not a consent change");
});

test("retry clears a self-inflicted pause without resetting the backoff attempts", () => {
  assert.equal(
    setTelemetryConfig({
      enabled: true,
      user: { enabled: true, endpoint: "http://127.0.0.1:14318" },
    }).ok,
    true,
  );
  const d = openDb();
  d.prepare(
    `INSERT INTO telemetry_destinations
       (profile, generation, policy_epoch, endpoint_digest, paused_reason,
        last_accepted_at, last_error, updated_at)
     VALUES ('user', 1, 1, '', 'auth', NULL, 'the destination rejected the credential', 0)
     ON CONFLICT(profile) DO UPDATE SET paused_reason = 'auth', last_error = excluded.last_error`,
  ).run();
  // A REAL backed-off delivery, not just a paused destination. Without this row the operation
  // has nothing to act on, and a `releaseBackoff` that deleted or zeroed attempts would pass
  // every assertion below - which is exactly what the earlier version of this test did.
  const now = Date.now();
  const dueLater = now + 45_000;
  seedBackedOffBatch(d, { batchId: "batch-retry-1", profile: "user", attempts: 4, nextAttemptAt: dueLater });
  assert.equal(telemetryHealth().profiles.find((p) => p.profile === "user")?.pausedReason, "auth");

  const result = runTelemetryOperation("retry", "user", now);
  assert.equal(result.resumed, true);
  const user = telemetryHealth().profiles.find((p) => p.profile === "user");
  assert.equal(user?.pausedReason, null);
  assert.equal(user?.lastError, null, "yesterday's reason does not survive beside a live queue");

  const row = delivery(d, "batch-retry-1");
  // Eligible NOW: that is what "Try again" has to mean on a destination sitting an hour into
  // its ceiling, and the reason this is an operation rather than just running a cycle.
  assert.ok(row.next_attempt_at <= now, "the backed-off batch is due immediately after a retry");
  // And the count is UNTOUCHED, which is the half that protects the endpoint: if this reset,
  // an operator holding the button would turn a dead destination into a tight retry loop.
  assert.equal(row.attempts, 4, "retry brings the schedule forward; it does not forgive attempts");
  assert.equal(row.state, "retry", "and it stays a retry rather than being promoted");
  assert.equal(result.purged, 0, "a retry drops nothing");
});

test("retry leaves a batch that is already due exactly as it found it", () => {
  // The other half of the contract: `releaseBackoff` only moves rows whose next attempt is in
  // the FUTURE. A version that rewrote every row would still pass the test above.
  assert.equal(
    setTelemetryConfig({
      enabled: true,
      user: { enabled: true, endpoint: "http://127.0.0.1:14318" },
    }).ok,
    true,
  );
  const d = openDb();
  const now = Date.now();
  const alreadyDue = now - 5_000;
  seedBackedOffBatch(d, {
    batchId: "batch-retry-due",
    profile: "user",
    attempts: 2,
    nextAttemptAt: alreadyDue,
  });

  runTelemetryOperation("retry", "user", now);
  const row = delivery(d, "batch-retry-due");
  assert.equal(row.next_attempt_at, alreadyDue, "a row already due is not rescheduled");
  assert.equal(row.attempts, 2);
});

test("retry does not reach across into another destination's backoff", () => {
  installProductIngestForTesting("http://127.0.0.1:14319");
  assert.equal(
    setTelemetryConfig({
      enabled: true,
      user: { enabled: true, endpoint: "http://127.0.0.1:14318" },
      product: { enabled: true, endpoint: "http://127.0.0.1:14319" },
    }).ok,
    true,
  );
  const d = openDb();
  const now = Date.now();
  const dueLater = now + 45_000;
  seedBackedOffBatch(d, { batchId: "batch-user", profile: "user", attempts: 1, nextAttemptAt: dueLater });
  seedBackedOffBatch(d, { batchId: "batch-product", profile: "product", attempts: 3, nextAttemptAt: dueLater });

  runTelemetryOperation("retry", "user", now);
  assert.ok(delivery(d, "batch-user").next_attempt_at <= now, "the named destination moves");
  assert.equal(
    delivery(d, "batch-product").next_attempt_at,
    dueLater,
    "the other destination's backoff is its own",
  );
  assert.equal(delivery(d, "batch-product").attempts, 3);
});

test("resetting the identity mints a new pseudonym and takes the old queues with it", () => {
  assert.equal(
    setTelemetryConfig({
      enabled: true,
      user: { enabled: true, endpoint: "http://127.0.0.1:14318" },
    }).ok,
    true,
  );
  capture();
  runProjectionPass();
  assert.ok(queued("user") > 0);
  const before = telemetryIdentity();

  const result = runTelemetryOperation("reset_identity");
  assert.notEqual(result.identity?.installationId, before.installationId);
  assert.equal(result.identity?.epoch, before.epoch + 1);
  assert.equal(
    queued("user"),
    0,
    "a batch built under the old pseudonym carries it in its resource and cannot be rewritten",
  );
  // The reset is about telemetry identity only. Consent is not withdrawn by it.
  assert.equal(getTelemetryConfig().enabled, true);
});

// ---- the control record itself ----

test("a control action is recorded with the actor basis the request earned", () => {
  assert.equal(setTelemetryConfig({ enabled: true }).ok, true);
  recordTelemetryControl({
    action: "configure",
    profile: "all",
    outcome: "applied",
    context: FROM_APP,
  });
  const row = journalRow(TELEMETRY_CONTROL_EVENT.name);
  assert.ok(row, "an applied control is captured through the ordinary facade");
  assert.equal(JSON.parse(row.actor).basis, "app_context");
  assert.equal(JSON.parse(row.facts).actor_basis, "app_context");
  assert.equal(JSON.parse(row.refs).operation_id, "abcdef0123456789");
});

test("a request with no operation context is recorded as unknown rather than as a person", () => {
  assert.equal(setTelemetryConfig({ enabled: true }).ok, true);
  recordTelemetryControl({
    action: "purge",
    profile: "local",
    outcome: "applied",
    context: ANONYMOUS,
  });
  const row = journalRow(TELEMETRY_CONTROL_EVENT.name);
  assert.ok(row);
  assert.equal(JSON.parse(row.actor).basis, "unknown");
  assert.equal(JSON.parse(row.actor).kind, "unknown");
  assert.equal(JSON.parse(row.refs).operation_id, undefined, "no id means no ref, not a null one");
});

test("switching collection off records nothing, because that is what off means", () => {
  assert.equal(setTelemetryConfig({ enabled: true }).ok, true);
  assert.equal(setTelemetryConfig({ enabled: false }).ok, true);
  recordTelemetryControl({
    action: "configure",
    profile: "all",
    outcome: "applied",
    context: FROM_APP,
  });
  assert.equal(journalRow(TELEMETRY_CONTROL_EVENT.name), null);
});

// ---- restore and backup boundaries ----

test("nothing on the telemetry page is carried by a settings snapshot", () => {
  for (const key of ["telemetry", "telemetryIdentity", "telemetryRuntime"] as const) {
    const entry = APP_CONFIG_ENTRIES[key];
    assert.equal(
      entry.backupDomain,
      null,
      `${entry.key} must not belong to a backup domain - a restore cannot be allowed to opt in`,
    );
    assert.equal(entry.classification.kind === "whole" && entry.classification.valueClass, "operational");
  }
  // And there is no domain named for it either, which is the way this would come back.
  assert.ok(
    !SETTINGS_BACKUP_DOMAIN_IDS.some((id) => id.includes("telemetry")),
    "a telemetry backup domain would be a way to restore consent onto another machine",
  );
});

test("the credential is not in app config at all, so no snapshot could carry one", () => {
  assert.equal(
    setTelemetryConfig({
      enabled: true,
      user: { enabled: true, endpoint: "http://127.0.0.1:14318" },
      userCredential: "super-secret-token",
    }).ok,
    true,
  );
  const stored = JSON.stringify(getAppConfig(APP_CONFIG_ENTRIES.telemetry) ?? {});
  assert.ok(!stored.includes("super-secret-token"));
});

// ---- helpers ----

function queued(profile: string): number {
  const row = openDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM telemetry_delivery
        WHERE profile = ? AND state IN ('pending','retry','leased')`,
    )
    .get(profile) as { n: number };
  return row.n;
}

/**
 * A batch sitting in backoff: a real payload row plus the delivery row that schedules it.
 *
 * Inserted directly rather than produced by a failed send, because the point is to control the
 * attempt count and the next-attempt time exactly. Both rows are needed - `deliveryCounts` and
 * `releaseBackoff` join them, so a delivery row with no batch behind it is invisible to the
 * very queries under test.
 */
function seedBackedOffBatch(
  d: ReturnType<typeof openDb>,
  input: { batchId: string; profile: string; attempts: number; nextAttemptAt: number },
): void {
  d.prepare(
    `INSERT INTO telemetry_batches
       (id, profile, signal, destination_generation, policy_epoch, catalog_version,
        envelope_version, payload_json, digest, item_count, bytes, created_at, oldest_event_at)
     VALUES (?, ?, 'metrics', 1, 1, 1, 1, '{}', 'digest', 1, 32, ?, ?)`,
  ).run(input.batchId, input.profile, input.nextAttemptAt - 60_000, input.nextAttemptAt - 60_000);
  d.prepare(
    `INSERT INTO telemetry_delivery
       (batch_id, profile, signal, state, attempts, next_attempt_at, updated_at)
     VALUES (?, ?, 'metrics', 'retry', ?, ?, 0)`,
  ).run(input.batchId, input.profile, input.attempts, input.nextAttemptAt);
}

/** One delivery row, as stored. */
function delivery(
  d: ReturnType<typeof openDb>,
  batchId: string,
): { state: string; attempts: number; next_attempt_at: number } {
  const row = d
    .prepare(`SELECT state, attempts, next_attempt_at FROM telemetry_delivery WHERE batch_id = ?`)
    .get(batchId) as { state: string; attempts: number; next_attempt_at: number } | undefined;
  assert.ok(row, `no delivery row for ${batchId}`);
  return row;
}

function journalRow(name: string): { actor: string; facts: string; refs: string } | null {
  const row = openDb()
    .prepare(
      `SELECT actor_json AS actor, facts_json AS facts, refs_json AS refs
         FROM telemetry_journal WHERE name = ? ORDER BY seq DESC LIMIT 1`,
    )
    .get(name) as { actor: string; facts: string; refs: string } | undefined;
  return row ?? null;
}

// ---- the routes ----
//
// Driven through `buildApp` rather than by calling the functions above, because what is being
// asserted is the ROUTE's contract: which status code a refusal carries, whether the settings
// tuple is pushed to every open dashboard, and what the ingress answers when it refuses. None of
// those live in the modules the tests above exercise.

const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

const registries = new WeakMap<object, InstanceType<typeof Registry>>();

function routes() {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const app = buildApp({ registry, reviews: {} as never, tasks, queues: {} as never });
  const statuses: ServerEvent[] = [];
  registry.subscribe((e) => {
    if (e.type === "settings_status") statuses.push(e);
  });
  // Kept beside the collector so a test can seed a baseline tuple before measuring what the
  // route pushes. `emitSettingsStatus` drops a frame that restates the last one, so without a
  // baseline the first emission after setup is indistinguishable from the one under test.
  registries.set(statuses, registry);
  return { app, statuses };
}

function registryOf(statuses: ServerEvent[]): InstanceType<typeof Registry> {
  const registry = registries.get(statuses);
  assert.ok(registry, "every statuses array is registered beside its registry");
  return registry;
}

test("PUT /api/telemetry/config pushes the telemetry tuple to every open dashboard", async () => {
  const { app, statuses } = routes();
  const res = await app.request("/api/telemetry/config", {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(res.status, 200);
  const last = statuses.at(-1);
  assert.ok(last && last.type === "settings_status");
  assert.equal(last.status.telemetry?.enabled, true);
});

test("a duplicate PUT wakes no dashboard, because nothing changed", async () => {
  const { app, statuses } = routes();
  const body = JSON.stringify({ enabled: true });
  await app.request("/api/telemetry/config", { method: "PUT", headers: HEADERS, body });
  const after = statuses.length;
  await app.request("/api/telemetry/config", { method: "PUT", headers: HEADERS, body });
  assert.equal(statuses.length, after, "the identical second write should push nothing");
});

test("a stale revision is a 409 the panel can tell apart from a bad value", async () => {
  const { app } = routes();
  await app.request("/api/telemetry/config", {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify({ enabled: true }),
  });
  const res = await app.request("/api/telemetry/config", {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify({ enabled: false, ifRevision: 0 }),
  });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { conflict: boolean }).conflict, true);
});

test("a refused endpoint is a 409 carrying the sentence an operator can act on", async () => {
  const { app } = routes();
  const res = await app.request("/api/telemetry/config", {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify({
      enabled: true,
      user: { enabled: true, endpoint: "http://telemetry.example.com" },
      userCredential: "token",
    }),
  });
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string; conflict: boolean };
  assert.match(body.error, /HTTPS/);
  assert.equal(body.conflict, false, "a bad value is not a concurrent edit");
});

test("an operation answers what it did and republishes a tuple that shows the change", async () => {
  const { app, statuses } = routes();
  await app.request("/api/telemetry/config", {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify({
      enabled: true,
      user: { enabled: true, endpoint: "http://127.0.0.1:14318" },
    }),
  });
  // Real queued work, so the purge has something to change and the emitted tuple has somewhere
  // to move. Without this the operation is a no-op and any assertion about it is vacuous.
  capture();
  runProjectionPass();
  publishSettingsStatus(registryOf(statuses));
  const queuedBefore = telemetrySettingsSummary().profiles.find((p) => p.profile === "user");
  assert.ok((queuedBefore?.pending ?? 0) > 0, "the fixture has a real backlog to drop");

  const before = statuses.length;
  const res = await app.request("/api/telemetry/operation", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ action: "purge", profile: "user" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { action: string; profile: string; purged: number; detail: string };
  assert.equal(body.action, "purge");
  assert.equal(body.profile, "user");
  assert.ok(body.purged > 0, "it reports what it actually dropped");
  assert.ok(body.detail.length > 0);

  // A NEW frame, not merely "at least as many as before" - which passed when nothing was sent.
  assert.ok(statuses.length > before, "the operation must push a settings_status, not just recompute");
  const last = statuses.at(-1);
  assert.ok(last && last.type === "settings_status");
  // And the frame carries the change, so a publish of a stale tuple cannot satisfy this either.
  const user = last.status.telemetry?.profiles.find((p) => p.profile === "user");
  assert.equal(user?.pending, 0, "the pushed tuple shows the queue this operation emptied");
});

test("an operation that needs a profile is refused by the schema, not defaulted", async () => {
  const { app } = routes();
  const res = await app.request("/api/telemetry/operation", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ action: "purge" }),
  });
  assert.equal(res.status, 400);
});

test("the ingress answers 200 with a refusal rather than failing the caller", async () => {
  const { app } = routes();
  await app.request("/api/telemetry/config", {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify({ enabled: true }),
  });
  const res = await app.request("/api/telemetry/ingress", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      records: [{ event: "mission.daemon.started", facts: {} }],
    }),
  });
  assert.equal(res.status, 200, "a telemetry refusal is not an application failure");
  assert.deepEqual(await res.json(), {
    accepted: 0,
    rejected: [{ index: 0, reason: "not_browser_eligible" }],
  });
});

// The byte ceiling, from all three directions a caller can come at it.
//
// `Content-Length` is supplied by the caller. It is absent on a chunked request and can simply
// be wrong, so a limit enforced against it refuses only the callers who were going to behave -
// which is the entire population this limit does not exist for. Each case below is one of those
// three, and the first is the only one an honest-header check would have caught.

/** An oversized ingress body. Valid JSON and valid shape; only its size is the problem. */
function oversizedIngressBody(): string {
  return JSON.stringify({
    records: [
      {
        event: "mission.telemetry.settings.opened",
        facts: { collection_enabled: true, destinations_enabled: 0, junk: "x".repeat(64 * 1024) },
      },
    ],
  });
}

test("an oversized ingress body with an honest Content-Length is refused", async () => {
  const { app } = routes();
  const body = oversizedIngressBody();
  const res = await app.request("/api/telemetry/ingress", {
    method: "POST",
    headers: { ...HEADERS, "content-length": String(Buffer.byteLength(body)) },
    body,
  });
  assert.equal(res.status, 413);
});

test("an oversized ingress body with NO Content-Length is refused", async () => {
  // A chunked request: the body is a stream, so the runtime sends no `Content-Length` at all.
  // A header check treats a missing length as zero and waves this through.
  const { app } = routes();
  const bytes = new TextEncoder().encode(oversizedIngressBody());
  const res = await app.request(
    new Request("http://127.0.0.1:7317/api/telemetry/ingress", {
      method: "POST",
      // The same headers the other route tests send, minus any length: the daemon's own
      // host guard applies here too, and a 403 would prove nothing about the byte ceiling.
      headers: HEADERS,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          // In slices, which is the shape that matters: the limit has to be enforced on the
          // RUNNING total, not on whatever the first chunk happened to contain.
          for (let at = 0; at < bytes.length; at += 4096) {
            controller.enqueue(bytes.slice(at, at + 4096));
          }
          controller.close();
        },
      }),
      // Node requires this when a request body is a stream.
      duplex: "half",
    } as RequestInit & { duplex: "half" }),
  );
  assert.equal(res.status, 413, "a chunked oversized body must not reach the parser");
});

test("an oversized ingress body that UNDERSTATES its Content-Length is refused", async () => {
  const { app } = routes();
  const body = oversizedIngressBody();
  const res = await app.request("/api/telemetry/ingress", {
    method: "POST",
    // The lie. A header check believes it and admits a 64 KiB payload.
    headers: { ...HEADERS, "content-length": "10" },
    body,
  });
  assert.equal(res.status, 413, "the measured size wins over the declared one");
});

test("a body inside the limit still goes through, so the bound is not simply refusing", async () => {
  const { app } = routes();
  await app.request("/api/telemetry/config", {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify({ enabled: true }),
  });
  const res = await app.request("/api/telemetry/ingress", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      records: [
        {
          event: "mission.telemetry.settings.opened",
          facts: { collection_enabled: true, destinations_enabled: 0 },
        },
      ],
    }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { accepted: 1, rejected: [] });
});

test("a body that is not JSON is a 400, which is a different failure from too large", async () => {
  const { app } = routes();
  const res = await app.request("/api/telemetry/ingress", {
    method: "POST",
    headers: HEADERS,
    body: "{not json",
  });
  assert.equal(res.status, 400);
});

test("no telemetry route returns a credential, whatever it is asked", async () => {
  const { app } = routes();
  await app.request("/api/telemetry/config", {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify({
      enabled: true,
      user: { enabled: true, endpoint: "http://127.0.0.1:14318" },
      userCredential: "super-secret-token",
    }),
  });
  for (const path of ["/api/telemetry/config", "/api/telemetry/health"]) {
    const text = await (await app.request(path, { headers: HEADERS })).text();
    assert.ok(!text.includes("super-secret-token"), `${path} leaked the credential`);
  }
});

// ---- the live health path ----
//
// The claim the Settings panel rests on is that queue health arrives on its own, with no poll
// behind it: the export cycle republishes the settings tuple when it moves something. That
// wiring sits between a timer and an SSE frame, which is exactly the shape of thing that breaks
// silently - the panel simply shows yesterday's numbers, and nothing fails.
//
// Driven through the real `startTelemetry` timer with its cadence shortened, rather than by
// calling the callback directly, because the thing worth testing IS the wiring.

test("a cycle that moves something republishes health, and an idle cycle wakes nobody", async () => {
  assert.equal(setTelemetryConfig({ enabled: true }).ok, true);
  // Real unprojected work, so the first cycle has something to consume.
  capture();

  let published = 0;
  const service = startTelemetry({}, { cycleMs: 20, onHealthChanged: () => (published += 1) });
  try {
    await waitFor(() => published > 0, "the cycle that consumed the journal should publish");

    // Now the journal is drained and local-only builds no batches, so every further tick is a
    // genuine no-op. It must stay silent: a publish per tick would wake every open dashboard
    // every thirty seconds forever, which is the poll this design exists to avoid.
    const afterWork = published;
    await sleep(300); // ~15 ticks at this cadence
    assert.equal(published, afterWork, "an idle cycle must not push a frame");
  } finally {
    await service.stop();
  }
});

async function waitFor(condition: () => boolean, why: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(10);
  }
  assert.fail(why);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
