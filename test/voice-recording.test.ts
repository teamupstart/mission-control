import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readRecording } from "../src/voice-listener/recording.ts";

test("the bounded WAV reader preserves PCM amplitudes and skips padded metadata", t => {
  const dir = mkdtempSync(join(tmpdir(), "voice-pcm-"));
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
    const wav = Buffer.concat([header, junk, data, Buffer.from(pcm)]);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.writeUInt16LE(format, 20);
    wav.writeUInt32LE(width * 16000, 28);
    wav.writeUInt16LE(width, 32);
    wav.writeUInt16LE(width * 8, 34);
    writeFileSync(path, wav);
    assert.deepEqual([...readRecording(path)], [-0.5, 0.5]);
  }
});
