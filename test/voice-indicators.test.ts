import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VOICE_INDICATOR_IDS } from "../src/shared/voice.ts";
import { VoiceIndicatorButton } from "../src/web/components/VoiceIndicators.tsx";
import { HeardRow } from "../src/web/components/RecentlyHeard.tsx";

for (const id of VOICE_INDICATOR_IDS) {
  test(id + " renders a glyph, mode and correct action in each state", () => {
    for (const [mode, word, action] of [
      ["listening", "Listening", "Mute"], ["muted", "Muted", "Unmute"],
      ["auto-muted", "On a call", "Mute"], ["push-to-talk", "Talk", "Mute"],
      ["unavailable", "Not listening", "Open Setup"],
    ] as const) {
      for (const chord of [undefined, "ctrl+alt+m"]) {
        const html = renderToStaticMarkup(createElement(VoiceIndicatorButton, { id, mode, chord, onClick() {} }));
        assert.ok(html.includes(`aria-label="Voice: ${word.toLowerCase()}. ${action}"`));
        assert.ok(html.includes("<svg"));
        assert.ok(html.includes(`>${word}<`));
        assert.equal(html.includes("⌃⌥M"), !!chord);
      }
    }
  });
}

test("diagnostics mark the heard spelling of a rejected name and its closest candidate", () => {
  const html = renderToStaticMarkup(createElement(HeardRow, { roster: [], now: 12000, entry: {
    id: "test", time: 0, text: "Stevie, check the build", matchedName: "Steve",
    outcome: "ignored", rule: "near-miss", pauseMs: null, detail: "",
  } }));
  for (const fragment of ['class="is-miss">Stevie</mark>', "Steve</strong>", "near miss rejected", "Not routed", "12s"]) {
    assert.ok(html.includes(fragment));
  }
});

test("a spoken selection names the selected agent without marking the selection as an address", () => {
  const html = renderToStaticMarkup(createElement(HeardRow, { roster: [], now: 0, entry: {
    id: "pick", time: 0, text: "second", matchedName: "Will", outcome: "control", rule: "pick", pauseMs: null, detail: "",
  } }));
  assert.match(html, /<td>second<\/td>/);
  assert.match(html, /<strong>Will<\/strong>/);
  assert.match(html, /spoken selection/);
});
