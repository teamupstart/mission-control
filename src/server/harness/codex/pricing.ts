import type { HarnessUsageEvent, PricedUsage } from "../types.ts";

import { CODEX_PRICE_VERSION, standardTokenPrice } from "@shared/codex-pricing.ts";
export { CODEX_PRICE_VERSION, STANDARD_TOKEN_PRICES, type StandardTokenPrice } from "@shared/codex-pricing.ts";

/** Value one Codex request at Standard API rates, or decline an unverified model id. */
export function estimateStandardApiUsage(event: HarnessUsageEvent): PricedUsage | null {
  if (!event.modelId) return null;
  const price = standardTokenPrice(event.modelId);
  if (!price || ((event.cacheRead > 0 || event.cacheWrite > 0) && price.cachedInputPerM === null)) return null;

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
