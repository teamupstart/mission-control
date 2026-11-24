import type { VoiceMode } from "../shared/voice.ts";

const modes = {
  listening: ["mic", "listening for names"],
  muted: ["mic-off", "muted"],
  unavailable: ["mic-off", "not listening"],
  "auto-muted": ["phone", "muted for a call"],
  "push-to-talk": ["ptt", "push-to-talk active"],
} as const;

export function voiceTray(mode: VoiceMode, muted: boolean) {
  if (mode === "off") return null;
  const [glyph, status] = modes[mode];
  return {
    image: `voice-${glyph}Template.png`,
    status: `Voice: ${status}`,
    action: muted ? "Unmute Voice" : "Mute Voice",
    nextMuted: !muted,
  };
}
