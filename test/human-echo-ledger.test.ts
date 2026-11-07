import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  HUMAN_ECHO_TTL_MS,
  claimHumanEcho,
  confirmHumanEcho,
  expectHumanEcho,
  expireHumanEchoes,
  forgetInjections,
  markHumanEchoCaptured,
  markHumanEchoSeen,
  originOf,
  releaseHumanEcho,
} from "../src/server/injections.ts";
import type { WorkCycleSummary } from "../src/shared/types.ts";

// What is at stake: a human follow-up to an Agent SDK session reaches the Goal by two doors,
// the send's acknowledgement and the agent's prompt-hook echo. This ledger is how exactly one
// of them opens a prompt revision, without silencing a person who types the same words again.

const S = "sdk:ledger";
const K = "conversation:ledger";
const T0 = 1_000_000;

const idle = (generation: number): WorkCycleSummary => ({
  logicalKey: K, generation, active: false, completedAt: null, updatedAt: T0,
});
const active = (generation: number): WorkCycleSummary => ({
  logicalKey: K, generation, active: true, completedAt: null, updatedAt: T0,
});

const expect = (text: string, cycle?: WorkCycleSummary, now = T0) =>
  expectHumanEcho(S, text, { noteKey: K, cycle, now });
const claim = (text: string, now = T0) => claimHumanEcho(S, K, text, now);

beforeEach(() => forgetInjections());

test("an acknowledged and captured follow-up answers skip to its echo, once", () => {
  const ticket = expect("follow up", idle(0));
  assert.deepEqual(confirmHumanEcho(ticket, { now: T0 }), { captured: false });
  markHumanEchoCaptured(ticket, { now: T0 });
  assert.equal(claim("follow up").kind, "skip");
  assert.equal(claim("follow up").kind, "none", "the skip consumed the entry");
});

test("an open or confirmed follow-up answers capture, and the claim changes nothing", () => {
  const ticket = expect("early echo", idle(0));
  const first = claim("early echo");
  assert.equal(first.kind, "capture");
  assert.equal(claim("early echo").kind, "capture", "a second claim before the mark still captures");
  assert.equal(confirmHumanEcho(ticket, { now: T0 }).captured, false, "the claim did not capture");
  assert.equal(claim("early echo").kind, "capture", "a confirmed entry still captures");
});

test("only markHumanEchoCaptured moves an entry to captured", () => {
  const ticket = expect("only the mark", idle(0));
  claim("only the mark");
  confirmHumanEcho(ticket, { now: T0 });
  releaseHumanEcho(ticket, T0); // not captured, so this drops it
  assert.equal(claim("only the mark").kind, "none");

  const again = expect("only the mark", idle(0));
  const claimed = claim("only the mark");
  assert.equal(claimed.kind, "capture");
  if (claimed.kind !== "capture") return;
  markHumanEchoCaptured(claimed.ticket, { echoed: true, now: T0 });
  assert.deepEqual(confirmHumanEcho(again, { now: T0 }), { captured: true });
});

test("an echo the hook captured is spent, so the next send of the same text is its own", () => {
  const first = expect("retype me", idle(0));
  const claimed = claim("retype me");
  assert.equal(claimed.kind, "capture");
  if (claimed.kind === "capture") markHumanEchoCaptured(claimed.ticket, { echoed: true, now: T0 });
  assert.equal(confirmHumanEcho(first, { now: T0 }).captured, true);

  const retype = expect("retype me", idle(0));
  assert.equal(claim("retype me").kind, "capture", "the retype's echo is not the first send's");
  assert.equal(confirmHumanEcho(retype, { now: T0 }).captured, false);
});

test("two sends of one text answer their echoes oldest first", () => {
  const one = expect("twice", idle(0));
  const two = expect("twice", idle(0));
  confirmHumanEcho(one, { now: T0 });
  markHumanEchoCaptured(one, { now: T0 });
  confirmHumanEcho(two, { now: T0 });
  markHumanEchoCaptured(two, { now: T0 });
  assert.equal(claim("twice").kind, "skip");
  assert.equal(claim("twice").kind, "skip");
  assert.equal(claim("twice").kind, "none");
});

test("an echo whose hook capture failed is still spent", () => {
  const first = expect("spent anyway", idle(0));
  const claimed = claim("spent anyway");
  assert.equal(claimed.kind, "capture");
  if (claimed.kind === "capture") markHumanEchoSeen(claimed.ticket, T0); // the hook's write failed
  assert.deepEqual(confirmHumanEcho(first, { now: T0 }), { captured: false }, "the acknowledgement still records it");
  markHumanEchoCaptured(first, { now: T0 });

  const retype = expect("spent anyway", idle(0));
  assert.equal(claim("spent anyway").kind, "capture", "the retype's echo is its own, not the first send's");
  assert.deepEqual(confirmHumanEcho(retype, { now: T0 }), { captured: false });
});

test("release never drops a captured entry", () => {
  const ticket = expect("kept", idle(0));
  confirmHumanEcho(ticket, { now: T0 });
  markHumanEchoCaptured(ticket, { now: T0 });
  releaseHumanEcho(ticket, T0);
  assert.equal(claim("kept").kind, "skip");
});

test("an idle send belongs to the next turn and expires when that turn completes", () => {
  const ticket = expect("idle send", idle(3));
  confirmHumanEcho(ticket, { now: T0 });
  markHumanEchoCaptured(ticket, { now: T0 });
  expireHumanEchoes(S, K, 3, T0);
  assert.equal(claim("idle send").kind, "skip", "the turn before it is not its turn");

  const later = expect("idle send", idle(3));
  confirmHumanEcho(later, { now: T0 });
  markHumanEchoCaptured(later, { now: T0 });
  expireHumanEchoes(S, K, 4, T0);
  assert.equal(claim("idle send").kind, "none", "its own turn completed");
});

test("a send during an active cycle belongs to the turn after it, and starts aging then", () => {
  const ticket = expect("queued", active(3));
  confirmHumanEcho(ticket, { now: T0 });
  markHumanEchoCaptured(ticket, { now: T0 });
  // Not eligible yet, so no age applies while the running turn takes its time.
  assert.equal(claim("queued", T0 + 10 * HUMAN_ECHO_TTL_MS).kind, "skip");

  const queued = expect("queued", active(3));
  confirmHumanEcho(queued, { now: T0 });
  markHumanEchoCaptured(queued, { now: T0 });
  const stop = T0 + 5_000;
  expireHumanEchoes(S, K, 4, stop);
  assert.equal(claim("queued", stop + HUMAN_ECHO_TTL_MS).kind, "skip", "eligibility began at the Stop");

  const third = expect("queued", active(3));
  confirmHumanEcho(third, { now: T0 });
  markHumanEchoCaptured(third, { now: T0 });
  expireHumanEchoes(S, K, 4, stop);
  assert.equal(claim("queued", stop + HUMAN_ECHO_TTL_MS + 1).kind, "none", "and aged from there");

  const fourth = expect("queued", active(3));
  confirmHumanEcho(fourth, { now: T0 });
  markHumanEchoCaptured(fourth, { now: T0 });
  expireHumanEchoes(S, K, 5, stop);
  assert.equal(claim("queued", stop).kind, "none", "its own turn completed");
});

test("a driver that answers steered moves an idle-stamped send behind the running turn", () => {
  const ticket = expect("steered late", idle(3));
  confirmHumanEcho(ticket, { queued: true, now: T0 });
  markHumanEchoCaptured(ticket, { now: T0 });
  expireHumanEchoes(S, K, 4, T0);
  assert.equal(claim("steered late").kind, "skip");
});

test("age is checked lazily on claim, confirm, mark and release", () => {
  const stale = T0 + HUMAN_ECHO_TTL_MS + 1;

  const onClaim = expect("aged", idle(0));
  confirmHumanEcho(onClaim, { now: T0 });
  markHumanEchoCaptured(onClaim, { now: T0 });
  assert.equal(claim("aged", T0 + HUMAN_ECHO_TTL_MS).kind, "skip", "at the limit it still answers");
  const again = expect("aged", idle(0));
  confirmHumanEcho(again, { now: T0 });
  markHumanEchoCaptured(again, { now: T0 });
  assert.equal(claim("aged", stale).kind, "none");

  const onConfirm = expect("aged confirm", idle(0));
  assert.deepEqual(confirmHumanEcho(onConfirm, { now: stale }), { captured: false });
  assert.equal(claim("aged confirm", stale).kind, "none", "the stale confirm dropped it");

  const onMark = expect("aged mark", idle(0));
  confirmHumanEcho(onMark, { now: T0 });
  markHumanEchoCaptured(onMark, { now: stale });
  assert.equal(claim("aged mark", T0).kind, "none", "the stale mark found nothing to mark");

  const onRelease = expect("aged release", idle(0));
  confirmHumanEcho(onRelease, { now: T0 });
  markHumanEchoCaptured(onRelease, { now: T0 });
  releaseHumanEcho(onRelease, stale);
  assert.equal(claim("aged release", T0).kind, "none");
});

test("a completion before the acknowledgement never expires an unacknowledged send", () => {
  // Stamped idle, but the driver queues it behind a turn that completes before `send` returns.
  const steered = expect("queued behind a quick turn", idle(3));
  expireHumanEchoes(S, K, 4, T0);
  assert.equal(claim("queued behind a quick turn").kind, "capture", "still on file while open");
  assert.deepEqual(confirmHumanEcho(steered, { queued: true, now: T0 }), { captured: false });
  markHumanEchoCaptured(steered, { now: T0 });
  assert.equal(claim("queued behind a quick turn").kind, "skip", "its later echo is absorbed");

  const later = expect("queued then its own turn ends", idle(3));
  expireHumanEchoes(S, K, 4, T0);
  confirmHumanEcho(later, { queued: true, now: T0 });
  markHumanEchoCaptured(later, { now: T0 });
  expireHumanEchoes(S, K, 5, T0);
  assert.equal(claim("queued then its own turn ends").kind, "none", "it ends with its own turn");

  const aging = expect("queued and eligible at once", idle(3));
  expireHumanEchoes(S, K, 4, T0);
  confirmHumanEcho(aging, { queued: true, now: T0 });
  markHumanEchoCaptured(aging, { now: T0 });
  assert.equal(claim("queued and eligible at once", T0 + HUMAN_ECHO_TTL_MS + 1).kind, "none",
    "the turn ahead already completed, so it is aging from the acknowledgement");

  const started = expect("started and finished before the ack", idle(3));
  expireHumanEchoes(S, K, 4, T0);
  assert.deepEqual(confirmHumanEcho(started, { now: T0 }), { captured: false });
  assert.equal(claim("started and finished before the ack").kind, "none",
    "its own turn already completed, so the acknowledgement settles it");
});

test("a hook capture survives its entry expiring before the acknowledgement", () => {
  const ticket = expect("captured then expired", idle(3));
  const claimed = claim("captured then expired");
  assert.equal(claimed.kind, "capture");
  if (claimed.kind === "capture") markHumanEchoCaptured(claimed.ticket, { echoed: true, now: T0 });
  // The turn the follow-up started completes while the driver's acknowledgement is in flight.
  expireHumanEchoes(S, K, 4, T0);
  assert.deepEqual(confirmHumanEcho(ticket, { now: T0 }), { captured: true });

  const aged = expect("captured then aged", idle(3));
  const agedClaim = claim("captured then aged");
  if (agedClaim.kind === "capture") markHumanEchoCaptured(agedClaim.ticket, { echoed: true, now: T0 });
  assert.deepEqual(confirmHumanEcho(aged, { now: T0 + HUMAN_ECHO_TTL_MS + 1 }), { captured: true });

  const uncaptured = expect("expired uncaptured", idle(3));
  expireHumanEchoes(S, K, 4, T0);
  assert.deepEqual(confirmHumanEcho(uncaptured, { now: T0 }), { captured: false });
});

test("an echo is matched only within the conversation the send was accepted into", () => {
  const ticket = expect("cleared", idle(0));
  confirmHumanEcho(ticket, { now: T0 });
  markHumanEchoCaptured(ticket, { now: T0 });
  assert.equal(claimHumanEcho(S, "conversation:replacement", "cleared", T0).kind, "none");
  // The replacement's completions cannot expire it by generation, so they start its clock.
  expireHumanEchoes(S, "conversation:replacement", 1, T0);
  assert.equal(claim("cleared", T0 + HUMAN_ECHO_TTL_MS + 1).kind, "none");
});

test("the per-session ceiling holds", () => {
  const first = expect("ceiling 0", idle(0));
  confirmHumanEcho(first, { now: T0 });
  markHumanEchoCaptured(first, { now: T0 });
  for (let i = 1; i <= 200; i++) expect(`ceiling ${i}`, idle(0));
  assert.equal(claim("ceiling 0").kind, "none", "the oldest entry was evicted");
  assert.equal(claim("ceiling 1").kind, "capture");
});

test("a human echo is never an authorship label", () => {
  const ticket = expect("mine", idle(0));
  confirmHumanEcho(ticket, { now: T0 });
  markHumanEchoCaptured(ticket, { now: T0 });
  assert.equal(originOf(S, "mine"), undefined);
});
