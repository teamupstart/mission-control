import test from "node:test";
import assert from "node:assert/strict";
import { piToMessages } from "../src/server/harness/pi/transcript.ts";

function record(stopReason: string, errorMessage?: string, content: unknown[] = []) {
  return { type: "message", id: "failed-turn", timestamp: "2026-11-18T12:00:00Z",
    message: { role: "assistant", provider: "openai-codex", stopReason, errorMessage, content } };
}

test("empty Pi OAuth failures remain visible with redacted diagnostics", () => {
  for (const provider of ["openai-codex", "anthropic"]) {
    const messages = piToMessages(record("error",
      `OAuth auth derivation failed for ${provider}: Cannot find module '${provider}.js' access_token=secret-fixture`));
    assert.equal(messages.length, 1);
    assert.match(messages[0]!.text, /Pi turn failed: OAuth auth derivation failed/);
    assert.match(messages[0]!.text, new RegExp(provider));
    assert.doesNotMatch(messages[0]!.text, /secret-fixture/);
  }
});

test("Pi failure preserves partial output, has a fallback, and never labels success as failed", () => {
  const messages = piToMessages(record("error", "provider unavailable", [{ type: "text", text: "Partial answer" }]));
  assert.equal(messages[0]!.text, "Partial answer");
  assert.match(messages[1]!.text, /Pi turn failed: provider unavailable/);
  assert.notEqual(messages[0]!.id, messages[1]!.id);
  assert.match(piToMessages(record("error"))[0]!.text, /Pi turn failed/);
  assert.deepEqual(piToMessages(record("stop", "stale error")), []);
});
