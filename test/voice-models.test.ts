// The speech model manifest (contract H): its shape, that every URL is pinned to a commit, and
// that its sizes and digests are exactly the ones the spike measured.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parsePinnedModelUrl,
  VOICE_TEST_MODEL,
  VOICE_SPEECH_MODELS,
  VOICE_SPEECH_NEURAL_VOICES,
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
  VoiceModelManifestSchema.parse(VOICE_MODELS["sherpa-onnx"]);
  assert.deepEqual(VoiceModelManifestSchema.parse(fluidaudio), fluidaudio);
  assert.match(fluidaudio.revision, /^[a-z0-9][a-z0-9.-]*$/);
  assert.ok(fluidaudio.sources.every((source) => source.license === "CC-BY-4.0"));
});

test("all ten voices share the pinned Supertonic 3 download within the 150 MB budget", () => {
  const model = VoiceModelManifestSchema.parse(VOICE_SPEECH_MODELS["supertonic-3"]);
  assert.equal(model.files.length, 7);
  assert.equal(voiceModelBytes(model), 145_295_768);
  assert.equal(model.sources[0]?.license, "OpenRAIL-M");
  assert.deepEqual(VOICE_SPEECH_NEURAL_VOICES.map(({ name, index }) => [name, index]), [
    ["F1", 0], ["F2", 1], ["F3", 2], ["F4", 3], ["F5", 4],
    ["M1", 5], ["M2", 6], ["M3", 7], ["M4", 8], ["M5", 9],
  ]);
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

test("one file may not sit inside another, and siblings stay valid", () => {
  const source = { repository: "fixture/model", commit: "c".repeat(40), license: "CC-BY-4.0", basedOn: "fixture/upstream" };
  const file = (name: string) => ({
    path: `model/${name}`,
    url: `https://huggingface.co/fixture/model/resolve/${"c".repeat(40)}/${name}`,
    bytes: 1,
    sha256: "a".repeat(64),
  });
  const shape = (...names: string[]) => ({ revision: "r1", label: "Fixture", sources: [source], files: names.map(file) });
  assert.equal(VoiceModelManifestSchema.safeParse(shape("a", "b", "c/d", "c/e")).success, true, "siblings");
  for (const names of [["a", "a/b"], ["a/b", "a"], ["c/d", "c/d/e/f"]]) {
    const parsed = VoiceModelManifestSchema.safeParse(shape(...names));
    assert.equal(parsed.success, false, names.join(" and "));
    assert.match(parsed.error!.issues[0]!.message, /cannot both be files: one is inside the other/);
  }
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
  assert.equal(voiceModelFileUrl(file, "https://mirror.example/models?token=abc"), `https://mirror.example/models${path}?token=abc`,
    "a mirror's query stays a query and the path goes on the pathname");
});

test("both sherpa manifests pin every measured recognizer file plus the same Silero detector", () => {
  for (const [backend, manifest] of [["sherpa", VOICE_MODELS["sherpa-onnx"]!], ["small-tdt", VOICE_TEST_MODEL]] as const) {
    const expected = spike.filter(entry => entry.backend === backend);
    VoiceModelManifestSchema.parse(manifest);
    assert.equal(manifest.files.length, expected.length + 1);
    for (const entry of expected) {
      const url = `${VOICE_MODEL_ORIGIN}/${entry.repository}/resolve/${entry.revision}/${entry.file}`;
      assert.deepEqual(manifest.files.find(file => file.url === url),
        { url, path: `${entry.repository.split("/")[1]}/${entry.file}`, bytes: entry.bytes, sha256: entry.sha256 });
    }
    assert.ok(manifest.files.some(file => file.path === "silero-vad/onnx/model.onnx"));
  }
});
