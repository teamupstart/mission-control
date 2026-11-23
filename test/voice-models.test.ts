// The speech model manifest (contract H): its shape, that every URL is pinned to a commit, and
// that its sizes and digests are exactly the ones the spike measured.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parsePinnedModelUrl,
  resolveVoiceBackend,
  VOICE_MODEL_ORIGIN,
  VOICE_MODELS,
  voiceModelBytes,
  voiceModelFileUrl,
  VoiceModelManifestSchema,
  VoiceModelManifestsSchema,
  type VoiceModelManifest,
} from "../src/shared/voice-models.ts";
import { VOICE_BACKENDS } from "../src/shared/voice.ts";

interface SpikeEntry {
  backend: string;
  repository: string;
  revision: string;
  file: string;
  bytes: number;
  sha256: string;
}

const spike = JSON.parse(readFileSync(new URL("../scripts/voice-spike/models.json", import.meta.url), "utf8")) as SpikeEntry[];
const fluidaudio = VOICE_MODELS.fluidaudio!;

test("the manifest is keyed by every backend, and fluidaudio's entry parses under the schema", () => {
  assert.deepEqual(Object.keys(VOICE_MODELS).sort(), [...VOICE_BACKENDS].sort());
  assert.ok(fluidaudio, "Phase 8 fills the fluidaudio entry");
  assert.equal(VOICE_MODELS["sherpa-onnx"], null, "Phase 16 fills sherpa-onnx");
  assert.deepEqual(VoiceModelManifestSchema.parse(fluidaudio), fluidaudio);
  assert.match(fluidaudio.revision, /^[a-z0-9][a-z0-9.-]*$/);
  assert.ok(fluidaudio.sources.every((source) => source.license === "CC-BY-4.0"));
});

test("every file is the spike's: the Parakeet TDT v2 Core ML model and the CTC model FluidAudio primes with", () => {
  const expected = spike.filter((entry) => entry.backend === "fluid" || entry.backend === "ctc");
  assert.equal(fluidaudio.files.length, expected.length);
  for (const entry of expected) {
    const url = `${VOICE_MODEL_ORIGIN}/${entry.repository}/resolve/${entry.revision}/${entry.file}`;
    const file = fluidaudio.files.find((candidate) => candidate.url === url);
    assert.ok(file, `${url} is in the manifest`);
    assert.equal(file.bytes, entry.bytes, entry.file);
    assert.equal(file.sha256, entry.sha256, entry.file);
    assert.equal(file.path, `${entry.repository.split("/")[1]}/${entry.file}`);
  }
  assert.equal(voiceModelBytes(fluidaudio), expected.reduce((sum, entry) => sum + entry.bytes, 0));
  assert.equal(voiceModelBytes(fluidaudio), 568_273_745);
});

test("every URL is pinned to a 40-character commit of a declared source", () => {
  for (const file of fluidaudio.files) {
    const pinned = parsePinnedModelUrl(file.url);
    assert.ok(pinned, `${file.url} is pinned`);
    const source = fluidaudio.sources.find((candidate) => candidate.repository === pinned.repository);
    assert.equal(source?.commit, pinned.commit, file.url);
  }
});

function withFile(manifest: VoiceModelManifest, change: Partial<VoiceModelManifest["files"][number]>): unknown {
  return { ...manifest, files: [{ ...manifest.files[0]!, ...change }, ...manifest.files.slice(1)] };
}

test("a URL that is not pinned to a commit is refused", () => {
  const first = fluidaudio.files[0]!;
  for (const url of [
    first.url.replace(/resolve\/[0-9a-f]{40}\//, "resolve/main/"),
    first.url.replace(/resolve\/[0-9a-f]{40}\//, "resolve/v1.0/"),
    first.url.replace(/resolve\/([0-9a-f]{40})\//, (_all, commit: string) => `resolve/${commit.slice(0, 12)}/`),
    first.url.replace("https://huggingface.co", "http://huggingface.co"),
    first.url.replace("https://huggingface.co", "https://example.com"),
    first.url.replace("/resolve/", "/blob/"),
    first.url.replace("Decoder.mlmodelc", "../Decoder.mlmodelc"),
  ]) {
    assert.equal(parsePinnedModelUrl(url), null, url);
    assert.equal(VoiceModelManifestSchema.safeParse(withFile(fluidaudio, { url })).success, false, url);
  }
});

test("a file pinned to a commit other than its source's, or kept anywhere but its own path, is refused", () => {
  const first = fluidaudio.files[0]!;
  const otherCommit = first.url.replace(/resolve\/[0-9a-f]{40}\//, `resolve/${"a".repeat(40)}/`);
  assert.equal(VoiceModelManifestSchema.safeParse(withFile(fluidaudio, { url: otherCommit })).success, false);
  for (const path of ["../escape.bin", "/abs/path.bin", "parakeet-tdt-0.6b-v2-coreml/./x", "other/Decoder.mlmodelc/analytics/coremldata.bin", ""]) {
    assert.equal(VoiceModelManifestSchema.safeParse(withFile(fluidaudio, { path })).success, false, path);
  }
  assert.equal(VoiceModelManifestSchema.safeParse(withFile(fluidaudio, { sha256: "ABC" })).success, false);
  assert.equal(VoiceModelManifestSchema.safeParse(withFile(fluidaudio, { bytes: 0 })).success, false);
  const twice = { ...fluidaudio, files: [fluidaudio.files[0], fluidaudio.files[0]] };
  assert.equal(VoiceModelManifestSchema.safeParse(twice).success, false, "a file listed twice");
  assert.equal(VoiceModelManifestSchema.safeParse({ ...fluidaudio, revision: "../up" }).success, false);
});

test("an override file names backends by id and is held to the same schema", () => {
  assert.deepEqual(VoiceModelManifestsSchema.parse({ fluidaudio }), { fluidaudio });
  assert.equal(VoiceModelManifestsSchema.safeParse({ whisper: fluidaudio }).success, false, "an unknown backend");
});

test("a base URL replaces the origin and keeps the pinned path", () => {
  const file = fluidaudio.files[0]!;
  assert.equal(voiceModelFileUrl(file, null), file.url);
  const path = file.url.slice(VOICE_MODEL_ORIGIN.length);
  assert.equal(voiceModelFileUrl(file, "http://127.0.0.1:9000"), `http://127.0.0.1:9000${path}`);
  assert.equal(voiceModelFileUrl(file, "http://127.0.0.1:9000/mirror/"), `http://127.0.0.1:9000/mirror${path}`);
});

test("auto picks FluidAudio on Apple silicon and sherpa-onnx elsewhere; an explicit choice stands", () => {
  assert.equal(resolveVoiceBackend("auto", "darwin", "arm64"), "fluidaudio");
  assert.equal(resolveVoiceBackend("auto", "darwin", "x64"), "sherpa-onnx");
  assert.equal(resolveVoiceBackend("auto", "linux", "x64"), "sherpa-onnx");
  assert.equal(resolveVoiceBackend("fluidaudio", "linux", "x64"), "fluidaudio");
  assert.equal(resolveVoiceBackend("sherpa-onnx", "darwin", "arm64"), "sherpa-onnx");
});
