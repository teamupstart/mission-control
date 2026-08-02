import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultWindowForModel,
  effectiveContextWindow,
  isLongContext,
  MODEL_CATALOG,
  modelLabel,
  parseContextWindowSize,
  providerModelDefault,
} from "../src/shared/model.ts";

test("Claude catalog offers Opus 5 before the preserved previous-generation Opus", () => {
  const opus5 = MODEL_CATALOG.claude.findIndex((choice) => choice.id === "claude-opus-5");
  const opus48 = MODEL_CATALOG.claude.findIndex((choice) => choice.id === "claude-opus-4-8");

  assert.ok(opus5 >= 0);
  assert.equal(MODEL_CATALOG.claude[opus5]?.label, "Opus 5");
  assert.equal(opus48, opus5 + 1);
  assert.equal(MODEL_CATALOG.claude[opus48]?.hint, "previous-generation Opus");
});

test("Claude deep calls default to Opus 5 while cheaper tiers stay unchanged", () => {
  assert.equal(providerModelDefault("claude", "deep"), "claude-opus-5");
  assert.equal(providerModelDefault("claude", "balanced"), "claude-sonnet-5");
  assert.equal(providerModelDefault("claude", "cheap"), "claude-haiku-4-5");
});

test("modelLabel maps Claude ids to friendly names", () => {
  assert.equal(modelLabel("claude-opus-5"), "Opus 5");
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

test("parseContextWindowSize infers 1M from a delimited marker, else the model default", () => {
  assert.deepEqual(parseContextWindowSize("claude-opus-4-8[1m]"), { size: 1_000_000, longContext: true });
  assert.deepEqual(parseContextWindowSize("model (1M)"), { size: 1_000_000, longContext: true });
  // An explicit smaller marker wins over the family default.
  assert.deepEqual(parseContextWindowSize("model (200k)"), { size: 200_000, longContext: false });
  // Marker-less long-context families use their published default windows.
  assert.deepEqual(parseContextWindowSize("claude-fable-5"), { size: 1_000_000, longContext: true });
  assert.deepEqual(parseContextWindowSize("claude-opus-4-8"), { size: 1_000_000, longContext: true });
  assert.deepEqual(parseContextWindowSize("claude-sonnet-5"), { size: 1_000_000, longContext: true });
  // Standard-window families and unknown/absent ids stay at 200k.
  assert.deepEqual(parseContextWindowSize("claude-haiku-4-5"), { size: 200_000, longContext: false });
  assert.deepEqual(parseContextWindowSize("claude-opus-3"), { size: 200_000, longContext: false });
  assert.deepEqual(parseContextWindowSize(null), { size: 200_000, longContext: false });
});

test("isLongContext keys off the 1M threshold", () => {
  assert.equal(isLongContext(1_000_000), true);
  assert.equal(isLongContext(258_400), false);
  assert.equal(isLongContext(200_000), false);
  assert.equal(isLongContext(null), false);
});

test("defaultWindowForModel maps long-context Claude families to 1M, else 200k", () => {
  assert.equal(defaultWindowForModel("claude-fable-5"), 1_000_000);
  assert.equal(defaultWindowForModel("claude-opus-5"), 1_000_000);
  assert.equal(defaultWindowForModel("claude-opus-4-8"), 1_000_000);
  assert.equal(defaultWindowForModel("claude-opus-4-6"), 1_000_000);
  assert.equal(defaultWindowForModel("claude-sonnet-4-6"), 1_000_000);
  assert.equal(defaultWindowForModel("claude-sonnet-5"), 1_000_000);
  assert.equal(defaultWindowForModel("claude-opus-4-8-20251101"), 1_000_000); // dated build
  assert.equal(defaultWindowForModel("claude-opus-4-5"), 200_000);
  assert.equal(defaultWindowForModel("claude-sonnet-4-5"), 200_000);
  assert.equal(defaultWindowForModel("claude-haiku-4-5"), 200_000);
  assert.equal(defaultWindowForModel("claude-opus-3"), 200_000); // pre-4 = 200k
  assert.equal(defaultWindowForModel("gpt-5-codex"), 200_000);
  assert.equal(defaultWindowForModel(null), 200_000);
});

test("effectiveContextWindow floors the window up to the tier the observed tokens prove", () => {
  // Under the id-inferred size: unchanged.
  assert.equal(effectiveContextWindow(200_000, 120_000), 200_000);
  assert.equal(effectiveContextWindow(200_000, 200_000), 200_000);
  // Over 200k with a marker-less id: must be the 1M tier (the reported bug).
  assert.equal(effectiveContextWindow(200_000, 200_001), 1_000_000);
  assert.equal(effectiveContextWindow(200_000, 490_606), 1_000_000);
  // Already 1M from the id: observed tokens never shrink it.
  assert.equal(effectiveContextWindow(1_000_000, 300_000), 1_000_000);
  // No/absent token signal: unchanged.
  assert.equal(effectiveContextWindow(200_000, null), 200_000);
  assert.equal(effectiveContextWindow(200_000, undefined), 200_000);
  // Beyond every known tier: fall back to the raw count so % pegs at 100, not more.
  assert.equal(effectiveContextWindow(200_000, 1_200_000), 1_200_000);
});
