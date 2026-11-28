// The picker uses a tiny download manifest. Substitute only the neural helper
// fork so the real daemon can send a voice-specific WAV to the supervised listener.
import childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(import.meta.url);
if (process.argv[1] === fixture) {
  const wav = readFileSync(new URL("../../test/fixtures/voice/steve-check-the-build.wav", import.meta.url));
  const durationMs = wav.readUInt32LE(40) * 1000 / wav.readUInt32LE(28);
  process.on("message", ({ id, type, voice }) => {
    if (type === "warm") process.send({ id, ready: true });
    else if (type === "synthesize" && voice === "supertonic-3/F4") process.send({ id, wav, durationMs });
    else process.send({ id, failed: true });
  });
  process.once("disconnect", () => process.exit(0));
} else if (process.argv[1] === fileURLToPath(new URL("../../dist/server/index.mjs", import.meta.url))) {
  const helper = fileURLToPath(new URL("../../dist/voice-speaker/synth.mjs", import.meta.url));
  const fork = childProcess.fork;
  childProcess.fork = (path, ...args) => fork(path === helper ? fixture : path, ...args);
  syncBuiltinESMExports();
}
