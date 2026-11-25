import assert from "node:assert/strict";
import test from "node:test";
import type { VoiceCard } from "../src/shared/voice-routing.ts";
import { receiveVoiceCard, VoiceCardClock } from "../src/web/lib/voice-card-clock.ts";

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
