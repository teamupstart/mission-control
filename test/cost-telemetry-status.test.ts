import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What the Cost panel is allowed to claim about telemetry, and when.
//
// Three states, and the middle one is new. It exists because this change gave session spend a
// SECOND writer, which broke a shortcut the panel used to be able to take: while OTel was the
// only writer, "any reported session row exists" and "the exporter is working" were the same
// sentence. They are not any more. A driven session's driver satisfies the first and says
// nothing about the second, so a panel reading only `receiving` would report healthy telemetry
// while every passively-discovered terminal session silently recorded nothing.
//
//   installed, no session rows        -> receiving false          -> the first-run hint
//   installed, driver rows only       -> receiving, NOT exporting -> the new warning
//   installed, an OTel row exists     -> receiving AND exporting  -> no message
//
// The fourth case is the one the original bug wore: rows in the ledger, none of them a
// session's. Automation spend must move neither flag, or the panel would have called this
// feature healthy on the very machine where session spend had been zero all day.
//
// `CLAUDE_SETTINGS_PATH` is redirected at a temp file for the same reason `MISSION_HOME` is:
// `costTelemetryStatus` READS the operator's real settings file to report what is actually
// installed, and a test must never read or write the one in their home directory.

const home = mkdtempSync(join(tmpdir(), "mission-cost-status-"));
process.env.MISSION_HOME = home;
const settingsPath = join(home, "claude-settings.json");
process.env.CLAUDE_SETTINGS_PATH = settingsPath;
writeFileSync(settingsPath, "{}\n");

const { openDb, recordAutomationUsage, recordDriverSessionUsage, upsertUsageCell } = await import(
  "../src/server/db.ts"
);
const { costTelemetryStatus, setCostConfig } = await import("../src/server/cost.ts");

after(() => rmSync(home, { recursive: true, force: true }));

openDb();

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

test("a fresh install reports installed but not yet receiving", () => {
  // Writing the env block is what `installed` reflects, and it is deliberately not enough to
  // claim anything is working: the block only reaches sessions started AFTER it was written.
  setCostConfig({ enabled: true });
  const status = costTelemetryStatus();
  assert.equal(status.installed, true, "the env block is in the file");
  assert.equal(status.receiving, false, "and nothing has reported through it yet");
  assert.equal(status.otelExporting, false);
  assert.equal(status.settingsPath, settingsPath, "the panel names the file it would edit");
});

test("automation spend alone claims nothing about session telemetry", () => {
  // The shape of the original bug. The ledger had 48 rows and $40 on it, every one of them the
  // app's own overhead, while session spend was zero. Neither flag may move for these, or the
  // panel would have reported a working feature on exactly the machine it was broken on.
  recordAutomationUsage({
    role: "foreman:review",
    agent: "claude",
    runId: "status-run-1",
    ts: 1_000,
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
  const status = costTelemetryStatus();
  assert.equal(status.receiving, false, "the app's own spend is not a session reporting");
  assert.equal(status.otelExporting, false, "and it is certainly not an export");
});

test("a driver row means receiving, and still not exporting", () => {
  // The state with no other symptom, and the whole reason `otelExporting` exists. Session spend
  // is landing and the topbar has numbers on it, so every older signal reads healthy - while a
  // terminal `claude` is contributing nothing and no one has been told.
  recordDriverSessionUsage({
    noteKey: "status-session-1",
    sessionId: "sdk:status-1",
    agent: "claude",
    turnId: "status-turn-1",
    ts: 2_000,
    models: MODELS,
  });
  const status = costTelemetryStatus();
  assert.equal(status.receiving, true, "session spend is reaching the ledger");
  assert.equal(
    status.otelExporting,
    false,
    "but the exporter has still never delivered, which is what the warning says",
  );
});

test("an exported row is what finally reports the exporter healthy", () => {
  upsertUsageCell(
    {
      noteKey: "status-session-2",
      sessionId: null,
      agent: "claude",
      modelId: "claude-opus-5",
      querySource: "main",
      windowEndNs: "1000000000000000777",
      ts: 3_000,
    },
    "costUsd",
    0.4,
  );
  const status = costTelemetryStatus();
  assert.equal(status.receiving, true);
  assert.equal(status.otelExporting, true, "one real export is enough to clear the warning");
});

test("switching the toggle off uninstalls the block without rewriting history", () => {
  // The flags answer different questions and must not be conflated: `installed` is about the
  // operator's file right now, the other two are about what the ledger has recorded. Turning
  // telemetry off does not un-spend anything.
  setCostConfig({ enabled: false });
  const status = costTelemetryStatus();
  assert.equal(status.installed, false, "the env block is gone from the file");
  assert.equal(status.receiving, true, "the rows it already wrote are still there");
  assert.equal(status.otelExporting, true);
});
