import { test } from "node:test";
import assert from "node:assert/strict";
import { blockerAge } from "../src/web/lib/blocker.ts";

// The `Blocked · age` flag and the detail band's "since" read through this one formatter, so
// each unit has to switch exactly at its boundary rather than a step early or late.

const NOW = 10_000_000_000;
const ago = (ms: number) => blockerAge(NOW - ms, NOW);
const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test("seconds hold until 60 seconds, then minutes take over", () => {
  assert.equal(ago(0), "0s");
  assert.equal(ago(59 * SEC), "59s");
  assert.equal(ago(59 * SEC + 999), "59s");
  assert.equal(ago(60 * SEC), "1m");
});

test("minutes hold until 60 minutes, then hours take over", () => {
  assert.equal(ago(59 * MIN), "59m");
  assert.equal(ago(60 * MIN - 1), "59m");
  assert.equal(ago(60 * MIN), "1h");
});

test("hours hold until 24 hours, then days take over", () => {
  assert.equal(ago(23 * HOUR), "23h");
  assert.equal(ago(DAY - 1), "23h");
  assert.equal(ago(DAY), "1d");
  assert.equal(ago(3 * DAY + 5 * HOUR), "3d");
});

test("a start time in the future reads as no age rather than a negative one", () => {
  assert.equal(blockerAge(NOW + 5 * SEC, NOW), "0s");
});
