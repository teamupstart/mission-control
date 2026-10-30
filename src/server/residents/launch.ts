import { standingInstructionsChannel } from "@shared/harness-capabilities.ts";
import type { ResidentRun } from "@shared/residents.ts";
import type { StandingInstructionsDelivery } from "@shared/standing-instructions.ts";
import type { AgentType, SessionRuntime } from "@shared/types.ts";
import type { ResidentMcpLaunch } from "../harness/types.ts";
import { residentMcpLaunchForRun } from "./mcp-launch.ts";

/**
 * The resident launch composer: what a resident run adds to the SDK launch the dispatcher
 * has already composed for its task.
 *
 * Every addition comes from an entry in `RESIDENT_LAUNCH_CONTRIBUTORS`, in order, and every
 * entry reads only the run - its pinned revision, its persona snapshot and its run
 * instructions - never the profile's current revision. Later phases append contributors
 * (skills, MCP servers, compaction) and widen `ResidentLaunchContribution` with optional
 * fields; none of them branches on a harness id, because the harness registry already
 * answers every per-harness question.
 */

/** What every contributor may read. */
export interface ResidentLaunchContext {
  run: ResidentRun;
  agent: AgentType;
  runtime: SessionRuntime;
}

/** What one contributor adds. Every field is optional, so a contributor states only its own. */
export interface ResidentLaunchContribution {
  /** A block appended to the resident section of the standing instructions. */
  standingInstructions?: string;
  /** The run's pinned MCP set, for `SdkLaunchOptions.residentMcp`. */
  residentMcp?: ResidentMcpLaunch | null;
}

export interface ResidentLaunchContributor {
  /** Stable for logs and tests; never persisted. */
  id: string;
  contribute(context: ResidentLaunchContext): ResidentLaunchContribution;
}

/** The heading the resident section of the standing instructions opens with. */
export const RESIDENT_STANDING_HEADING = "## Resident role";

/**
 * Persona guidance, then profile instructions, then this run's instructions: who the agent is,
 * how this profile wants it to work, and what this launch is about. Snapshotted text only, so
 * a Persona or profile edit after launch never reaches the run.
 */
export const personaInstructionsContributor: ResidentLaunchContributor = {
  id: "personaInstructions",
  contribute({ run }) {
    const parts = [`${RESIDENT_STANDING_HEADING}: ${run.persona.name}`];
    const guidance = run.persona.guidanceMarkdown.trim();
    if (guidance) parts.push(guidance);
    const profile = run.settings.instructions.markdown.trim();
    if (profile) parts.push(`### Profile instructions\n\n${profile}`);
    if (run.runInstructions) parts.push(`### Instructions for this run\n\n${run.runInstructions}`);
    return { standingInstructions: parts.join("\n\n") };
  },
};

/**
 * The run's MCP servers, from the snapshot it took at launch and nothing else, whether its
 * profile inherits the harness defaults or not. Read again at every launch and resume, so no
 * later edit to a profile, a custom server, a secret or the native configuration reaches it.
 */
export const mcpContributor: ResidentLaunchContributor = {
  id: "mcp",
  contribute({ run }) {
    return { residentMcp: residentMcpLaunchForRun(run.id) };
  },
};

/** Ordered. Append; never reorder an existing entry, because order is delivery order. */
export const RESIDENT_LAUNCH_CONTRIBUTORS: readonly ResidentLaunchContributor[] = [
  personaInstructionsContributor,
  mcpContributor,
];

/** The composed resident additions to one launch. */
export interface ResidentLaunchPlan {
  /** The standing-instruction delivery to launch with: repository rules, then the resident section. */
  standing: StandingInstructionsDelivery;
  /** The run's pinned MCP set, or null to keep the harness's native MCP behaviour. */
  residentMcp: ResidentMcpLaunch | null;
}

/**
 * Compose a resident launch over the repository standing instructions the dispatcher resolved.
 *
 * The resident section is appended AFTER the repository block, so the operator's rules for the
 * checkout read first and the role that works inside them follows. The delivery mechanism is
 * the pair's own out-of-band channel (`systemPrompt.append` on Claude, developer instructions
 * on Codex); the supervisor records what it actually sent in `session_standing_instructions`,
 * which is what a resume replays.
 */
export function composeResidentLaunch(
  context: ResidentLaunchContext,
  repository: StandingInstructionsDelivery,
  contributors: readonly ResidentLaunchContributor[] = RESIDENT_LAUNCH_CONTRIBUTORS,
): ResidentLaunchPlan {
  const contributions = contributors.map((contributor) => contributor.contribute(context));
  const residentMcp = contributions.find((contribution) => contribution.residentMcp)?.residentMcp ?? null;
  const sections = contributions
    .map((contribution) => contribution.standingInstructions?.trim() ?? "")
    .filter((text) => text.length > 0);
  if (sections.length === 0) return { standing: repository, residentMcp };
  const text = [repository.text, ...sections].filter((part) => part.length > 0).join("\n\n");
  return {
    residentMcp,
    standing: {
      text,
      mechanism: repository.mechanism === "none"
        ? standingInstructionsChannel(context.agent, context.runtime) ?? "prompt-prefix"
        : repository.mechanism,
      sources: repository.sources,
    },
  };
}
