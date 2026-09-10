import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateStandardApiUsage } from "../src/server/harness/codex/pricing.ts";
import type { HarnessUsageEvent } from "../src/server/harness/types.ts";

function usage(modelId: string, patch: Partial<HarnessUsageEvent> = {}): HarnessUsageEvent {
  return {
    vendorCostUsd: null, identity: "request", ts: 1, modelId, querySource: "main",
    input: 1_000, cacheRead: 2_000, cacheWrite: 3_000, output: 400,
    reasoningOutput: 100, ...patch,
  };
}

test("the verified Standard API catalog is hand-checkable model by model", () => {
  assert.equal(estimateStandardApiUsage(usage("gpt-5.6-sol"))?.costUsd, 0.03675);
  assert.equal(estimateStandardApiUsage(usage("gpt-5.6-terra"))?.costUsd, 0.018375);
  assert.equal(estimateStandardApiUsage(usage("gpt-5.6-luna"))?.costUsd, 0.00735);
  assert.equal(estimateStandardApiUsage(usage("gpt-5.5"))?.costUsd, 0.033);
});

test("long-context multipliers use full input and reasoning is not charged twice", () => {
  const event = usage("gpt-5.6-sol", {
    input: 100_000, cacheRead: 100_000, cacheWrite: 73_000, output: 10_000,
    reasoningOutput: 9_000,
  });
  assert.equal(estimateStandardApiUsage(event)?.costUsd, 2.4625);
  assert.equal(
    estimateStandardApiUsage({ ...event, reasoningOutput: 0 })?.costUsd,
    2.4625,
    "reasoning tokens are already a subset of output",
  );
});

test("unknown or absent model ids are explicitly unpriced", () => {
  assert.equal(estimateStandardApiUsage(usage("gpt-future")), null);
  assert.equal(estimateStandardApiUsage({ ...usage("gpt-5.6-sol"), modelId: null }), null);
});
