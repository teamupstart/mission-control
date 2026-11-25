import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { once } from "node:events";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { app, cards, home, name, queued, roster, voiceStateStore } from "./helpers/voice-http.ts";

test("native recorded Cancel reaches the daemon after the countdown", {
  skip: !process.env.MISSION_CANCEL_TEST_WAV || !process.env.MISSION_CANCEL_TEST_MODELS,
}, async t => {
  voiceStateStore.reset();
  // This roster name can win CTC rescoring even when Parakeet decoded "Cancel." exactly.
  voiceStateStore.useRoster(() => [...roster, name("Voice")]);
  const config = await app.request("/api/voice/config", { method: "PUT",
    headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ endOfSpeechMs: 3000 }) });
  assert.equal(config.status, 200);
  const server = serve({ fetch: async request => {
    const response = await app.fetch(request);
    t.diagnostic(request.method + " " + new URL(request.url).pathname + " " + response.status);
    return response;
  }, port: 0, hostname: "127.0.0.1" });
  try {
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const { stdout } = await promisify(execFile)("swift", ["test", "--package-path", "native/voice-listener",
      "--filter", "SpokenCancelTests.testRecordedCancel"], { env: { ...process.env,
      MISSION_VOICE_DAEMON_URL: "http://127.0.0.1:" + address.port, MISSION_VOICE_TOKEN_FILE: join(home, "token"),
      MISSION_VOICE_MODEL_DIR: process.env.MISSION_CANCEL_TEST_MODELS } });
    t.diagnostic(stdout.match(/onset=.*transcript=[^\n]*/)?.[0] ?? stdout);
    t.diagnostic("window=" + cards[0]?.windowMs + "ms outcome=" + cards.at(-1)?.state + " queued=" + queued("Will").length);
    assert.equal(cards.at(-1)?.state, "cancelled");
    assert.deepEqual(queued("Will"), []);
  } finally { server.close(); }
});
