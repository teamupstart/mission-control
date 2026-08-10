import { AGENT_IDENTITY } from "@shared/agent.ts";
import {
  HARNESS_CAPABILITIES,
  skillCommand,
} from "@shared/harness-capabilities.ts";
import type { SkillsConfig } from "@shared/protocol.ts";
import type { AgentType, Session } from "@shared/types.ts";
import { getSkillsAcks } from "../db.ts";
import { noteKeyFor } from "../registry.ts";
import { readCatalog, type Catalog } from "./catalog.ts";
import { getSkillsConfig } from "./config.ts";
import {
  skillInstallProblem,
  skillsDirFor,
} from "./reconcile.ts";

export type RequiredSkillCommand =
  | { ok: true; command: string }
  | { ok: false; message: string };

export interface RequiredSkillCommandDeps {
  config: () => SkillsConfig;
  catalog: () => Catalog;
  acks: () => Map<string, number>;
  installProblem: (agent: AgentType, id: string) => string | null;
  command: (agent: AgentType, name: string) => string | null;
}

const defaultDeps: RequiredSkillCommandDeps = {
  config: getSkillsConfig,
  catalog: readCatalog,
  acks: getSkillsAcks,
  installProblem: (agent, id) => {
    const spec = HARNESS_CAPABILITIES[agent].skills;
    return spec
      ? skillInstallProblem(id, skillsDirFor(spec))
      : `${AGENT_IDENTITY[agent].label} does not load Mission Control skills`;
  },
  command: skillCommand,
};

/**
 * Resolve a skill invocation only when the bound session can actually run it.
 *
 * A configured toggle is not enough: the link may have drifted, and a reload-capable
 * session that predates the current generation may still hold the previous skill set.
 * Failing closed here is what makes a workflow's required skill a guarantee rather than
 * prose that merely asks the model to behave as if it had loaded one.
 */
export function requiredSkillCommand(
  session: Session,
  id: string,
  deps: RequiredSkillCommandDeps = defaultDeps,
): RequiredSkillCommand {
  const config = deps.config();
  if (!config.enabled || config.skills[id] !== true) {
    return {
      ok: false,
      // "this instruction", not "this pull request". This function gates every skill-backed
      // thing the daemon types into a session - the PR handoff was merely the first - and a
      // retro refused because its skill is off would otherwise tell an operator to enable it
      // "before preparing this pull request", which names work nobody asked for.
      message: `Enable Skills and the ${id} skill before sending this instruction.`,
    };
  }

  const catalog = deps.catalog();
  const entry = catalog.skills.find((skill) => skill.id === id);
  if (!catalog.readable || !entry) {
    return {
      ok: false,
      message: `The required ${id} skill is unavailable in this build.`,
    };
  }

  const skills = HARNESS_CAPABILITIES[session.agent].skills;
  const command = deps.command(session.agent, entry.name);
  if (!skills || !command) {
    return {
      ok: false,
      message: `${AGENT_IDENTITY[session.agent].label} cannot invoke the required ${entry.name} skill.`,
    };
  }

  const installProblem = deps.installProblem(session.agent, id);
  if (installProblem) return { ok: false, message: installProblem };

  // A null reload command means the harness watches its skills directory itself. For a
  // reload-capable harness, the generation watermark is proof that THIS conversation
  // has read the current symlink set. Starting after the change is equivalent proof.
  if (skills.reloadCommand && config.generation > 0) {
    const ack = deps.acks().get(noteKeyFor(session)) ?? 0;
    const startedCurrent =
      session.startedAt !== null
      && session.startedAt >= config.generationAt;
    if (ack < config.generation && !startedCurrent) {
      return {
        ok: false,
        message: `Wait for ${AGENT_IDENTITY[session.agent].label} to reload its skills before sending this instruction.`,
      };
    }
  }

  return { ok: true, command };
}
