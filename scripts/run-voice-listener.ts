import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { BASE_URL, stateDir, tokenPath } from "../src/shared/harness-runtime.mjs";
import { VOICE_MODELS } from "../src/shared/voice-models.ts";

const binary = resolve("dist/native/voice-listener");
if (!existsSync(binary)) {
  console.error("Voice listener is missing. On an Apple silicon Mac, run npm run build:voice-listener first.");
  process.exit(1);
}
process.env.MISSION_VOICE_DAEMON_URL ??= BASE_URL;
process.env.MISSION_VOICE_TOKEN_FILE ??= tokenPath();
process.env.MISSION_VOICE_MODEL_DIR ??= join(stateDir(), "voice", "models", "fluidaudio", VOICE_MODELS.fluidaudio!.revision);
process.execve!(binary, [binary], process.env as Record<string, string>);
