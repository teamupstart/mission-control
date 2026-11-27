import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Audio for the first-preview hold specs. The synthesized playlist is labeled: for each window, what
 * was in it. Its speech is macOS `say` synthesis of invented text and its noise is synthesized: a room
 * floor under everything, key clicks, desk knocks and breaths. The operator's recording is not labeled.
 */
export interface PreviewWindow {
  id: string;
  kind: "non-speech" | "one-word" | "call-sign" | "cancel";
  /** Window bounds in ms from the first sample. A window ends where the next one starts. */
  startMs: number;
  endMs: number;
  /** When the speech in it starts, in ms from the first sample. Null for non-speech. */
  onsetMs: number | null;
  /** What was said, for the first useful preview: its first word must match. */
  expected: string | null;
  /** False when the window ends before its phrase's final can show: the next window follows within the end-of-speech delay. */
  finalInWindow: boolean;
}

export interface PreviewPlaylist { wav: string; windows: PreviewWindow[] }

const RATE = 16_000;

function readWav(path: string): Float32Array {
  const bytes = readFileSync(path);
  let offset = 12;
  let format: { code: number; channels: number; rate: number; bits: number } | undefined;
  while (offset < bytes.length - 8) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === "fmt ") format = { code: bytes.readUInt16LE(offset + 8), channels: bytes.readUInt16LE(offset + 10),
      rate: bytes.readUInt32LE(offset + 12), bits: bytes.readUInt16LE(offset + 22) };
    if (id === "data" && format) {
      if (format.rate !== RATE || format.channels !== 1) throw new Error(`${path} is not 16 kHz mono`);
      const count = size / (format.bits / 8);
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        const at = offset + 8 + i * (format.bits / 8);
        samples[i] = format.bits === 32 ? bytes.readFloatLE(at) : bytes.readInt16LE(at) / 32_768;
      }
      return samples;
    }
    offset += 8 + size + (size & 1);
  }
  throw new Error(`${path} has no PCM data`);
}

function writeWav(path: string, samples: Float32Array) {
  const bytes = Buffer.alloc(44 + samples.length * 4);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(36 + samples.length * 4, 4); bytes.write("WAVE", 8);
  bytes.write("fmt ", 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(3, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(RATE, 24); bytes.writeUInt32LE(RATE * 4, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(32, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(samples.length * 4, 40);
  samples.forEach((sample, i) => bytes.writeFloatLE(sample, 44 + i * 4));
  writeFileSync(path, bytes);
}

// A fixed seed: every run plays exactly the same samples, so the flag-off and flag-on runs differ only in the flag.
let seed = 7;
const random = () => (seed = (seed * 1_103_515_245 + 12_345) >>> 0) / 2 ** 32;
const gauss = () => { let sum = 0; for (let i = 0; i < 6; i++) sum += random(); return (sum - 3) / 1.2; };
const silence = (seconds: number) => new Float32Array(Math.round(RATE * seconds));
const gain = (samples: Float32Array, db: number) => samples.map(v => v * 10 ** (db / 20));

function lowpass(samples: Float32Array, hz: number) {
  const a = Math.exp(-2 * Math.PI * hz / RATE);
  let y = 0, z = 0;
  return samples.map(v => (y = (1 - a) * v + a * y, z = (1 - a) * y + a * z));
}

function keyClick(amp: number) {
  const out = new Float32Array(Math.round(RATE * 0.025));
  for (let i = 0; i < out.length; i++) {
    out[i] = gauss() * amp * Math.exp(-i / (RATE * 0.004)) + Math.sin(2 * Math.PI * 2200 * i / RATE) * amp * 0.3 * Math.exp(-i / (RATE * 0.002));
  }
  return out;
}

function typing(seconds: number, perSecond: number, amp: number) {
  const out = silence(seconds);
  for (let t = 0.1; t < seconds - 0.1; t += (1 / perSecond) * (0.5 + random()) + (random() < 0.08 ? 0.4 : 0)) {
    const click = keyClick(amp * (0.6 + 0.8 * random()));
    const at = Math.round(t * RATE);
    out.set(click.subarray(0, Math.min(click.length, out.length - at)), at);
  }
  return out;
}

function knock(amp: number) {
  const out = new Float32Array(Math.round(RATE * 0.12));
  for (let i = 0; i < out.length; i++) out[i] = (Math.sin(2 * Math.PI * 180 * i / RATE) * 0.7 + gauss() * 0.3) * amp * Math.exp(-i / (RATE * 0.02));
  return out;
}

function breath(seconds: number, amp: number) {
  const noise = lowpass(Float32Array.from({ length: Math.round(RATE * seconds) }, gauss), 1500);
  return noise.map((v, i) => v * amp * Math.sin(Math.PI * i / noise.length) ** 2);
}

function concat(...parts: Float32Array[]) {
  const out = new Float32Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

function speech(directory: string, voice: string, text: string) {
  const path = join(directory, `say-${voice}-${text.replace(/\W+/gu, "-")}.wav`);
  execFileSync("/usr/bin/say", ["-v", voice, "-o", path, "--file-format=WAVE", "--data-format=LEF32@16000", text]);
  let samples = readWav(path);
  let start = 0, end = samples.length;
  while (start < end && Math.abs(samples[start]!) < 0.003) start++;
  while (end > start && Math.abs(samples[end - 1]!) < 0.003) end--;
  samples = samples.slice(start, end);
  const peak = samples.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
  return samples.map(v => v / peak * 0.5);
}

/** Long enough after each fixture for its phrase to close, its final to show and the overlay to expire. */
const GAP_S = 7.5;

/** The synthesized playlist: non-speech, one-word replies, short and normal call signs and spoken Cancel. */
export function synthesizedPlaylist(directory: string): PreviewPlaylist {
  seed = 7;
  type Fixture = { id: string; kind: PreviewWindow["kind"]; samples: Float32Array; onsetS?: number; expected?: string; after?: Float32Array };
  const fixtures: Fixture[] = [
    { id: "room-only", kind: "non-speech", samples: silence(6) },
    { id: "typing-fast", kind: "non-speech", samples: typing(6, 7, 0.25) },
    { id: "typing-slow", kind: "non-speech", samples: typing(6, 4, 0.4) },
    { id: "knock", kind: "non-speech", samples: knock(0.5) },
    { id: "breath", kind: "non-speech", samples: breath(0.6, 0.12) },
    { id: "knock-breath", kind: "non-speech", samples: concat(knock(0.4), silence(0.3), breath(0.5, 0.1)) },
    { id: "yes", kind: "one-word", samples: speech(directory, "Samantha", "Yes."), expected: "Yes." },
    { id: "no", kind: "one-word", samples: speech(directory, "Daniel", "No."), expected: "No." },
    { id: "okay", kind: "one-word", samples: speech(directory, "Karen", "Okay."), expected: "Okay." },
    { id: "stop", kind: "one-word", samples: speech(directory, "Moira", "Stop."), expected: "Stop." },
    { id: "typing-then-yes", kind: "one-word", samples: concat(typing(2.5, 6, 0.25), silence(0.4), speech(directory, "Daniel", "Yes.")),
      onsetS: 2.9, expected: "Yes." },
    { id: "call-max", kind: "call-sign", samples: speech(directory, "Samantha", "Max, stop."), expected: "Max, stop." },
    { id: "call-steve", kind: "call-sign", samples: speech(directory, "Daniel", "Steve, check the build."), expected: "Steve, check the build." },
    { id: "call-after-knock", kind: "call-sign", samples: concat(knock(0.4), silence(0.25), speech(directory, "Karen", "Steve, stop.")),
      onsetS: 0.37, expected: "Steve, stop." },
    { id: "call-quiet", kind: "call-sign", samples: gain(speech(directory, "Moira", "Max, run the tests."), -16), expected: "Max, run the tests." },
    // Spoken Cancel while the confirmation it cancels is still pending.
    { id: "call-carol", kind: "call-sign", samples: speech(directory, "Samantha", "Carol, run the tests."), expected: "Carol, run the tests.",
      after: silence(2.8) },
    { id: "cancel", kind: "cancel", samples: speech(directory, "Daniel", "Cancel."), expected: "Cancel." },
  ];
  const parts: Float32Array[] = [silence(1)];
  const windows: PreviewWindow[] = [];
  let at = 1;
  for (const fixture of fixtures) {
    const tail = fixture.after ?? silence(GAP_S);
    const startMs = Math.round(at * 1000);
    const duration = fixture.samples.length / RATE + tail.length / RATE;
    windows.push({ id: fixture.id, kind: fixture.kind, startMs, endMs: Math.round((at + duration) * 1000),
      onsetMs: fixture.kind === "non-speech" ? null : startMs + Math.round((fixture.onsetS ?? 0) * 1000), expected: fixture.expected ?? null,
      finalInWindow: !fixture.after });
    parts.push(fixture.samples, tail);
    at += duration;
  }
  // A room floor under everything, about -44 dBFS, so the classifier hears a real room rather than digital silence.
  const playlist = concat(...parts);
  const floor = lowpass(Float32Array.from({ length: playlist.length }, gauss), 900).map(v => v * 0.02);
  const mixed = playlist.map((v, i) => v + floor[i]!);
  const wav = join(directory, "preview-hold-synthesized.wav");
  writeWav(wav, mixed);
  return { wav, windows };
}

/**
 * The operator's own recording, copied as the 16 kHz mono float WAV the listener harness reads. It has no
 * timed labels, so it is scored by nothing here: its runs are compared on their finals alone.
 */
export function humanRecording(directory: string, wav: string): string {
  const copy = join(directory, "preview-hold-human.wav");
  writeWav(copy, readWav(wav));
  return copy;
}
