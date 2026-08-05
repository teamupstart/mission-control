import test from "node:test";
import assert from "node:assert/strict";

import { claudeTurnUsage } from "../src/server/harness/claude/sdk.ts";
import {
  claudeEnvelopeModels,
  claudeEnvelopeTurnId,
} from "../src/server/harness/claude/envelope.ts";

// Reading what a turn cost off the SDK's `result` frame.
//
// This is the frame the driver used to throw away, and the fixtures below are the real shape
// off the wire - captured from `claude -p --output-format stream-json`, not written from the
// documentation. That matters for one reason in particular: it is the same envelope
// `claude -p --output-format json` hands back for a headless run, which is why one parser
// serves both and why `claudeSpendReport` reads through the same function.

/** A `result` frame verbatim, trimmed to the keys the parser reads. */
const FRAME = {
  type: "result",
  subtype: "success",
  uuid: "12e1245c-a09e-47ab-bd4e-6bab0845f7c7",
  session_id: "ca305135-2669-42fd-8a90-ac9a2394f4fe",
  total_cost_usd: 0.051683,
  num_turns: 1,
  modelUsage: {
    "claude-haiku-4-5": {
      inputTokens: 10,
      outputTokens: 37,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 25744,
      webSearchRequests: 0,
      costUSD: 0.051683,
      contextWindow: 200000,
    },
  },
  usage: {
    input_tokens: 10,
    cache_creation_input_tokens: 25744,
    cache_read_input_tokens: 0,
    output_tokens: 37,
  },
};

test("a result frame yields the ledger's per-model view and the card's flat one", () => {
  const usage = claudeTurnUsage(FRAME, "claude-haiku-4-5");
  assert.ok(usage, "the frame carries usage");
  assert.equal(usage.turnId, "12e1245c-a09e-47ab-bd4e-6bab0845f7c7", "the frame uuid identifies the turn");
  assert.equal(usage.costUsd, 0.051683);
  assert.equal(usage.input, 10);
  assert.equal(usage.output, 37);
  assert.equal(usage.cacheWrite, 25744, "cache creation is the write tier");
  assert.equal(usage.cacheRead, 0);
  assert.deepEqual(usage.models, [
    {
      modelId: "claude-haiku-4-5",
      input: 10,
      output: 37,
      reasoningOutput: 0,
      cacheRead: 0,
      cacheWrite: 25744,
      reportedCostUsd: 0.051683,
    },
  ]);
});

test("a turn served by two models keeps both ids and sums the flat view", () => {
  // The case `modelUsage` exists for. An opus conversation that also spent haiku tokens on a
  // summarization is ONE turn, and filing all of it under the bound model would make the
  // ledger's model_id stop meaning what it says.
  const usage = claudeTurnUsage(
    {
      ...FRAME,
      total_cost_usd: 1.25,
      modelUsage: {
        "claude-opus-5": {
          inputTokens: 100,
          outputTokens: 900,
          cacheReadInputTokens: 5000,
          cacheCreationInputTokens: 200,
          costUSD: 1.2,
        },
        "claude-haiku-4-5": {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.05,
        },
      },
    },
    "claude-opus-5",
  );
  assert.ok(usage);
  assert.equal(usage.models?.length, 2, "a row each, so the ledger keeps both ids");
  assert.equal(usage.input, 110, "the flat view is the turn's total");
  assert.equal(usage.output, 920);
  assert.equal(usage.cacheRead, 5000);
  assert.equal(
    usage.modelId,
    "claude-opus-5",
    "the card names the conversation's model, not whichever served first",
  );
  assert.equal(usage.costUsd, 1.25, "the envelope's own total, not a re-derived sum");
});

test("a frame with no per-model breakdown falls back to the flat block", () => {
  const { modelUsage, ...noBreakdown } = FRAME;
  void modelUsage;
  const models = claudeEnvelopeModels(noBreakdown, "claude-sonnet-5");
  assert.equal(models.length, 1);
  assert.equal(models[0]?.modelId, "claude-sonnet-5", "and only then is the asked-for id used");
  assert.equal(models[0]?.input, 10);
  assert.equal(models[0]?.cacheWrite, 25744);
  assert.equal(models[0]?.reportedCostUsd, 0.051683, "the envelope total values a single row");
});

test("a turn that reports no usage at all is not a zero-cost turn", () => {
  // The shape a frame takes when the turn failed before it reached a model. Returning a zeroed
  // usage would put a $0 row in the ledger for a call that never happened, and - worse - make
  // `usageLedgerHasRows` claim telemetry is working.
  assert.equal(claudeTurnUsage({ type: "result", uuid: "u1" }, "claude-opus-5"), null);
  assert.deepEqual(claudeEnvelopeModels({ type: "result" }, "claude-opus-5"), []);
});

test("a frame with usage but no uuid reports the cost and refuses to key it", () => {
  // The display view survives, the ledger view does not: without a stable identity the row
  // cannot be deduplicated, and the registry declines to write rather than invent a key.
  const { uuid, ...noUuid } = FRAME;
  void uuid;
  const usage = claudeTurnUsage(noUuid, "claude-haiku-4-5");
  assert.ok(usage, "the chip can still show what the turn cost");
  assert.equal(usage.costUsd, 0.051683);
  assert.equal(usage.turnId, undefined, "but nothing will be written for it");
  assert.equal(usage.models, undefined, "and never one half without the other");
  assert.equal(claudeEnvelopeTurnId(noUuid), null);
});

test("an unpriced model leaves the turn's cost unknown rather than short", () => {
  // A sum over a breakdown where one model came back without `costUSD` would read as a
  // complete total that is quietly missing a model. Null is the honest answer, and the ledger
  // stores it as cost_known = 0.
  const usage = claudeTurnUsage(
    {
      type: "result",
      uuid: "u2",
      modelUsage: {
        "claude-opus-5": { inputTokens: 5, outputTokens: 5, costUSD: 0.5 },
        "some-new-model": { inputTokens: 5, outputTokens: 5 },
      },
    },
    "claude-opus-5",
  );
  assert.ok(usage);
  assert.equal(usage.costUsd, null, "no total is better than a subtotal presented as one");
  assert.equal(usage.models?.find((m) => m.modelId === "some-new-model")?.reportedCostUsd, null);
});

test("negative and non-numeric token counts are floored, never trusted into the ledger", () => {
  const models = claudeEnvelopeModels(
    {
      modelUsage: {
        "claude-opus-5": {
          inputTokens: -5,
          outputTokens: "12",
          cacheReadInputTokens: null,
          cacheCreationInputTokens: 7,
          costUSD: 0.1,
        },
      },
    },
    "claude-opus-5",
  );
  assert.deepEqual(models, [
    {
      modelId: "claude-opus-5",
      input: 0,
      output: 0,
      reasoningOutput: 0,
      cacheRead: 0,
      cacheWrite: 7,
      reportedCostUsd: 0.1,
    },
  ]);
});
