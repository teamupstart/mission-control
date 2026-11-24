import { z } from "zod";
import type { VoiceConfig, VoiceModelState, VoiceState } from "./voice.ts";

export const VOICE_SPEECH_DEFAULT_NEURAL = "supertonic-3/F4";
export const VOICE_SPEECH_START_LIMIT_MS = 2000;
export const VOICE_SPEECH_END_MARGIN_MS = 1500;
export const VOICE_SPEECH_SYSTEM_LIMIT_MS = 10000;
export const VOICE_SPEECH_CONFIRM_LIMIT_MS = 5000;
export const VOICE_INSTANCE_HEADER = "x-mission-voice-instance";
export const SpeechInstanceSchema = z.string().min(22).max(256).regex(/^[A-Za-z0-9_+/=-]+$/u);
export const SpeechVoiceSchema = z.object({ engine: z.enum(["neural", "system"]), id: z.string().min(1).max(256) }).strict();
export type VoiceSpeechVoice = z.infer<typeof SpeechVoiceSchema>;
export const SpeechHelloSchema = z.object({
  audio: z.boolean(),
  systemVoices: z.array(z.object({ id: z.string().min(1).max(256), name: z.string().min(1).max(256),
    language: z.string().max(64), quality: z.enum(["premium", "enhanced", "default"]) })).max(256),
});
type Entry = { id: string; name: string; detail: string };
export interface VoiceSpeechCatalog { neural: Entry[]; system: Entry[] }
export interface VoiceSpeechJob {
  id: string; purpose: "ask" | "audition"; text: string; voice: VoiceSpeechVoice | null; cardId: string | null;
  state: "preparing" | "ready" | "speaking" | "stopping" | "finished" | "stopped" | "failed" | "timed-out";
  durationMs: number | null; holder: string | null;
}
export interface VoiceSpeechState {
  voice: VoiceSpeechVoice | null; reason: string | null; catalog: VoiceSpeechCatalog; model: VoiceModelState;
  job: Pick<VoiceSpeechJob, "id" | "purpose" | "state" | "cardId"> | null;
  lastAudition: { id: string; state: "finished" | "stopped" | "failed" | "timed-out" } | null;
}
export type SpeakDirective = { id: string; stop: true } | { id: string; kind: "audio"; durationMs: number } |
  { id: string; kind: "system"; voiceId: string; text: string };

export function resolveSpeechVoice(config: VoiceConfig, catalog: VoiceSpeechCatalog,
  defaults = { neural: VOICE_SPEECH_DEFAULT_NEURAL }): Pick<VoiceSpeechState, "voice" | "reason"> {
  const selected = config.speech.voice;
  if (selected) return catalog[selected.engine].some(v => v.id === selected.id)
    ? { voice: selected, reason: null } : { voice: null, reason: "The selected voice is unavailable." };
  if (catalog.neural.some(v => v.id === defaults.neural)) return { voice: { engine: "neural", id: defaults.neural }, reason: null };
  for (const quality of ["premium", "enhanced", "default"]) {
    const system = catalog.system.find(v => v.detail === quality);
    if (system) return { voice: { engine: "system", id: system.id }, reason: null };
  }
  return { voice: null, reason: "No voice is ready." };
}

export function askSentence(names: readonly string[]): string | null {
  if (names.length === 2) return `${names[0]} or ${names[1]}?`;
  if (names.length === 3) return `${names[0]}, ${names[1]} or ${names[2]}?`;
  return null;
}

export function askAloudPossible(config: VoiceConfig, state: VoiceState): boolean {
  return config.whenUnsure === "ask" && state.mode === "listening" && state.capabilities["speech-output"]?.available === true;
}
