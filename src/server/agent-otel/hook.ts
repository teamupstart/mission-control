import type { AgentType } from "@shared/types.ts";

// The seam between the harness drivers and agent telemetry.
//
// The drivers' default deps are imported by processes that must never open the database -
// the Foreman worker reaches Claude's SDK deps for its one-shot runner - so they cannot import
// `config.ts`, even lazily. The daemon installs the resolver once at startup instead, and every
// other process, and every test that does not install one, gets an empty answer.

export interface AgentOtelLaunchInputs {
  env: Record<string, string>;
  args: string[];
}

type Resolver = (agent: AgentType) => Promise<AgentOtelLaunchInputs>;

let resolver: Resolver | null = null;

export function configureAgentOtelLaunch(next: Resolver | null): void {
  resolver = next;
}

/** Never throws and never blocks a launch on a failure: any problem is an empty answer. */
export async function agentOtelLaunchInputs(agent: AgentType): Promise<AgentOtelLaunchInputs> {
  if (resolver === null) return { env: {}, args: [] };
  try {
    return await resolver(agent);
  } catch {
    return { env: {}, args: [] };
  }
}
