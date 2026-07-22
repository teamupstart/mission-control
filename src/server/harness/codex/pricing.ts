import type { HarnessUsageEvent, PricedUsage } from "../types.ts";

/** Immutable identity of the OpenAI Standard API price snapshot used for new rows. */
export const CODEX_PRICE_VERSION = "openai-standard-2026-07-22";

export interface StandardTokenPrice {
  inputPerM: number;
  cachedInputPerM: number;
  outputPerM: number;
  cacheWriteMultiplier: number;
  longContextAfter: number | null;
  longInputMultiplier: number;
  longOutputMultiplier: number;
}

const GPT_56 = {
  cacheWriteMultiplier: 1.25,
  longContextAfter: 272_000,
  longInputMultiplier: 2,
  longOutputMultiplier: 1.5,
} as const;

/** Exact model ids with rates verified for this snapshot. Unknown ids remain unpriced. */
export const STANDARD_TOKEN_PRICES: Readonly<Record<string, StandardTokenPrice>> = {
  "gpt-5.6-sol": { inputPerM: 5, cachedInputPerM: 0.5, outputPerM: 30, ...GPT_56 },
  "gpt-5.6-terra": { inputPerM: 2.5, cachedInputPerM: 0.25, outputPerM: 15, ...GPT_56 },
  "gpt-5.6-luna": { inputPerM: 1, cachedInputPerM: 0.1, outputPerM: 6, ...GPT_56 },
  "gpt-5.5": {
    inputPerM: 5,
    cachedInputPerM: 0.5,
    outputPerM: 30,
    cacheWriteMultiplier: 1,
    longContextAfter: 272_000,
    longInputMultiplier: 2,
    longOutputMultiplier: 1.5,
  },
};

/** Value one Codex request at Standard API rates, or decline an unverified model id. */
export function estimateStandardApiUsage(event: HarnessUsageEvent): PricedUsage | null {
  if (!event.modelId) return null;
  const price = STANDARD_TOKEN_PRICES[event.modelId];
  if (!price) return null;

  const fullInput = event.input + event.cacheRead + event.cacheWrite;
  const long = price.longContextAfter !== null && fullInput > price.longContextAfter;
  const inputMultiplier = long ? price.longInputMultiplier : 1;
  const outputMultiplier = long ? price.longOutputMultiplier : 1;
  const perM = 1_000_000;
  const costUsd =
    (event.input * price.inputPerM * inputMultiplier +
      event.cacheRead * price.cachedInputPerM * inputMultiplier +
      event.cacheWrite * price.inputPerM * price.cacheWriteMultiplier * inputMultiplier +
      event.output * price.outputPerM * outputMultiplier) /
    perM;

  return {
    costUsd,
    pricingModel: event.modelId,
    pricingVersion: CODEX_PRICE_VERSION,
  };
}
