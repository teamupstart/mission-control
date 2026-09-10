import { capabilitiesFor, missionToolsUnavailableWhy } from "@shared/harness-capabilities.ts";
import type { AgentType } from "@shared/types.ts";

/** Phase 4 supplies the install probe; Phase 6 replaces it with the environment reading. */
export const piExtensionInstalled = (): boolean => false;

/**
 * Resolve machine availability once before provisioning. Launch-scoped tools still need
 * the builders' registration reports later; a bundle check is a separate question.
 * Every acceptance and dispatch path uses this same installation decision.
 */
export async function missionToolsAvailability(
  agent: AgentType,
  installed: () => boolean | Promise<boolean> = piExtensionInstalled,
): Promise<{ available: boolean; reason: string | null }> {
  const spec = capabilitiesFor(agent).missionTools;
  switch (spec?.mechanism) {
    case "mcp-client":
      return { available: true, reason: null };
    case "installed-extension":
      if (await installed()) return { available: true, reason: null };
      break;
  }
  return { available: false, reason: missionToolsUnavailableWhy(agent) };
}
