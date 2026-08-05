import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
// And the flag pairs arrival with recent session spend, because silence on an idle machine is
// not a fault. A panel that warns about a quiet weekend is one an operator learns to scroll
// past, which is how a silent failure becomes invisible a second time.
//
// `CLAUDE_SETTINGS_PATH` is redirected at a temp file for the same reason `MISSION_HOME` is:
// `costTelemetryStatus` READS the operator's real settings file to report what is actually
// installed, and a test must never read or write the one in their home directory.

const home = mkdtempSync(join(tmpdir(), "mission-cost-status-"));
process.env.MISSION_HOME = home;
const settingsPath = join(home, "claude-settings.json");
process.env.CLAUDE_SETTINGS_PATH = settingsPath;
writeFileSync(settingsPath, "{}\n");

const {
  noteOtelExportSeen,
  openDb,
  recordAutomationUsage,
  recordDriverSessionUsage,
  upsertUsageCell,
} = await import("../src/server/db.ts");
const { costTelemetryStatus, setCostConfig } = await import("../src/server/cost.ts");

after(() => rmSync(home, { recursive: true, force: true }));

openDb();

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

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

test("a fresh install reports installed, not receiving, and warns about nothing", () => {
  // Writing the env block is what `installed` reflects, and it is deliberately not enough to
  // claim anything is working: the block only reaches sessions started AFTER it was written.
  // Nor is it enough to warn - there is no spend yet, so nothing is going uncounted.
  setCostConfig({ enabled: true });
  const status = costTelemetryStatus(NOW);
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
    ts: NOW - 1_000,
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
  const status = costTelemetryStatus(NOW);
  assert.equal(status.receiving, false, "the app's own spend is not a session reporting");
});

test("a driven fleet with a silent exporter is the state that gets the warning", () => {
  // Session spend is landing and the topbar has numbers on it, so every older signal reads
  // healthy - while a terminal `claude` contributes nothing and nobody has been told.
  driverTurn("a", NOW - 1_000);
  const status = costTelemetryStatus(NOW);
  assert.equal(status.receiving, true, "session spend is reaching the ledger");
  assert.equal(
    status.exporterSilent,
    true,
    "and the exporter has said nothing while it did, which is what the warning names",
  );
});

test("an export ARRIVING clears the warning, even though its rows were all dropped", () => {
  // The unsoundness a row test would have. Every datapoint in a driven fleet's export is
  // discarded by `sdkOwnedNoteKey`, so no `otel` row is ever written - and yet the exporter
  // plainly ran. Reading rows here would report a healthy exporter as a dead one and put a
  // false warning in front of every operator whose fleet is embedded.
  noteOtelExportSeen(NOW - 60_000);
  const status = costTelemetryStatus(NOW);
  assert.equal(status.exporterSilent, false, "arrival is the signal, not the surviving rows");
});

test("an exporter that worked and then stopped goes back to warning", () => {
  // THE REGRESSION THIS FILE EXISTS FOR, and the one the first implementation got wrong. It
  // asked whether an `otel` row had EVER been written, with no time bound, against a ledger
  // that keeps rows for 180 days. So an operator whose exporter worked once and then silently
  // stopped - the exact failure this change is about - kept reading healthy for up to six
  // months while every terminal session was uncounted the whole time.
  //
  // Driven forwards in time rather than by back-dating the stamp, because `noteOtelExportSeen`
  // refuses to move backwards on purpose and a test that fought that would be testing a
  // scenario production cannot produce. The real arrival above is the last one there was; here
  // it is eight days old, and the fleet worked yesterday.
  const later = NOW + 8 * DAY;
  driverTurn("b", later - 1 * DAY);
  const status = costTelemetryStatus(later);
  assert.equal(status.receiving, true, "spend is still landing, so nothing else looks wrong");
  assert.equal(
    status.exporterSilent,
    true,
    "a working exporter that stops must return to warning, not stay healthy until retention",
  );

  // A real `otel` row from the working period is still sitting in the ledger, well inside
  // retention - which is exactly what the first implementation found and trusted.
  upsertUsageCell(
    {
      noteKey: "discovered-session-old",
      sessionId: null,
      agent: "claude",
      modelId: "claude-opus-5",
      querySource: "main",
      windowEndNs: "1000000000000000777",
      ts: NOW,
    },
    "costUsd",
    0.4,
  );
  assert.equal(
    costTelemetryStatus(later).exporterSilent,
    true,
    "an old row is history, not evidence the exporter is running now",
  );
});

test("an idle stretch is not a fault, however long the exporter has been quiet", () => {
  // The false positive the pairing prevents. The exporter has now been silent for weeks, but the
  // fleet has done nothing recently either - so there is no work going uncounted and nothing to
  // say. Warning here would be noise, and noise is what makes the real warning ignorable.
  const quiet = NOW + 60 * DAY;
  assert.equal(
    costTelemetryStatus(quiet).exporterSilent,
    false,
    "no recent session spend means no shortfall to report",
  );
});

test("switching the toggle off uninstalls the block without rewriting history", () => {
  // `installed` is about the operator's file right now; `receiving` is about what the ledger has
  // recorded. Turning telemetry off does not un-spend anything.
  setCostConfig({ enabled: false });
  const status = costTelemetryStatus(NOW);
  assert.equal(status.installed, false, "the env block is gone from the file");
  assert.equal(status.receiving, true, "the rows it already wrote are still there");
});
