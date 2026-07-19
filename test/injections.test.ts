import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { forgetInjections, originOf, recordInjection } from "../src/server/injections.ts";

beforeEach(() => forgetInjections());

test("a delivery is credited to whoever made it, in that session only", () => {
  recordInjection("s1", "fix the arrow keys", "foreman");
  recordInjection("s1", "/reload-skills", "harness");
  assert.equal(originOf("s1", "fix the arrow keys"), "foreman");
  assert.equal(originOf("s1", "/reload-skills"), "harness");
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
