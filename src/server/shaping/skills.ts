import type { AgentType } from "@shared/types.ts";
import { readCatalog } from "../skills/catalog.ts";
import { skillInvocationForAgent } from "../skills/invoke.ts";

/**
 * What Mission Control knows about a routed skill's name (D15).
 *
 * - A name in Mission Control's own catalog is checked the way a launch checks a skill it
 *   requires: switched on, present and linked for this harness. `name` is the catalog's own,
 *   which is what the harness invokes.
 * - A catalog skill that fails that check is never announced, and `reason` says why.
 * - Any other name is not Mission Control's to check. It is announced as given, marked not
 *   verified, because a skill installed some other way is not inventoried anywhere here.
 */
export type RoutedSkillResolution =
  | { catalog: true; ok: true; name: string }
  | { catalog: true; ok: false; reason: string }
  | { catalog: false };

export type RoutedSkillResolver = (agent: AgentType, name: string) => RoutedSkillResolution;

export interface RoutedSkillResolverDeps {
  catalog: typeof readCatalog;
  invocation: typeof skillInvocationForAgent;
}

const DEFAULT_DEPS: RoutedSkillResolverDeps = { catalog: readCatalog, invocation: skillInvocationForAgent };

/**
 * Resolve one routed name against the catalog, for an agent about to be launched. No reload
 * watermark: the session does not exist yet, and it will start on the current skill set, which
 * is why this asks `skillInvocationForAgent` rather than `requiredSkillCommand`.
 */
export function resolveRoutedSkill(agent: AgentType, name: string, deps: RoutedSkillResolverDeps = DEFAULT_DEPS): RoutedSkillResolution {
  const entry = deps.catalog().skills.find((skill) => skill.name === name);
  if (!entry) return { catalog: false };
  const checked = deps.invocation(agent, entry.id);
  return checked.ok ? { catalog: true, ok: true, name: entry.name } : { catalog: true, ok: false, reason: checked.message };
}

/** The catalog id behind a routed name, or null for a name Mission Control does not ship. */
export function catalogSkillId(name: string, catalog: typeof readCatalog = readCatalog): string | null {
  return catalog().skills.find((skill) => skill.name === name)?.id ?? null;
}
