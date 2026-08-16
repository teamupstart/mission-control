import type { ForemanModelRole, ResolvedForemanModel } from "@shared/foreman-models.ts";
import type { LlmRunnerId } from "@shared/llm.ts";
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
  runner: LlmRunnerId | null;
  models: Record<ForemanModelRole, ResolvedForemanModel> | null;
}

export function foremanInstructionsSourceLabel(source: ForemanInstructionsSource): string {
  return FOREMAN_INSTRUCTIONS_SOURCE_LABEL[source];
}

export function foremanProviderLabel(summary: ForemanProfileSummary): string {
  return summary.runner === null ? "Provider pending" : AGENT_IDENTITY[summary.runner].label;
}

export function foremanProfileFact(summary: ForemanProfileSummary): string {
  return `${foremanProviderLabel(summary)} · 4 model roles`;
}
