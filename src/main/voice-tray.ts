import type { VoiceMode } from "../shared/voice.ts";

export type TrayVoiceState = { mode: VoiceMode | "reconnecting"; muted?: boolean; pushToTalkSession?: string };

const modes = {
  listening: ["mic", "listening for names"],
  muted: ["mic-off", "muted"],
  unavailable: ["mic-off", "not listening"],
  reconnecting: ["mic-off", "reconnecting"],
  "waiting-for-key": ["mic-off", "waiting for hotkey"],
  "auto-muted": ["phone", "muted for a call"],
  "push-to-talk": ["ptt", "push-to-talk active"],
} as const;

export function voiceTray(mode: TrayVoiceState["mode"], muted: boolean, pushToTalkSession?: string) {
  if (mode === "off") return null;
  const [glyph, status] = modes[mode];
  return {
    image: `voice-${glyph}Template.png`,
    status: `Voice: ${status}`,
    action: pushToTalkSession ? null : muted ? "Unmute Voice" : "Mute Voice",
    nextMuted: !muted,
  };
}
