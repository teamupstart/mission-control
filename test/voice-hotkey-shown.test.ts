import assert from "node:assert/strict";
import test from "node:test";
import { voiceStateOff } from "../src/shared/voice.ts";
import { confirmedVoiceHotkey } from "../src/web/components/VoiceIndicators.tsx";

test("advertise a registered saved chord even when a replacement was refused", () => {
  const state = voiceStateOff();
  assert.equal(confirmedVoiceHotkey(state), null);
  state.configuredHotkey = "ctrl+alt+m";
  state.capabilities.hotkey = { available: true, reason: null };
  assert.equal(confirmedVoiceHotkey(state), null, "capability alone does not acknowledge a chord");
  state.registeredHotkey = "ctrl+alt+m";
  assert.equal(confirmedVoiceHotkey(state), "ctrl+alt+m");
  assert.equal(confirmedVoiceHotkey({ ...state, configuredHotkey: "ctrl+alt+k" }), null);
  assert.equal(confirmedVoiceHotkey({ ...state, configuredHotkey: null }), null);
  state.hotkeyError = { reason: "Already in use", chordInForce: state.configuredHotkey };
  assert.equal(confirmedVoiceHotkey(state), "ctrl+alt+m");
  state.hotkeyError = { reason: "Already in use", chordInForce: null };
  assert.equal(confirmedVoiceHotkey(state), null);
});
