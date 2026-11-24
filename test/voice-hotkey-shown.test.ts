import assert from "node:assert/strict";
import test from "node:test";
import { VOICE_CONFIG_DEFAULTS, voiceStateOff } from "../src/shared/voice.ts";
import { confirmedVoiceHotkey } from "../src/web/components/VoiceIndicators.tsx";

test("only a registered, error-free, configured voice chord is advertised", () => {
  const state = voiceStateOff();
  assert.equal(confirmedVoiceHotkey(state, VOICE_CONFIG_DEFAULTS), null);
  state.capabilities.hotkey = { available: true, reason: null };
  assert.equal(confirmedVoiceHotkey(state, VOICE_CONFIG_DEFAULTS), null, "capability alone does not acknowledge a chord");
  state.registeredHotkey = "ctrl+alt+m";
  assert.equal(confirmedVoiceHotkey(state, VOICE_CONFIG_DEFAULTS), "ctrl+alt+m");
  assert.equal(confirmedVoiceHotkey(state, { ...VOICE_CONFIG_DEFAULTS, hotkey: "ctrl+alt+k" }), null);
  assert.equal(confirmedVoiceHotkey(state, { ...VOICE_CONFIG_DEFAULTS, hotkey: null }), null);
  state.hotkeyError = { reason: "Already in use", chordInForce: null };
  assert.equal(confirmedVoiceHotkey(state, VOICE_CONFIG_DEFAULTS), null);
});
