import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

const MAX_WAV_BYTES = 32 * 1024 * 1024;

/** Read a bounded snapshot from one regular file. Never size an allocation from a WAV header. */
function recordingBytes(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const file = fstatSync(fd);
    if (!file.isFile()) throw new Error("Expected a regular WAV file");
    if (file.size > MAX_WAV_BYTES) throw new Error("Recording exceeds the 32 MiB WAV limit");
    const bytes = Buffer.allocUnsafe(file.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error("Truncated WAV recording");
      offset += count;
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export function readRecording(path: string): Float32Array {
  const wav = recordingBytes(path);
  if (wav.length < 12 || wav.toString("latin1", 0, 4) !== "RIFF" || wav.toString("latin1", 8, 12) !== "WAVE") {
    throw new Error("Expected a RIFF/WAVE recording");
  }
  const end = 8 + wav.readUInt32LE(4);
  if (end > wav.length) throw new Error("Truncated WAV recording");
  let width = 0;
  let floating = false;
  for (let offset = 12; offset + 8 <= end;) {
    const chunk = wav.toString("latin1", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (size > end - start) throw new Error("Truncated WAV chunk");
    if (chunk === "fmt ") {
      if (size < 16 || width) throw new Error("Invalid WAV format chunk");
      if (wav.readUInt16LE(start + 2) !== 1 || wav.readUInt32LE(start + 4) !== 16000) throw new Error("Expected a 16 kHz mono WAV");
      const format = wav.readUInt16LE(start);
      const bits = wav.readUInt16LE(start + 14);
      floating = format === 3 && bits === 32;
      if (!floating && !(format === 1 && [8, 16, 32].includes(bits))) throw new Error("Unsupported WAV sample encoding");
      width = bits / 8;
      if (wav.readUInt16LE(start + 12) !== width || wav.readUInt32LE(start + 8) !== width * 16000) throw new Error("Invalid WAV frame size");
    } else if (chunk === "data") {
      if (!width || size % width) throw new Error("Invalid WAV data chunk");
      const samples = new Float32Array(size / width);
      const scale = 2 ** (width * 8 - 1);
      for (let i = 0; i < samples.length; i++) {
        const at = start + i * width;
        if (floating) samples[i] = wav.readFloatLE(at);
        else if (width === 1) samples[i] = (wav[at]! - 128) / scale;
        else samples[i] = wav.readIntLE(at, width) / scale;
      }
      return samples;
    }
    offset = start + size + (size % 2); // RIFF chunks start on even byte boundaries.
  }
  throw new Error("Missing WAV data chunk");
}
