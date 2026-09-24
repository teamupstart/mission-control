import assert from "node:assert/strict";
import { test } from "node:test";

import { MODEL_CATALOG } from "../src/shared/model.ts";
import { discoverClaudeModels, type ClaudeModelCatalogDeps } from "../src/server/harness/claude/model-catalog.ts";

const rows = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Moving default" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "Newest Opus" },
  { value: "claude-opus-5", resolvedModel: "claude-opus-5", displayName: "Opus 5", description: "Previous Opus" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet 5", description: "Sonnet" },
  { value: "opusplan", resolvedModel: "claude-sonnet-5", displayName: "Opus Plan Mode", description: "A mode" },
];

function deps(models: unknown): ClaudeModelCatalogDeps {
  return {
    executable: async () => "/fake/claude",
    env: () => ({}),
    query: async ({ prompt, options }) => {
      assert.equal(options.pathToClaudeCodeExecutable, "/fake/claude");
      assert.deepEqual(options.settingSources, ["user"]);
      assert.deepEqual(options.tools, []);
      // The probe's input stream must close without yielding a turn.
      const next = prompt[Symbol.asyncIterator]().next();
      options.abortController.signal.addEventListener("abort", () => {
        void next.then((message) => assert.equal(message.done, true));
      }, { once: true });
      return { supportedModels: async () => models };
    },
  };
}

test("Claude discovery resolves the local Opus alias to a stable id and retains shipped choices", async () => {
  const result = await discoverClaudeModels(new AbortController().signal, deps(rows));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.choices[0]?.id, "claude-opus-5-5");
  assert.equal(result.choices[0]?.label, "Opus 5.5");
  assert.equal(result.choices[0]?.hint, "Newest Opus");
  assert.equal(result.choices.filter((row) => row.id === "claude-opus-5-5").length, 1);
  assert.equal(result.choices.some((row) => row.id === "default" || row.id === "opusplan"), false);
  assert.equal(result.choices.some((row) => row.id === MODEL_CATALOG.claude[0]?.id), true);
  assert.equal(JSON.stringify(result).includes("account"), false);
});

test("a dated live id does not duplicate the same shipped model in the picker", async () => {
  const result = await discoverClaudeModels(new AbortController().signal, deps([
    { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" },
  ]));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.choices.filter((row) => row.label === "Haiku 4.5").length, 1);
  assert.equal(result.choices.some((row) => row.id === "claude-haiku-4-5"), false);
});

test("Claude discovery rejects unsafe ids and never carries account data", async () => {
  const result = await discoverClaudeModels(new AbortController().signal, deps([
    { value: "opus", resolvedModel: "../../secret", displayName: "Wrong" },
    { value: "claude-opus-5-5", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", account: { token: "secret" } },
  ]));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.choices[0]?.id, "claude-opus-5-5");
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("Claude discovery bounds malformed, empty and oversized replies", async () => {
  assert.deepEqual(await discoverClaudeModels(new AbortController().signal, deps({ models: rows })), { ok: false, problem: "invalid_response" });
  assert.deepEqual(await discoverClaudeModels(new AbortController().signal, deps([])), { ok: false, problem: "unavailable" });
  assert.deepEqual(await discoverClaudeModels(new AbortController().signal, {
    ...deps(rows), bounds: { responseBytes: 10 },
  }), { ok: false, problem: "output_limit" });
});

test("Claude discovery aborts a stalled handshake within its bound", async () => {
  const result = await discoverClaudeModels(new AbortController().signal, {
    ...deps(rows),
    bounds: { timeoutMs: 5 },
    query: async () => await new Promise(() => {}),
  });
  assert.deepEqual(result, { ok: false, problem: "timeout" });
});

test("Claude discovery classifies a failed SDK query startup as process_failed", async () => {
  const result = await discoverClaudeModels(new AbortController().signal, {
    ...deps(rows),
    query: async () => { throw new Error("SDK startup failed"); },
  });
  assert.deepEqual(result, { ok: false, problem: "process_failed" });
});

test("Claude discovery classifies a failed supportedModels control as rpc_failed", async () => {
  const result = await discoverClaudeModels(new AbortController().signal, {
    ...deps(rows),
    query: async () => ({
      supportedModels: async () => { throw new Error("control request failed"); },
    }),
  });
  assert.deepEqual(result, { ok: false, problem: "rpc_failed" });
});
