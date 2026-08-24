import { FOREMAN_MODEL_ROLES } from "@shared/foreman-models.ts";
import type { ForemanModelRole, ResolvedForemanModel } from "@shared/foreman-models.ts";
import type { LlmRunnerId, ResolvedLlmRunner } from "@shared/llm.ts";
import type { ForemanInstructionsSource } from "@shared/protocol.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";

/** The fixed browser-local id. It is deliberately not part of the workflow Persona contract. */
export const FOREMAN_PROFILE_ID = "foreman";

export const FOREMAN_PROFILE_DESCRIPTION =
  "Foreman reviews and coordinates Mission Control work while the application keeps its identity, policy, and authority boundaries fixed.";

export const FOREMAN_INSTRUCTIONS_SOURCE_LABEL: Record<ForemanInstructionsSource, string> = {
  builtin: "Built-in default",
  custom: "Customized",
  none: "No standing guidance",
};

/** The small resolved runtime projection the Library needs from App's existing Foreman poll. */
export interface ForemanProfileSummary {
  /** Foreman's GROUP-LEVEL provider - what a role that has not chosen inherits. */
  runner: LlmRunnerId | null;
  models: Record<ForemanModelRole, ResolvedForemanModel> | null;
  /**
   * What each role actually resolved to, which since the roles gained their own providers is
   * no longer one answer. Optional so a caller with only the older projection still compiles;
   * absent reads as "they all follow `runner`", which is what it used to mean.
   */
  roleRunners?: Record<ForemanModelRole, ResolvedLlmRunner> | null;
}

export function foremanInstructionsSourceLabel(source: ForemanInstructionsSource): string {
  return FOREMAN_INSTRUCTIONS_SOURCE_LABEL[source];
}

export function foremanProviderLabel(summary: ForemanProfileSummary): string {
  return summary.runner === null ? "Provider pending" : AGENT_IDENTITY[summary.runner].label;
}

/**
 * Every DISTINCT provider the four roles resolved to, in role order.
 *
 * The chip used to be able to say "all four run through X" because that was structurally
 * true. It is not any more, and a summary that still claimed it would be a confident wrong
 * answer to the one question it exists to answer - so it enumerates what is actually there.
 */
export function foremanRoleProviderLabels(summary: ForemanProfileSummary): string[] {
  const runners = summary.roleRunners;
  if (!runners) return summary.runner === null ? [] : [AGENT_IDENTITY[summary.runner].label];
  const seen: string[] = [];
  for (const role of FOREMAN_MODEL_ROLES) {
    const label = AGENT_IDENTITY[runners[role].id].label;
    if (!seen.includes(label)) seen.push(label);
  }
  return seen;
}

export function foremanProfileFact(summary: ForemanProfileSummary): string {
  const labels = foremanRoleProviderLabels(summary);
  // One provider still reads as one fact; a split reads as the split, rather than as
  // whichever one happened to be Foreman's group-level value.
  const provider = labels.length > 1 ? labels.join(" + ") : foremanProviderLabel(summary);
  return `${provider} · 4 model roles`;
}
