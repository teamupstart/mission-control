import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// When the grace period before exporter silence is a fault STARTS, and the one path that has
// to start it without ever being told to.
//
// `costTelemetryStatus`'s toggle in Settings - Cost calls `setCostConfig`, which stamps the
// grace period the moment `enabled` flips false -> true. That is the ordinary path and it is
// NOT the only one that makes `flags.installed` true: `npm run install-telemetry` writes the
// same `env` block by calling `writeOtelEnv` directly, an operator can hand-edit
// `~/.claude/settings.json`, and a daemon can be upgraded onto a machine where the block was
// already there from before this stamp existed. All three leave `installed` true with no stamp
// at all - and a grace period that only the UI path can start would stay unset, which is to say
// SILENT, forever for every one of them. That is the same shape of bug this whole change exists
// to fix, reintroduced for a different population.
//
// So `costTelemetryStatus` backfills the stamp itself, on the read path everyone shares, the
// first time it observes `installed` true with no stamp. This file drives that path directly -
// writing the env block with `writeOtelEnv`, never `setCostConfig` - because that is the
// scenario the backfill exists for and a test that only used `setCostConfig` would never
// exercise it.

const home = mkdtempSync(join(tmpdir(), "mission-cost-enable-"));
process.env.MISSION_HOME = home;
const settingsPath = join(home, "claude-settings.json");
process.env.CLAUDE_SETTINGS_PATH = settingsPath;
writeFileSync(settingsPath, "{}\n");

const { openDb, recordDriverSessionUsage } = await import("../src/server/db.ts");
const { costTelemetryStatus, setCostConfig } = await import("../src/server/cost.ts");
const { writeOtelEnv } = await import("../src/shared/claude-settings.ts");

after(() => rmSync(home, { recursive: true, force: true }));

openDb();

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_800_000_000_000;

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

function driverTurn(id: string, ts: number): void {
  recordDriverSessionUsage({
    noteKey: `enable-session-${id}`,
    sessionId: `sdk:${id}`,
    agent: "claude",
    turnId: `enable-turn-${id}`,
    ts,
    models: MODELS,
  });
}

test("an installation setCostConfig never touched backfills its own grace period", () => {
  // The CLI path: `npm run install-telemetry` calls exactly this, never the daemon's config
  // store. `installed` becomes true with no stamp anywhere - the state the backfill exists for.
  writeOtelEnv({ endpoint: "http://127.0.0.1:7317", token: "test-token", intervalMs: 15_000 });

  // Session spend from BEFORE this daemon ever computed status - the exact shape of the
  // reporting machine's own history: sessions had already run under the installed env block.
  driverTurn("preexisting", T0 - 1 * DAY);

  const first = costTelemetryStatus(T0);
  assert.equal(first.installed, true, "the file already carries the block");
  assert.equal(first.receiving, true, "and the driver had already reported through it");
  assert.equal(
    first.exporterSilent,
    false,
    "the FIRST read must not accuse an exporter of a week it was never granted - " +
      "this is the exact regression a UI-only stamp would have reintroduced",
  );

  // The backfill has to be durable, not re-computed fresh on every call: this second read is
  // moments later and must see the SAME grace period the first read just started, not a new one.
  const second = costTelemetryStatus(T0 + 1_000);
  assert.equal(second.exporterSilent, false, "the backfilled stamp persists across reads");
});

test("that backfilled grace period elapses on schedule, same as an enabled one", () => {
  // The backfill is a fallback for HOW the grace period starts, not an exemption from having
  // one. Once it has elapsed and the exporter has still said nothing, the warning is real.
  const t = T0 + 8 * DAY;
  driverTurn("still-active", t - 1_000);
  assert.equal(
    costTelemetryStatus(t).exporterSilent,
    true,
    "a backfilled grace period expires exactly like a UI-started one",
  );
});

test("disabling and re-enabling through the UI earns a fresh grace period", () => {
  // Disabling clears the stamp; re-enabling restamps it. Without the clear, a fleet switched off
  // for months and back on would inherit a grace period that had already expired the INSTANT it
  // came back - warning immediately, which is the bug this file exists to prevent, reachable by
  // a different door.
  const off = T0 + 20 * DAY;
  setCostConfig({ enabled: false }, off);
  assert.equal(costTelemetryStatus(off).installed, false, "the block is gone");

  const on = T0 + 60 * DAY;
  setCostConfig({ enabled: true }, on);
  driverTurn("resumed", on + 1_000);
  assert.equal(
    costTelemetryStatus(on + 2_000).exporterSilent,
    false,
    "re-enabling starts a fresh grace period rather than resuming the expired one",
  );
});

test("a stamp for a disabled feature cannot shorten the next grace period", () => {
  // What the clear-on-disable specifically prevents, isolated from the test above's narrower
  // check. Disable, wait well past what a grace period would be, THEN re-enable - if the old
  // stamp had survived, the moment of re-enabling would already read as grace-elapsed.
  const off = T0 + 90 * DAY;
  setCostConfig({ enabled: false }, off);

  const later = T0 + 150 * DAY;
  setCostConfig({ enabled: true }, later);
  driverTurn("late-resume", later + 1_000);
  assert.equal(
    costTelemetryStatus(later + 2_000).exporterSilent,
    false,
    "60 days of being off must not count against the grace period after coming back on",
  );
});
