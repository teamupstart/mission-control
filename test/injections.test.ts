import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  claimInjectionEcho,
  confirmReservedInjection,
  forgetInjections,
  originOf,
  recordInjection,
  releaseInjection,
  reserveInjection,
} from "../src/server/injections.ts";

beforeEach(() => forgetInjections());

test("a delivery is credited to whoever made it, in that session only", () => {
  recordInjection("s1", "fix the arrow keys", "foreman");
  recordInjection("s1", "/reload-skills", "harness");
  recordInjection("s1", "deterministic repair packet", "workflow");
  assert.equal(originOf("s1", "fix the arrow keys"), "foreman");
  assert.equal(originOf("s1", "/reload-skills"), "harness");
  assert.equal(originOf("s1", "deterministic repair packet"), "workflow");
  // Two sessions can be working the same item text; only the one we typed into is ours.
  assert.equal(originOf("s2", "fix the arrow keys"), undefined);
});

test("text nobody recorded is the human's - the default under-claims on purpose", () => {
  recordInjection("s1", "fix the arrow keys", "foreman");
  assert.equal(originOf("s1", "fix the arrows"), undefined);
  assert.equal(originOf("unknown-session", "anything"), undefined);
});

test("a turn matches through the trim the transcript put it through", () => {
  recordInjection("s1", "  run the tests\n", "foreman");
  assert.equal(originOf("s1", "run the tests"), "foreman");
});

test("a session's deliveries are bounded, oldest first", () => {
  for (let i = 0; i < 260; i++) recordInjection("s1", `item ${i}`, "foreman");
  assert.equal(originOf("s1", "item 0"), undefined, "the oldest fell off");
  assert.equal(originOf("s1", "item 259"), "foreman", "the newest is kept");
  assert.equal(originOf("s1", "item 100"), "foreman", "the cap is a window, not a purge");
});

test("a payload re-sent across fix rounds isn't aged out by its first delivery", () => {
  recordInjection("s1", "the standing instruction", "foreman");
  for (let i = 0; i < 199; i++) recordInjection("s1", `item ${i}`, "foreman");
  recordInjection("s1", "the standing instruction", "foreman");
  for (let i = 0; i < 100; i++) recordInjection("s1", `later ${i}`, "foreman");
  assert.equal(originOf("s1", "the standing instruction"), "foreman");
});

test("forgetting one session leaves the others alone", () => {
  recordInjection("s1", "a", "foreman");
  recordInjection("s2", "b", "foreman");
  forgetInjections("s1");
  assert.equal(originOf("s1", "a"), undefined);
  assert.equal(originOf("s2", "b"), "foreman");
});

test("a released reservation takes its session with it, instead of holding a slot", () => {
  // The session ceiling evicts the least recently STARTED session, so dead weight at the
  // front costs a live one at the back. Releases are the only thing that can empty a
  // session's map - a recorded delivery never removes a fingerprint - so without cleanup
  // enough refused deliveries push the ceiling over on empty maps and evict a session that
  // still has a claim outstanding. Its next daemon echo is then read as the human's Goal,
  // which is the failure this module exists to prevent.
  recordInjection("keeper", "the operator's actual ask", "foreman");

  // Comfortably past the 500-session ceiling, every one of them leaving nothing behind.
  for (let i = 0; i < 600; i++) {
    reserveInjection(`refused-${i}`, `packet ${i}`, "foreman");
    releaseInjection(`refused-${i}`, `packet ${i}`);
  }

  assert.equal(
    originOf("keeper", "the operator's actual ask"),
    "foreman",
    "a live session must not be evicted to make room for sessions that hold nothing",
  );
});

test("releasing one of several deliveries keeps the session and the rest", () => {
  // The decrement arm, which must not take the session with it. Two deliveries of one text
  // owe two echoes; releasing one leaves the other, and releasing a second text's only
  // delivery leaves the session because the first text is still on file.
  reserveInjection("s9", "twice-sent", "foreman");
  reserveInjection("s9", "twice-sent", "foreman");
  reserveInjection("s9", "once-sent", "workflow");

  releaseInjection("s9", "twice-sent");
  releaseInjection("s9", "once-sent");

  assert.equal(originOf("s9", "twice-sent"), "foreman", "one delivery of it survives");
  assert.equal(originOf("s9", "once-sent"), undefined, "its only delivery was given back");
});

test("a refused retry never erases the label of a delivery that already landed", () => {
  // The restart continuation is a fixed string, so a second restart reserves the exact text a
  // first one already delivered. Release must give back only what its own reservation added:
  // the earlier turn is still in the conversation, and the log asks who typed it every time it
  // renders, so answering undefined would hand machine-typed words back to the operator.
  const CONTINUATION = "Mission Control restarted while your previous turn was still in progress.";

  reserveInjection("s10", CONTINUATION, "harness");
  confirmReservedInjection("s10", CONTINUATION, "harness");
  assert.equal(claimInjectionEcho("s10", CONTINUATION), "harness", "its echo is accounted for");
  assert.equal(originOf("s10", CONTINUATION), "harness", "and the label outlives the claim");

  // A second restart reserves the same text, and this time the driver refuses.
  reserveInjection("s10", CONTINUATION, "harness");
  releaseInjection("s10", CONTINUATION);

  assert.equal(originOf("s10", CONTINUATION), "harness", "the delivered turn keeps its label");
  assert.equal(
    claimInjectionEcho("s10", CONTINUATION),
    undefined,
    "and the refused reservation owes no echo, so it cannot silence a later human turn",
  );
});

test("a confirmed delivery settles to one owed echo, not two", () => {
  // Reservation counts the echo; confirmation must not count a second, or the surplus is spent
  // suppressing whatever the operator types next that repeats the text.
  reserveInjection("s11", "packet", "workflow");
  confirmReservedInjection("s11", "packet", "workflow");
  assert.equal(claimInjectionEcho("s11", "packet"), "workflow");
  assert.equal(claimInjectionEcho("s11", "packet"), undefined);
});

test("a refused cross-origin retry leaves the landed turn credited to its own sender", () => {
  // Two senders can put byte-identical text into one session, and the fingerprint cannot tell
  // them apart. A reservation is provisional, so it may not take a label from a delivery that
  // actually happened - otherwise the earlier turn ends up credited to whoever merely tried
  // to send it next, in a log that is read long after both.
  const TEXT = "identical text, two senders";
  recordInjection("s12", TEXT, "foreman");
  assert.equal(claimInjectionEcho("s12", TEXT), "foreman");

  reserveInjection("s12", TEXT, "workflow");
  releaseInjection("s12", TEXT);

  assert.equal(originOf("s12", TEXT), "foreman", "the delivered turn keeps its own author");
});

test("a delivery that lands does update the label, unlike a reservation", () => {
  // The other half, and the behaviour this had before reservations existed: last landed
  // delivery wins. Two turns with identical text and different authors are indistinguishable
  // by fingerprint, so the most recent landing is the honest answer.
  const TEXT = "the same words again";
  recordInjection("s13", TEXT, "foreman");
  recordInjection("s13", TEXT, "workflow");
  assert.equal(originOf("s13", TEXT), "workflow");
});

test("the session ceiling spends itself on settled entries, not on owed echoes", () => {
  // An entry whose echo is still owed is the one kind whose loss is a defect rather than
  // forgetting: the agent is about to report that text back, and with no claim on file the
  // Goal path reads it as the operator's own instruction.
  reserveInjection("s14", "still awaiting its echo", "foreman");
  for (let i = 0; i < 250; i++) {
    recordInjection("s14", `settled ${i}`, "foreman");
    claimInjectionEcho("s14", `settled ${i}`);
  }

  assert.equal(
    claimInjectionEcho("s14", "still awaiting its echo"),
    "foreman",
    "an owed claim outlives settled ones however many arrive after it",
  );
  assert.equal(originOf("s14", "settled 0"), undefined, "and the ceiling still holds");
});
