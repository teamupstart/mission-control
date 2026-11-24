import assert from "node:assert/strict";
import test from "node:test";
import { voiceTray } from "../src/main/voice-tray.ts";

test("selected tray glyphs and native menu actions cover every mode", () => {
  assert.equal(voiceTray("off", false), null);
  for (const [mode, image, status] of [
    ["listening", "mic", "listening for names"],
    ["muted", "mic-off", "muted"],
    ["auto-muted", "phone", "muted for a call"],
    ["push-to-talk", "ptt", "push-to-talk active"],
    ["unavailable", "mic-off", "not listening"],
  ] as const) {
    const muted = mode === "muted";
    assert.deepEqual(voiceTray(mode, muted), {
      image: `voice-${image}Template.png`, status: `Voice: ${status}`,
      action: muted ? "Unmute Voice" : "Mute Voice", nextMuted: !muted,
    });
  }
  assert.equal(voiceTray("unavailable", true)?.action, "Unmute Voice");
});
