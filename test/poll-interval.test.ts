import assert from "node:assert/strict";
import test from "node:test";

import { pollIntervalMs } from "../src/server/config.ts";

/**
 * The passive-polling off switch.
 *
 * `MISSION_POLL_MS=0` has to actually stop the sweep, and the reason is the same one
 * `reapIntervalMs` documents one module over: handed to `setTimeout`, 0 is a ~1ms tick, so a
 * naive `Number(env ?? default)` turns the off switch into the busiest possible loop. Here
 * that loop is `ps` over every process on the machine.
 *
 * The switch exists because terminal discovery is not scoped by `MISSION_HOME`: it cards any
 * agent process it can see, so a second daemon booted beside an operator's real sessions
 * adopts them, along with the Kill and Reset controls that act on them. `e2e/` relies on
 * this, and so would any daemon run in a container or on CI.
 */
test("an explicit zero switches passive polling off", () => {
  assert.equal(pollIntervalMs("0"), null);
});

test("a negative interval is off rather than a hot loop", () => {
  assert.equal(pollIntervalMs("-1"), null);
});

test("an absent or empty value falls back to the default cadence", () => {
  assert.equal(pollIntervalMs(undefined), 1500);
  // An exported-but-empty `MISSION_POLL_MS=` is `""`, and `Number("")` is 0 - which would
  // read as the off switch from an operator who never asked for one.
  assert.equal(pollIntervalMs(""), 1500);
  assert.equal(pollIntervalMs("   "), 1500);
});

test("an unparseable value is a typo, not an instruction to spin", () => {
  assert.equal(pollIntervalMs("soon"), 1500);
});

test("a real interval is honoured", () => {
  assert.equal(pollIntervalMs("250"), 250);
});

