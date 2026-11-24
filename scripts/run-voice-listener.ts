import { existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { BASE_URL, tokenPath } from "../src/shared/harness-runtime.mjs";
import { VoiceModelManifestSchema } from "../src/shared/voice-models.ts";
import { VOICE_BACKENDS, VOICE_BACKEND_CHOICES } from "../src/shared/voice.ts";
import { loopbackDaemonUrl } from "../src/voice-listener/daemon-url.ts";

const { values } = parseArgs({ options: { backend: { type: "string" }, "input-file": { type: "string" } } });
const file = values["input-file"];
if (file === "") throw new Error("--input-file requires a non-empty recording path");
const selected = values.backend ?? process.env.MISSION_VOICE_BACKEND;
const choice = z.enum(VOICE_BACKEND_CHOICES).optional().safeParse(selected);
if (!choice.success) throw new Error("Unknown voice backend: " + selected);
const override = choice.data === "auto" ? undefined : choice.data;
const binaries = { fluidaudio: resolve("dist/native/voice-listener"), "sherpa-onnx": resolve("dist/voice-listener/sherpa.mjs") };
function missingBinary(): never {
  console.error("Voice listener is missing. Run npm run build:voice-listener first.");
  process.exit(1);
}
if (!Object.values(binaries).some(path => existsSync(path))) missingBinary();
if (file !== undefined && override === "fluidaudio") throw new Error("--input-file requires sherpa-onnx");
process.env.MISSION_VOICE_DAEMON_URL ??= BASE_URL;
const url = new URL("/api/voice/model", loopbackDaemonUrl(process.env.MISSION_VOICE_DAEMON_URL));
if (override) url.searchParams.set("backend", override);
const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
if (!response.ok) {
  if (response.status === 409 && (await response.json()).error === "backend_not_selected") {
    throw new Error(`The daemon selected a different voice backend. Select ${override ?? "the desired backend"} with PUT /api/voice/config or MISSION_VOICE_BACKEND on the daemon, then verify its model in Voice Setup.`);
  }
  throw new Error("Voice model lookup failed (HTTP " + response.status + "). Check Voice Setup and the selected backend.");
}
const model = z.object({ backend: z.enum(VOICE_BACKENDS), directory: z.string().refine(isAbsolute), manifest: VoiceModelManifestSchema })
  .parse(await response.json());
if (override && model.backend !== override) throw new Error("Unexpected backend in daemon model response");
const sherpa = model.backend === "sherpa-onnx";
if (file !== undefined && !sherpa) throw new Error("--input-file requires sherpa-onnx");
const binary = binaries[model.backend];
if (!existsSync(binary)) missingBinary();
process.env.MISSION_VOICE_TOKEN_FILE ??= tokenPath();
process.env.MISSION_VOICE_MODEL_DIR = model.directory;
if (sherpa) process.env.MISSION_VOICE_LISTENER_MANIFEST = JSON.stringify(model.manifest);
const args = sherpa ? [process.execPath, binary] : [binary];
if (file !== undefined) args.push("--input-file", file);
process.execve!(args[0]!, args, process.env as Record<string, string>);
