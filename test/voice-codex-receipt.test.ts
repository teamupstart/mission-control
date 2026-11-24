import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spokenMessageText } from "../src/shared/voice-delivery.ts";
import { closeDb, loadSpokenTurns } from "../src/server/db.ts";
import { forgetDeliveryBindingState } from "../src/server/delivery-binding.ts";
import { applyFeatureFlagIntent } from "../src/server/feature-flags/index.ts";
import { codexSdkSpec } from "../src/server/harness/codex/sdk.ts";
import { spawnAppServer } from "../src/server/harness/codex/sdk-deps.ts";
import { sessionMessages } from "../src/server/harness/index.ts";
import { PendingTurnManager } from "../src/server/pending-turns.ts";
import { Registry } from "../src/server/registry.ts";
import { attributeTranscript } from "../src/server/transcript-attribution.ts";
import { unexpectedActiveSdkDelivery } from "./helpers/pending-turn-sender.ts";

test("native Codex writes the spoken delivery receipt and restores the exact disclosure after reload", { timeout: 45_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "spoken-codex-"));
  const native = join(root, "codex");
  const cwd = join(root, "project");
  mkdirSync(native);
  mkdirSync(cwd);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Only the model response is a fixture. The lockfile's Codex binary owns the RPC and rollout.
  let modelRequests = 0;
  const provider = createServer((req, res) => {
    req.resume();
    if (req.url !== "/v1/responses") { res.writeHead(404).end(); return; }
    modelRequests++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const response = { id: "resp-local", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } };
    res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`);
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const port = (provider.address() as AddressInfo).port;
  const bin = fileURLToPath(new URL("../node_modules/@openai/codex/bin/codex.js", import.meta.url));
  const sdk = codexSdkSpec({ connect: async args => spawnAppServer(bin, [
    ...args, "-c", 'model_provider="local"',
    "-c", `model_providers.local={name="loopback",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",requires_openai_auth=false}`,
  ], cwd, { PATH: process.env.PATH, HOME: root, CODEX_HOME: native }) });
  const id = "sdk:native-voice";
  const words = "inspect the fixture";
  const received = spokenMessageText(words, { openQuestions: null, unseenReports: null });
  const registry = new Registry();
  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true });
  registry.registerSdkSession({ id, agent: "codex", name: "Codex", cwd });
  try {
    const handle = await sdk.launch({ cwd, stateHome: root, prompt: "", model: "gpt-5.4", effort: null,
      permissionMode: null, mcp: null, extraDirs: [], standingInstructions: "", standingInstructionsPrompt: "", resume: null });
    const stopOnTimeout = () => { void handle.stop(); };
    t.signal.addEventListener("abort", stopOnTimeout, { once: true });
    const outbox = new PendingTurnManager(registry, {
      ...unexpectedActiveSdkDelivery,
      sendWhenIdle: async (_, input, guard) => guard?.() ? null : handle.sendIfIdle(input),
    }, { idleSettleMs: 0 });
    outbox.start();
    try {
      for await (const event of handle.events) {
        registry.applyDriverEvent(id, event);
        if (event.kind === "bound") {
          assert.ok(outbox.submitSpoken(id, words, "native-receipt").ok);
        }
        if (event.kind === "turn_done") break;
        assert.notEqual(event.kind, "exited", "Codex exited before recording the turn");
      }
    } finally {
      outbox.stop();
      t.signal.removeEventListener("abort", stopOnTimeout);
      await handle.stop();
    }

    assert.equal(modelRequests, 1, "the local Responses fixture handled the spoken turn");
    const session = registry.getSession(id)!;
    const key = session.agentSessionId!;
    closeDb();
    forgetDeliveryBindingState();
    const transcript = sessionMessages(session);
    assert.ok(transcript, "Codex reported a readable native rollout");
    const { messages } = transcript.read.after(transcript.path, 0);
    const user = messages.find(message => message.role === "user" && message.text === received);
    assert.ok(user, "the runtime wrote the exact spoken payload");
    const [reservation] = loadSpokenTurns(key);
    assert.ok(reservation);
    assert.equal(user.clientMessageId ?? user.id, reservation.id, "the native rollout echoed the outbox receipt");
    const [restored] = attributeTranscript(id, [user], null, undefined, { key, transcript });
    assert.deepEqual(restored?.presentation, { kind: "spoken", displayText: words, received });
    const { version } = JSON.parse(readFileSync(new URL("../node_modules/@openai/codex/package.json", import.meta.url), "utf8"));
    t.diagnostic(`Codex ${version} wrote the outbox UUID in ${user.clientMessageId ? "the client receipt field" : "the native user-message ID"}. Reload restored the spoken words and complete payload.`);
  } finally {
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    closeDb();
  }
});
