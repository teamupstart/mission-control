import { join } from "node:path";
import type { PrefixAudioCase, PrefixCase, PrefixNoise } from "../../test/fixtures/voice-prefix-corpus.ts";
import {
  RATE, breath, concat, gauss, keyClick, knock, lowpass, random, readWav, reseed, silence, speech, typing, writeWav,
} from "./voice-preview-fixtures.ts";

/**
 * Audio for the prefix recovery spec. Each labeled case becomes one window of a 16 kHz playlist that the
 * production listener hears at microphone pace. Speech is macOS `say` synthesis or, when the operator's
 * consented recording is supplied, a clip of their own voice. Noise is synthesized, or cut from that
 * recording's typing and desk tap. Nothing here writes outside the daemon's temporary home.
 */
export interface PrefixWindow {
  case: PrefixCase;
  /** Window bounds in ms from the first sample. A window ends where the next one starts. */
  startMs: number;
  endMs: number;
  /** When the speech starts, after any noise. */
  onsetMs: number;
}

export interface PrefixPlaylist { wav: string; windows: PrefixWindow[]; skipped: string[] }

/**
 * The operator's 90-second recording made for the first-preview hold (docs/voice.md): its sample count,
 * and where each phrase lies in it, measured from its energy. The cue sheet runs about 1.3 s ahead.
 */
const HUMAN_SAMPLES = 1_438_327;
const HUMAN_CLIPS: Record<NonNullable<PrefixAudioCase["human"]> | "tap" | "typing", [number, number]> = {
  "max-stop": [39.6, 40.9], "steve-build": [44.5, 46.0], "carol-tests": [50.4, 52.0], cancel: [56.3, 57.2],
  "tap-cancel": [62.3, 64.0], "steve-stop-quiet": [68.3, 69.7], tap: [62.3, 62.8], typing: [7.0, 9.6],
};

/** Whether `wav` is that recording: the clip times above are only true of it. */
export function isOperatorRecording(wav: string | undefined): wav is string {
  return !!wav && readWav(wav).length === HUMAN_SAMPLES;
}

function cough(amp: number) {
  const burst = (seconds: number, level: number) => {
    const low = lowpass(Float32Array.from({ length: Math.round(RATE * seconds) }, gauss), 2800);
    const body = lowpass(low, 350);
    return low.map((v, i) => (v - body[i]!) * level * Math.exp(-i / (RATE * seconds / 3)) * Math.min(1, i / (RATE * 0.01)));
  };
  return concat(burst(0.22, amp), silence(0.08), burst(0.16, amp * 0.6));
}

function thump(amp: number) {
  const out = new Float32Array(Math.round(RATE * 0.25));
  for (let i = 0; i < out.length; i++) out[i] = (Math.sin(2 * Math.PI * 70 * i / RATE) * 0.8 + gauss() * 0.2) * amp * Math.exp(-i / (RATE * 0.05));
  return out;
}

function clicks(amp: number) {
  return concat(keyClick(amp), silence(0.11 + random() * 0.04), keyClick(amp * 0.9), silence(0.12), keyClick(amp));
}

const peak = (samples: Float32Array) => samples.reduce((max, v) => Math.max(max, Math.abs(v)), 0);

/** The voices the development set is spoken in: the four the first-preview hold used. The holdout names its own. */
const DEV_VOICES = ["Samantha", "Daniel", "Karen", "Moira"];

/**
 * Build one playlist. `human` is the operator's recording: without it, cases that need it are skipped and
 * listed, and the synthesized noise stands in for its typing and tap. A room floor runs under everything
 * synthesized: about -44 dBFS of filtered noise. The operator's clips keep their own room sound.
 */
export function prefixPlaylist(directory: string, name: string, cases: readonly PrefixAudioCase[], human?: string): PrefixPlaylist {
  reseed(11);
  const recording = isOperatorRecording(human) ? readWav(human) : null;
  const clip = (id: keyof typeof HUMAN_CLIPS) => {
    const [from, to] = HUMAN_CLIPS[id];
    return recording!.slice(Math.round(from * RATE), Math.round(to * RATE));
  };
  const noiseOf = (noise: PrefixNoise, level: number): Float32Array => {
    switch (noise) {
      case "knock": return knock(0.45 * level);
      case "double-knock": return concat(knock(0.4 * level), silence(0.18), knock(0.4 * level));
      case "cough": return cough(0.5 * level);
      case "thump": return thump(0.6 * level);
      case "clicks": return clicks(0.35 * level);
      case "breath": return breath(0.5, 0.12 * level);
      // The operator's own keyboard and desk when the recording is supplied; synthesized otherwise.
      case "typing": return recording ? clip("typing").slice(Math.round(0.2 * RATE), Math.round(1.4 * RATE)) : typing(1.2, 8, 0.3 * level);
      case "tap": return recording ? clip("tap") : knock(0.3 * level);
    }
  };
  const parts: Float32Array[] = [silence(1)];
  const humanMask: [number, number][] = [];
  const windows: PrefixWindow[] = [];
  const skipped: string[] = [];
  let samples = RATE;
  cases.forEach((item, index) => {
    if (item.human && !recording) { skipped.push(item.id); return; }
    const voice = item.voice ?? DEV_VOICES[index % DEV_VOICES.length]!;
    const spoken = item.human ? clip(item.human) : speech(directory, voice, item.text);
    // Noise is scaled to the speech it precedes: a knock as loud as a quiet webcam voice is still a knock.
    const level = peak(spoken) / 0.5;
    const noise = item.noise ? concat(noiseOf(item.noise, level), silence((item.gapMs ?? 150) / 1000)) : new Float32Array(0);
    const tail = silence(item.afterS ?? 4.5);
    const startMs = Math.round(samples / RATE * 1000);
    if (item.human) humanMask.push([samples + noise.length, samples + noise.length + spoken.length]);
    parts.push(noise, spoken, tail);
    samples += noise.length + spoken.length + tail.length;
    windows.push({ case: item, startMs, onsetMs: startMs + Math.round(noise.length / RATE * 1000), endMs: Math.round(samples / RATE * 1000) });
  });
  parts.push(silence(3));
  const playlist = concat(...parts);
  // The recording's own room tone, looped, held phrases open across the gaps between cases and merged them
  // into minute-long captures; the -44 dBFS floor the first-preview hold uses lets each phrase close.
  const room = lowpass(Float32Array.from({ length: RATE * 20 }, gauss), 900).map(v => v * 0.02);
  let mask = 0;
  const mixed = playlist.map((v, i) => {
    while (humanMask[mask] && humanMask[mask]![1] <= i) mask++;
    const inside = humanMask[mask] && humanMask[mask]![0] <= i;
    return inside ? v : v + room[i % room.length]!;
  });
  const wav = join(directory, `prefix-${name}.wav`);
  writeWav(wav, mixed);
  return { wav, windows, skipped };
}

