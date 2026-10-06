import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What the Cost panel is allowed to claim about telemetry, and when.
//
// The warning here exists because this change gave session spend a SECOND writer, which broke a
// shortcut the panel used to be able to take: while OpenTelemetry was the only writer, "any
// reported session row exists" and "the exporter is working" were the same sentence. They are
// not any more. A driven session's driver satisfies the first and says nothing about the second,
// so a panel reading only `receiving` would report healthy telemetry while every
// passively-discovered terminal session silently recorded nothing.
//
// The signal is ARRIVAL, stamped in the ingest before any datapoint is filtered, and not the
// rows the ingest went on to write. Two independent reasons, each with a test below:
//
//   - a driven session's datapoints are deliberately DROPPED, so a healthy exporter on an
//     embedded fleet writes no `otel` row and a row test would cry wolf;
//   - rows are pruned at 180 days and an unbounded "has one ever existed" test never returns to
//     false, so an exporter that worked and then stopped would read healthy for months.
//
// And the flag requires recent CLAUDE session spend before it fires, scoped to `agent = 'claude'`
// - Codex's rollout reader writes `spend_kind = 'session'` rows too, and counting those would
// accuse Claude's exporter of silence on a machine it had nothing to report on. Silence on an
// idle machine is not a fault either way; a panel that warns about a quiet weekend is one an
// operator learns to scroll past, which is how a silent failure becomes invisible a second time.
//
// A third condition, added after this file's own tests below caught the gap: the GRACE PERIOD
// since telemetry was last enabled. `test/cost-telemetry-enable.test.ts` covers that in isolation,
// including the self-healing backfill for an installation `setCostConfig` never touched. Here,
// every `setCostConfig` call passes an explicit `now` so this file's timeline stays independent
// of when it happens to run, and every timestamp advances the shared narrative forward - the
// tests are sequential and share one ledger and one settings file on purpose.
//
// `CLAUDE_SETTINGS_PATH` is redirected at a temp file for the same reason `MISSION_HOME` is:
// `costTelemetryStatus` READS the operator's real settings file to report what is actually
// installed, and a test must never read or write the one in their home directory.
// `MISSION_MANAGED_SETTINGS_ROOT` is redirected for the same reason: the status also reports
// what this Mac's managed Claude Code policy does with metrics, and that is the developer's.

const home = mkdtempSync(join(tmpdir(), "mission-cost-status-"));
process.env.MISSION_HOME = home;
const settingsPath = join(home, "claude-settings.json");
process.env.CLAUDE_SETTINGS_PATH = settingsPath;
writeFileSync(settingsPath, "{}\n");
const managedRoot = join(home, "managed-root");
process.env.MISSION_MANAGED_SETTINGS_ROOT = managedRoot;

const {
  commitUsageRead,
  noteOtelExportSeen,
  openDb,
  recordAutomationUsage,
  recordDriverSessionUsage,
  upsertUsageCell,
} = await import("../src/server/db.ts");
const { costTelemetryStatus, setCostConfig } = await import("../src/server/cost.ts");
const { refreshManagedMetricsPolicy } = await import("../src/server/environment/claude-managed.ts");

after(() => rmSync(home, { recursive: true, force: true }));

openDb();

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = 1_800_000_000_000;

/** One model's worth of driver usage, valued. */
const MODELS = [
  {
    modelId: "claude-opus-5",
    input: 10,
    output: 5,
    reasoningOutput: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reportedCostUsd: 0.25,
  },
];

/** A driven turn recorded at `ts`, which is what makes the fleet count as active. */
function driverTurn(id: string, ts: number): void {
  recordDriverSessionUsage({
    noteKey: `status-session-${id}`,
    sessionId: `sdk:${id}`,
    agent: "claude",
    turnId: `status-turn-${id}`,
    ts,
    models: MODELS,
  });
}

test("enabling at T0 starts installed, not receiving, warning about nothing", () => {
  // Writing the env block is what `installed` reflects, and it is deliberately not enough to
  // claim anything is working: the block only reaches sessions started AFTER it was written.
  // Nor is it enough to warn - there is no spend yet, so nothing is going uncounted.
  setCostConfig({ enabled: true }, T0);
  const status = costTelemetryStatus(T0);
  assert.equal(status.installed, true, "the env block is in the file");
  assert.equal(status.receiving, false, "and nothing has reported through it yet");
  assert.equal(status.exporterSilent, false, "silence with no work to report is not a fault");
  assert.equal(status.settingsPath, settingsPath, "the panel names the file it would edit");
});

test("automation spend alone claims nothing about session telemetry", () => {
  // The shape of the original bug. The ledger had 48 rows and $40 on it, every one of them the
  // app's own overhead, while session spend was zero. `receiving` may not move for these, or the
  // panel would report a working feature on exactly the machine it was broken on.
  recordAutomationUsage({
    role: "foreman:review",
    agent: "claude",
    runId: "status-run-1",
    ts: T0 + 1 * HOUR,
    models: [
      {
        modelId: "claude-opus-5",
        input: 100,
        output: 50,
        reasoningOutput: 0,
        cacheRead: 0,
        cacheWrite: 0,
        costUsd: 1.5,
        basis: "reported",
        pricingVersion: "",
      },
    ],
  });
  const status = costTelemetryStatus(T0 + 1 * HOUR);
  assert.equal(status.receiving, false, "the app's own spend is not a session reporting");
});

test("a driven turn minutes after enabling does not accuse the exporter yet", () => {
  // THE REGRESSION THIS TEST PINS. `hasClaudeSessionUsageSince` is satisfied by the DRIVER's own
  // rows, so the moment someone enables telemetry and dispatches one session - the single most
  // common action in the app - session spend starts landing seconds later. Without a grace
  // period tied to when telemetry was enabled, that alone made the panel accuse an exporter that
  // had not had ONE export interval yet, let alone the week its wording claimed.
  driverTurn("early", T0 + 2 * HOUR);
  const status = costTelemetryStatus(T0 + 2 * HOUR);
  assert.equal(status.receiving, true, "the driver's own report reaches the ledger immediately");
  assert.equal(
    status.exporterSilent,
    false,
    "but the grace period since enabling has not elapsed, so there is nothing to accuse yet",
  );
});

test("once the grace period elapses, a silent exporter on an active fleet is the warning", () => {
  // Now past the grace period (8 days since T0), with the fleet still active and the exporter
  // having never delivered a single datapoint. Session spend is landing and the topbar has
  // numbers on it, so every OTHER signal reads healthy - while a terminal `claude` contributes
  // nothing and nobody has been told.
  const t = T0 + 8 * DAY;
  driverTurn("active", t - 1 * HOUR);
  const status = costTelemetryStatus(t);
  assert.equal(status.receiving, true, "session spend is reaching the ledger");
  assert.equal(
    status.exporterSilent,
    true,
    "the grace period has elapsed and the exporter has said nothing the whole time",
  );
});

test("an export ARRIVING clears the warning, even though its rows were all dropped", () => {
  // The unsoundness a row test would have. Every datapoint in a driven fleet's export is
  // discarded by `sdkOwnedNoteKey`, so no `otel` row is ever written - and yet the exporter
  // plainly ran. Reading rows here would report a healthy exporter as a dead one and put a
  // false warning in front of every operator whose fleet is embedded.
  const t = T0 + 8 * DAY;
  noteOtelExportSeen(t - 60_000);
  const status = costTelemetryStatus(t);
  assert.equal(status.exporterSilent, false, "arrival is the signal, not the surviving rows");
});

test("an exporter that worked and then stopped goes back to warning", () => {
  // The regression the FIRST implementation of the arrival signal got wrong. It asked whether
  // an `otel` row had EVER been written, with no time bound, against a ledger that keeps rows
  // for 180 days. So an operator whose exporter worked once and then silently stopped - the
  // exact failure this change is about - kept reading healthy for up to six months while every
  // terminal session was uncounted the whole time.
  //
  // The arrival above (T0 + 8 days) is the last one there was. Here it is 8 more days stale, and
  // the fleet worked yesterday - well past both the grace period and the arrival's own staleness.
  const t = T0 + 16 * DAY;
  driverTurn("later", t - 1 * DAY);
  const status = costTelemetryStatus(t);
  assert.equal(status.receiving, true, "spend is still landing, so nothing else looks wrong");
  assert.equal(
    status.exporterSilent,
    true,
    "a working exporter that stops must return to warning, not stay healthy until retention",
  );

  // A real `otel` row from the earlier working period is still sitting in the ledger, well
  // inside retention - which is exactly what the first implementation found and trusted.
  upsertUsageCell(
    {
      noteKey: "discovered-session-old",
      sessionId: null,
      agent: "claude",
      modelId: "claude-opus-5",
      querySource: "main",
      windowEndNs: "1000000000000000777",
      ts: T0 + 8 * DAY,
    },
    "costUsd",
    0.4,
  );
  assert.equal(
    costTelemetryStatus(t).exporterSilent,
    true,
    "an old row is history, not evidence the exporter is running now",
  );
});

test("an idle stretch is not a fault, however long the exporter has been quiet", () => {
  // The false positive the activity half prevents. The exporter has now been silent for weeks,
  // but the fleet has done nothing recently either - so there is no work going uncounted and
  // nothing to say. Warning here would be noise, and noise is what makes the real warning
  // ignorable.
  const quiet = T0 + 76 * DAY;
  assert.equal(
    costTelemetryStatus(quiet).exporterSilent,
    false,
    "no recent session spend means no shortfall to report",
  );
});

test("a Codex-only week does not accuse Claude Code's exporter", () => {
  // The false alarm the activity half has to be SCOPED to avoid, not merely paired. Codex's
  // rollout reader writes `spend_kind = 'session'` rows too, so an unscoped activity test counts
  // a fleet whose only recent work was Codex - and since no Claude session ran, no Claude export
  // arrived either. The panel would then announce that Claude Code's exporter is broken on a
  // machine where it simply had nothing to report, which is the exact noise the pairing exists to
  // prevent. Activity has to be measured for the same harness whose exporter is being judged.
  const codexOnly = T0 + 200 * DAY;
  commitUsageRead({
    sourceKey: "codex-source-1",
    noteKey: "codex-conversation-1",
    sessionId: null,
    agent: "codex",
    cursor: { offset: 10, modelId: "gpt-5.5", discardPartial: false, fileId: "f1" },
    updatedAt: codexOnly - 1_000,
    events: [
      {
        identity: "codex-req-1",
        querySource: "",
        modelId: "gpt-5.5",
        ts: codexOnly - 1_000,
        costUsd: 0.3,
        pricingVersion: "openai-standard-test",
        input: 100,
        output: 20,
        reasoningOutput: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    ],
  });

  const status = costTelemetryStatus(codexOnly);
  assert.equal(
    status.exporterSilent,
    false,
    "Codex activity is not evidence that Claude's exporter should have spoken",
  );
});

test("switching the toggle off uninstalls the block without rewriting history", () => {
  // `installed` is about the operator's file right now; `receiving` is about what the ledger has
  // recorded. Turning telemetry off does not un-spend anything.
  const t = T0 + 200 * DAY;
  setCostConfig({ enabled: false }, t);
  const status = costTelemetryStatus(t);
  assert.equal(status.installed, false, "the env block is gone from the file");
  assert.equal(status.receiving, true, "the rows it already wrote are still there");
});

test("with Cost off, the managed policy is never read and nothing is reported", async () => {
  const t = T0 + 250 * DAY;
  // The previous test switched Cost off. A policy is in place, and the polls below - the only
  // production path that starts a read - have every chance to read it.
  const dir = join(managedRoot, "Library", "Application Support", "ClaudeCode");
  mkdirSync(dir, { recursive: true });
  const policy = join(dir, "managed-settings.json");
  writeFileSync(
    policy,
    JSON.stringify({ env: { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://otel.example.com" } }),
  );
  assert.equal(costTelemetryStatus(t).config.enabled, false);
  assert.equal(costTelemetryStatus(t).managedRedirect, null);
  // Long enough for any read a poll had started to land in the cache.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(costTelemetryStatus(t + 1).managedRedirect, null);

  // Switching Cost on proves nothing was read while it was off: the cache is empty, so the
  // first poll has no answer yet and only starts the read. The one after it has the host.
  setCostConfig({ enabled: true }, t + 2);
  assert.equal(costTelemetryStatus(t + 2).managedRedirect, null, "nothing was cached while off");
  await refreshManagedMetricsPolicy(t + 2);
  assert.equal(costTelemetryStatus(t + 3).managedRedirect?.host, "otel.example.com");

  // And switching it off again drops the answer rather than reporting it.
  setCostConfig({ enabled: false }, t + 4);
  assert.equal(costTelemetryStatus(t + 4).managedRedirect, null);

  // Leave nothing in flight for the next test: the enabled poll above started a read.
  rmSync(policy);
  await refreshManagedMetricsPolicy(t + 5);
  await refreshManagedMetricsPolicy(t + 5);
});

test("a managed policy that redirects metrics is reported from the cache, without waiting", async () => {
  const t = T0 + 300 * DAY;
  // The policy is read only while Cost is on.
  setCostConfig({ enabled: true }, t);
  // Nothing at the managed root yet: no policy, and the read says so.
  await refreshManagedMetricsPolicy(t);
  assert.equal(costTelemetryStatus(t).managedRedirect, null);

  const dir = join(managedRoot, "Library", "Application Support", "ClaudeCode");
  mkdirSync(dir, { recursive: true });
  const policy = join(dir, "managed-settings.json");
  writeFileSync(
    policy,
    JSON.stringify({
      env: { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://otel.example.com:4318/v1/metrics" },
    }),
  );

  // Synchronous: the poll returns what the cache held, and only starts a read for next time.
  const first = costTelemetryStatus(t + 1);
  assert.equal(first instanceof Promise, false);
  assert.equal(first.managedRedirect, null, "the poll never waits on the read it started");
  await refreshManagedMetricsPolicy(t + 1);
  assert.deepEqual(costTelemetryStatus(t + 2).managedRedirect, {
    kind: "redirect",
    host: "otel.example.com",
    source: "managed-settings",
    // No organization manages a test process.
    organizationLabel: null,
  });

  // An edit changes the file's size, so the very next read notices it - no minute to wait.
  writeFileSync(
    policy,
    JSON.stringify({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://gateway.example.org" } }),
  );
  costTelemetryStatus(t + 3);
  await refreshManagedMetricsPolicy(t + 3);
  assert.equal(costTelemetryStatus(t + 4).managedRedirect?.host, "gateway.example.org");

  // And removing the policy clears it.
  rmSync(policy);
  costTelemetryStatus(t + 5);
  await refreshManagedMetricsPolicy(t + 5);
  assert.equal(costTelemetryStatus(t + 6).managedRedirect, null);
});

test("an edit that keeps the file's size and modification time is reread after a minute", async () => {
  const t = T0 + 400 * DAY;
  setCostConfig({ enabled: true }, t);
  const dir = join(managedRoot, "Library", "Application Support", "ClaudeCode");
  mkdirSync(dir, { recursive: true });
  const policy = join(dir, "managed-settings.json");
  // Two hosts of the same length, and one fixed modification time, so the metadata key the
  // cache watches is identical before and after the edit. Only the minute can notice it.
  const write = (host: string) => {
    writeFileSync(policy, JSON.stringify({ env: { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `https://${host}` } }));
    utimesSync(policy, 1_700_000_000, 1_700_000_000);
  };
  // A refresh joins one already running, which carries the clock it started with, and every
  // status read starts one. So each step first drains whatever is in flight, then refreshes
  // at exactly the time it names.
  const refreshAt = async (now: number) => {
    await refreshManagedMetricsPolicy(now);
    await refreshManagedMetricsPolicy(now);
  };
  write("aaa.example.com");
  await refreshAt(t);
  assert.equal(costTelemetryStatus(t).managedRedirect?.host, "aaa.example.com");
  const before = statSync(policy);

  write("bbb.example.com");
  const after = statSync(policy);
  assert.equal(after.size, before.size, "the edit keeps the size");
  assert.equal(after.mtimeMs, before.mtimeMs, "the edit keeps the modification time");

  // One millisecond short of the minute: the key is unchanged, so the cached host stands.
  await refreshAt(t + 59_999);
  assert.equal(costTelemetryStatus(t + 59_999).managedRedirect?.host, "aaa.example.com");

  // At the minute, the policy is read again whatever its metadata says.
  await refreshAt(t + 60_000);
  assert.equal(costTelemetryStatus(t + 60_000).managedRedirect?.host, "bbb.example.com");

  rmSync(policy);
  await refreshAt(t + 60_001);
});

test("a read in flight when Cost is switched off does not put its answer back", async () => {
  const t = T0 + 500 * DAY;
  const dir = join(managedRoot, "Library", "Application Support", "ClaudeCode");
  mkdirSync(dir, { recursive: true });
  const policy = join(dir, "managed-settings.json");
  writeFileSync(
    policy,
    JSON.stringify({ env: { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://stale.example.com" } }),
  );
  setCostConfig({ enabled: true }, t);
  // A poll starts the read. Cost goes off before it lands.
  costTelemetryStatus(t);
  const inFlight = refreshManagedMetricsPolicy(t);
  setCostConfig({ enabled: false }, t + 1);
  await inFlight;

  // Back on: the abandoned read wrote nothing, so the first poll has no answer yet rather than
  // the one read before Cost went off.
  setCostConfig({ enabled: true }, t + 2);
  assert.equal(costTelemetryStatus(t + 2).managedRedirect, null, "the abandoned read wrote nothing");
  await refreshManagedMetricsPolicy(t + 2);
  assert.equal(costTelemetryStatus(t + 3).managedRedirect?.host, "stale.example.com");

  setCostConfig({ enabled: false }, t + 4);
  rmSync(policy);
});

test("switching Cost off and on between two polls does not bring back the old answer", async () => {
  const t = T0 + 600 * DAY;
  const dir = join(managedRoot, "Library", "Application Support", "ClaudeCode");
  mkdirSync(dir, { recursive: true });
  const policy = join(dir, "managed-settings.json");
  writeFileSync(
    policy,
    JSON.stringify({ env: { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://before.example.com" } }),
  );
  setCostConfig({ enabled: true }, t);
  costTelemetryStatus(t);
  await refreshManagedMetricsPolicy(t);
  assert.equal(costTelemetryStatus(t + 1).managedRedirect?.host, "before.example.com");
  await refreshManagedMetricsPolicy(t + 1);

  // Off and on again with no status read in between - the toggle clicked twice.
  setCostConfig({ enabled: false }, t + 2);
  setCostConfig({ enabled: true }, t + 3);
  assert.equal(costTelemetryStatus(t + 3).managedRedirect, null, "switching off dropped the answer");

  setCostConfig({ enabled: false }, t + 4);
  rmSync(policy);
});
