import assert from "node:assert/strict";
import test from "node:test";
import { getVoiceConfig, setVoiceConfig } from "../src/server/voice/config.ts";
import { resolveVoiceBackend } from "../src/shared/voice-models.ts";

test("auto uses FluidAudio on macOS 14+ Apple silicon, with explicit overrides on every platform", () => {
  for (const [platform, arch, kernel, expected] of [
    ["darwin", "arm64", "23.0.0", "fluidaudio"], ["darwin", "arm64", "25.1.0", "fluidaudio"],
    ["darwin", "arm64", "22.6", "sherpa-onnx"], ["darwin", "x64", "23.0", "sherpa-onnx"],
    ["linux", "x64", "6.8.0", "sherpa-onnx"], ["linux", "arm64", "6.8.0", "sherpa-onnx"],
  ] as const) {
    assert.equal(resolveVoiceBackend("auto", platform, arch, kernel), expected);
    for (const backend of ["fluidaudio", "sherpa-onnx"] as const) {
      assert.equal(resolveVoiceBackend(backend, platform, arch, kernel), backend);
    }
  }
});

test("the daemon environment overrides the stored backend without persisting it on unrelated config writes", t => {
  const previous = process.env.MISSION_VOICE_BACKEND;
  t.after(() => {
    if (previous === undefined) delete process.env.MISSION_VOICE_BACKEND;
    else process.env.MISSION_VOICE_BACKEND = previous;
  });
  process.env.MISSION_VOICE_BACKEND = "sherpa-onnx";
  assert.equal(setVoiceConfig({ backend: "fluidaudio" }).backend, "sherpa-onnx");
  assert.equal(setVoiceConfig({ muted: true }).backend, "sherpa-onnx");
  delete process.env.MISSION_VOICE_BACKEND;
  assert.equal(getVoiceConfig().backend, "fluidaudio");
});
