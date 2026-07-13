import { test } from "node:test";
import assert from "node:assert/strict";
import { isLongContext, modelLabel, parseContextWindowSize } from "../src/shared/model.ts";

test("modelLabel maps Claude ids to friendly names", () => {
  assert.equal(modelLabel("claude-opus-4-8"), "Opus 4.8");
  assert.equal(modelLabel("claude-opus-4-8[1m]"), "Opus 4.8"); // 1M marker stripped
  assert.equal(modelLabel("claude-sonnet-5"), "Sonnet 5");
  assert.equal(modelLabel("claude-haiku-4-5-20251001"), "Haiku 4.5"); // dated build dropped
  assert.equal(modelLabel("claude-fable-5"), "Fable 5");
});

test("modelLabel maps GPT / o-series ids", () => {
  assert.equal(modelLabel("gpt-5-codex"), "GPT-5 Codex");
  assert.equal(modelLabel("gpt-5"), "GPT-5");
  assert.equal(modelLabel("gpt-4o"), "GPT-4o");
  assert.equal(modelLabel("o3"), "o3");
});

test("modelLabel prettifies unknowns and drops empties", () => {
  assert.equal(modelLabel("some-new-model"), "Some New Model");
  assert.equal(modelLabel(null), null);
  assert.equal(modelLabel(""), null);
  assert.equal(modelLabel(undefined), null);
});

test("parseContextWindowSize infers 1M from a delimited marker, else the default", () => {
  assert.deepEqual(parseContextWindowSize("claude-opus-4-8[1m]"), { size: 1_000_000, longContext: true });
  assert.deepEqual(parseContextWindowSize("model (1M)"), { size: 1_000_000, longContext: true });
  assert.deepEqual(parseContextWindowSize("model (200k)"), { size: 200_000, longContext: false });
  assert.deepEqual(parseContextWindowSize("claude-opus-4-8"), { size: 200_000, longContext: false });
  assert.deepEqual(parseContextWindowSize(null), { size: 200_000, longContext: false });
});

test("isLongContext keys off the 1M threshold", () => {
  assert.equal(isLongContext(1_000_000), true);
  assert.equal(isLongContext(258_400), false);
  assert.equal(isLongContext(200_000), false);
  assert.equal(isLongContext(null), false);
});
