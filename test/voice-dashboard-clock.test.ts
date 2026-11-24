import assert from "node:assert/strict";
import test from "node:test";
import { VoiceDashboardClock } from "../src/web/lib/voice-dashboard-clock.ts";

test("a slow first snapshot is refreshed within the edit's original budget", async t => {
  let now = 12_000;
  t.mock.method(performance, "now", () => now);
  let reads = 0;
  const clock = new VoiceDashboardClock(async () => {
    reads++;
    now += 100;
    return { providerRevision: "daemon:0", snapshotOrder: 2, serverTime: 112_010 };
  });
  clock.observe({ providerRevision: "daemon:0", snapshotOrder: 1, serverTime: 100_000 }, 0);
  assert.equal(await clock.deadline(15_000, new AbortController().signal), 126_910);
  assert.equal(reads, 1);
  now += 8_000;
  assert.equal(await clock.deadline(15_000, new AbortController().signal), 135_010);
  assert.equal(reads, 1);
});

test("a delayed reply cannot move a reliable clock behind or beyond daemon time", async t => {
  let now = 10;
  t.mock.method(performance, "now", () => now);
  const clock = new VoiceDashboardClock(async () => assert.fail("the earlier sample already bounds the clock"));
  clock.observe({ providerRevision: "daemon:1", snapshotOrder: 1, serverTime: 100_003 }, 0);
  now = 13_010;
  clock.observe({ providerRevision: "daemon:2", snapshotOrder: 2, serverTime: 101_000 }, 1_000);
  assert.equal(await clock.deadline(15_000, new AbortController().signal), 128_003);
  now += 12_000;
  clock.observe({ providerRevision: "daemon:2", snapshotOrder: 3, serverTime: 125_010 }, 13_010);
  assert.equal(await clock.deadline(15_000, new AbortController().signal), 140_010);
});
