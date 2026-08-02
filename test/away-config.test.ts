import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Away mode's config: a schema-validated blob over the `app_config` KV. Real db, so
// the round-trip through zod's defaults is exercised, not mocked. Mirrors the setup in
// harnesses-config.test.ts.

const home = mkdtempSync(join(tmpdir(), "mission-away-cfg-"));
// Set before importing anything that resolves the state dir.
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { getAwayConfig, setAwayConfig, stallThresholds } = await import(
  "../src/server/away/config.ts"
);

after(() => rmSync(home, { recursive: true, force: true }));

beforeEach(() => {
  openDb().exec("DELETE FROM app_config");
});

test("ships not-away, with no awaySince to summarise from", () => {
  const cfg = getAwayConfig();
  assert.equal(cfg.away, false);
  assert.equal(cfg.awaySince, null);
});

test("stall detection ships ON - being told an agent is wedged is useful at the desk too", () => {
  assert.equal(getAwayConfig().detectStalls, true);
});

test("going away persists and reads back", () => {
  assert.equal(setAwayConfig({ away: true }).away, true);
  assert.equal(getAwayConfig().away, true);
});

test("entering away stamps awaySince from the server, not the caller", () => {
  const next = setAwayConfig({ away: true }, 1234);
  assert.equal(next.awaySince, 1234);
});

test("a client cannot set away without a timestamp, nor backdate its own", () => {
  // The digest's window is derived, never trusted: a caller that supplies its own
  // awaySince alongside the transition has it overwritten.
  const next = setAwayConfig({ away: true, awaySince: 999 }, 5000);
  assert.equal(next.awaySince, 5000);
});

test("a patch carrying awaySince ALONE cannot backdate the window", () => {
  // The one the transition guard used to miss: with no `away` alongside it, the
  // caller's timestamp merged straight through. The watcher reads a changed
  // awaySince as a NEW away window and replaces the open buffer with an empty one,
  // so this backdate would have emptied the return digest.
  setAwayConfig({ away: true }, 1000);
  const next = setAwayConfig({ awaySince: 0 }, 9000);
  assert.equal(next.away, true);
  assert.equal(next.awaySince, 1000);
});

test("awaySince cannot be conjured while you are at the desk either", () => {
  const next = setAwayConfig({ awaySince: 500 }, 9000);
  assert.equal(next.away, false);
  assert.equal(next.awaySince, null);
});

test("returning clears awaySince", () => {
  setAwayConfig({ away: true }, 1000);
  const back = setAwayConfig({ away: false }, 2000);
  assert.equal(back.away, false);
  assert.equal(back.awaySince, null);
});

test("re-asserting away does NOT restamp - the window still starts when you left", () => {
  // Otherwise a client that re-sends its state on every reconnect keeps sliding the
  // window forward, and the return digest covers only the last few seconds.
  setAwayConfig({ away: true }, 1000);
  const again = setAwayConfig({ away: true }, 9000);
  assert.equal(again.awaySince, 1000);
});

test("a patch that doesn't mention away leaves the window alone", () => {
  setAwayConfig({ away: true }, 1000);
  const next = setAwayConfig({ stallWorkingMinutes: 30 }, 9000);
  assert.equal(next.away, true);
  assert.equal(next.awaySince, 1000);
  assert.equal(next.stallWorkingMinutes, 30);
});

test("a patch merges over the stored config rather than replacing it", () => {
  setAwayConfig({ stallWorkingMinutes: 45 });
  const next = setAwayConfig({ stallEscalationMinutes: 3 });
  assert.equal(next.stallWorkingMinutes, 45);
  assert.equal(next.stallEscalationMinutes, 3);
});

test("thresholds convert the human's minutes into the detector's ms", () => {
  const th = stallThresholds(
    setAwayConfig({
      stallWorkingMinutes: 10,
      stallUnfinishedMinutes: 20,
      stallEscalationMinutes: 2,
    }),
  );
  assert.deepEqual(th, {
    workingMs: 600_000,
    unfinishedMs: 1_200_000,
    escalationMs: 120_000,
  });
});

test("a config written by an older build gains new fields rather than failing", () => {
  openDb()
    .prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)")
    .run("away", JSON.stringify({ away: true }));
  const cfg = getAwayConfig();
  assert.equal(cfg.away, true);
  assert.equal(cfg.stallWorkingMinutes, 10);
});
