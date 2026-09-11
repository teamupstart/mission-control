import { piExtensionHealthyForDispatch } from "./environment/pi-extension.ts";
import { capabilitiesFor, missionToolsUnavailableWhy } from "@shared/harness-capabilities.ts";
import type { AgentType } from "@shared/types.ts";

/** The same reading Setup uses, including the installed link and bridged tools. */
export const piExtensionInstalled = piExtensionHealthyForDispatch;

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
