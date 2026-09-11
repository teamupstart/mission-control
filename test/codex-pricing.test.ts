import { test } from "node:test";
import assert from "node:assert/strict";
import { CODEX_PRICE_VERSION, estimateStandardApiUsage, STANDARD_TOKEN_PRICES } from "../src/server/harness/codex/pricing.ts";
import { MODEL_CATALOG } from "../src/shared/model.ts";
import { claudeRunner } from "../src/server/llm/claude.ts";
import type { HarnessUsageEvent } from "../src/server/harness/types.ts";

function usage(modelId: string, patch: Partial<HarnessUsageEvent> = {}): HarnessUsageEvent {
  return {
    vendorCostUsd: null, identity: "request", ts: 1, modelId, querySource: "main",
    input: 1_000, cacheRead: 2_000, cacheWrite: 3_000, output: 400,
    reasoningOutput: 100, ...patch,
  };
}

test("the verified Standard API catalog is hand-checkable model by model", () => {
  assert.equal(estimateStandardApiUsage(usage("gpt-6-astra"))?.costUsd, 0.0695);
  assert.equal(estimateStandardApiUsage(usage("gpt-5.6-sol"))?.costUsd, 0.0278);
  assert.equal(estimateStandardApiUsage(usage("gpt-5.6-terra"))?.costUsd, 0.0147);
  assert.equal(estimateStandardApiUsage(usage("gpt-5.6-luna"))?.costUsd, 0.00147);
  assert.equal(estimateStandardApiUsage(usage("gpt-5.5"))?.costUsd, 0.033);
});

test("long-context multipliers use full input and reasoning is not charged twice", () => {
  const event = usage("gpt-5.6-sol", {
    input: 100_000, cacheRead: 100_000, cacheWrite: 73_000, output: 10_000,
    reasoningOutput: 9_000,
  });
  assert.equal(estimateStandardApiUsage(event)?.costUsd, 1.91);
  assert.equal(
    estimateStandardApiUsage({ ...event, reasoningOutput: 0 })?.costUsd,
    1.91,
    "reasoning tokens are already a subset of output",
  );
});

test("unknown or absent model ids are explicitly unpriced", () => {
  assert.equal(estimateStandardApiUsage(usage("gpt-future")), null);
  assert.equal(estimateStandardApiUsage({ ...usage("gpt-5.6-sol"), modelId: null }), null);
});

test("every shipped OpenAI model is priced and every Claude model preserves reported cost", () => {
  for (const { id } of MODEL_CATALOG.codex) {
    assert.ok(estimateStandardApiUsage(usage(id)), id);
  }
  for (const id of [...MODEL_CATALOG.claude.map((model) => model.id),
    "claude-haiku-4-5-20251001", "claude-opus-4-8[1m]", "claude-future"]) {
    const event = { ...usage(id), modelId: id, reportedCostUsd: 1.234 };
    assert.deepEqual(claudeRunner.price(event), {
      costUsd: 1.234, basis: "reported", pricingVersion: "",
    }, id);
    assert.equal(claudeRunner.price({ ...event, reportedCostUsd: null }), null, id);
  }
});

test("older OpenAI text and coding models retain their own rates", () => {
  const rates: Array<[string, number, number, number]> = [
    ["gpt-5.4", 2.5, 0.25, 15], ["gpt-5.4-mini", 0.75, 0.075, 4.5],
    ["gpt-5.4-nano", 0.2, 0.02, 1.25], ["gpt-5.3-codex", 1.75, 0.175, 14],
    ["gpt-5.2-codex", 1.75, 0.175, 14], ["gpt-5.2", 1.75, 0.175, 14],
    ["gpt-5.1-codex-max", 1.25, 0.125, 10], ["gpt-5.1-codex", 1.25, 0.125, 10],
    ["gpt-5.1-codex-mini", 0.25, 0.025, 2], ["gpt-5.1", 1.25, 0.125, 10],
    ["gpt-5-codex", 1.25, 0.125, 10], ["gpt-5", 1.25, 0.125, 10],
    ["gpt-5-mini", 0.25, 0.025, 2], ["gpt-5-nano", 0.05, 0.005, 0.4],
    ["gpt-4.1", 2, 0.5, 8], ["gpt-4.1-mini", 0.4, 0.1, 1.6],
    ["gpt-4.1-nano", 0.1, 0.025, 0.4], ["gpt-4o", 2.5, 1.25, 10],
    ["gpt-4o-mini", 0.15, 0.075, 0.6], ["o3", 2, 0.5, 8],
    ["o4-mini", 1.1, 0.275, 4.4], ["o3-mini", 1.1, 0.55, 4.4],
    ["o1", 15, 7.5, 60], ["codex-mini-latest", 1.5, 0.375, 6],
    ["chat-latest", 5, 0.5, 30],
  ];
  for (const [id, input, cached, output] of rates) {
    const event = usage(id, { input: 1_000, cacheRead: 1_000, cacheWrite: 0, output: 1_000 });
    assert.ok(Math.abs(estimateStandardApiUsage(event)!.costUsd - (input + cached + output) / 1_000) < 1e-12, id);
  }
});

test("Astra's threshold includes cache tiers and is strictly greater than 272k", () => {
  const event = usage("gpt-6-astra", {
    input: 100_000, cacheRead: 100_000, cacheWrite: 72_000, output: 10_000,
  });
  assert.deepEqual(estimateStandardApiUsage(event), {
    costUsd: 2.5, pricingModel: "gpt-6-astra", pricingVersion: CODEX_PRICE_VERSION,
  });
  assert.equal(estimateStandardApiUsage({ ...event, cacheWrite: 72_001 })?.costUsd, 4.750025);
  assert.equal(estimateStandardApiUsage({ ...event, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })?.costUsd, 0);
  for (const id of ["gpt-6-astra-preview", "gpt-6-astra-pro", "gpt-5.6-future", "constructor", "toString", "__proto__"]) {
    assert.equal(estimateStandardApiUsage(usage(id)), null, id);
  }
});


test("verified dated snapshots resolve without guessing unknown suffixes", () => {
  for (const id of ["gpt-5.5-2026-04-23", "gpt-5.4-mini-2026-03-17", "gpt-5-2025-08-07",
    "gpt-4.1-2025-04-14", "gpt-4o-2024-08-06", "o4-mini-2025-04-16"]) {
    const base = id.slice(0, -11);
    assert.deepEqual(estimateStandardApiUsage(usage(id)), {
      ...estimateStandardApiUsage(usage(base)), pricingModel: id,
    });
  }
  assert.equal(estimateStandardApiUsage(usage("gpt-5.4-2099-01-01")), null);
  assert.equal(estimateStandardApiUsage(usage("gpt-4o-2024-05-13")), null,
    "an older snapshot with different rates must not inherit the alias price");
});


test("Pro, chat, and legacy models use their published rates without inventing cache discounts", () => {
  const rates: Array<[string, number, number]> = [
    ["gpt-5.5-pro", 30, 180], ["gpt-5.4-pro", 30, 180], ["gpt-5.2-pro", 21, 168],
    ["gpt-5-pro", 15, 120], ["o3-pro", 20, 80], ["o1-pro", 150, 600],
    ["o1-mini", 1.1, 4.4], ["o1-preview", 15, 60], ["gpt-4-turbo", 10, 30],
    ["gpt-4", 30, 60], ["gpt-3.5-turbo", 0.5, 1.5],
    ["gpt-5-chat-latest", 1.25, 10], ["gpt-5.1-chat-latest", 1.25, 10],
    ["gpt-5.2-chat-latest", 1.75, 14], ["gpt-5.3-chat-latest", 1.75, 14],
  ];
  for (const [id, input, output] of rates) {
    const event = usage(id, { input: 1_000, output: 1_000, cacheRead: 0, cacheWrite: 0 });
    assert.ok(Math.abs(estimateStandardApiUsage(event)!.costUsd - (input + output) / 1_000) < 1e-12, id);
  }
  assert.equal(estimateStandardApiUsage(usage("gpt-5.4-pro")), null,
    "a cache tier with no published rate cannot be valued as free");
});


test("models without published cache rates decline both cache reads and first-turn writes", () => {
  for (const [id, price] of Object.entries(STANDARD_TOKEN_PRICES)) {
    if (price.cachedInputPerM !== null) continue;
    for (const [cacheRead, cacheWrite] of [[1, 0], [0, 1], [1, 1]]) {
      assert.equal(estimateStandardApiUsage(usage(id, { cacheRead, cacheWrite })), null, id);
    }
    assert.ok(estimateStandardApiUsage(usage(id, { cacheRead: 0, cacheWrite: 0 })), id);
  }
});
