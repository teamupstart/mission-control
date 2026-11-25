import { readFileSync, existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { BASE_URL, stateDir, tokenPath } from "../src/shared/harness-runtime.mjs";
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
const binary = binaries[model.backend];
if (!existsSync(binary)) missingBinary();
process.env.MISSION_VOICE_TOKEN_FILE ??= tokenPath();
process.env.MISSION_VOICE_MODEL_DIR = model.directory;
// File playback keeps its own argv and lifetime. It never enters the microphone supervisor.
delete process.env.MISSION_VOICE_LISTENER_INSTANCE;
if (model.backend === "sherpa-onnx") {
  process.env.MISSION_VOICE_LISTENER_MANIFEST = JSON.stringify(model.manifest);
  const args = [process.execPath, binary];
  if (file !== undefined) args.push("--input-file", file);
  process.execve!(process.execPath, args, process.env as Record<string, string>);
}
// FluidAudio only supports live input. Refuse a recording before either its
// supervised launch or its direct exec, including when the daemon chose the backend.
if (file !== undefined) throw new Error("--input-file requires sherpa-onnx");
const credential = process.env.MISSION_VOICE_DEV_CREDENTIAL_FD;
if (credential !== undefined) {
  const { createVoiceSupervisor, VOICE_SUPERVISOR_PROOF_HEADER } = await import("../src/server/voice/supervisor-auth.ts");
  const { MacListenerSupervisor } = await import("../src/server/voice/macos-supervisor.ts");
  const { VoiceListener } = await import("../src/main/voice-listener.ts");
  const { ShellVoiceStateSchema } = await import("../src/main/voice-state-schema.ts");
  const { voiceStateOff } = await import("../src/shared/voice.ts");
  const signer = createVoiceSupervisor("dev", Number(credential));
  const supervisor = new MacListenerSupervisor(stateDir(), "dev", signer, binary, async (instance, state, proof, signal) => {
    const response = await fetch(new URL("/voice/listener/supervised", url), {
      method: "POST", redirect: "error", signal, body: JSON.stringify({instance, state}),
      headers: { "Content-Type": "application/json", "x-harness-token": readFileSync(process.env.MISSION_VOICE_TOKEN_FILE!, "utf8").trim(),
        [VOICE_SUPERVISOR_PROOF_HEADER]: proof },
    });
    await response.body?.cancel();
    if (state === "started" && (response.status === 403 || response.status === 409)) return false;
    if (!response.ok) throw new Error("Voice supervisor report unacknowledged.");
  });
  const service = new VoiceListener(directory => supervisor.start({...process.env, MISSION_VOICE_MODEL_DIR: directory}), line => console.error(line), supervisor);
  let connected = false;
  let source: string | undefined;
  const sync = async () => {
    const res = await fetch(new URL("/api/voice/mute", url), {redirect: "error", signal: AbortSignal.timeout(3000)});
    if (!res.ok) throw new Error("Cannot read voice state.");
    const state = ShellVoiceStateSchema.parse((await res.json()).state);
    if (!connected || source !== state.modeVersion?.source) service.reconnect();
    source = state.modeVersion?.source;
    connected = true;
    service.update(state, true);
  };
  const lifetime = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => lifetime.abort());
  try {
    while (!lifetime.signal.aborted) {
      try { await sync(); }
      catch { service.update(voiceStateOff(), false); connected = false; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } finally { await service.stop(); }
} else {
  process.execve!(binary, [binary], process.env as Record<string, string>);
}
