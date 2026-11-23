/**
 * The work unit an agent is launched with, and how it reaches the agent.
 *
 * Pure on purpose, like `agent-trace-context.ts` beside it: the SDK adapters import this, and
 * none of them may reach `config.ts` at module load. Deciding WHETHER a launch carries a work
 * unit is `launchWorkUnitId` in `work-unit.ts`, read once when the launch begins; this module
 * only carries the decision. See `docs/work-units.md`, "The launch environment".
 *
 * The carrier is one variable, `WORK_UNIT_ID`. Mission Control writes no header into any MCP
 * config (decision D2): the owner of a server's config references the variable, and the agent
 * turns it into the `x-work-unit-id` header itself.
 */
import { WORK_UNIT_ENV_VAR } from "@shared/work-unit.ts";

/**
 * The launch environment with this launch's work unit, and only this launch's.
 *
 * Any inherited `WORK_UNIT_ID` is removed first, with or without an id to set. The daemon's own
 * environment belongs to whatever started it - a worker's shell, an agent's Bash tool - and a
 * session must never carry another unit's id. With no id the agent starts with none, exactly as
 * it would outside Mission Control.
 */
export function withWorkUnit<T extends Record<string, string | undefined>>(env: T, workUnitId: string | null | undefined): T {
  const next: Record<string, string | undefined> = { ...env };
  delete next[WORK_UNIT_ENV_VAR];
  if (workUnitId) next[WORK_UNIT_ENV_VAR] = workUnitId;
  return next as T;
}

/**
 * The variable alone, for a launch that hands its environment over as extra variables (a
 * terminal wrapper's `export` lines, a managed resume's record). Empty when the launch carries
 * none: the launch path itself removes an inherited value (`agentSubprocessEnv`, the wrapper's
 * `unset`, the resume guard), so absence here means absent in the agent.
 */
export function workUnitEnv(workUnitId: string | null | undefined): Record<string, string> {
  return workUnitId ? { [WORK_UNIT_ENV_VAR]: workUnitId } : {};
}
