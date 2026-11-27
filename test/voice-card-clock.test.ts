import assert from "node:assert/strict";
import test from "node:test";
import type { VoiceCard } from "../src/shared/voice-routing.ts";
import { receiveVoiceCard, refineVoiceCardClock, VOICE_CARD_CLOCK_TIGHT_MS, VoiceCardClock } from "../src/web/lib/voice-card-clock.ts";

test("a reconnect and a clock refinement share the first receipt's cap for the same window", () => {
  const card: VoiceCard = { id: "one", state: "pending", deadline: 24_000, windowMs: 4000,
    parts: [], candidates: [], openQuestions: 0, reason: "exact" };
  const first = receiveVoiceCard(card, { receivedAt: 1000, offset: -16_000, uncertain: true });
  assert.equal(first.localDeadline, 5000);
  const reconnect = receiveVoiceCard(card, { receivedAt: 2800, offset: -17_000, uncertain: true }, first);
  assert.equal(reconnect.localDeadline, 5000);
  const refined = receiveVoiceCard(reconnect, { receivedAt: 3500, offset: -19_500, uncertain: false }, reconnect);
  assert.equal(refined.localDeadline, 4500);
  const later = receiveVoiceCard({ ...card, deadline: 30_000 }, { receivedAt: 8000, offset: -15_000, uncertain: true }, first);
  assert.equal(later.localDeadline, 12_000);
});

test("a stream spanning a backward daemon clock step moves its bounds while a new connection keeps the clock", () => {
  const clock = new VoiceCardClock();
  const initial = clock.observeStream(1000, 1005, 100_000, 100_002);
  const afterStep = clock.observeStream(1000, 3005, 40_000, 42_002);
  assert.equal(afterStep.offset, initial.offset + 60_000);
  const reconnect = clock.observeStream(6000, 6005, 45_000, 45_002);
  assert.equal(reconnect.offset, afterStep.offset);
});

// The daemon's monotonic clock reads 8000 ms ahead of this page's in every sample below.
const fastSample = (at: number) => ({ sent: at, received: at + 2, stamp: at + 1 + 8000 });

test("a slow first clock sample is narrowed so a later focus observation is tight", async () => {
  const clock = new VoiceCardClock();
  // Taken in the dashboard's startup burst: the request waited 86 ms to reach the daemon.
  assert.equal(clock.observe(1000, 1088, 9086, 9086).uncertain, false);
  assert.deepEqual(clock.serverTimeAt(2000), { earliest: 9997, latest: 10_087 });
  let samples = 0;
  let sampled = 0;
  await refineVoiceCardClock(clock, async () => fastSample(1500 + 10 * samples++), () => sampled++, new AbortController().signal, [0, 0, 0]);
  assert.equal(samples, 1);
  assert.equal(sampled, 1);
  assert.ok(clock.width <= VOICE_CARD_CLOCK_TIGHT_MS);
  assert.deepEqual(clock.serverTimeAt(2000), { earliest: 9998, latest: 10_002 });
});

test("clock refinement retries failed and slow samples within its budget and stops on abort", async () => {
  const clock = new VoiceCardClock();
  clock.observe(1000, 1088, 9086, 9086);
  const replies = [null, { sent: 1200, received: 1260, stamp: 9230 }, null];
  let calls = 0;
  await refineVoiceCardClock(clock, async () => replies[calls++] ?? null, () => {}, new AbortController().signal, [0, 0, 0]);
  assert.equal(calls, 3);
  assert.ok(clock.width > VOICE_CARD_CLOCK_TIGHT_MS);
  const stop = new AbortController();
  calls = 0;
  await refineVoiceCardClock(clock, async () => {
    calls++;
    stop.abort();
    return fastSample(1400);
  }, () => assert.fail("an aborted refinement must not re-report"), stop.signal, [0, 0, 0]);
  assert.equal(calls, 1);
  const already = new VoiceCardClock();
  already.observe(1000, 1002, 9001, 9001);
  await refineVoiceCardClock(already, async () => assert.fail("a tight clock is not sampled again"), () => {}, new AbortController().signal);
});

test("clock refinement stops at the tight width and samples just above it", async () => {
  // A round trip of `rtt` gives a width of rtt + 2: each bound rounds by one millisecond.
  for (const [rtt, expected] of [[8, 0], [9, 1]] as const) {
    const clock = new VoiceCardClock();
    clock.observe(1000, 1000 + rtt, 9004, 9004);
    assert.equal(clock.width, rtt + 2);
    let samples = 0;
    await refineVoiceCardClock(clock, async () => (samples++, fastSample(1500)), () => {}, new AbortController().signal, [0, 0]);
    assert.equal(samples, expected, "width " + (rtt + 2));
    assert.ok(clock.width <= VOICE_CARD_CLOCK_TIGHT_MS);
  }
});

test("an abort during a refinement pause ends it without another sample or report", async () => {
  const clock = new VoiceCardClock();
  clock.observe(1000, 1088, 9086, 9086);
  const stop = new AbortController();
  let samples = 0;
  let reports = 0;
  // A slow sample keeps the clock wide, so refinement pauses a full minute before its next one.
  const refining = refineVoiceCardClock(clock, async () => (samples++, { sent: 1200, received: 1260, stamp: 9230 }), () => {
    reports++;
    setTimeout(() => stop.abort(), 5);
  }, stop.signal, [0, 60_000, 0]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ended = await Promise.race([refining.then(() => true),
    new Promise<false>(resolve => { timer = setTimeout(resolve, 2000, false); })]);
  clearTimeout(timer);
  assert.equal(ended, true, "the pause outlived its abort");
  assert.equal(samples, 1);
  assert.equal(reports, 1);
});
