import { test } from "node:test";
import assert from "node:assert/strict";
import { EvaluationDebounce } from "../src/server/foreman/debounce.ts";

/** A hand-cranked clock so debounce timing is deterministic - no real waiting. */
function fakeClock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("first evaluation of a session is always due", () => {
  const clock = fakeClock();
  const d = new EvaluationDebounce(60_000, clock.now);
  assert.equal(d.claim("s1"), true);
});

test("a second evaluation inside the window is held off", () => {
  const clock = fakeClock();
  const d = new EvaluationDebounce(60_000, clock.now);
  assert.equal(d.claim("s1"), true);
  clock.advance(59_999);
  assert.equal(d.claim("s1"), false, "still inside the 60s window");
});

test("evaluation is due again once the window fully elapses", () => {
  const clock = fakeClock();
  const d = new EvaluationDebounce(60_000, clock.now);
  assert.equal(d.claim("s1"), true);
  clock.advance(60_000);
  assert.equal(d.claim("s1"), true, "exactly at the interval is allowed");
});

test("the window is measured from the last SUCCESSFUL claim, so a flap stays rate-limited", () => {
  const clock = fakeClock();
  const d = new EvaluationDebounce(60_000, clock.now);
  assert.equal(d.claim("s1"), true); // t=1000, records 1000
  clock.advance(40_000);
  assert.equal(d.claim("s1"), false, "40s < 60s -> held; a held claim records nothing"); // t=41000
  clock.advance(40_000);
  assert.equal(d.claim("s1"), true, "80s since the last successful claim -> due"); // t=81000, records 81000
  clock.advance(30_000);
  assert.equal(d.claim("s1"), false, "30s since the new successful claim -> held again"); // t=111000
});

test("sessions are rate-limited independently", () => {
  const clock = fakeClock();
  const d = new EvaluationDebounce(60_000, clock.now);
  assert.equal(d.claim("s1"), true);
  assert.equal(d.claim("s2"), true, "a different session has its own window");
  assert.equal(d.claim("s1"), false, "s1 is still within its own window");
});

test("expired entries are pruned so the tracker stays bounded", () => {
  const clock = fakeClock();
  const d = new EvaluationDebounce(60_000, clock.now);
  d.claim("s1");
  d.claim("s2");
  d.claim("s3");
  assert.equal(d.size, 3);
  clock.advance(60_000); // s1/s2/s3 windows have all elapsed
  assert.equal(d.claim("s4"), true, "a new session prunes the expired entries on claim");
  assert.equal(d.size, 1, "only the still-live s4 remains");
});

test("a custom interval is honoured", () => {
  const clock = fakeClock();
  const d = new EvaluationDebounce(1_000, clock.now);
  assert.equal(d.claim("s1"), true);
  clock.advance(999);
  assert.equal(d.claim("s1"), false);
  clock.advance(1);
  assert.equal(d.claim("s1"), true, "due at exactly the custom interval");
});
