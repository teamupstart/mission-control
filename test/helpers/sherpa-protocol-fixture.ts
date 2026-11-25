// Run the real file-listener protocol with one deterministic segment in place of the ONNX model.
import { ListenerClient } from "../../src/voice-listener/client.ts";
import { playRecording } from "../../src/voice-listener/playback.ts";
import { recordingSegments } from "../../src/voice-listener/segments.ts";
import { voiceHostTimeUs } from "../../src/server/voice/host-clock.ts";

const client = new ListenerClient(process.env.MISSION_VOICE_DAEMON_URL!, process.env.MISSION_VOICE_TOKEN_FILE!);
const samples = new Float32Array(512);
let ready = false;
await playRecording(client, signal => recordingSegments(samples, () => ({
  acceptWaveform() { ready = true; }, isDetected: () => false, isEmpty: () => !ready, front: () => ({ start: 0, samples }),
  pop() { ready = false; }, flush() {}, reset() { ready = false; },
}), signal, voiceHostTimeUs), async (_samples, roster) => {
  process.stdout.write("prime " + JSON.stringify(roster) + "\n");
  return { text: "first", tokens: ["▁first"], timestamps: [0], durations: [0.32] };
});
