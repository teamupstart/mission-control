// Run the real file-listener protocol with one deterministic segment in place of the ONNX model.
import { ListenerClient } from "../../src/voice-listener/client.ts";
import { playRecording } from "../../src/voice-listener/playback.ts";

const client = new ListenerClient(process.env.MISSION_VOICE_DAEMON_URL!, process.env.MISSION_VOICE_TOKEN_FILE!);
await playRecording(client, [new Float32Array(512)].values(), async (_samples, roster) => {
  process.stdout.write("prime " + JSON.stringify(roster) + "\n");
  return { text: "first", tokens: ["▁first"], timestamps: [0], durations: [0.32] };
});
