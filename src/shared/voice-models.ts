// The speech models voice addressing downloads (contract H of
// `docs/plans/voice-addressing-for-agents/phased-plan.md`), pinned file by file.
//
// Browser-safe: no `node:` import may reach this module. The daemon's model manager downloads and
// verifies against `VOICE_MODELS`, and the dashboard reads the same manifest to say how large a
// download is and to turn a `VoiceModelState` into a Setup row, so the two cannot disagree about
// what "verified" covers.
//
// Every file names a Hugging Face URL pinned to a commit, its exact size and its SHA-256. The
// digests are the ones the spike measured (`docs/voice-spike-findings.md`, generated into
// `scripts/voice-spike/models.json`); `test/voice-models.test.ts` holds them equal. A new model
// is a new `revision`: it downloads into its own directory beside the old one, and the old one is
// removed only after the new one verifies.

import { z } from "zod";
import type { SetupStatus } from "./setup-catalog.ts";
import {
  VOICE_BACKENDS,
  type VoiceBackend,
  type VoiceBackendChoice,
  type VoiceMicrophonePermission,
  type VoiceModelState,
} from "./voice.ts";

/** The only origin a manifest may name. `MISSION_VOICE_MODEL_BASE_URL` replaces it as a whole. */
export const VOICE_MODEL_ORIGIN = "https://huggingface.co" as const;

/**
 * A pinned Hugging Face file URL: `/<owner>/<repo>/resolve/<40-hex commit>/<file>`. A branch or tag
 * in the commit's place (`resolve/main/...`) is what this refuses, because a branch moves and a
 * download from it can be different bytes on a different day.
 */
const PINNED_URL = /^https:\/\/huggingface\.co\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)\/resolve\/([0-9a-f]{40})\/(.+)$/;

/** One path segment on disk: no separators, no `.` or `..`, nothing a shell would mangle. */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

const REVISION = /^[a-z0-9][a-z0-9.-]{0,79}$/;

export function parsePinnedModelUrl(url: string): { repository: string; commit: string; file: string } | null {
  const match = PINNED_URL.exec(url);
  if (!match) return null;
  const [, owner, repo, commit, file] = match;
  if (!file!.split("/").every((segment) => SEGMENT.test(segment))) return null;
  return { repository: `${owner}/${repo}`, commit: commit!, file: file! };
}

function safeRelativePath(path: string): boolean {
  return path.length > 0 && path.length <= 512 && path.split("/").every((segment) => SEGMENT.test(segment));
}

export const VoiceModelFileSchema = z.object({
  /**
   * Where the file is kept under the revision directory: the repository's name, then the file's
   * path inside it, so the layout on disk mirrors the source and a listener can find each model.
   */
  path: z.string().refine(safeRelativePath, "a relative path of plain segments"),
  url: z.string().refine((url) => parsePinnedModelUrl(url) !== null, "a Hugging Face URL pinned to a 40-character commit"),
  bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "a lowercase hex SHA-256 digest"),
}).strict();
export type VoiceModelFile = z.infer<typeof VoiceModelFileSchema>;

/** A repository the files come from, with the licence its model card declares. */
export const VoiceModelSourceSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  license: z.string().min(1).max(64),
  /** The upstream model this repository converts. */
  basedOn: z.string().min(1).max(200),
}).strict();
export type VoiceModelSource = z.infer<typeof VoiceModelSourceSchema>;

export const VoiceModelManifestSchema = z.object({
  /** The directory the files are kept in, under `<state home>/voice/models/<backend>/`. */
  revision: z.string().regex(REVISION, "a revision directory name"),
  label: z.string().min(1).max(120),
  sources: z.array(VoiceModelSourceSchema).min(1).max(8),
  files: z.array(VoiceModelFileSchema).min(1).max(256),
}).strict().superRefine((manifest, ctx) => {
  const paths = new Set<string>();
  for (const [index, file] of manifest.files.entries()) {
    if (paths.has(file.path)) ctx.addIssue({ code: "custom", path: ["files", index, "path"], message: `${file.path} is listed twice` });
    // One path may not be a directory of another: the file written first would block the other.
    const nested = [...paths].find((other) => file.path.startsWith(`${other}/`) || other.startsWith(`${file.path}/`));
    if (nested) {
      ctx.addIssue({ code: "custom", path: ["files", index, "path"], message: `${file.path} and ${nested} cannot both be files: one is inside the other` });
    }
    paths.add(file.path);
    const pinned = parsePinnedModelUrl(file.url);
    if (!pinned) continue;
    const source = manifest.sources.find((candidate) => candidate.repository === pinned.repository);
    if (!source) {
      ctx.addIssue({ code: "custom", path: ["files", index, "url"], message: `${pinned.repository} is not a declared source` });
    } else if (source.commit !== pinned.commit) {
      ctx.addIssue({ code: "custom", path: ["files", index, "url"], message: `${file.path} is pinned to ${pinned.commit}, not ${source.commit}` });
    }
    const expected = `${pinned.repository.split("/")[1]}/${pinned.file}`;
    if (file.path !== expected) {
      ctx.addIssue({ code: "custom", path: ["files", index, "path"], message: `${file.path} should be kept at ${expected}` });
    }
  }
});
export type VoiceModelManifest = z.infer<typeof VoiceModelManifestSchema>;

/** A manifest per backend. Null where this build publishes no model for a backend yet. */
export const VoiceModelManifestsSchema = z.object(
  Object.fromEntries(VOICE_BACKENDS.map((backend) => [backend, VoiceModelManifestSchema.nullable().optional()])) as
    Record<VoiceBackend, z.ZodOptional<z.ZodNullable<typeof VoiceModelManifestSchema>>>,
).strict();
export type VoiceModelManifests = Readonly<Record<VoiceBackend, VoiceModelManifest | null>>;

// ---- the pinned models ----

const PARAKEET_TDT_V2_COREML = "FluidInference/parakeet-tdt-0.6b-v2-coreml";
const PARAKEET_TDT_V2_COREML_COMMIT = "ee09c569f73759e6d44c9bd16766f477b2b36d39";
/**
 * FluidAudio primes names from the roster with a vocabulary-boosting pass over this smaller CTC
 * model (the spike's S1, and what Phase 9's name priming needs), so it ships with the recognizer.
 */
const PARAKEET_CTC_110M_COREML = "FluidInference/parakeet-ctc-110m-coreml";
const PARAKEET_CTC_110M_COREML_COMMIT = "accdafd8cf8a2ff1cabe3c11e54416b405d409aa";

function pinned(repository: string, commit: string, file: string, bytes: number, sha256: string): VoiceModelFile {
  return {
    path: `${repository.split("/")[1]}/${file}`,
    url: `${VOICE_MODEL_ORIGIN}/${repository}/resolve/${commit}/${file}`,
    bytes,
    sha256,
  };
}

const tdt = (file: string, bytes: number, sha256: string) =>
  pinned(PARAKEET_TDT_V2_COREML, PARAKEET_TDT_V2_COREML_COMMIT, file, bytes, sha256);
const ctc = (file: string, bytes: number, sha256: string) =>
  pinned(PARAKEET_CTC_110M_COREML, PARAKEET_CTC_110M_COREML_COMMIT, file, bytes, sha256);

/** NVIDIA Parakeet TDT 0.6B v2 for FluidAudio, with the CTC model FluidAudio primes names with. */
const FLUIDAUDIO_PARAKEET_V2: VoiceModelManifest = {
  revision: "parakeet-v2-ee09c569-ctc110m-accdafd8",
  label: "NVIDIA Parakeet TDT 0.6B v2 (Core ML)",
  sources: [
    { repository: PARAKEET_TDT_V2_COREML, commit: PARAKEET_TDT_V2_COREML_COMMIT, license: "CC-BY-4.0", basedOn: "nvidia/parakeet-tdt-0.6b-v2" },
    { repository: PARAKEET_CTC_110M_COREML, commit: PARAKEET_CTC_110M_COREML_COMMIT, license: "CC-BY-4.0", basedOn: "nvidia/parakeet-tdt_ctc-110m" },
  ],
  files: [
    tdt("Decoder.mlmodelc/analytics/coremldata.bin", 243, "46de1a6fe2e49d19a2125bc91acf020df7f2aea84ba821532aade8427a440b05"),
    tdt("Decoder.mlmodelc/coremldata.bin", 554, "d200ca07694a347f6d02a3886a062ae839831e094e443222f2e48a14945966a8"),
    tdt("Decoder.mlmodelc/metadata.json", 3427, "90a279b822496316458febc0ce761ab05954fadd9d66aa97bea077a35fc8f2b2"),
    tdt("Decoder.mlmodelc/model.mil", 13106, "7b95a5a6b672c652000348a67b6d4d92bb8e176b978c6666fe73c28a4d7ec579"),
    tdt("Decoder.mlmodelc/weights/weight.bin", 14429952, "27d26890221d82322c1092fd99d7b40578e435d5cf4b83c887c42603caf97aba"),
    tdt("Encoder.mlmodelc/analytics/coremldata.bin", 243, "42e638870d73f26b332918a3496ce36793fbb413a81cbd3d16ba01328637a105"),
    tdt("Encoder.mlmodelc/coremldata.bin", 485, "4def7aa848599ad0e17a8b9a982edcdbf33cf92e1f4b798de32e2ca0bc74b030"),
    tdt("Encoder.mlmodelc/metadata.json", 2926, "58222fbc48c13c49d9715567803cd50cb9c23e4360462e0f8ffcea59a2c73c63"),
    tdt("Encoder.mlmodelc/model.mil", 959769, "ed7b19156ca29fa7dfd6891deb9fda4b0e8893f68597c985d135736546a43808"),
    tdt("Encoder.mlmodelc/weights/weight.bin", 445187200, "4adc7ad44f9d05e1bffeb2b06d3bb02861a5c7602dff63a6b494aed3bf8a6c3e"),
    tdt("JointDecision.mlmodelc/analytics/coremldata.bin", 243, "f1183ba213bb94a918c8d2cad19ab045320618f97f6ca662245b3936d7b090f7"),
    tdt("JointDecision.mlmodelc/coremldata.bin", 534, "e2c6752f1c8cf2d3f6f26ec93195c9bfa759ad59edf9f806696a138154f96f11"),
    tdt("JointDecision.mlmodelc/metadata.json", 2936, "ba8d309417b9acd4a175fdb15687de6a941db2f5b06666a60e7cf3cc8e2d3c3c"),
    tdt("JointDecision.mlmodelc/model.mil", 9722, "93bf82042235127cb81ab537dcae47a1c2e7e242ce4ffdaf772981b45eedc4f0"),
    tdt("JointDecision.mlmodelc/weights/weight.bin", 3453388, "ca22a65903a05e64137677da608077578a8606090a598abf4875fa6199aaa19d"),
    tdt("Preprocessor.mlmodelc/analytics/coremldata.bin", 243, "03ab3c1327a054c54c07a40325db967ec574f2c91dcc8192bfa44aa561bcf2d8"),
    tdt("Preprocessor.mlmodelc/coremldata.bin", 494, "d88ea1fc349459c9e100d6a96688c5b29a1f0d865f544be103001724b986b6d6"),
    tdt("Preprocessor.mlmodelc/metadata.json", 2974, "fb16c581ff5e1b962e7cb2181ed892cd32f9f84c12b6e80ff3e089f28e35bcbb"),
    tdt("Preprocessor.mlmodelc/model.mil", 27166, "3e06d16fd061294c8a75be68c43a3b1ed1f593d4a9c35249e9cdbccadc59721e"),
    tdt("Preprocessor.mlmodelc/weights/weight.bin", 298880, "a5f7df6c7f47147ae9486fe18cc7792f9a44d093ec3c6a11e91ef2dc363c48dc"),
    tdt("parakeet_vocab.json", 18762, "57019fe3c745772ca83a1b048a4bb951cd51329504ea33d4d83316b96e279a97"),
    ctc("AudioEncoder.mlmodelc/analytics/coremldata.bin", 243, "8906c823e9bb3bf6b16d9f0308f98cd70573526333ad85dd767dc3f9ae6b25fa"),
    ctc("AudioEncoder.mlmodelc/coremldata.bin", 505, "a88b002b58193b4c31211754cdfdf220a85f9651dc61caf336ab84400cbc191a"),
    ctc("AudioEncoder.mlmodelc/metadata.json", 3456, "4f288bfe5cbe867ef1e592cdae33578b2fe59ada69182fc12209879558f985c2"),
    ctc("AudioEncoder.mlmodelc/model.mil", 1060924, "2f84ef93a69115e55f3b5d8ce695b3c937de1833d4d229620634fae967cd587e"),
    ctc("AudioEncoder.mlmodelc/weights/weight.bin", 100778304, "af0734b4a5d7465ad9e8bb170f0c53c5e6b91ebb75a9bdf88d3f59ae4ad6aebd"),
    ctc("CtcHead.mlmodelc/analytics/coremldata.bin", 243, "2bb2d397129247a478fce10652d3011e155cf0247e93086bcdc384a754f005d5"),
    ctc("CtcHead.mlmodelc/coremldata.bin", 488, "14df3ea46b298ac3efd8141b7dcab77acdaf2d0c700827bc1435093744ae206d"),
    ctc("CtcHead.mlmodelc/metadata.json", 1865, "d46a845e8b7871f84848201d4ee5808e85e9104da43188fa51c8c416ac8323f4"),
    ctc("CtcHead.mlmodelc/model.mil", 3605, "077c343f7018aee3820ff92a4bd384aeac00b64ab9716d25276e7bfe0dfa2866"),
    ctc("CtcHead.mlmodelc/weights/weight.bin", 1051842, "fb9bead064427ffcb7529c0e3f378e421b4dde8e6d81447b6d1ca3352ca850e1"),
    ctc("MelSpectrogram.mlmodelc/analytics/coremldata.bin", 243, "22f2a8cba1de25c984050566b534a1d8caf22a82f9fe6c1c6f3149a0dd7e8ae3"),
    ctc("MelSpectrogram.mlmodelc/coremldata.bin", 330, "3a32ec67c76aa0aa2faef518413c311493e89aeb7fa11289fa4b8653ab8a160c"),
    ctc("MelSpectrogram.mlmodelc/metadata.json", 1962, "5e11d21a65c02bcfc37db43e941978e5d60d59e0efeadfda08e41f33b4f835d3"),
    ctc("MelSpectrogram.mlmodelc/model.mil", 12584, "0a7cb5693b39667295218bac5c7c09053f6bcd4b32699a83d06ac35d14ac6b79"),
    ctc("MelSpectrogram.mlmodelc/weights/weight.bin", 567712, "0a89c055bfde9022029d3cc59a23e949385e063974460d8eaec3a7614c3eaaa8"),
    ctc("tokenizer.json", 360106, "9f7c517c0bf644b1b690ab037bab4d4c53aecd38e047e7154d011013ab9160db"),
    ctc("vocab.json", 16086, "319d386eead79aadc80df9c3ecc8340d1a727efb7c02a8847eb940380dd61e1f"),
  ],
};

/**
 * The model each backend downloads. `sherpa-onnx` is Phase 16's to fill; until then a machine whose
 * backend resolves to it has no model to download, and its Setup row says so.
 */
export const VOICE_MODELS: VoiceModelManifests = Object.freeze({
  fluidaudio: FLUIDAUDIO_PARAKEET_V2,
  "sherpa-onnx": null,
});

export function voiceModelBytes(manifest: Pick<VoiceModelManifest, "files">): number {
  return manifest.files.reduce((sum, file) => sum + file.bytes, 0);
}

/**
 * Where a file is fetched from: its pinned URL, or the same path under `baseUrl` when one is set
 * (`MISSION_VOICE_MODEL_BASE_URL`), which is how a test serves fixture files and a mirror serves
 * the real ones. The path, and so the commit, never changes.
 */
export function voiceModelFileUrl(file: Pick<VoiceModelFile, "url">, baseUrl: string | null): string {
  if (!baseUrl) return file.url;
  // Through the pathname, so a mirror URL's query (a token, say) and fragment stay where they are.
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${file.url.slice(VOICE_MODEL_ORIGIN.length)}`;
  return url.toString();
}

/**
 * The backend a choice runs on this platform. `auto` is FluidAudio on Apple silicon, where the
 * spike measured it, and sherpa-onnx everywhere else.
 */
export function resolveVoiceBackend(choice: VoiceBackendChoice, platform: string, arch: string): VoiceBackend {
  if (choice !== "auto") return choice;
  return platform === "darwin" && arch === "arm64" ? "fluidaudio" : "sherpa-onnx";
}

// ---- Setup readings, shared by the daemon's probes and the panel's live rows ----

/**
 * The `voice-model` Setup row's reading of a model state. The daemon's probe answers with it, and
 * the panel applies it to the live state from the event stream, so the row follows a download as
 * it runs without a Re-check.
 */
export function voiceModelSetupStatus(model: VoiceModelState): SetupStatus {
  switch (model.status) {
    case "ready":
      return { state: "satisfied", evidence: `${model.directory ?? "The speech model"} · checksum verified` };
    case "missing":
      return model.revision === null
        ? { state: "needs-setup", why: model.error ?? "No speech model is available for this machine yet.", evidence: null }
        : { state: "missing" };
    case "downloading":
      return { state: "needs-setup", why: "Downloading the speech model.", evidence: null };
    case "verifying":
      return { state: "needs-setup", why: "Checking the speech model on disk against its pinned checksums.", evidence: null };
    case "failed":
      return { state: "needs-setup", why: model.error ?? "The speech model failed its checksum check.", evidence: null };
  }
}

/** Who said what the microphone permission is: the listener's hello or the desktop shell's report. */
export interface VoiceMicrophoneReading {
  permission: VoiceMicrophonePermission;
  source: "listener" | "shell";
}

const READING_SOURCE: Record<VoiceMicrophoneReading["source"], string> = {
  listener: "the voice listener",
  shell: "the desktop app",
};

export const VOICE_MICROPHONE_NOT_CHECKED =
  "Not checked yet. The voice listener or the desktop app reports it once one is running.";

export function voiceMicrophoneSetupStatus(reading: VoiceMicrophoneReading | null): SetupStatus {
  if (!reading) return { state: "unknown", why: VOICE_MICROPHONE_NOT_CHECKED, evidence: null };
  const source = READING_SOURCE[reading.source];
  switch (reading.permission) {
    case "granted":
      return { state: "satisfied", evidence: `Allowed, as ${source} reports` };
    case "denied":
      return { state: "needs-setup", why: "macOS denied the microphone to Mission Control.", evidence: `As ${source} reports` };
    case "not-determined":
      return { state: "needs-setup", why: "macOS has not asked for the microphone yet.", evidence: `As ${source} reports` };
    case "restricted":
      return { state: "needs-setup", why: "A device policy restricts the microphone on this machine.", evidence: `As ${source} reports` };
    case "unknown":
      return { state: "unknown", why: `${source[0]!.toUpperCase()}${source.slice(1)} could not read the microphone permission.`, evidence: null };
  }
}
