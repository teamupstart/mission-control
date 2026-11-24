import { existsSync } from "node:fs";
import { release } from "node:os";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { BASE_URL, stateDir, tokenPath } from "../src/shared/harness-runtime.mjs";
import { resolveVoiceBackend, VOICE_MODELS } from "../src/shared/voice-models.ts";
import { VOICE_BACKEND_CHOICES } from "../src/shared/voice.ts";

const { values } = parseArgs({ options: { backend: { type: "string" }, "input-file": { type: "string" } } });
const selected = values.backend ?? process.env.MISSION_VOICE_BACKEND ?? "auto";
const choice = VOICE_BACKEND_CHOICES.find(option => option === selected);
if (!choice) throw new Error("Unknown voice backend: " + selected);
const backend = resolveVoiceBackend(choice, process.platform, process.arch, release());
const sherpa = backend === "sherpa-onnx";
const binary = resolve(sherpa ? "dist/voice-listener/sherpa.mjs" : "dist/native/voice-listener");
if (!existsSync(binary)) {
  console.error("Voice listener is missing. Run npm run build:voice-listener first.");
  process.exit(1);
}
if (values["input-file"] && !sherpa) throw new Error("--input-file requires sherpa-onnx");
process.env.MISSION_VOICE_DAEMON_URL ??= BASE_URL;
process.env.MISSION_VOICE_TOKEN_FILE ??= tokenPath();
process.env.MISSION_VOICE_MODEL_DIR ??= join(stateDir(), "voice", "models", backend, VOICE_MODELS[backend]!.revision);
const args = sherpa ? [process.execPath, binary] : [binary];
if (values["input-file"]) args.push("--input-file", values["input-file"]);
process.execve!(args[0]!, args, process.env as Record<string, string>);
