import type { HarnessUsageEvent, PricedUsage } from "../types.ts";

/** Immutable identity of the OpenAI Standard API price snapshot used for new rows. */
export const CODEX_PRICE_VERSION = "openai-standard-2026-09-11";

export interface StandardTokenPrice {
  inputPerM: number;
  cachedInputPerM: number | null;
  outputPerM: number;
  cacheWriteMultiplier: number;
  longContextAfter: number | null;
  longInputMultiplier: number;
  longOutputMultiplier: number;
}

const LONG_CONTEXT = {
  cacheWriteMultiplier: 1.25,
  longContextAfter: 272_000,
  longInputMultiplier: 2,
  longOutputMultiplier: 1.5,
} as const;

const STANDARD_CONTEXT = {
  cacheWriteMultiplier: 1,
  longContextAfter: null,
  longInputMultiplier: 1,
  longOutputMultiplier: 1,
} as const;

/**
 * Verified 2026-09-11 against https://developers.openai.com/api/docs/pricing and
 * https://developers.openai.com/api/docs/models/<model-id> (older text/code models).
 * Standard text-token rates only; unknown ids and variants must not inherit a price
 * just because their name starts with a known model. Claude/Pi use reported dollars.
 */
export const STANDARD_TOKEN_PRICES: Readonly<Record<string, StandardTokenPrice>> = {
  "gpt-6-astra": { inputPerM: 10, cachedInputPerM: 1, outputPerM: 50, ...LONG_CONTEXT },
  "gpt-5.6-sol": { inputPerM: 4, cachedInputPerM: 0.4, outputPerM: 20, ...LONG_CONTEXT },
  "gpt-5.6-terra": { inputPerM: 2, cachedInputPerM: 0.2, outputPerM: 12, ...LONG_CONTEXT },
  "gpt-5.6-luna": { inputPerM: 0.2, cachedInputPerM: 0.02, outputPerM: 1.2, ...LONG_CONTEXT },
  "gpt-5.5": { inputPerM: 5, cachedInputPerM: 0.5, outputPerM: 30, ...LONG_CONTEXT, cacheWriteMultiplier: 1 },
  "gpt-5.4": { inputPerM: 2.5, cachedInputPerM: 0.25, outputPerM: 15, ...LONG_CONTEXT, cacheWriteMultiplier: 1 },
  "gpt-5.4-mini": { inputPerM: 0.75, cachedInputPerM: 0.075, outputPerM: 4.5, ...STANDARD_CONTEXT },
  "gpt-5.4-nano": { inputPerM: 0.2, cachedInputPerM: 0.02, outputPerM: 1.25, ...STANDARD_CONTEXT },
  "gpt-5.3-codex": { inputPerM: 1.75, cachedInputPerM: 0.175, outputPerM: 14, ...STANDARD_CONTEXT },
  "gpt-5.2-codex": { inputPerM: 1.75, cachedInputPerM: 0.175, outputPerM: 14, ...STANDARD_CONTEXT },
  "gpt-5.2": { inputPerM: 1.75, cachedInputPerM: 0.175, outputPerM: 14, ...STANDARD_CONTEXT },
  "gpt-5.1-codex-max": { inputPerM: 1.25, cachedInputPerM: 0.125, outputPerM: 10, ...STANDARD_CONTEXT },
  "gpt-5.1-codex": { inputPerM: 1.25, cachedInputPerM: 0.125, outputPerM: 10, ...STANDARD_CONTEXT },
  "gpt-5.1-codex-mini": { inputPerM: 0.25, cachedInputPerM: 0.025, outputPerM: 2, ...STANDARD_CONTEXT },
  "gpt-5.1": { inputPerM: 1.25, cachedInputPerM: 0.125, outputPerM: 10, ...STANDARD_CONTEXT },
  "gpt-5-codex": { inputPerM: 1.25, cachedInputPerM: 0.125, outputPerM: 10, ...STANDARD_CONTEXT },
  "gpt-5": { inputPerM: 1.25, cachedInputPerM: 0.125, outputPerM: 10, ...STANDARD_CONTEXT },
  "gpt-5-mini": { inputPerM: 0.25, cachedInputPerM: 0.025, outputPerM: 2, ...STANDARD_CONTEXT },
  "gpt-5-nano": { inputPerM: 0.05, cachedInputPerM: 0.005, outputPerM: 0.4, ...STANDARD_CONTEXT },
  "gpt-4.1": { inputPerM: 2, cachedInputPerM: 0.5, outputPerM: 8, ...STANDARD_CONTEXT },
  "gpt-4.1-mini": { inputPerM: 0.4, cachedInputPerM: 0.1, outputPerM: 1.6, ...STANDARD_CONTEXT },
  "gpt-4.1-nano": { inputPerM: 0.1, cachedInputPerM: 0.025, outputPerM: 0.4, ...STANDARD_CONTEXT },
  "gpt-4o": { inputPerM: 2.5, cachedInputPerM: 1.25, outputPerM: 10, ...STANDARD_CONTEXT },
  "gpt-4o-mini": { inputPerM: 0.15, cachedInputPerM: 0.075, outputPerM: 0.6, ...STANDARD_CONTEXT },
  "o3": { inputPerM: 2, cachedInputPerM: 0.5, outputPerM: 8, ...STANDARD_CONTEXT },
  "o4-mini": { inputPerM: 1.1, cachedInputPerM: 0.275, outputPerM: 4.4, ...STANDARD_CONTEXT },
  "o3-mini": { inputPerM: 1.1, cachedInputPerM: 0.55, outputPerM: 4.4, ...STANDARD_CONTEXT },
  "o1": { inputPerM: 15, cachedInputPerM: 7.5, outputPerM: 60, ...STANDARD_CONTEXT },
  "codex-mini-latest": { inputPerM: 1.5, cachedInputPerM: 0.375, outputPerM: 6, ...STANDARD_CONTEXT },
  "gpt-5.5-pro": { inputPerM: 30, cachedInputPerM: null, outputPerM: 180, ...STANDARD_CONTEXT },
  "gpt-5.4-pro": { inputPerM: 30, cachedInputPerM: null, outputPerM: 180, ...LONG_CONTEXT, cacheWriteMultiplier: 1 },
  "gpt-5.2-pro": { inputPerM: 21, cachedInputPerM: null, outputPerM: 168, ...STANDARD_CONTEXT },
  "gpt-5-pro": { inputPerM: 15, cachedInputPerM: null, outputPerM: 120, ...STANDARD_CONTEXT },
  "o3-pro": { inputPerM: 20, cachedInputPerM: null, outputPerM: 80, ...STANDARD_CONTEXT },
  "o1-pro": { inputPerM: 150, cachedInputPerM: null, outputPerM: 600, ...STANDARD_CONTEXT },
  "o1-mini": { inputPerM: 1.1, cachedInputPerM: 0.55, outputPerM: 4.4, ...STANDARD_CONTEXT },
  "o1-preview": { inputPerM: 15, cachedInputPerM: 7.5, outputPerM: 60, ...STANDARD_CONTEXT },
  "gpt-4-turbo": { inputPerM: 10, cachedInputPerM: null, outputPerM: 30, ...STANDARD_CONTEXT },
  "gpt-4": { inputPerM: 30, cachedInputPerM: null, outputPerM: 60, ...STANDARD_CONTEXT },
  "gpt-3.5-turbo": { inputPerM: 0.5, cachedInputPerM: null, outputPerM: 1.5, ...STANDARD_CONTEXT },
  "gpt-5-chat-latest": { inputPerM: 1.25, cachedInputPerM: 0.125, outputPerM: 10, ...STANDARD_CONTEXT },
  "gpt-5.1-chat-latest": { inputPerM: 1.25, cachedInputPerM: 0.125, outputPerM: 10, ...STANDARD_CONTEXT },
  "gpt-5.2-chat-latest": { inputPerM: 1.75, cachedInputPerM: 0.175, outputPerM: 14, ...STANDARD_CONTEXT },
  "gpt-5.3-chat-latest": { inputPerM: 1.75, cachedInputPerM: 0.175, outputPerM: 14, ...STANDARD_CONTEXT },
  "chat-latest": { inputPerM: 5, cachedInputPerM: 0.5, outputPerM: 30, ...STANDARD_CONTEXT },
};

/** Only snapshots listed by the model reference with the same verified rates. */
const PRICING_ALIASES: Readonly<Record<string, string>> = {
  "gpt-5.5-2026-04-23": "gpt-5.5",
  "gpt-5.4-2026-03-05": "gpt-5.4",
  "gpt-5.4-mini-2026-03-17": "gpt-5.4-mini",
  "gpt-5.4-nano-2026-03-17": "gpt-5.4-nano",
  "gpt-5.2-2025-12-11": "gpt-5.2",
  "gpt-5.1-2025-11-13": "gpt-5.1",
  "gpt-5-2025-08-07": "gpt-5",
  "gpt-5-mini-2025-08-07": "gpt-5-mini",
  "gpt-5-nano-2025-08-07": "gpt-5-nano",
  "gpt-4.1-2025-04-14": "gpt-4.1",
  "gpt-4.1-mini-2025-04-14": "gpt-4.1-mini",
  "gpt-4.1-nano-2025-04-14": "gpt-4.1-nano",
  "gpt-4o-2024-08-06": "gpt-4o",
  "gpt-4o-2024-11-20": "gpt-4o",
  "gpt-4o-mini-2024-07-18": "gpt-4o-mini",
  "o3-2025-04-16": "o3",
  "o4-mini-2025-04-16": "o4-mini",
  "o1-2024-12-17": "o1",
  "o3-mini-2025-01-31": "o3-mini",
};

/** Value one Codex request at Standard API rates, or decline an unverified model id. */
export function estimateStandardApiUsage(event: HarnessUsageEvent): PricedUsage | null {
  if (!event.modelId) return null;
  const model = Object.hasOwn(PRICING_ALIASES, event.modelId)
    ? PRICING_ALIASES[event.modelId]!
    : event.modelId;
  const price = Object.hasOwn(STANDARD_TOKEN_PRICES, model)
    ? STANDARD_TOKEN_PRICES[model]
    : undefined;
  if (!price || (event.cacheRead > 0 && price.cachedInputPerM === null)) return null;

  const fullInput = event.input + event.cacheRead + event.cacheWrite;
  const long = price.longContextAfter !== null && fullInput > price.longContextAfter;
  const inputMultiplier = long ? price.longInputMultiplier : 1;
  const outputMultiplier = long ? price.longOutputMultiplier : 1;
  const perM = 1_000_000;
  const costUsd =
    (event.input * price.inputPerM * inputMultiplier +
      event.cacheRead * (price.cachedInputPerM ?? 0) * inputMultiplier +
      event.cacheWrite * price.inputPerM * price.cacheWriteMultiplier * inputMultiplier +
      event.output * price.outputPerM * outputMultiplier) /
    perM;

  return {
    costUsd,
    pricingModel: event.modelId,
    pricingVersion: CODEX_PRICE_VERSION,
  };
}
