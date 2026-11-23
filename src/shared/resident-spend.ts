import { coreModelId } from "./model.ts";
import { standardTokenPrice } from "./codex-pricing.ts";
import type { ResidentAgent } from "./residents.ts";

/**
 * Published Claude models whose harness reports dollars, independent of picker membership.
 * Verified 2026-11-02: https://platform.claude.com/docs/en/about-claude/pricing
 * No token-rate estimate: the reported cost remains authoritative, including cache tiers.
 */
export const CLAUDE_REPORTED_SPEND_MODELS = [
  "claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5",
  "claude-mythos-5-1", "claude-fable-5", "claude-mythos-5", "claude-opus-5",
  "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5",
  "claude-opus-4-1", "claude-opus-4", "claude-sonnet-5", "claude-sonnet-4-6",
  "claude-sonnet-4-5", "claude-sonnet-4", "claude-haiku-4-5", "claude-3-5-haiku",
] as const;

/** Same availability rule for the editor and daemon; the caller resolves defaults. */
export function residentModelSpendAvailable(agent: ResidentAgent, model: string | null): boolean {
  const measurable = {
    claude: () => model === null || ["opus", "sonnet", "haiku", "fable"].includes(model) ||
      CLAUDE_REPORTED_SPEND_MODELS.some((id) => id === coreModelId(model)),
    codex: () => standardTokenPrice(model) !== null,
  };
  return measurable[agent]();
}
