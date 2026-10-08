import assert from "node:assert/strict";
import test from "node:test";
import {
  claudeProviderFailure,
  isTokenExhaustion,
  ProviderFailure,
} from "../src/server/llm/provider-failure.ts";

test("only explicit token exhaustion bypasses provider backoff", () => {
  assert.equal(new ProviderFailure("rate limit exceeded", "api_error").kind, "retryable");
  assert.equal(new ProviderFailure("provider unavailable", "api_error").kind, "retryable");
  assert.equal(new ProviderFailure("request rejected", "prompt_too_long").kind, "token_exhausted");
  assert.equal(isTokenExhaustion("prompt exceeds model token limit"), true);
  assert.equal(isTokenExhaustion("This model's maximum context length was exceeded"), true);
  assert.equal(isTokenExhaustion("HTTP 429 from provider"), false);
});

test("token exhaustion after the retained diagnostic boundary still blocks immediately", () => {
  const failure = new ProviderFailure(`${"provider detail ".repeat(24)}prompt exceeds model token limit`);
  assert.equal(failure.message.length, 300);
  assert.equal(failure.kind, "token_exhausted");
});

test("Claude result frames establish provider origin; local failures do not", () => {
  assert.equal(claudeProviderFailure({ type: "result", is_error: true, terminal_reason: "api_error" })?.kind, "retryable");
  assert.equal(claudeProviderFailure({ type: "result", is_error: true, terminal_reason: "prompt_too_long" })?.kind, "token_exhausted");
  assert.equal(claudeProviderFailure({ type: "result", is_error: true, terminal_reason: "api_error", errors: ["Usage limit reached for this account"] })?.kind, "token_exhausted");
  assert.equal(claudeProviderFailure({ type: "result", is_error: true, errors: ["Usage limit reached for this account"] }), null);
  assert.equal(claudeProviderFailure({ type: "result", is_error: true, terminal_reason: "tool_error" }), null);
  assert.equal(claudeProviderFailure({ type: "result", is_error: true, terminal_reason: "tool_error", errors: ["prompt exceeds model token limit"] }), null);
  assert.equal(claudeProviderFailure({ type: "system", is_error: true, terminal_reason: "api_error" }), null);
});
