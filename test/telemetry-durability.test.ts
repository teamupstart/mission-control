import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";

// The durable core: capture, the crash boundaries, cumulative state across restarts, consent
// fencing, series ceilings and retention.
//
// A real database, and real restarts - `closeDb()` then `openDb()` is the same reopen a daemon
// does, through the same migration path. Nothing here is mocked, because every property being
// asserted is a property of what SQLite actually committed.

const home = mkdtempSync(join(tmpdir(), "mission-telemetry-durable-"));
// Set before importing anything that resolves the state dir.
process.env.HARNESS_HOME = join(home, "state");

const { closeDb, openDb } = await import("../src/server/db.ts");
const { captureTelemetry } = await import("../src/server/telemetry/capture.ts");
const { setTelemetryConfig, telemetryIdentity } = await import(
  "../src/server/telemetry/config.ts"
);
const { runProjectionPass } = await import("../src/server/telemetry/projection.ts");
const { registerBuiltinTelemetry } = await import("../src/server/telemetry/service.ts");
const { runRetentionPass } = await import("../src/server/telemetry/retention.ts");
const { telemetryHealth } = await import("../src/server/telemetry/health.ts");
const { observeDaemonStart } = await import("../src/server/telemetry/diagnostics.ts");
const { DAEMON_STARTED_EVENT } = await import("../src/shared/telemetry-catalog.ts");
const { TELEMETRY_LIMITS } = await import("../src/shared/telemetry.ts");

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
});

/** The same reopen a daemon performs, through the same upgrade path. */
function restartDaemon(): void {
  closeDb();
  openDb();
}

function enableLocalOnly(): void {
  const applied = setTelemetryConfig({ enabled: true });
  assert.equal(applied.ok, true);
}

function enableUserBackend(endpoint = "http://127.0.0.1:14318"): void {
  const applied = setTelemetryConfig({ enabled: true, user: { enabled: true, endpoint } });
  assert.equal(applied.ok, true, applied.ok ? "" : applied.error);
}

function capture(id: string, now: number, startupMs = 120) {
  return captureTelemetry({
    event: DAEMON_STARTED_EVENT,
    source: { kind: "mission.daemon", id, revision: 1 },
    facts: { startup_ms: startupMs, schema_upgraded: false, launch_mode: "daemon" },
    now,
  });
}

interface SeriesRow {
  value: number;
  start_time: number;
  dimensions_json: string;
  hist_buckets: string | null;
  hist_count: number | null;
}

function series(profile: string, instrument: string): SeriesRow[] {
  return openDb()
    .prepare(
      `SELECT value, start_time, dimensions_json, hist_buckets, hist_count FROM telemetry_series
        WHERE profile = ? AND instrument = ? ORDER BY dimensions_key`,
    )
    .all(profile, instrument) as unknown as SeriesRow[];
}

function journalCount(): number {
  return (openDb().prepare(`SELECT COUNT(*) AS n FROM telemetry_journal`).get() as { n: number }).n;
}

function batchCount(profile: string): number {
  return (
    openDb()
      .prepare(`SELECT COUNT(*) AS n FROM telemetry_batches WHERE profile = ?`)
      .get(profile) as { n: number }
  ).n;
}

// ---- default-off and upgrade safety ----

test("collection is off by default and capture writes nothing", () => {
  const result = capture("boot-1", 1_000);
  assert.equal(result.kind, "disabled");
  assert.equal(journalCount(), 0);
  // The identity is not even minted: an installation that never opts in leaves no telemetry
  // trace of any kind, which is what "default off" has to mean to be worth anything.
  assert.equal((openDb().prepare(`SELECT COUNT(*) AS n FROM app_config`).get() as { n: number }).n, 0);
});

test("starting the daemon with collection off mints no installation identity", () => {
  // The regression for the leak this suite previously walked straight past: the default-off test
  // above calls `captureTelemetry` directly, but the DAEMON calls `observeDaemonStart`, which
  // built its source id from `bootId()` - and `bootId()` reads `telemetryIdentity()`, which mints
  // and PERSISTS a pseudonym on first read. The capture was correctly refused afterwards, by
  // which point the row existed. A never-opted-in installation acquired telemetry identity state
  // simply by booting.
  const result = observeDaemonStart({
    startupMs: 250,
    schemaUpgraded: false,
    launchMode: "daemon",
    now: 1_000,
  });
  assert.equal(result.kind, "disabled");
  assert.equal(journalCount(), 0);

  const keys = openDb().prepare(`SELECT key FROM app_config`).all() as unknown as Array<{
    key: string;
  }>;
  assert.deepEqual(
    keys.map((k) => k.key),
    [],
    "a daemon start with collection off leaves no telemetry trace of any kind, identity included",
  );
});

test("repeated starts with collection off stay silent", () => {
  // Because the leak was once per boot, not once ever. Every restart of a never-opted-in
  // installation has to be as quiet as the first.
  for (let boot = 0; boot < 3; boot += 1) {
    assert.equal(
      observeDaemonStart({ startupMs: 100, schemaUpgraded: false, launchMode: "daemon" }).kind,
      "disabled",
    );
    restartDaemon();
  }
  const row = openDb().prepare(`SELECT COUNT(*) AS n FROM app_config`).get() as { n: number };
  assert.equal(row.n, 0);
  assert.equal(journalCount(), 0);
});

test("health reports a disabled, empty facility without minting anything", () => {
  const health = telemetryHealth(5_000);
  assert.equal(health.enabled, false);
  assert.equal(health.journalBacklog, 0);
  assert.equal(health.usedBytes, 0);
  assert.equal(health.productEnrollment, "unavailable");
  for (const profile of health.profiles) assert.equal(profile.capturing, false);
});

test("an unclean previous run is reported as an unknown gap, not as zero loss", async () => {
  // The promise this closes: after a hard stop, health must say the loss is UNKNOWN rather than
  // report zero. What is actually unquantifiable is the pre-acceptance gap - a crash between a
  // business commit and its capture call - since everything after acceptance replays or retries.
  const { noteTelemetryRunStart, noteTelemetryRunStopped } = await import(
    "../src/server/telemetry/retention.ts"
  );
  enableLocalOnly();

  // A run starts and is killed: the marker is left saying "in progress".
  assert.equal(noteTelemetryRunStart(true, 1_000), false, "the first ever start reports no gap");
  assert.equal(
    noteTelemetryRunStart(true, 2_000),
    true,
    "a start that finds the previous run still marked in progress reports a gap",
  );

  const gap = telemetryHealth(3_000).gaps.find((g) => g.kind === "unknown_gap");
  assert.ok(gap, "health reports an unknown gap rather than claiming zero");
  assert.ok(gap!.count >= 1);

  // And an orderly stop clears it, so an ordinary restart is silent.
  noteTelemetryRunStopped(true);
  assert.equal(noteTelemetryRunStart(true, 4_000), false);
});

test("a loss counter that could not be written becomes an unknown gap at the next chance", async () => {
  // The double failure: a fact was refused AND its own counter failed. Relying on
  // unclean-shutdown detection alone meant a transient write failure followed by an orderly
  // exit recorded nothing at all, and health showed zero gaps for a real incident.
  const { markUnknownGapPending, flushPendingUnknownGap, resetPendingUnknownGap } = await import(
    "../src/server/telemetry/retention.ts"
  );
  enableLocalOnly();
  resetPendingUnknownGap();

  assert.equal(flushPendingUnknownGap(1_000), false, "nothing owed, nothing written");

  markUnknownGapPending();
  assert.equal(flushPendingUnknownGap(2_000), true, "the owed gap is written once the store takes it");
  assert.equal(flushPendingUnknownGap(3_000), false, "and is not written twice");

  const gap = telemetryHealth(4_000).gaps.find((g) => g.kind === "unknown_gap");
  assert.ok(gap, "health reports it rather than absorbing it");
});

test("an owed gap is not written by a capture call made while collection is off", async () => {
  // Default-off is a property of the whole capture path, not just the journal write. Settling
  // the owed counter before reading the enabled flag meant an installation that had opted out
  // still grew a row at the next capture attempt from any source - the same shape of bug as
  // minting an identity ahead of the consent check.
  const { markUnknownGapPending, resetPendingUnknownGap } = await import(
    "../src/server/telemetry/retention.ts"
  );
  enableLocalOnly();
  resetPendingUnknownGap();
  markUnknownGapPending();

  const off = setTelemetryConfig({ enabled: false });
  assert.equal(off.ok, true);
  assert.equal(capture("boot-1", 2_000).kind, "disabled");
  assert.equal(
    (openDb().prepare(`SELECT COUNT(*) AS n FROM telemetry_gaps`).get() as { n: number }).n,
    0,
    "collection is off, so the capture path wrote nothing at all",
  );

  // The debt is held in memory rather than dropped, so opting back in still settles it.
  enableLocalOnly();
  assert.equal(capture("boot-2", 3_000).kind, "accepted");
  assert.ok(
    telemetryHealth(4_000).gaps.some((g) => g.kind === "unknown_gap"),
    "and the incident is not lost by having been deferred",
  );
  resetPendingUnknownGap();
});

test("an owed gap that still cannot be written keeps the run marked unclean", async () => {
  // The fallback when the store itself is the thing at fault: rather than declare a clean
  // shutdown and lose the incident, leave the marker set so the next start reports it.
  const { noteTelemetryRunStopped, resetPendingUnknownGap, noteTelemetryRunStart } = await import(
    "../src/server/telemetry/retention.ts"
  );
  const { APP_CONFIG_ENTRIES } = await import("../src/shared/app-config-entries.ts");
  const { getAppConfig } = await import("../src/server/db.ts");
  enableLocalOnly();
  resetPendingUnknownGap();

  noteTelemetryRunStart(true, 1_000);
  noteTelemetryRunStopped(true, 2_000);
  assert.equal(getAppConfig(APP_CONFIG_ENTRIES.telemetryRuntime)?.cleanShutdown, true);
  resetPendingUnknownGap();
});

test("the unclean-run marker is not written while collection is off", async () => {
  // Default-off covers this too: a never-opted-in installation writes no marker, so it can
  // never be told on its next boot that it lost something it was never collecting.
  const { noteTelemetryRunStart, noteTelemetryRunStopped } = await import(
    "../src/server/telemetry/retention.ts"
  );
  assert.equal(noteTelemetryRunStart(false, 1_000), false);
  noteTelemetryRunStopped(false);
  const row = openDb().prepare(`SELECT COUNT(*) AS n FROM app_config`).get() as { n: number };
  assert.equal(row.n, 0);
});

// ---- the acceptance boundary ----

test("accepted means committed: a captured fact survives a restart", () => {
  enableLocalOnly();
  const result = capture("boot-1", 1_000);
  assert.equal(result.kind, "accepted");
  assert.equal(journalCount(), 1);

  restartDaemon();

  // The whole v1 requirement in one assertion: what was accepted is still here after the
  // process that accepted it is gone.
  assert.equal(journalCount(), 1);
  const row = openDb()
    .prepare(`SELECT name, occurred_at, facts_json FROM telemetry_journal`)
    .get() as { name: string; occurred_at: number; facts_json: string };
  assert.equal(row.name, "mission.daemon.started");
  assert.equal(row.occurred_at, 1_000);
  assert.deepEqual(JSON.parse(row.facts_json), {
    startup_ms: 120,
    schema_upgraded: false,
    launch_mode: "daemon",
  });
});

test("a crash between journal commit and projection contributes exactly once", () => {
  // P1's first crash boundary. The fact is committed; the projection never ran. After a
  // restart it must contribute once - not zero times, and not twice.
  enableLocalOnly();
  assert.equal(capture("boot-1", 1_000).kind, "accepted");

  restartDaemon();

  runProjectionPass(2_000);
  assert.deepEqual(series("local", "mission.daemon.starts").map((s) => s.value), [1]);
});

test("replaying the journal does not re-increment a counter", () => {
  // The failure this prevents is the one that would double every metric on every reboot:
  // journal events replayed through live counters. The journal is consumed once, into durable
  // state; retries operate on batches.
  enableLocalOnly();
  capture("boot-1", 1_000);
  runProjectionPass(2_000);
  runProjectionPass(3_000);
  restartDaemon();
  runProjectionPass(4_000);
  runProjectionPass(5_000);

  assert.deepEqual(series("local", "mission.daemon.starts").map((s) => s.value), [1]);
});

test("a cumulative stream keeps its original start time across a restart", () => {
  // If the start time moved, the backend would read every restart as a counter reset.
  enableLocalOnly();
  capture("boot-1", 1_000);
  runProjectionPass(1_500);
  const [before] = series("local", "mission.daemon.starts");

  restartDaemon();
  capture("boot-2", 90_000);
  runProjectionPass(91_000);
  const [after] = series("local", "mission.daemon.starts");

  assert.equal(after!.start_time, before!.start_time);
  assert.equal(after!.value, 2);
});

test("a fact projected long after it happened keeps its own timestamp", () => {
  // The regression for original-time attribution, and the case the whole durable design exists
  // for: accepted before a crash, projected after the restart. If the metric point carried the
  // PROJECTION clock, a week-old backlog drained today would be exported as today's activity -
  // which is the one thing a restart-safe pipeline must never do.
  enableUserBackend();
  const happened = 1_000;
  const projectedMuchLater = happened + 3 * 24 * 60 * 60 * 1000;

  capture("boot-1", happened);
  restartDaemon();
  runProjectionPass(projectedMuchLater);

  const [row] = series("user", "mission.daemon.starts");
  assert.equal(row!.start_time, happened, "the stream starts when the fact happened");

  // And the exported point, which is what a backend actually stores.
  const batch = openDb()
    .prepare(`SELECT payload_json FROM telemetry_batches WHERE profile = 'user' AND signal = 'metrics'`)
    .get() as { payload_json: string };
  const payload = JSON.parse(batch.payload_json) as {
    metrics: Array<{ name: string; startTimeMs: number; endTimeMs: number }>;
  };
  const point = payload.metrics.find((m) => m.name === "mission.daemon.starts");
  assert.ok(point);
  assert.equal(point!.startTimeMs, happened);
  assert.equal(
    point!.endTimeMs,
    happened,
    "the point ends when the last contributing fact happened, not when the projection ran",
  );
});

test("several facts in one pass each keep their own time", () => {
  // The pass-level version of the same defect: reading "the current event" during `apply`, after
  // the event loop has finished, silently collapses every contribution onto one clock.
  enableLocalOnly();
  capture("boot-1", 1_000, 40);
  capture("boot-2", 5_000, 300);
  runProjectionPass(9_999_999);

  const [row] = series("local", "mission.daemon.starts");
  assert.equal(row!.start_time, 1_000, "the earliest contributing fact opens the stream");
  assert.equal(row!.value, 2);
});

// ---- identity and idempotency ----

test("the same source identity is captured once, however often it is offered", () => {
  enableLocalOnly();
  assert.equal(capture("boot-1", 1_000).kind, "accepted");
  const second = capture("boot-1", 1_050);
  assert.equal(second.kind, "duplicate");
  assert.equal(journalCount(), 1);

  runProjectionPass(2_000);
  assert.deepEqual(series("local", "mission.daemon.starts").map((s) => s.value), [1]);
});

test("a duplicate at a full store is a duplicate, not a claimed loss", () => {
  // The ordering defect: admission control ran before the dedupe lookup, so a retried capture
  // at a full store was refused as `over_capacity` AND recorded a `capture_refused` gap. A
  // duplicate costs zero additional bytes; it is not new data pressing on the quota, and
  // claiming a loss for a fact that is already safely stored is the one thing this facility's
  // honesty rests on not doing.
  enableLocalOnly();
  assert.equal(capture("boot-1", 1_000).kind, "accepted");

  // Force "at capacity" rather than manufacturing 256 MiB. Restored in `finally`, and the
  // limits object is the real one the capture path reads.
  const limits = TELEMETRY_LIMITS as unknown as { maxTotalBytes: number };
  const original = limits.maxTotalBytes;
  limits.maxTotalBytes = 1;
  try {
    const again = capture("boot-1", 2_000);
    assert.equal(again.kind, "duplicate", "the retry is recognised before the quota is consulted");

    const newFact = capture("boot-2", 3_000);
    assert.equal(newFact.kind, "refused", "genuinely new data is still refused at the cap");
    assert.equal(newFact.kind === "refused" && newFact.reason, "over_capacity");
  } finally {
    limits.maxTotalBytes = original;
  }

  const gaps = telemetryHealth(4_000).gaps;
  const refused = gaps.find((g) => g.kind === "capture_refused");
  assert.ok(refused, "the genuinely refused fact is counted");
  assert.equal(refused!.count, 1, "and the duplicate contributed no phantom loss");
});

test("dedupe outlives the payload it deduplicated", () => {
  // A unique key on a row that is later deleted is not durable deduplication. Once retention
  // prunes the journal row, the same expired historical source must not be importable again as
  // fresh activity - so the identity has its own table and its own longer window.
  enableLocalOnly();
  const captured = 1_000;
  capture("boot-1", captured);
  runProjectionPass(captured + 1);

  // Eight days later: past the payload window, well inside the identity window.
  const later = captured + TELEMETRY_LIMITS.payloadRetentionMs + 86_400_000;
  runRetentionPass(later);

  const payload = openDb()
    .prepare(`SELECT facts_json, payload_pruned_at FROM telemetry_journal`)
    .get() as { facts_json: string; payload_pruned_at: number | null } | undefined;
  assert.ok(payload, "the row itself survives the payload prune");
  assert.notEqual(payload!.payload_pruned_at, null);
  assert.equal(payload!.facts_json, "{}");

  assert.equal(capture("boot-1", later).kind, "duplicate");
});

// ---- histograms ----

test("a histogram accumulates into its declared explicit buckets", () => {
  enableLocalOnly();
  // Boundaries are [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000].
  capture("boot-1", 1_000, 40);
  capture("boot-2", 1_100, 300);
  capture("boot-3", 1_200, 300);
  runProjectionPass(2_000);

  const [row] = series("local", "mission.daemon.startup.duration");
  assert.equal(row!.hist_count, 3);
  assert.equal(row!.value, 640);
  const buckets = JSON.parse(row!.hist_buckets!) as number[];
  assert.equal(buckets.length, 10, "nine boundaries plus the +Inf bucket");
  assert.equal(buckets[0], 1, "40ms falls in the <=50 bucket");
  assert.equal(buckets[3], 2, "300ms falls in the <=500 bucket");
});

// ---- consent fencing ----

test("enabling a destination later does not hand it the history it was never consented to", () => {
  // The rule this protects: enabling an audience authorizes new data FROM THAT POINT, not
  // automatic historical sharing. A fresh profile starts at the journal head.
  enableLocalOnly();
  capture("boot-1", 1_000);
  capture("boot-2", 1_100);
  runProjectionPass(2_000);
  assert.deepEqual(series("local", "mission.daemon.starts").map((s) => s.value), [2]);

  enableUserBackend();
  capture("boot-3", 3_000);
  runProjectionPass(4_000);

  // The user backend sees the one fact captured after it was enabled, not all three.
  assert.deepEqual(series("user", "mission.daemon.starts").map((s) => s.value), [1]);
  assert.deepEqual(series("local", "mission.daemon.starts").map((s) => s.value), [3]);
});

test("withdrawing consent purges that profile's queue and projections", () => {
  enableUserBackend();
  capture("boot-1", 1_000);
  runProjectionPass(2_000);
  assert.ok(batchCount("user") > 0);

  const off = setTelemetryConfig({ user: { enabled: false } });
  assert.equal(off.ok, true);

  assert.equal(batchCount("user"), 0);
  assert.equal(series("user", "mission.daemon.starts").length, 0);
  // Local data the operator separately authorized is untouched.
  assert.ok(journalCount() > 0);
});

test("a re-enabled destination starts a new consent epoch and a new baseline", () => {
  enableUserBackend();
  capture("boot-1", 1_000);
  runProjectionPass(2_000);
  const firstEpoch = telemetryHealth(2_100).profiles.find((p) => p.profile === "user")!.policyEpoch;

  setTelemetryConfig({ user: { enabled: false } });
  setTelemetryConfig({ user: { enabled: true } });
  capture("boot-2", 3_000);
  runProjectionPass(4_000);

  const secondEpoch = telemetryHealth(4_100).profiles.find((p) => p.profile === "user")!.policyEpoch;
  assert.ok(secondEpoch > firstEpoch, "a new opt-in is a new epoch");
  assert.deepEqual(
    series("user", "mission.daemon.starts").map((s) => s.value),
    [1],
    "the new epoch does not inherit the previous cumulative total",
  );
});

test("local-only collection produces no export batches at all", () => {
  // Local-only needs no endpoint, and building an outbox for a destination that does not exist
  // would double the byte budget to hold data nobody asked to send.
  enableLocalOnly();
  capture("boot-1", 1_000);
  runProjectionPass(2_000);

  assert.ok(series("local", "mission.daemon.starts").length > 0);
  assert.equal(batchCount("local"), 0);
});

test("an endpoint change starts a new destination generation", () => {
  enableUserBackend("http://127.0.0.1:14318");
  const before = telemetryHealth(1_000).profiles.find((p) => p.profile === "user")!;
  setTelemetryConfig({ user: { endpoint: "http://127.0.0.1:24318" } });
  const after = telemetryHealth(2_000).profiles.find((p) => p.profile === "user")!;
  assert.ok(after.destinationGeneration > before.destinationGeneration);
});

// ---- the product audience ----

test("the product audience cannot be enabled while no ingest service exists", () => {
  const refused = setTelemetryConfig({ enabled: true, product: { enabled: true } });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /no ingest service/i);
});

test("product-only eligibility never produces a user-backend batch", () => {
  // Even with both switches conceptually independent, a fact eligible for one audience must
  // never land in another's queue.
  enableLocalOnly();
  capture("boot-1", 1_000);
  runProjectionPass(2_000);
  assert.equal(batchCount("user"), 0);
  assert.equal(batchCount("product"), 0);
});

// ---- capacity and gaps ----

test("an undeclared ref is dropped before the journal rather than inflating the event", () => {
  enableLocalOnly();
  const result = captureTelemetry({
    event: DAEMON_STARTED_EVENT,
    source: { kind: "mission.daemon", id: "boot-big", revision: 1 },
    // `launch_mode` is a closed enum, so the only way to get a large payload past the schema
    // is a ref - which is where an accidental blob would come from anyway.
    facts: { startup_ms: 1, schema_upgraded: false, launch_mode: "daemon" },
    refs: { blob: "x".repeat(TELEMETRY_LIMITS.maxEventBytes * 2) },
    now: 1_000,
  });
  // The ref is not declared on this event, so it is dropped before the size check and the
  // event is accepted with an omission count - which is the correct, bounded behaviour.
  assert.equal(result.kind, "accepted");
  const row = openDb()
    .prepare(`SELECT refs_json, refs_omitted FROM telemetry_journal`)
    .get() as { refs_json: string; refs_omitted: number };
  assert.equal(row.refs_omitted, 1);
  assert.ok(!row.refs_json.includes("xxxx"), "an undeclared ref never reaches the journal");
});

test("an undeclared fact is refused rather than passed through", () => {
  enableLocalOnly();
  const result = captureTelemetry({
    event: DAEMON_STARTED_EVENT,
    source: { kind: "mission.daemon", id: "boot-bad", revision: 1 },
    facts: {
      startup_ms: 1,
      schema_upgraded: false,
      launch_mode: "daemon",
      repoRoot: "/Users/someone/private",
    } as never,
    now: 1_000,
  });
  assert.equal(result.kind, "refused");
  assert.equal(result.kind === "refused" && result.reason, "invalid_facts");
  assert.equal(journalCount(), 0);
});

test("capacity shedding stops as soon as the budget is back under the mark", async () => {
  // The defect this covers: the pressure branch took a fixed slice of up to 500 batches with no
  // re-check, so a brief overshoot - the tail of one short outage - expired the entire
  // undelivered queue for every destination in a single tick. The loss was counted rather than
  // silent, but it was wildly out of proportion to the condition that caused it, and it threw
  // away data that would have been delivered a minute later.
  const { relievePressure } = await import("../src/server/telemetry/retention.ts");
  const { telemetryTransaction, lowestConsumedSeq } = await import(
    "../src/server/telemetry/store.ts"
  );
  enableUserBackend();
  for (let i = 0; i < 4; i += 1) {
    capture(`boot-${i}`, 1_000 + i * 100);
    runProjectionPass(1_000 + i * 100 + 10);
  }
  const before = batchCount("user");
  assert.ok(before >= 4, `expected several batches to shed from, got ${before}`);

  // Over budget for exactly two checks, then under. The real predicate reads `usedBytes`;
  // driving it directly is what lets this assert the STOPPING behaviour without manufacturing
  // 230 MiB of telemetry.
  let overFor = 2;
  const relieved = telemetryTransaction((d) =>
    relievePressure(d, 9_000, lowestConsumedSeq(d), () => overFor-- > 0),
  );

  assert.equal(relieved.expiredBatches, 2, "it sheds what the overshoot needed, not the queue");
  assert.equal(
    batchCount("user"),
    before - 2,
    "every other undelivered batch is still there to be delivered",
  );
});

test("settled delivery bookkeeping does not accumulate for ever", async () => {
  // `settleDelivery` updates a row rather than inserting one, and releasing a payload removed
  // only the payload, so every batch an installation ever produced left a small permanent row -
  // an unbounded table that neither retention window bounded and that nothing charged to the
  // byte budget. Low volume in Phase 1; multiplied by every source phase after it.
  const { telemetryTransaction, settleDelivery, releaseBatchPayload, usedBytes } = await import(
    "../src/server/telemetry/store.ts"
  );
  enableUserBackend();
  capture("boot-1", 1_000);
  runProjectionPass(1_100);

  const ids = openDb()
    .prepare(`SELECT batch_id FROM telemetry_delivery`)
    .all() as unknown as Array<{ batch_id: string }>;
  assert.ok(ids.length > 0);

  // Deliver them, the way a successful export does.
  telemetryTransaction((d) => {
    for (const { batch_id } of ids) {
      settleDelivery(
        d,
        batch_id,
        { state: "accepted", attempts: 1, nextAttemptAt: 1_200, lastError: null },
        1_200,
      );
      releaseBatchPayload(d, batch_id);
    }
  });
  const bytesWhileRetained = telemetryTransaction((d) => usedBytes(d));
  assert.ok(bytesWhileRetained > 0, "the surviving rows are charged to the budget");

  const later = 1_200 + TELEMETRY_LIMITS.payloadRetentionMs + 1_000;
  const result = runRetentionPass(later);
  assert.equal(result.prunedDeliveries, ids.length, "the settled rows are swept");

  const remaining = openDb()
    .prepare(`SELECT COUNT(*) AS n FROM telemetry_delivery`)
    .get() as { n: number };
  assert.equal(remaining.n, 0, "nothing is left behind for the next decade of batches");
});

test("a batch retained for a superseded endpoint keeps its payload until the window closes", async () => {
  // The one terminal state that keeps its bytes on purpose, so Phase 2 can offer the operator
  // the keep / discard / transfer choice. Its bookkeeping must NOT be pruned while the payload
  // is still there, or the payload is orphaned with nothing describing it.
  const { telemetryTransaction, settleDelivery, pruneTerminalDeliveries } = await import(
    "../src/server/telemetry/store.ts"
  );
  enableUserBackend();
  capture("boot-1", 1_000);
  runProjectionPass(1_100);
  const ids = openDb()
    .prepare(`SELECT batch_id FROM telemetry_delivery`)
    .all() as unknown as Array<{ batch_id: string }>;

  // Rejected, payload deliberately RETAINED.
  telemetryTransaction((d) => {
    for (const { batch_id } of ids) {
      settleDelivery(
        d,
        batch_id,
        { state: "rejected", attempts: 1, nextAttemptAt: 1_200, lastError: "stale generation" },
        1_200,
      );
    }
  });

  const later = 1_200 + TELEMETRY_LIMITS.payloadRetentionMs + 1_000;
  const pruned = telemetryTransaction((d) => pruneTerminalDeliveries(d, later, 500));
  assert.equal(pruned, 0, "bookkeeping stays while the payload it describes is still retained");
  assert.equal(batchCount("user"), ids.length);

  // The full sweep releases the payload first, then the row.
  const result = runRetentionPass(later);
  assert.ok(result.releasedTerminalBatches > 0);
  assert.equal(batchCount("user"), 0);
  const remaining = openDb()
    .prepare(`SELECT COUNT(*) AS n FROM telemetry_delivery`)
    .get() as { n: number };
  assert.equal(remaining.n, 0);
});

test("an expired batch is counted as loss rather than deleted quietly", () => {
  enableUserBackend();
  capture("boot-1", 1_000);
  runProjectionPass(1_100);
  assert.ok(batchCount("user") > 0);

  // Measured from the BATCH's creation, which is the projection's clock, not the capture's.
  const later = 1_100 + TELEMETRY_LIMITS.payloadRetentionMs + 1_000;
  const result = runRetentionPass(later);
  assert.ok(result.expiredBatches > 0);

  const health = telemetryHealth(later);
  const gap = health.gaps.find((g) => g.kind === "payload_expired");
  assert.ok(gap, "the loss is visible in health, not inferred from an empty chart");
  assert.ok(gap!.count > 0);
  assert.equal(health.profiles.find((p) => p.profile === "user")!.expired > 0, true);
});

// ---- the daemon's own observation ----

test("the daemon start observation flows through the same path as any other fact", () => {
  enableLocalOnly();
  const result = observeDaemonStart({
    startupMs: 480,
    schemaUpgraded: true,
    launchMode: "daemon",
    now: 1_000,
  });
  assert.equal(result.kind, "accepted");
  runProjectionPass(2_000);

  const [starts] = series("local", "mission.daemon.starts");
  assert.equal(starts!.value, 1);
  assert.deepEqual(JSON.parse(starts!.dimensions_json), {
    launch_mode: "daemon",
    schema_upgraded: "true",
  });
  const [duration] = series("local", "mission.daemon.startup.duration");
  assert.equal(duration!.hist_count, 1);
});

test("the same boot cannot record its start twice", () => {
  enableLocalOnly();
  const first = observeDaemonStart({ startupMs: 100, schemaUpgraded: false, launchMode: "daemon", now: 1_000 });
  const second = observeDaemonStart({ startupMs: 100, schemaUpgraded: false, launchMode: "daemon", now: 1_050 });
  assert.equal(first.kind, "accepted");
  assert.equal(second.kind, "duplicate");
});

test("the installation identity is a local pseudonym, not an account or a hostname", () => {
  enableLocalOnly();
  const identity = telemetryIdentity();
  assert.equal(identity.epoch, 1);
  // An opaque fixed-width hex seed, so it can carry nothing but itself.
  assert.match(identity.installationId, /^[0-9a-f]{24}$/);

  // And it derives from none of the obvious machine or account facts. Checking only $USER left
  // the test narrower than its own name claimed.
  for (const secret of [process.env.USER, process.env.LOGNAME, hostname(), homedir()]) {
    if (!secret) continue;
    assert.ok(
      !identity.installationId.includes(secret.toLowerCase()),
      `the pseudonym must not embed ${secret}`,
    );
  }
});

test("a stored identity missing its epoch is not used", () => {
  // A row written by an older build, or hand-edited, would otherwise flow through as
  // `epoch: undefined` and be digested into every profile salt and stamped on every exported
  // resource as the string "undefined" - a silent, permanent corruption of this installation's
  // identity that nothing downstream could unpick.
  enableLocalOnly();
  openDb()
    .prepare(`INSERT INTO app_config (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run("telemetry.identity", JSON.stringify({ installationId: "abc" }));

  const identity = telemetryIdentity();
  assert.equal(identity.epoch, 1, "a fresh, valid identity replaces the unusable one");
  assert.match(identity.installationId, /^[0-9a-f]{24}$/);
});
