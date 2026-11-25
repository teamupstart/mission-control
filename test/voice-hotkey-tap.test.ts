import assert from "node:assert/strict";
import test from "node:test";
import { hotkeySpeechJob } from "../src/main/voice-hotkey-tap.ts";

test("the mute tap stops only the job that was live at key-up", () => {
  for (const state of ["preparing", "ready", "speaking", "stopping"]) {
    assert.equal(hotkeySpeechJob({speech: { job: {id: "current", state} }}), "current");
  }
  for (const state of ["stopped", "failed", "finished", "timed-out"]) {
    assert.equal(hotkeySpeechJob({speech: { job: {id: "previous", state} }}), null);
  }
  assert.equal(hotkeySpeechJob({}), null);
  assert.equal(hotkeySpeechJob({speech: {job: null}}), null);
});
