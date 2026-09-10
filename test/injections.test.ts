import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
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
