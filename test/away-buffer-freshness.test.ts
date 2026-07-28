import { test } from "node:test";
import assert from "node:assert/strict";
import { bufferReadIsCurrent } from "../src/web/lib/awayMode.ts";
import type { AwayConfig } from "../src/shared/protocol.ts";
import type { AwayBufferSummary } from "../src/shared/away-buffer.ts";

/**
 * What is at stake: a count from the away window you just ended must never be shown as
 * the count for the one you just started.
 *
 * The away card reads a buffer summary two round trips behind a moving target - a config
 * read that decides to ask, then the buffer read itself - and a human can flip away mode
 * in between. The panel already refuses a summary whose `since` does not match the
 * current `awaySince`, and that guard is not enough on its own, which is the subtle part
 * this pins.
 *
 * On the way back INTO away mode the optimistic config update keeps the OLD `awaySince`
 * until the server answers, because it spreads the state it already has. So a response
 * describing the window that just ended still matches, and the panel accepts a previous
 * window's count and preview lines. Only knowing that a toggle HAPPENED during the read
 * rules that out, which is what the epoch is for.
 *
 * The two checks are therefore not redundant: the epoch catches a local toggle mid-read,
 * and the config comparison catches the window moving with no local toggle at all (a
 * second dashboard window, or a tray toggle), which bumps no epoch here.
 */

const T1 = 1_000_000_000;
const T2 = T1 + 90_000;

const cfg = (away: boolean, awaySince: number | null): AwayConfig => ({
  away,
  awaySince,
  detectStalls: true,
  stallWorkingMinutes: 10,
  stallUnfinishedMinutes: 20,
  stallGateMinutes: 5,
  stallEscalationMinutes: 5,
});

const summary = (since: number | null): AwayBufferSummary => ({
  since,
  count: 7,
  dropped: 0,
  rollup: "1 stuck · 6 finished",
  lines: ["Session wedged - silent for 40m"],
});

test("a response for the window we are still in is committed", () => {
  assert.equal(
    bufferReadIsCurrent({
      buf: summary(T1),
      cfg: cfg(true, T1),
      epochAtStart: 3,
      epochNow: 3,
    }),
    true,
  );
});

// The Inspector's race, and the reason the epoch exists. Both windows are away, and the
// response matches the config that was read - it is stale only because a toggle happened
// while it was in flight.
test("a toggle during the read retires it, even though it matches the config read", () => {
  const buf = summary(T1);
  const read = cfg(true, T1);
  assert.equal(
    bufferReadIsCurrent({ buf, cfg: read, epochAtStart: 3, epochNow: 3 }),
    true,
    "same window, no toggle - this is the case the epoch must not reject",
  );
  assert.equal(
    bufferReadIsCurrent({ buf, cfg: read, epochAtStart: 3, epochNow: 4 }),
    false,
    "off then on again mid-read: the config still says T1, so only the epoch knows",
  );
});

test("a response for a window that has since moved on is dropped", () => {
  assert.equal(
    bufferReadIsCurrent({
      buf: summary(T1),
      cfg: cfg(true, T2),
      epochAtStart: 0,
      epochNow: 0,
    }),
    false,
    "no local toggle, but another window moved away mode on",
  );
});

test("nothing is current once you are back at the desk", () => {
  assert.equal(
    bufferReadIsCurrent({
      buf: summary(T1),
      cfg: cfg(false, null),
      epochAtStart: 0,
      epochNow: 0,
    }),
    false,
  );
});

// Two nulls are an absence on each side, not a pair that agrees.
test("a null stamp on both sides is not a match", () => {
  assert.equal(
    bufferReadIsCurrent({
      buf: summary(null),
      cfg: cfg(true, null),
      epochAtStart: 0,
      epochNow: 0,
    }),
    false,
  );
});
