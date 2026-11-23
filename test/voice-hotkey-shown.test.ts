import assert from "node:assert/strict";
import test from "node:test";
import { VOICE_CONFIG_DEFAULTS, voiceStateOff } from "../src/shared/voice.ts";
import { hotkeyShown } from "../src/web/components/VoiceIndicators.tsx";

test("only a registered, error-free, configured voice chord is advertised", () => {
  const state = voiceStateOff();
  assert.equal(hotkeyShown(state, VOICE_CONFIG_DEFAULTS), false);
  state.capabilities.hotkey = { available: true, reason: null };
  assert.equal(hotkeyShown(state, VOICE_CONFIG_DEFAULTS), true);
  assert.equal(hotkeyShown(state, { ...VOICE_CONFIG_DEFAULTS, hotkey: null }), false);
  state.hotkeyError = { reason: "Already in use", chordInForce: null };
  assert.equal(hotkeyShown(state, VOICE_CONFIG_DEFAULTS), false);
});
