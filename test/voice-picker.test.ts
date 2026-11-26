import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VOICE_CONFIG_DEFAULTS, voiceStateOff } from "../src/shared/voice.ts";
import type { VoiceSpeechVoice } from "../src/shared/voice-speech.ts";
import { SpokenReplies } from "../src/web/components/SpokenReplies.tsx";

function render(voice = voiceStateOff(), selected: VoiceSpeechVoice | null = null) {
  return renderToStaticMarkup(createElement(SpokenReplies, { voice, state: {
    config: { ...VOICE_CONFIG_DEFAULTS, speech: { voice: selected } }, update: async () => true,
  } }));
}

test("both voice catalogs use the listener's names and quality tiers", () => {
  const voice = voiceStateOff();
  voice.speech.voice = { engine: "system", id: "p" };
  voice.capabilities["speech-output"] = { available: true, reason: null };
  voice.speech.catalog.system = ["premium", "enhanced", "default"].map(detail => ({ id: detail[0]!, name: detail.toUpperCase(), detail }));
  const html = render(voice);
  assert.match(html, /Automatic: PREMIUM/);
  assert.match(html, /PREMIUM \(Premium\)/);
  assert.match(html, /ENHANCED \(Enhanced\)/);
  assert.match(html, />DEFAULT \(Standard\)<\/option>/);
  assert.equal((html.match(/value="neural:supertonic-3\//g) ?? []).length, 10);
});

test("unavailable reasons and stored choices survive rendering with an empty catalog", () => {
  const voice = voiceStateOff();
  for (const reason of ["No listener is running.", "This listener cannot play speech.", "this listener was not started by a supervisor", "the listener did not confirm that speech had stopped", "the record of unfinished speech could not be read"]) {
    voice.speech.reason = reason;
    const html = render(voice);
    assert.ok(html.includes(reason));
    assert.doesNotMatch(html, /optgroup label="This Mac/);
  }
  const reason = "The requested voice is absent from the catalog.";
  voice.capabilities["speech-output"] = { available: false, code: "speech_voice_unavailable", reason };
  voice.speech.catalog.system = [{ id: "other", name: "Other", detail: "default" }];
  voice.speech.model.revision = "fixture";
  const missingSystem = render(voice, { engine: "system", id: "old" });
  assert.match(missingSystem, /old, not available/);
  assert.match(missingSystem, /absent from the catalog\. Install it in System Settings/);
  const html = render(voice, { engine: "neural", id: "supertonic-3/F4" });
  assert.match(html, /Automatic: Other/);
  assert.match(html, /F4, not available/);
  assert.match(html, /Download the Mission Control voices to enable speech/);
});

test("a verified download never enables a sample on the shipping capture-only listener", () => {
  const voice = voiceStateOff();
  voice.speech.model.status = "ready";
  const reason = "Playback is disabled in this listener.";
  voice.speech.reason = reason;
  voice.capabilities["speech-output"] = { available: false, reason, code: "speech_playback_unsupported" };
  for (const choice of [null, { engine: "neural", id: "supertonic-3/F4" } as const]) {
    const html = render(voice, choice);
    assert.match(html, /<button[^>]*disabled=""[^>]*>Play sample<\/button>/);
    assert.match(html, /Playback is disabled in this listener\. Questions appear on screen/);
    assert.doesNotMatch(html, /will speak\.|This Mac&#x27;s voices/);
  }
});
