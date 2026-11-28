import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { readRecording } from "../src/voice-listener/recording.ts";
import { tempDir } from "./temp-root.mjs";

test("the bounded WAV reader preserves PCM amplitudes and skips padded metadata", t => {
  const dir = tempDir("voice-pcm-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "recording.wav");
  const header = readFileSync(new URL("./fixtures/voice/steve-check-the-build.wav", import.meta.url)).subarray(0, 36);
  const junk = Buffer.from([74, 85, 78, 75, 1, 0, 0, 0, 97, 0]); // One metadata byte plus RIFF padding.
  for (const [format, width, pcm] of [
    [1, 1, [64, 192]],
    [1, 2, [0, 192, 0, 64]],
    [1, 4, [0, 0, 0, 192, 0, 0, 0, 64]],
    [3, 4, [0, 0, 0, 191, 0, 0, 0, 63]],
  ] as const) {
    const data = Buffer.from("data\0\0\0\0", "latin1");
    data.writeUInt32LE(pcm.length, 4);
    const wav = Buffer.concat([header, junk, data, Buffer.from(pcm), junk]);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.writeUInt16LE(format, 20);
    wav.writeUInt32LE(width * 16000, 28);
    wav.writeUInt16LE(width, 32);
    wav.writeUInt16LE(width * 8, 34);
    writeFileSync(path, wav);
    assert.deepEqual([...readRecording(path)], [-0.5, 0.5]);
  }
});

test("the WAV reader checks chunk headers, payloads and padding after the audio", t => {
  const dir = tempDir("voice-trailing-chunk-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "recording.wav");
  const audio = readFileSync(new URL("./fixtures/voice/steve-check-the-build.wav", import.meta.url));
  const metadata = Buffer.from([74, 85, 78, 75, 1, 0, 0, 0, 97, 0]);
  for (const length of [4, 8, 9]) {
    const wav = Buffer.concat([audio, metadata.subarray(0, length)]);
    wav.writeUInt32LE(wav.length - 8, 4);
    writeFileSync(path, wav);
    assert.throws(() => readRecording(path), /Truncated WAV chunk/);
  }
});

test("extensible PCM and float WAVs decode through their validated subformat", t => {
  const dir = tempDir("voice-extensible-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "extensible.wav");
  const fixture = readFileSync(new URL("./fixtures/voice/steve-check-the-build.wav", import.meta.url));
  const wav = Buffer.concat([fixture.subarray(0, 36), Buffer.alloc(24), fixture.subarray(36, 48)]);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.writeUInt32LE(40, 16);
  wav.writeUInt16LE(0xfffe, 20);
  wav.writeUInt32LE(16000 * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(32, 34);
  wav.writeUInt16LE(22, 36); // cbSize
  wav.writeUInt32LE(4, 40); // mono front-center channel
  wav.write("00001000800000aa00389b71", 48, "hex");
  wav.writeUInt32LE(4, 64);
  for (const [tag, precision] of [[1, 24], [1, 32], [3, 32]] as const) {
    wav.writeUInt16LE(precision, 38);
    wav.writeUInt32LE(tag, 44);
    if (tag === 1) wav.writeInt32LE(-0x40000000, 68);
    else wav.writeFloatLE(-0.5, 68);
    writeFileSync(path, wav);
    assert.deepEqual([...readRecording(path)], [-0.5]);
  }
  for (const [offset, value] of [[36, 21], [36, 23], [38, 0], [38, 33], [40, 3], [44, 6], [59, 0]] as const) {
    const invalid = Buffer.from(wav);
    invalid.writeUInt8(value, offset);
    writeFileSync(path, invalid);
    assert.throws(() => readRecording(path), /Invalid WAV format extension|Unsupported WAV/);
  }
});
