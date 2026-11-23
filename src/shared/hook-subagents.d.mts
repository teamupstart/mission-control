// Hand-written types for hook-subagents.mjs, so `protocol.ts` and the tests can import the
// same bounds and readers the bare-node hook runs. Same arrangement as pr-command.d.mts.

export const HOOK_SUBAGENT_TEXT_MAX: number;
export const HOOK_BACKGROUND_TASKS_MAX: number;

export interface AgentToolDescriptor {
  agentId?: string;
  status?: string;
  subagentType?: string;
  description?: string;
}

export interface BackgroundTaskEntry {
  id: string;
  type?: string;
  description?: string;
  agentType?: string;
}

/** A non-empty string clipped to the wire bound, else undefined. Accepts unknown payload fields. */
export function hookText(value: unknown): string | undefined;

/** The Agent tool call a `PostToolUse` reports, or undefined for every other event and tool. */
export function agentToolDescriptor(payload: unknown, event: string): AgentToolDescriptor | undefined;

/** The payload's `background_tasks`, bounded; undefined when the payload carries no such list. */
export function backgroundTaskList(payload: unknown): BackgroundTaskEntry[] | undefined;

/** True when `backgroundTaskList` cut the list at its bound, else undefined. */
export function backgroundTasksTruncated(payload: unknown): true | undefined;
