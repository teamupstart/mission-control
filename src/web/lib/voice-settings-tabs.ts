/**
 * Settings > Voice is one category with five tabs, one per job. The status line sits above
 * them, so `voice/mode` belongs to no tab. Every other `voice/*` anchor lives on exactly one
 * tab, and a deep link has to show that tab before the settings page can find the control.
 */
export const VOICE_SETTINGS_TABS = [
  {
    id: "listening",
    label: "Listening",
    hint: "When the microphone listens, which one, and where a spoken message ends",
    anchors: [
      "voice/listening-mode",
      "voice/input-device",
      "voice/hotkey",
      "voice/auto-mute",
      "voice/end-of-speech",
      "voice/separator",
      "voice/cancel-window",
    ],
  },
  {
    id: "routing",
    label: "Names & routing",
    hint: "Who can be addressed by name, and what happens when a sentence is unclear",
    anchors: [
      "voice/roster",
      "voice/when-unsure",
      "voice/faster-routing",
      "voice/decision-provider",
      "voice/key-openai",
      "voice/key-jev",
    ],
  },
  {
    id: "replies",
    label: "Spoken replies",
    hint: "The voice that speaks questions aloud, and answering forms by voice",
    anchors: ["voice/spoken-replies", "voice/plan-forms"],
  },
  {
    id: "screen",
    label: "On screen",
    hint: "The live transcript, the confirmation card, and the indicators in the window",
    anchors: ["voice/transcript", "voice/confirmation", "voice/indicators"],
  },
  {
    id: "heard",
    label: "Recently heard",
    hint: "What voice heard recently, who it matched, and what happened",
    anchors: ["voice/heard"],
  },
] as const;

export type VoiceSettingsTabId = (typeof VOICE_SETTINGS_TABS)[number]["id"];

/** The tab a deep link must show before its control can be found, or null when no tab holds it. */
export function voiceTabForAnchor(anchor: string): VoiceSettingsTabId | null {
  return VOICE_SETTINGS_TABS.find((tab) => (tab.anchors as readonly string[]).includes(anchor))?.id ?? null;
}
