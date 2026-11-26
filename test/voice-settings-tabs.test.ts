import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ALL_SETTINGS_CONTROLS } from "../src/shared/settings-controls.ts";
import { VOICE_SETTINGS_TABS, voiceTabForAnchor } from "../src/web/lib/voice-settings-tabs.ts";
import { VoiceSettingsPanel } from "../src/web/components/VoiceSettingsPanel.tsx";
import type { VoiceConfigState } from "../src/web/useVoiceConfig.ts";

/** The status line sits above the tabs, so it is the one Voice anchor no tab holds. */
const ABOVE_TABS = new Set(["voice/mode"]);

const VOICE_SOURCES = [
  "src/web/components/VoiceSettingsPanel.tsx",
  "src/web/components/SpokenReplies.tsx",
  "src/web/components/VoiceCardPlacement.tsx",
  "src/web/components/VoiceIndicators.tsx",
  "src/web/components/RecentlyHeard.tsx",
];

test("every searchable Voice setting lives on exactly one tab", () => {
  const anchors = ALL_SETTINGS_CONTROLS.filter((control) => control.category === "voice").map((control) => control.anchor);
  assert.ok(anchors.length > 10, "the registry lists the Voice controls");
  for (const anchor of anchors) {
    if (ABOVE_TABS.has(anchor)) continue;
    assert.ok(voiceTabForAnchor(anchor), `${anchor} has no Voice tab, so a search result for it would land on a hidden control`);
  }
  const all = VOICE_SETTINGS_TABS.flatMap((tab) => [...tab.anchors]);
  assert.equal(new Set(all).size, all.length, "no anchor is claimed by two tabs");
});

test("every anchor the Voice panel renders resolves to a tab", () => {
  const rendered = VOICE_SOURCES.flatMap((path) =>
    Array.from(readFileSync(path, "utf8").matchAll(/data-anchor[=:]\s*\{?[`"](voice\/[a-z-]+)(\$\{[^}]+\})?[`"]/g), (match) =>
      match[2] ? null : match[1]!)).filter((anchor): anchor is string => anchor !== null);
  assert.ok(rendered.length > 10, "the scan found the panel's anchors");
  for (const anchor of rendered) {
    if (ABOVE_TABS.has(anchor)) continue;
    assert.ok(voiceTabForAnchor(anchor), `${anchor} is rendered but no tab claims it`);
  }
  assert.equal(voiceTabForAnchor("voice/key-openai"), "routing");
  assert.equal(voiceTabForAnchor("voice/key-jev"), "routing");
});

test("anchors outside the Voice tabs resolve to no tab", () => {
  assert.equal(voiceTabForAnchor("voice/mode"), null);
  assert.equal(voiceTabForAnchor("storage/backups"), null);
  assert.equal(voiceTabForAnchor("voice/nonexistent"), null);
});

const state = {
  config: null,
  error: null,
  update: async () => true,
  confirmedDecisionProvider: undefined,
  pendingDecisionProvider: undefined,
  keyReportVersion: "",
  observeProvider: () => true,
  clock: { observe: () => {} },
} as unknown as VoiceConfigState;

function render(jumpAnchor: string | null, jumpRequestId: number | null): string {
  return renderToStaticMarkup(createElement(VoiceSettingsPanel, {
    state, voice: null, onNavigate: () => {}, jumpAnchor, jumpRequestId,
  }));
}

test("the panel opens on Listening, with the status line above the tabs", () => {
  const html = render(null, null);
  assert.match(html, /aria-label="Voice mode"[\s\S]*role="tablist" aria-label="Voice settings"/);
  assert.match(html, /id="voice-tab-listening"[^>]*aria-selected="true"/);
  for (const label of ["Listening mode", "Input device", "Mute hotkey", "Auto-mute on calls", "End-of-speech delay", "Cancel window"]) {
    assert.ok(html.includes(label), `Listening shows ${label}`);
  }
  assert.ok(!html.includes("Plan forms by voice"), "other tabs are not rendered");
  assert.deepEqual(
    Array.from(html.matchAll(/role="tab"[^>]*>([^<]+)</g), (match) => match[1]),
    ["Listening", "Names &amp; routing", "Spoken replies", "On screen", "Recently heard"],
  );
});

test("a deep link shows its tab in the same render", () => {
  const cases: [string, string, string][] = [
    ["voice/plan-forms", "replies", "Plan forms by voice"],
    ["voice/when-unsure", "routing", "When routing is unsure"],
    ["voice/indicators", "screen", "In the window"],
    ["voice/heard", "heard", "Recently heard utterances"],
  ];
  for (const [anchor, tab, text] of cases) {
    const html = render(anchor, 7);
    assert.match(html, new RegExp(`id="voice-tab-${tab}"[^>]*aria-selected="true"`), anchor);
    assert.ok(html.includes(text), `${anchor} renders ${text}`);
  }
  assert.match(render("voice/mode", 8), /id="voice-tab-listening"[^>]*aria-selected="true"/, "the status line keeps the current tab");
});

test("a jump to each Voice anchor selects the tab whose panel renders that control", () => {
  // The registry and the panel can drift apart: a control moved to another tab without updating
  // the registry would still be rendered somewhere and still resolve to a tab, yet a search
  // result would open the wrong tab and find nothing. Render every anchor through its own jump.
  const registered = ALL_SETTINGS_CONTROLS.filter((control) => control.category === "voice").map((control) => control.anchor);
  const anchors = new Set([...registered, ...VOICE_SETTINGS_TABS.flatMap((tab) => [...tab.anchors])]);
  let checked = 0;
  for (const anchor of anchors) {
    if (ABOVE_TABS.has(anchor)) continue;
    const tab = voiceTabForAnchor(anchor)!;
    const html = render(anchor, 11);
    assert.match(html, new RegExp(`id="voice-tab-${tab}"[^>]*aria-selected="true"`), `${anchor} selects ${tab}`);
    const panel = html.slice(html.indexOf('role="tabpanel"'));
    assert.ok(panel.includes(`id="voice-tabpanel-${tab}"`), `${anchor}: the open panel is ${tab}`);
    assert.ok(panel.includes(`data-anchor="${anchor}"`), `${anchor} is not rendered on the ${tab} tab its jump opens`);
    checked++;
  }
  assert.ok(checked >= 18, `checked ${checked} anchors`);
});
